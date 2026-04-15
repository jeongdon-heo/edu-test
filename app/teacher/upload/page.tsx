"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import type { ParsedQuestion } from "@/app/api/parse-pdf/route";

type Status =
  | "idle"
  | "converting"
  | "analyzing"
  | "reviewing"
  | "saving"
  | "done";

type Progress = { current: number; total: number };

async function pdfToJpegDataUrls(
  file: File,
  onProgress: (p: Progress) => void
): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    onProgress({ current: pageNum, total: pdf.numPages });
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D 컨텍스트를 생성하지 못했습니다.");
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    images.push(canvas.toDataURL("image/jpeg", 0.8));
    page.cleanup();
  }

  await pdf.cleanup();
  await pdf.destroy();
  return images;
}

async function analyzePage(
  image: string,
  pageIndex: number,
  provider: string,
  apiKey: string
): Promise<ParsedQuestion[]> {
  const res = await fetch("/api/parse-pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-provider": provider,
      "x-ai-api-key": apiKey,
    },
    body: JSON.stringify({ image, pageIndex }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error ?? `페이지 ${pageIndex + 1} 분석 실패 (${res.status})`);
  }
  return (json.questions ?? []) as ParsedQuestion[];
}

async function saveToInstantDB(
  title: string,
  questions: ParsedQuestion[],
  teacherId: string
) {
  const testId = id();
  const txns = [
    db.tx.tests[testId].update({
      title,
      subject: "미분류",
      createdAt: Date.now(),
      teacher_id: teacherId,
    }),
    ...questions.map((q) =>
      db.tx.questions[id()].update({
        test_id: testId,
        questionNumber: q.questionNumber,
        questionText: q.questionText,
        type: q.type,
        hasImage: q.hasImage,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation,
        ...(q.materialImage ? { materialImage: q.materialImage } : {}),
      })
    ),
  ];
  await db.transact(txns);
  return testId;
}

export default function UploadPdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [questions, setQuestions] = useState<ParsedQuestion[]>([]);
  const [savedTestId, setSavedTestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const teacherId = useTeacherId();

  const selectFile = (next: File | null | undefined) => {
    if (!next) return;
    if (next.type && next.type !== "application/pdf") {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    setFile(next);
    setError(null);
    setQuestions([]);
    setSavedTestId(null);
    setSaveWarning(null);
    setStatus("idle");
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    selectFile(e.dataTransfer.files?.[0]);
  };

  const reset = () => {
    setFile(null);
    setQuestions([]);
    setSavedTestId(null);
    setError(null);
    setSaveWarning(null);
    setStatus("idle");
  };

  const handleAnalyze = async () => {
    if (!file) return;

    const provider = localStorage.getItem("ai_provider");
    const apiKey = localStorage.getItem("ai_api_key");
    if (!provider || !apiKey) {
      alert("설정 메뉴에서 API 키를 먼저 등록해 주세요.");
      router.push("/teacher/settings");
      return;
    }

    setError(null);
    setSaveWarning(null);
    setQuestions([]);
    setSavedTestId(null);

    const accumulated: ParsedQuestion[] = [];
    try {
      setStatus("converting");
      const images = await pdfToJpegDataUrls(file, setProgress);

      setStatus("analyzing");
      setProgress({ current: 0, total: images.length });
      for (const [index, image] of images.entries()) {
        const pageQuestions = await analyzePage(image, index, provider, apiKey);
        accumulated.push(...pageQuestions);
        setQuestions([...accumulated]);
        setProgress({ current: index + 1, total: images.length });
      }

      setStatus("reviewing");
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
      setStatus("idle");
    } finally {
      setProgress(null);
    }
  };

  const handleSave = async () => {
    if (!file || questions.length === 0) return;
    if (!teacherId) {
      setSaveWarning("교사 ID가 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    setStatus("saving");
    setSaveWarning(null);
    try {
      const testId = await saveToInstantDB(
        file.name.replace(/\.pdf$/i, ""),
        questions,
        teacherId
      );
      setSavedTestId(testId);
      setStatus("done");
    } catch (saveErr) {
      console.warn("[upload] InstantDB 저장 실패", saveErr);
      setSaveWarning(
        "InstantDB 저장에 실패했습니다. App ID와 권한을 확인한 뒤 다시 시도해 주세요."
      );
      setStatus("reviewing");
    }
  };

  const updateQuestion = (index: number, patch: Partial<ParsedQuestion>) => {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? { ...q, ...patch } : q))
    );
  };

  const busy =
    status === "converting" || status === "analyzing" || status === "saving";
  const editable = status === "reviewing";
  const analyzeLabel =
    status === "converting"
      ? progress
        ? `PDF 변환 중 ${progress.current}/${progress.total}`
        : "PDF 변환 중..."
      : status === "analyzing"
        ? progress
          ? `AI 분석 중 ${progress.current}/${progress.total}`
          : "AI 분석 중..."
        : "분석 시작";

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-slate-900">시험지 PDF 분석</h1>
          <p className="mt-1 text-slate-600">
            AI가 문항과 정답·해설을 함께 추출합니다. 선생님이 내용을 검토·수정한 뒤 [최종 저장]을 누르면 InstantDB에 기록됩니다.
          </p>
        </header>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition ${
            dragging
              ? "border-sky-500 bg-sky-50"
              : "border-slate-300 bg-white hover:border-sky-400"
          }`}
        >
          {file ? (
            <>
              <p className="text-lg font-semibold text-slate-800">{file.name}</p>
              <p className="mt-1 text-sm text-slate-500">
                {(file.size / 1024 / 1024).toFixed(2)} MB · 다른 파일을 놓으면 교체됩니다
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold text-slate-700">
                PDF 파일을 이곳에 끌어다 놓으세요
              </p>
              <p className="mt-1 text-sm text-slate-500">
                또는 클릭해서 파일을 선택하세요
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => selectFile(e.target.files?.[0])}
          />
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleAnalyze}
            disabled={!file || busy || status === "reviewing" || status === "done"}
            className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-sky-700"
          >
            {analyzeLabel}
          </button>
          {(status === "reviewing" || status === "done") && (
            <button
              onClick={reset}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              새 PDF 분석
            </button>
          )}
        </div>

        {progress && progress.total > 0 && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        )}
        {saveWarning && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {saveWarning}
          </p>
        )}
        {savedTestId && (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            InstantDB에 저장되었습니다. (test id: {savedTestId})
          </p>
        )}

        {questions.length > 0 && (
          <section className="mt-8 space-y-4">
            <div className="flex items-end justify-between">
              <h2 className="text-xl font-semibold text-slate-900">
                문제 검토 · 수정 ({questions.length}문항)
              </h2>
              {editable && (
                <span className="text-xs text-slate-500">
                  AI가 풀어낸 정답을 확인하고 필요하면 직접 수정하세요.
                </span>
              )}
            </div>

            <ol className="space-y-4">
              {questions.map((q, idx) => (
                <li
                  key={`${q.questionNumber}-${idx}`}
                  className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">
                      {q.questionNumber}번
                    </span>
                    <TypeBadge type={q.type} />
                    {q.hasImage && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        그림 포함
                      </span>
                    )}
                  </div>

                  {q.materialImage && (
                    <div className="mb-3 overflow-hidden rounded-lg border-2 border-slate-200 bg-slate-50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={q.materialImage}
                        alt={`${q.questionNumber}번 지문/자료`}
                        className="block w-full"
                      />
                    </div>
                  )}

                  <p className="mb-3 text-sm leading-relaxed text-slate-800">
                    {q.questionText}
                  </p>

                  {q.options.length > 0 && (
                    <ol className="mb-4 list-decimal space-y-1 pl-6 text-sm text-slate-700">
                      {q.options.map((opt, i) => (
                        <li key={i}>{opt}</li>
                      ))}
                    </ol>
                  )}

                  <div className="space-y-3 rounded-lg bg-slate-50 p-4">
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-600">
                        정답 (AI 채점)
                      </span>
                      <input
                        type="text"
                        value={q.answer}
                        readOnly={!editable}
                        onChange={(e) =>
                          updateQuestion(idx, { answer: e.target.value })
                        }
                        placeholder="정답"
                        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none disabled:bg-slate-100 read-only:bg-slate-100"
                      />
                    </label>

                    <label className="block">
                      <span className="text-xs font-semibold text-slate-600">
                        해설
                      </span>
                      <textarea
                        value={q.explanation}
                        readOnly={!editable}
                        onChange={(e) =>
                          updateQuestion(idx, { explanation: e.target.value })
                        }
                        placeholder="해설"
                        rows={2}
                        className="mt-1 w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100"
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ol>

            {(status === "reviewing" || status === "saving") && (
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleSave}
                  disabled={status === "saving"}
                  className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-emerald-700"
                >
                  {status === "saving" ? "저장 중..." : "최종 저장"}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function TypeBadge({ type }: { type: ParsedQuestion["type"] }) {
  const map = {
    multiple_choice: { label: "객관식", cls: "bg-sky-100 text-sky-800" },
    short_answer: { label: "단답형", cls: "bg-emerald-100 text-emerald-800" },
    essay: { label: "서술형", cls: "bg-violet-100 text-violet-800" },
  } as const;
  const { label, cls } = map[type];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}
