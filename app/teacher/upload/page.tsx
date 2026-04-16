"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import type { ParsedQuestion } from "@/app/api/parse-pdf/route";

/* ── Types ── */

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] 0~1000

type EditableQuestion = ParsedQuestion & { pageIndex: number };

type Status =
  | "idle"
  | "converting"
  | "analyzing"
  | "reviewing"
  | "saving"
  | "done";

type Progress = { current: number; total: number };

/* ── Helpers ── */

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

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
    if (!context)
      throw new Error("Canvas 2D 컨텍스트를 생성하지 못했습니다.");
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
  if (!res.ok)
    throw new Error(
      json?.error ?? `페이지 ${pageIndex + 1} 분석 실패 (${res.status})`
    );
  return (json.questions ?? []) as ParsedQuestion[];
}

async function cropImage(
  pageImage: string,
  bbox: BBox
): Promise<string | null> {
  const res = await fetch("/api/crop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: pageImage, bbox, padding: 0 }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return (json.croppedImage as string) ?? null;
}

async function saveToInstantDB(
  title: string,
  questions: EditableQuestion[],
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

/* ══════════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════════ */

export default function UploadPdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [questions, setQuestions] = useState<EditableQuestion[]>([]);
  const [savedTestId, setSavedTestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [cropping, setCropping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const teacherId = useTeacherId();

  /* ── file handling ── */
  const selectFile = (next: File | null | undefined) => {
    if (!next) return;
    if (next.type && next.type !== "application/pdf") {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    setFile(next);
    setError(null);
    setQuestions([]);
    setPageImages([]);
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
    setPageImages([]);
    setSavedTestId(null);
    setError(null);
    setSaveWarning(null);
    setStatus("idle");
    setEditingIndex(null);
    setSharedOpen(false);
  };

  /* ── analyze ── */
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
    setPageImages([]);
    setSavedTestId(null);
    const acc: EditableQuestion[] = [];
    try {
      setStatus("converting");
      const images = await pdfToJpegDataUrls(file, setProgress);
      setPageImages(images);
      setStatus("analyzing");
      setProgress({ current: 0, total: images.length });
      for (const [i, img] of images.entries()) {
        const pq = await analyzePage(img, i, provider, apiKey);
        acc.push(...pq.map((q) => ({ ...q, pageIndex: i })));
        setQuestions([...acc]);
        setProgress({ current: i + 1, total: images.length });
      }
      setStatus("reviewing");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다."
      );
      setStatus("idle");
    } finally {
      setProgress(null);
    }
  };

  /* ── save ── */
  const handleSave = async () => {
    if (!file || questions.length === 0) return;
    if (!teacherId) {
      setSaveWarning("교사 ID가 아직 준비되지 않았어요.");
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
    } catch {
      setSaveWarning("InstantDB 저장에 실패했습니다.");
      setStatus("reviewing");
    }
  };

  /* ── question updates ── */
  const updateQuestion = (i: number, p: Partial<EditableQuestion>) =>
    setQuestions((prev) => prev.map((q, idx) => (idx === i ? { ...q, ...p } : q)));

  const handleBBoxApply = async (index: number, bbox: BBox) => {
    const q = questions[index];
    const pageImg = pageImages[q.pageIndex];
    if (!pageImg) return;
    setEditingIndex(null);
    setCropping(true);
    try {
      const cropped = await cropImage(pageImg, bbox);
      updateQuestion(index, {
        materialImage: cropped,
        materialImageBBox: bbox,
        hasImage: true,
      });
    } catch {
      alert("이미지 크롭에 실패했습니다.");
    } finally {
      setCropping(false);
    }
  };

  const handleBBoxRemove = (index: number) => {
    setEditingIndex(null);
    updateQuestion(index, { materialImage: null, materialImageBBox: null });
  };

  /* ── shared material apply ── */
  const handleSharedApply = async (
    bbox: BBox,
    pageIdx: number,
    qIndices: number[]
  ) => {
    setSharedOpen(false);
    const pageImg = pageImages[pageIdx];
    if (!pageImg || qIndices.length === 0) return;
    setCropping(true);
    try {
      const cropped = await cropImage(pageImg, bbox);
      setQuestions((prev) =>
        prev.map((q, i) =>
          qIndices.includes(i)
            ? { ...q, materialImage: cropped, materialImageBBox: bbox, hasImage: true }
            : q
        )
      );
    } catch {
      alert("이미지 크롭에 실패했습니다.");
    } finally {
      setCropping(false);
    }
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
          <h1 className="text-3xl font-bold text-slate-900">
            시험지 PDF 분석
          </h1>
          <p className="mt-1 text-slate-600">
            AI가 문항과 정답/해설을 추출합니다. 지문 영역이 부정확하면
            직접 조정한 뒤 [최종 저장]을 누르세요.
          </p>
        </header>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
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
                {(file.size / 1024 / 1024).toFixed(2)} MB
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

        {/* Buttons */}
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleAnalyze}
            disabled={!file || busy || status === "reviewing" || status === "done"}
            className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-sky-700"
          >
            {analyzeLabel}
          </button>
          {(status === "reviewing" || status === "done") && (
            <button onClick={reset} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
              새 PDF 분석
            </button>
          )}
        </div>

        {/* Progress */}
        {progress && progress.total > 0 && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
          </div>
        )}

        {/* Alerts */}
        {error && <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
        {saveWarning && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{saveWarning}</p>}
        {savedTestId && <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">InstantDB에 저장되었습니다. (test id: {savedTestId})</p>}

        {editable && (
          <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-800">
            임시 상태 — 검수를 마친 뒤 아래 [최종 저장]을 눌러야 DB에 확정됩니다.
          </div>
        )}
        {cropping && (
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-center text-sm text-sky-700">
            이미지를 다시 자르는 중...
          </div>
        )}

        {/* Question list */}
        {questions.length > 0 && (
          <section className="mt-8 space-y-4">
            <div className="flex items-end justify-between">
              <h2 className="text-xl font-semibold text-slate-900">
                문제 검토 · 수정 ({questions.length}문항)
              </h2>
              {editable && (
                <span className="text-xs text-slate-500">
                  정답/해설/지문 영역을 확인하고 수정하세요.
                </span>
              )}
            </div>

            {/* ★ 공통 지문 등록 버튼 */}
            {editable && pageImages.length > 0 && (
              <button
                onClick={() => setSharedOpen(true)}
                className="w-full rounded-xl border-2 border-dashed border-violet-300 bg-violet-50 py-4 text-sm font-bold text-violet-700 transition hover:border-violet-400 hover:bg-violet-100"
              >
                + 공통 지문/자료 등록하기
              </button>
            )}

            <ol className="space-y-4">
              {questions.map((q, idx) => {
                const hasPage = !!pageImages[q.pageIndex];
                return (
                  <li key={`${q.questionNumber}-${idx}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{q.questionNumber}번</span>
                      <TypeBadge type={q.type} />
                      {q.hasImage && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">그림 포함</span>}
                      {editable && hasPage && (
                        <span className="group relative ml-auto">
                          <button onClick={() => setEditingIndex(idx)} className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 transition hover:bg-violet-100">
                            {q.materialImageBBox ? "영역 수정" : "영역 지정"}
                          </button>
                          <span className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-56 rounded-lg bg-slate-800 px-3 py-2 text-xs leading-relaxed text-white shadow-lg group-hover:block">
                            AI가 보기나 지문을 놓쳤다면, 여기서 해당 영역까지 넉넉히 박스를 그려 이미지로 포함시킬 수 있어요.
                          </span>
                        </span>
                      )}
                    </div>

                    {q.materialImage && (
                      <div className="mb-3 overflow-hidden rounded-lg border-2 border-slate-200 bg-slate-50">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={q.materialImage} alt={`${q.questionNumber}번 지문/자료`} className="block w-full" />
                      </div>
                    )}

                    <p className="mb-3 text-sm leading-relaxed text-slate-800">{q.questionText}</p>

                    {q.options.length > 0 && (
                      <ol className="mb-4 list-decimal space-y-1 pl-6 text-sm text-slate-700">
                        {q.options.map((opt, i) => <li key={i}>{opt}</li>)}
                      </ol>
                    )}

                    <div className="space-y-3 rounded-lg bg-slate-50 p-4">
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-600">정답 (AI 채점)</span>
                        <input type="text" value={q.answer} readOnly={!editable} onChange={(e) => updateQuestion(idx, { answer: e.target.value })} placeholder="정답" className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-600">해설</span>
                        <textarea value={q.explanation} readOnly={!editable} onChange={(e) => updateQuestion(idx, { explanation: e.target.value })} placeholder="해설" rows={2} className="mt-1 w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ol>

            {(status === "reviewing" || status === "saving") && (
              <div className="flex justify-end pt-2">
                <button onClick={handleSave} disabled={status === "saving"} className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-emerald-700">
                  {status === "saving" ? "저장 중..." : "최종 저장"}
                </button>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Single-question BBox Editor ── */}
      {editingIndex !== null && pageImages[questions[editingIndex]?.pageIndex] && (
        <BBoxEditorModal
          pageImage={pageImages[questions[editingIndex].pageIndex]}
          questionNumber={questions[editingIndex].questionNumber}
          initialBBox={questions[editingIndex].materialImageBBox}
          onApply={(bbox) => handleBBoxApply(editingIndex, bbox)}
          onRemove={() => handleBBoxRemove(editingIndex)}
          onCancel={() => setEditingIndex(null)}
        />
      )}

      {/* ── Shared Material Modal ── */}
      {sharedOpen && (
        <SharedMaterialModal
          pageImages={pageImages}
          questions={questions}
          onApply={handleSharedApply}
          onCancel={() => setSharedOpen(false)}
        />
      )}
    </main>
  );
}

/* ══════════════════════════════════════════════════════════
   BBoxSelector — reusable: image + draggable rectangle
   ══════════════════════════════════════════════════════════ */

function BBoxSelector({
  pageImage,
  bbox,
  onBBoxChange,
}: {
  pageImage: string;
  bbox: BBox;
  onBBoxChange: (b: BBox) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cbRef = useRef(onBBoxChange);
  cbRef.current = onBBoxChange;
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;

  const dragRef = useRef<{
    type: "move" | "nw" | "ne" | "sw" | "se";
    sx: number;
    sy: number;
    orig: BBox;
  } | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const pos = (e: MouseEvent) => {
      const el = imgRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - r.left) / r.width) * 1000),
        y: Math.round(((e.clientY - r.top) / r.height) * 1000),
      };
    };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const p = pos(e);
      if (!p) return;
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      const [oY1, oX1, oY2, oX2] = d.orig;
      const M = 30;
      let y1 = oY1, x1 = oX1, y2 = oY2, x2 = oX2;
      if (d.type === "move") {
        const w = oX2 - oX1, h = oY2 - oY1;
        x1 = clamp(oX1 + dx, 0, 1000 - w);
        y1 = clamp(oY1 + dy, 0, 1000 - h);
        x2 = x1 + w;
        y2 = y1 + h;
      } else {
        if (d.type === "nw" || d.type === "sw") x1 = clamp(oX1 + dx, 0, oX2 - M);
        if (d.type === "ne" || d.type === "se") x2 = clamp(oX2 + dx, oX1 + M, 1000);
        if (d.type === "nw" || d.type === "ne") y1 = clamp(oY1 + dy, 0, oY2 - M);
        if (d.type === "sw" || d.type === "se") y2 = clamp(oY2 + dy, oY1 + M, 1000);
      }
      cbRef.current([y1, x1, y2, x2]);
    };
    const onUp = () => {
      if (dragRef.current) { dragRef.current = null; tick((n) => n + 1); }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  const startDrag = (e: React.MouseEvent, type: "move" | "nw" | "ne" | "sw" | "se") => {
    e.preventDefault();
    e.stopPropagation();
    const el = imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = {
      type,
      sx: Math.round(((e.clientX - r.left) / r.width) * 1000),
      sy: Math.round(((e.clientY - r.top) / r.height) * 1000),
      orig: [...bboxRef.current] as BBox,
    };
    tick((n) => n + 1);
  };

  const [yMin, xMin, yMax, xMax] = bbox;
  const active = dragRef.current !== null;

  return (
    <div className="relative mx-auto inline-block select-none" style={{ cursor: active ? "grabbing" : undefined }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} src={pageImage} alt="시험지 원본" className="block max-h-[65vh] w-auto rounded-lg border border-slate-200" draggable={false} />

      {/* Dimming */}
      <div className="pointer-events-none absolute inset-0" style={{
        background: `linear-gradient(to bottom, rgba(0,0,0,0.35) ${yMin / 10}%, transparent ${yMin / 10}%, transparent ${yMax / 10}%, rgba(0,0,0,0.35) ${yMax / 10}%)`,
      }} />

      {/* Box */}
      <div
        className="absolute border-[3px] border-sky-500 bg-sky-400/15"
        style={{
          top: `${yMin / 10}%`, left: `${xMin / 10}%`,
          width: `${(xMax - xMin) / 10}%`, height: `${(yMax - yMin) / 10}%`,
          cursor: active ? "grabbing" : "grab",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.15)",
        }}
        onMouseDown={(e) => startDrag(e, "move")}
      >
        {/* NW */}
        <div className="absolute -left-[8px] -top-[8px] z-10 h-4 w-4 rounded-sm border-[3px] border-sky-600 bg-white shadow-md hover:scale-125" style={{ cursor: "nwse-resize" }} onMouseDown={(e) => startDrag(e, "nw")} />
        {/* NE */}
        <div className="absolute -right-[8px] -top-[8px] z-10 h-4 w-4 rounded-sm border-[3px] border-sky-600 bg-white shadow-md hover:scale-125" style={{ cursor: "nesw-resize" }} onMouseDown={(e) => startDrag(e, "ne")} />
        {/* SW */}
        <div className="absolute -bottom-[8px] -left-[8px] z-10 h-4 w-4 rounded-sm border-[3px] border-sky-600 bg-white shadow-md hover:scale-125" style={{ cursor: "nesw-resize" }} onMouseDown={(e) => startDrag(e, "sw")} />
        {/* SE */}
        <div className="absolute -bottom-[8px] -right-[8px] z-10 h-4 w-4 rounded-sm border-[3px] border-sky-600 bg-white shadow-md hover:scale-125" style={{ cursor: "nwse-resize" }} onMouseDown={(e) => startDrag(e, "se")} />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   BBoxEditorModal — single question bbox edit
   ══════════════════════════════════════════════════════════ */

function BBoxEditorModal({
  pageImage,
  questionNumber,
  initialBBox,
  onApply,
  onRemove,
  onCancel,
}: {
  pageImage: string;
  questionNumber: number;
  initialBBox: BBox | null;
  onApply: (bbox: BBox) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [bbox, setBbox] = useState<BBox>(initialBBox ?? [150, 50, 650, 950]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-4 pt-8">
      <div className="flex w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-bold text-slate-900">
            {questionNumber}번 문제 — 지문/그림 영역 수정
          </h3>
          <button onClick={onCancel} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">닫기</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          <p className="mb-4 text-sm text-slate-600">
            파란 박스의 <b>모서리</b>를 드래그하면 크기가 바뀌고, 박스 <b>안쪽</b>을 드래그하면 위치가 이동합니다.
            박스 영역이 그대로 잘립니다 (패딩 없음).
          </p>
          <BBoxSelector pageImage={pageImage} bbox={bbox} onBBoxChange={setBbox} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4">
          <button onClick={onRemove} className="text-sm font-medium text-rose-600 hover:text-rose-700">영역 삭제</button>
          <div className="flex gap-3">
            <button onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">취소</button>
            <button onClick={() => onApply(bbox)} className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-sky-700">적용</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SharedMaterialModal — shared passage multi-assign
   ══════════════════════════════════════════════════════════ */

function SharedMaterialModal({
  pageImages,
  questions,
  onApply,
  onCancel,
}: {
  pageImages: string[];
  questions: EditableQuestion[];
  onApply: (bbox: BBox, pageIdx: number, qIndices: number[]) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"select" | "assign">("select");
  const [pageIdx, setPageIdx] = useState(0);
  const [bbox, setBbox] = useState<BBox>([80, 30, 550, 970]);
  const [preview, setPreview] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const handleNext = async () => {
    setCropping(true);
    try {
      const img = await cropImage(pageImages[pageIdx], bbox);
      setPreview(img);
      setStep("assign");
    } catch {
      alert("크롭에 실패했습니다.");
    } finally {
      setCropping(false);
    }
  };

  const handleApply = () => {
    if (checked.size === 0) { alert("적용할 문제를 하나 이상 선택해 주세요."); return; }
    onApply(bbox, pageIdx, Array.from(checked));
  };

  const sorted = [...questions]
    .map((q, i) => ({ q, i }))
    .sort((a, b) => a.q.questionNumber - b.q.questionNumber);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-4 pt-8">
      <div className="flex w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-bold text-slate-900">
            공통 지문/자료 등록
          </h3>
          <button onClick={onCancel} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">닫기</button>
        </div>

        {step === "select" ? (
          <>
            {/* Step 1: select region */}
            <div className="flex-1 overflow-auto p-6">
              <p className="mb-3 text-sm text-slate-600">
                공통 지문 영역을 파란 박스로 선택하세요. 박스 영역이 그대로 잘립니다.
              </p>

              {/* Page tabs */}
              {pageImages.length > 1 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {pageImages.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => { setPageIdx(i); setBbox([80, 30, 550, 970]); }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        pageIdx === i
                          ? "bg-sky-600 text-white"
                          : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                      }`}
                    >
                      {i + 1}페이지
                    </button>
                  ))}
                </div>
              )}

              <BBoxSelector pageImage={pageImages[pageIdx]} bbox={bbox} onBBoxChange={setBbox} />
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4">
              <button onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">취소</button>
              <button onClick={handleNext} disabled={cropping} className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-50 hover:bg-sky-700">
                {cropping ? "자르는 중..." : "다음 — 문제 선택"}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Step 2: assign to questions */}
            <div className="flex-1 overflow-auto p-6">
              <p className="mb-4 text-sm font-medium text-slate-700">
                이 지문을 어느 문제에 적용할까요?
              </p>

              {/* Preview */}
              {preview && (
                <div className="mb-5 overflow-hidden rounded-xl border-2 border-slate-200 bg-slate-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={preview} alt="공통 지문 미리보기" className="block w-full" />
                </div>
              )}

              {/* Question checkboxes */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {sorted.map(({ q, i }) => {
                  const on = checked.has(i);
                  return (
                    <button
                      key={i}
                      onClick={() => toggle(i)}
                      className={`flex items-center gap-2 rounded-xl border-2 px-4 py-3 text-left text-sm font-medium transition ${
                        on
                          ? "border-sky-500 bg-sky-50 text-sky-800"
                          : "border-slate-200 bg-white text-slate-600 hover:border-sky-300"
                      }`}
                    >
                      <span className={`flex h-5 w-5 flex-none items-center justify-center rounded border-2 text-xs font-bold ${
                        on ? "border-sky-500 bg-sky-500 text-white" : "border-slate-300"
                      }`}>
                        {on ? "V" : ""}
                      </span>
                      {q.questionNumber}번
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-between border-t border-slate-200 px-6 py-4">
              <button onClick={() => setStep("select")} className="text-sm font-medium text-slate-500 hover:text-slate-700">
                이전으로
              </button>
              <div className="flex gap-3">
                <button onClick={onCancel} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">취소</button>
                <button onClick={handleApply} disabled={checked.size === 0} className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-40 hover:bg-violet-700">
                  {checked.size}개 문제에 적용
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function TypeBadge({ type }: { type: ParsedQuestion["type"] }) {
  const map: Record<string, { label: string; cls: string }> = {
    multiple_choice: { label: "객관식", cls: "bg-sky-100 text-sky-800" },
    multi_select: { label: "복수 선택", cls: "bg-indigo-100 text-indigo-800" },
    ox: { label: "OX", cls: "bg-amber-100 text-amber-800" },
    short_answer: { label: "단답형", cls: "bg-emerald-100 text-emerald-800" },
    essay: { label: "서술형", cls: "bg-violet-100 text-violet-800" },
  };
  const { label, cls } = map[type] ?? { label: type, cls: "bg-slate-100 text-slate-700" };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}
