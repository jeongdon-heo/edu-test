"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import type { ParsedQuestion } from "@/app/api/parse-pdf/route";

/* ── Types ── */

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] 0~1000

type TextBlock = {
  text: string;
  bbox: BBox;
};

type PageData = {
  image: string;
  textBlocks: TextBlock[];
  rawText: string;
};

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

const SNAP_THRESHOLD = 15; // 0~1000 단위, 이 거리 안이면 스냅

function snapValue(value: number, targets: number[]): number {
  let best = value;
  let bestDist = SNAP_THRESHOLD + 1;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= SNAP_THRESHOLD ? best : value;
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

/** PDF 텍스트 레이어에서 텍스트 아이템을 추출하고 줄 단위로 클러스터링 */
function buildTextBlocks(
  textContent: { items: unknown[] },
  vpWidth: number,
  vpHeight: number,
  vpTransform: number[]
): TextBlock[] {
  const raw: Array<{ text: string; x: number; y: number; w: number; h: number }> = [];

  for (const item of textContent.items) {
    const ti = item as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
    };
    if (!ti.str?.trim() || !ti.transform) continue;

    const [a, b, c, d, tx, ty] = ti.transform;
    const fontH = Math.sqrt(c * c + d * d) || Math.abs(a) || 12;
    const tw = ti.width || 0;

    // 뷰포트 변환 적용 (PDF 좌표 → 화면 좌표)
    const [va, vb, vc, vd, ve, vf] = vpTransform;
    const vx = va * tx + vc * ty + ve;
    const vy = vb * tx + vd * ty + vf;
    const vx2 = va * (tx + tw) + vc * (ty + fontH) + ve;
    const vy2 = vb * (tx + tw) + vd * (ty + fontH) + vf;

    const xMin = Math.min(vx, vx2);
    const yMin = Math.min(vy, vy2);
    const xMax = Math.max(vx, vx2);
    const yMax = Math.max(vy, vy2);

    raw.push({
      text: ti.str,
      x: xMin,
      y: yMin,
      w: xMax - xMin,
      h: yMax - yMin,
    });
  }

  // y 중심 기준 줄 단위 클러스터링
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<typeof raw> = [];
  for (const item of raw) {
    const cy = item.y + item.h / 2;
    const last = lines[lines.length - 1];
    if (last) {
      const lastCy = last[0].y + last[0].h / 2;
      if (Math.abs(cy - lastCy) < Math.max(item.h * 0.6, 4)) {
        last.push(item);
        continue;
      }
    }
    lines.push([item]);
  }

  return lines.map((items) => {
    items.sort((a, b) => a.x - b.x);
    const text = items.map((i) => i.text).join(" ");
    const xMin = Math.min(...items.map((i) => i.x));
    const yMin = Math.min(...items.map((i) => i.y));
    const xMax = Math.max(...items.map((i) => i.x + i.w));
    const yMax = Math.max(...items.map((i) => i.y + i.h));
    return {
      text,
      bbox: [
        clamp(Math.round((yMin / vpHeight) * 1000), 0, 1000),
        clamp(Math.round((xMin / vpWidth) * 1000), 0, 1000),
        clamp(Math.round((yMax / vpHeight) * 1000), 0, 1000),
        clamp(Math.round((xMax / vpWidth) * 1000), 0, 1000),
      ] as BBox,
    };
  });
}

/** 시험지 PDF → 이미지 + 텍스트 레이어를 동시에 추출 */
async function pdfToPageData(
  file: File,
  onProgress: (p: Progress) => void
): Promise<PageData[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages: PageData[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    onProgress({ current: pageNum, total: pdf.numPages });
    const page = await pdf.getPage(pageNum);

    // 이미지 렌더링
    const renderVp = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = renderVp.width;
    canvas.height = renderVp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D 컨텍스트를 생성하지 못했습니다.");
    await page.render({ canvasContext: ctx, viewport: renderVp, canvas }).promise;
    const image = canvas.toDataURL("image/jpeg", 0.8);

    // 텍스트 레이어 추출
    const textVp = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const textBlocks = buildTextBlocks(
      textContent,
      textVp.width,
      textVp.height,
      textVp.transform as unknown as number[]
    );

    const rawText = textBlocks
      .map((b, i) => `(${i + 1}) ${b.text}`)
      .join("\n");

    pages.push({ image, textBlocks, rawText });
    page.cleanup();
  }

  await pdf.cleanup();
  await pdf.destroy();
  return pages;
}

async function analyzePage(
  image: string,
  pageIndex: number,
  provider: string,
  apiKey: string,
  answerKeyImages?: string[],
  pageText?: string
): Promise<ParsedQuestion[]> {
  const res = await fetch("/api/parse-pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-provider": provider,
      "x-ai-api-key": apiKey,
    },
    body: JSON.stringify({
      image,
      pageIndex,
      ...(answerKeyImages && answerKeyImages.length > 0
        ? { answerKeyImages }
        : {}),
      ...(pageText ? { pageText } : {}),
    }),
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
        ...(q.questionImage ? { questionImage: q.questionImage } : {}),
        ...(q.blankCount ? { blankCount: q.blankCount } : {}),
        ...(q.subItems ? { subItems: q.subItems } : {}),
        ...(q.requiresProcess ? { requiresProcess: q.requiresProcess } : {}),
        ...(q.unit ? { unit: q.unit } : {}),
        ...(q.rubric ? { rubric: q.rubric } : {}),
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
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draggingAnswer, setDraggingAnswer] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [pageTextBlocks, setPageTextBlocks] = useState<TextBlock[][]>([]);
  const [questions, setQuestions] = useState<EditableQuestion[]>([]);
  const [savedTestId, setSavedTestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingMode, setEditingMode] = useState<"material" | "question">(
    "material"
  );
  const [sharedOpen, setSharedOpen] = useState(false);
  const [cropping, setCropping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
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

  const selectAnswerFile = (next: File | null | undefined) => {
    if (!next) return;
    if (next.type && next.type !== "application/pdf") {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    setAnswerFile(next);
    setError(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    selectFile(e.dataTransfer.files?.[0]);
  };

  const handleAnswerDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingAnswer(false);
    selectAnswerFile(e.dataTransfer.files?.[0]);
  };

  const reset = () => {
    setFile(null);
    setAnswerFile(null);
    setQuestions([]);
    setPageImages([]);
    setPageTextBlocks([]);
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
    setPageTextBlocks([]);
    setSavedTestId(null);
    const acc: EditableQuestion[] = [];
    try {
      setStatus("converting");
      // 시험지 PDF → 이미지 + 텍스트 레이어 동시 추출
      const pages = await pdfToPageData(file, setProgress);
      setPageImages(pages.map((p) => p.image));
      setPageTextBlocks(pages.map((p) => p.textBlocks));

      // 정답지 PDF가 있으면 이미지만 변환
      let answerKeyImgs: string[] = [];
      if (answerFile) {
        answerKeyImgs = await pdfToJpegDataUrls(answerFile, setProgress);
      }

      setStatus("analyzing");
      setProgress({ current: 0, total: pages.length });
      for (const [i, page] of pages.entries()) {
        const pq = await analyzePage(
          page.image,
          i,
          provider,
          apiKey,
          answerKeyImgs.length > 0 ? answerKeyImgs : undefined,
          page.rawText || undefined
        );
        acc.push(...pq.map((q) => ({ ...q, pageIndex: i })));
        setQuestions([...acc]);
        setProgress({ current: i + 1, total: pages.length });
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
    const mode = editingMode;
    setEditingIndex(null);
    setCropping(true);
    try {
      const cropped = await cropImage(pageImg, bbox);
      if (mode === "question") {
        updateQuestion(index, {
          questionImage: cropped,
          questionImageBBox: bbox,
        });
      } else {
        updateQuestion(index, {
          materialImage: cropped,
          materialImageBBox: bbox,
          hasImage: true,
        });
      }
    } catch {
      alert("이미지 크롭에 실패했습니다.");
    } finally {
      setCropping(false);
    }
  };

  const handleBBoxRemove = (index: number) => {
    const mode = editingMode;
    setEditingIndex(null);
    if (mode === "question") {
      updateQuestion(index, { questionImage: null, questionImageBBox: null });
    } else {
      updateQuestion(index, { materialImage: null, materialImageBBox: null });
    }
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
        : answerFile
          ? "분석 시작 (정답지 포함)"
          : "분석 시작";

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <Link
            href="/teacher"
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            ← 대시보드로
          </Link>
          <h1 className="mt-1 text-3xl font-bold text-slate-900">
            시험지 PDF 분석
          </h1>
          <p className="mt-1 text-slate-600">
            AI가 문항과 정답/해설을 추출합니다. 지문 영역이 부정확하면
            직접 조정한 뒤 [최종 저장]을 누르세요.
          </p>
        </header>

        {/* ── 시험지 업로드 (필수) ── */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition ${
            dragging
              ? "border-sky-500 bg-sky-50"
              : file
                ? "border-sky-400 bg-sky-50"
                : "border-slate-300 bg-white hover:border-sky-400"
          }`}
        >
          <span className="mb-2 inline-block rounded-full bg-sky-100 px-3 py-1 text-xs font-bold text-sky-700">
            필수
          </span>
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
                시험지 PDF를 이곳에 끌어다 놓으세요
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

        {/* ── 정답지/해설지 업로드 (선택) ── */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDraggingAnswer(true); }}
          onDragLeave={() => setDraggingAnswer(false)}
          onDrop={handleAnswerDrop}
          onClick={() => answerInputRef.current?.click()}
          className={`mt-4 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition ${
            draggingAnswer
              ? "border-emerald-500 bg-emerald-50"
              : answerFile
                ? "border-emerald-400 bg-emerald-50"
                : "border-slate-200 bg-slate-50 hover:border-emerald-400"
          }`}
        >
          <span className="mb-2 inline-block rounded-full bg-slate-200 px-3 py-1 text-xs font-bold text-slate-600">
            선택
          </span>
          {answerFile ? (
            <div className="flex items-center gap-3">
              <div>
                <p className="text-base font-semibold text-slate-800">{answerFile.name}</p>
                <p className="text-xs text-slate-500">
                  {(answerFile.size / 1024 / 1024).toFixed(2)} MB — 정답지 첨부됨
                </p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setAnswerFile(null); }}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                제거
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-600">
                정답지/해설지 PDF 첨부 (선택)
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                첨부하면 AI가 직접 계산하지 않고 정답지를 그대로 참조합니다
              </p>
            </>
          )}
          <input
            ref={answerInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => selectAnswerFile(e.target.files?.[0])}
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
                const isFirstInPassageGroup =
                  !!q.materialImage &&
                  (idx === 0 ||
                    questions[idx - 1]?.materialImage !== q.materialImage);
                return (
                  <li key={`${q.questionNumber}-${idx}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    {isFirstInPassageGroup && (
                      <div className="mb-4 overflow-hidden rounded-xl border-4 border-amber-300 bg-amber-50 p-3">
                        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-amber-800">
                          📖 공통 지문
                        </p>
                        <div className="overflow-hidden rounded-lg border-2 border-amber-200 bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={q.materialImage!} alt="공통 지문" className="block w-full" />
                        </div>
                      </div>
                    )}

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{q.questionNumber}번</span>
                      <TypeBadge type={q.type} />
                      {q.hasImage && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">그림 포함</span>}
                      {editable && hasPage && (
                        <div className="ml-auto flex gap-2">
                          <button
                            onClick={() => {
                              setEditingMode("question");
                              setEditingIndex(idx);
                            }}
                            className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 transition hover:bg-sky-100"
                          >
                            문항 영역 {q.questionImageBBox ? "수정" : "지정"}
                          </button>
                          <button
                            onClick={() => {
                              setEditingMode("material");
                              setEditingIndex(idx);
                            }}
                            className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 transition hover:bg-violet-100"
                          >
                            지문 영역 {q.materialImageBBox ? "수정" : "지정"}
                          </button>
                        </div>
                      )}
                    </div>

                    {q.questionImage && (
                      <div className="mb-3 overflow-hidden rounded-lg border-2 border-sky-200 bg-sky-50">
                        <p className="bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800">
                          🧩 문항 고유 영역
                        </p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={q.questionImage} alt={`${q.questionNumber}번 문항 영역`} className="block w-full bg-white" />
                      </div>
                    )}

                    <p className="mb-3 text-sm leading-relaxed text-slate-800">{q.questionText}</p>

                    {q.options.length > 0 && (
                      <ol className="mb-4 list-decimal space-y-1 pl-6 text-sm text-slate-700">
                        {q.options.map((opt, i) => <li key={i}>{opt}</li>)}
                      </ol>
                    )}

                    <div className="space-y-3 rounded-lg bg-slate-50 p-4">
                      {/* 다중 빈칸: 개별 정답 입력란 */}
                      {q.blankCount && q.blankCount >= 2 ? (
                        <div>
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-600">정답 (빈칸별)</span>
                            <label className="ml-auto flex items-center gap-1">
                              <span className="text-xs font-semibold text-slate-600">단위</span>
                              <input type="text" value={q.unit ?? ""} readOnly={!editable} onChange={(e) => updateQuestion(idx, { unit: e.target.value || null })} placeholder="예: 년" className="w-16 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                            </label>
                          </div>
                          <div className="space-y-2">
                            {(() => {
                              const parts = q.answer.split(";;");
                              while (parts.length < q.blankCount) parts.push("");
                              return parts.slice(0, q.blankCount).map((part, pi) => (
                                <div key={pi} className="flex items-center gap-2">
                                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-700 text-[10px] font-bold text-white">
                                    {pi + 1}
                                  </span>
                                  <input
                                    type="text"
                                    value={part}
                                    readOnly={!editable}
                                    onChange={(e) => {
                                      const next = [...parts];
                                      next[pi] = e.target.value;
                                      updateQuestion(idx, { answer: next.join(";;") });
                                    }}
                                    placeholder={`${pi + 1}번째 빈칸 정답`}
                                    className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100"
                                  />
                                </div>
                              ));
                            })()}
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <label className="block flex-1">
                            <span className="text-xs font-semibold text-slate-600">정답 (AI 채점)</span>
                            <input type="text" value={q.answer} readOnly={!editable} onChange={(e) => updateQuestion(idx, { answer: e.target.value })} placeholder="정답" className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                          </label>
                          <label className="block w-20">
                            <span className="text-xs font-semibold text-slate-600">단위</span>
                            <input type="text" value={q.unit ?? ""} readOnly={!editable} onChange={(e) => updateQuestion(idx, { unit: e.target.value || null })} placeholder="예: 년" className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                          </label>
                        </div>
                      )}
                      {/* 서술형 루브릭 */}
                      {q.requiresProcess && (
                        <label className="block">
                          <span className="text-xs font-semibold text-violet-700">모범 풀이 및 채점 기준 (루브릭)</span>
                          <textarea
                            value={q.rubric ?? q.explanation ?? ""}
                            readOnly={!editable}
                            onChange={(e) => updateQuestion(idx, { rubric: e.target.value })}
                            placeholder={"예: 30만÷3만=10 식 포함 시 부분점수 부여\n모범 풀이 과정과 핵심 채점 기준을 작성하세요."}
                            rows={4}
                            className="mt-1 w-full resize-none rounded-md border-2 border-violet-200 bg-violet-50 px-3 py-2 text-sm text-slate-900 focus:border-violet-500 focus:outline-none read-only:bg-slate-100"
                          />
                        </label>
                      )}
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-600">해설</span>
                        <textarea value={q.explanation} readOnly={!editable} onChange={(e) => updateQuestion(idx, { explanation: e.target.value })} placeholder="해설" rows={2} className="mt-1 w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none read-only:bg-slate-100" />
                      </label>
                      {/* blankCount 조절 */}
                      {(q.type === "short_answer") && editable && (
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-semibold text-slate-600">빈칸 개수</span>
                          <button onClick={() => updateQuestion(idx, { blankCount: Math.max(0, (q.blankCount ?? 0) - 1) || null })} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-sm font-bold text-slate-600 hover:bg-slate-100">−</button>
                          <span className="w-6 text-center text-sm font-semibold text-slate-800">{q.blankCount ?? 0}</span>
                          <button onClick={() => updateQuestion(idx, { blankCount: (q.blankCount ?? 0) + 1 })} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-sm font-bold text-slate-600 hover:bg-slate-100">+</button>
                          <span className="text-xs text-slate-400">(0~1이면 단일 입력, 2이상이면 다중 빈칸)</span>
                        </div>
                      )}
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
          textBlocks={pageTextBlocks[questions[editingIndex].pageIndex]}
          questionNumber={questions[editingIndex].questionNumber}
          initialBBox={
            editingMode === "question"
              ? questions[editingIndex].questionImageBBox
              : questions[editingIndex].materialImageBBox
          }
          title={
            editingMode === "question" ? "문항 고유 영역" : "공통 지문 영역"
          }
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
  textBlocks,
}: {
  pageImage: string;
  bbox: BBox;
  onBBoxChange: (b: BBox) => void;
  textBlocks?: TextBlock[];
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cbRef = useRef(onBBoxChange);
  cbRef.current = onBBoxChange;
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  const [showHints, setShowHints] = useState(true);

  // 텍스트 블록 가장자리를 스냅 타겟으로 수집
  const snapEdges = useMemo(() => {
    if (!textBlocks) return { xs: [] as number[], ys: [] as number[] };
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (const tb of textBlocks) {
      ys.add(tb.bbox[0]); // y_min
      xs.add(tb.bbox[1]); // x_min
      ys.add(tb.bbox[2]); // y_max
      xs.add(tb.bbox[3]); // x_max
    }
    return { xs: [...xs], ys: [...ys] };
  }, [textBlocks]);

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
      // 스냅 적용
      if (d.type !== "move") {
        if (d.type === "nw" || d.type === "ne") y1 = snapValue(y1, snapEdges.ys);
        if (d.type === "sw" || d.type === "se") y2 = snapValue(y2, snapEdges.ys);
        if (d.type === "nw" || d.type === "sw") x1 = snapValue(x1, snapEdges.xs);
        if (d.type === "ne" || d.type === "se") x2 = snapValue(x2, snapEdges.xs);
      }
      cbRef.current([y1, x1, y2, x2]);
    };
    const onUp = () => {
      if (dragRef.current) { dragRef.current = null; tick((n) => n + 1); }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [snapEdges]);

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
  const hasHints = textBlocks && textBlocks.length > 0;

  return (
    <div>
      {hasHints && (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHints((p) => !p)}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
              showHints
                ? "bg-amber-100 text-amber-800"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {showHints ? "텍스트 힌트 켜짐" : "텍스트 힌트 꺼짐"}
          </button>
          {showHints && (
            <span className="text-xs text-slate-400">
              모서리 드래그 시 텍스트 영역에 자동 스냅됩니다
            </span>
          )}
        </div>
      )}
      <div className="relative mx-auto inline-block select-none" style={{ cursor: active ? "grabbing" : undefined }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={pageImage} alt="시험지 원본" className="block max-h-[65vh] w-auto rounded-lg border border-slate-200" draggable={false} />

        {/* 텍스트 블록 힌트 오버레이 */}
        {showHints && textBlocks?.map((tb, i) => (
          <div
            key={i}
            className="pointer-events-none absolute border border-amber-400/40 bg-amber-300/15"
            style={{
              top: `${tb.bbox[0] / 10}%`,
              left: `${tb.bbox[1] / 10}%`,
              width: `${(tb.bbox[3] - tb.bbox[1]) / 10}%`,
              height: `${(tb.bbox[2] - tb.bbox[0]) / 10}%`,
            }}
          />
        ))}

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
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   BBoxEditorModal — single question bbox edit
   ══════════════════════════════════════════════════════════ */

/**
 * 2단 시험지에 맞는 초기 BBox를 계산합니다.
 * 1) textBlocks에서 해당 문제 번호 텍스트의 좌표를 찾아 앵커링
 * 2) 찾지 못하면 1~10번은 왼쪽 단, 11~20번은 오른쪽 단 휴리스틱
 * 3) 크기: 너비 ~47%, 높이 ~28%
 */
function computeDefaultBBox(
  questionNumber: number,
  textBlocks?: TextBlock[]
): BBox {
  const W = 470; // 너비 ~47% of 1000
  const H = 280; // 높이 ~28% of 1000

  // 1) textBlocks에서 문제 번호를 찾아 앵커링
  if (textBlocks && textBlocks.length > 0) {
    const numStr = String(questionNumber);
    // "3.", "3)", "3 ." 등의 패턴으로 문제 번호가 시작하는 텍스트 블록을 찾음
    const anchor = textBlocks.find((tb) => {
      const t = tb.text.trimStart();
      return (
        t.startsWith(numStr + ".") ||
        t.startsWith(numStr + ")") ||
        t.startsWith(numStr + " ") ||
        t.startsWith(numStr + ".")
      );
    });
    if (anchor) {
      const [ay, ax] = anchor.bbox;
      // 문제 번호 바로 위에서 시작, 같은 단(x 기준)에 배치
      const top = clamp(ay - 20, 0, 1000 - H);
      const left = ax < 500
        ? clamp(ax - 10, 0, 530 - W) // 왼쪽 단
        : clamp(ax - 10, 470, 1000 - W); // 오른쪽 단
      return [top, left, top + H, left + W];
    }
  }

  // 2) 휴리스틱: 1~10번 왼쪽 단, 11~20번 오른쪽 단
  const isRightColumn = questionNumber > 10;
  const left = isRightColumn ? 510 : 20;
  // 페이지 상단 근처에서 시작
  const top = 80;
  return [top, left, top + H, left + W];
}

function BBoxEditorModal({
  pageImage,
  textBlocks,
  questionNumber,
  initialBBox,
  title,
  onApply,
  onRemove,
  onCancel,
}: {
  pageImage: string;
  textBlocks?: TextBlock[];
  questionNumber: number;
  initialBBox: BBox | null;
  title?: string;
  onApply: (bbox: BBox) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [bbox, setBbox] = useState<BBox>(
    initialBBox ?? computeDefaultBBox(questionNumber, textBlocks)
  );
  const heading = title ?? "지문/그림 영역";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-4 pt-8">
      <div className="flex w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-bold text-slate-900">
            {questionNumber}번 문제 — {heading} 수정
          </h3>
          <button onClick={onCancel} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">닫기</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-6">
          <p className="mb-4 text-sm text-slate-600">
            파란 박스의 <b>모서리</b>를 드래그하면 크기가 바뀌고, 박스 <b>안쪽</b>을 드래그하면 위치가 이동합니다.
            박스 영역이 그대로 잘립니다 (패딩 없음).
          </p>
          <BBoxSelector pageImage={pageImage} bbox={bbox} onBBoxChange={setBbox} textBlocks={textBlocks} />
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
