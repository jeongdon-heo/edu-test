"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import {
  gradeSubmission,
  buildAIGradeItems,
  buildEssayGradeItems,
  buildPureEssayGradeItems,
  type AnswerValue,
  type PureEssayGrade,
  type RubricGrade,
} from "@/lib/scoring";
import { clearLoggedInStudent, useLoggedInStudent } from "@/lib/studentLogin";
import { ResultView, type SubmitResult } from "../_components/ResultView";

type PageProps = {
  params: Promise<{ testId: string }>;
};

class GradingBusyError extends Error {
  constructor() {
    super("grading server busy");
    this.name = "GradingBusyError";
  }
}

function formatDate(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TakeTestPage({ params }: PageProps) {
  const { testId } = use(params);
  const router = useRouter();
  const loggedIn = useLoggedInStudent();

  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  // Hydration: once we know the student is not logged in, bounce to root.
  useEffect(() => {
    if (loggedIn === null) {
      router.replace("/");
    }
  }, [loggedIn, router]);

  const studentId = loggedIn?.id ?? "";

  const testScopedQuery = db.useQuery({
    tests: { $: { where: { id: testId } } },
    questions: { $: { where: { test_id: testId } } },
    results: { $: { where: { test_id: testId } } },
    submissions: { $: { where: { test_id: testId } } },
  });

  const test = testScopedQuery.data?.tests?.[0];

  const isLoading = testScopedQuery.isLoading || loggedIn === undefined;
  const error = testScopedQuery.error;

  const questions = useMemo(
    () =>
      [...(testScopedQuery.data?.questions ?? [])].sort(
        (a, b) => (a.questionNumber ?? 0) - (b.questionNumber ?? 0)
      ),
    [testScopedQuery.data]
  );
  const resultsForTest = testScopedQuery.data?.results ?? [];

  const existingResult = useMemo(
    () => (studentId ? resultsForTest.find((r) => r.student_id === studentId) : undefined),
    [resultsForTest, studentId]
  );

  useEffect(() => {
    if (existingResult) {
      const prev = existingResult.submittedAnswers;
      if (prev && typeof prev === "object" && !Array.isArray(prev)) {
        setAnswers(prev as Record<string, AnswerValue>);
        return;
      }
    }
    setAnswers({});
  }, [studentId, existingResult?.id]);

  const setAnswer = (qId: string, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [qId]: value }));
  };

  const setBlankAnswer = (qId: string, index: number, value: string, total: number) => {
    setAnswers((prev) => {
      const current = Array.isArray(prev[qId])
        ? [...(prev[qId] as string[])]
        : Array(total).fill("");
      current[index] = value;
      return { ...prev, [qId]: current };
    });
  };

  const setSubItemAnswer = (qId: string, index: number, value: string, total: number) => {
    setAnswers((prev) => {
      const current = Array.isArray(prev[qId])
        ? [...(prev[qId] as string[])]
        : Array(total).fill("");
      current[index] = value;
      return { ...prev, [qId]: current };
    });
  };

  const setProcessField = (
    qId: string,
    field: "process" | "answer",
    value: string
  ) => {
    setAnswers((prev) => {
      const current =
        prev[qId] &&
        typeof prev[qId] === "object" &&
        !Array.isArray(prev[qId])
          ? { ...(prev[qId] as { process: string; answer: string }) }
          : { process: "", answer: "" };
      current[field] = value;
      return { ...prev, [qId]: current };
    });
  };

  /* ═══ 실시간 진행 상황(submissions) 동기화 ═══ */
  const existingSubmission = useMemo(() => {
    if (!studentId) return undefined;
    return (testScopedQuery.data?.submissions ?? []).find(
      (s) => s.student_id === studentId
    );
  }, [testScopedQuery.data, studentId]);

  const submissionIdRef = useRef<string | null>(null);
  const lastPushedRef = useRef<number>(-1);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const questionListRef = useRef<HTMLOListElement>(null);
  const totalQuestions = questions.length;

  // Ensure a submission row exists once we know who/what this test is.
  useEffect(() => {
    if (!studentId || !loggedIn || totalQuestions === 0 || result) return;
    if (submissionIdRef.current) return;
    const subId = existingSubmission?.id ?? id();
    submissionIdRef.current = subId;
    db.transact(
      db.tx.submissions[subId].update({
        student_id: studentId,
        student_name: loggedIn.name,
        test_id: testId,
        currentQuestionIndex: existingSubmission?.currentQuestionIndex ?? 0,
        totalQuestions,
        status: existingResult ? "submitted" : "in_progress",
        startedAt: existingSubmission?.startedAt ?? Date.now(),
        lastActiveAt: Date.now(),
      })
    ).catch((e) => console.warn("[submission] init failed", e));
  }, [
    studentId,
    loggedIn,
    totalQuestions,
    result,
    existingSubmission,
    existingResult,
    testId,
  ]);

  const pushProgress = useCallback(
    (idx: number) => {
      const subId = submissionIdRef.current;
      if (!subId || !studentId) return;
      if (idx === lastPushedRef.current) return;
      lastPushedRef.current = idx;
      db.transact(
        db.tx.submissions[subId].update({
          currentQuestionIndex: idx,
          lastActiveAt: Date.now(),
        })
      ).catch((e) => console.warn("[submission] progress push failed", e));
    },
    [studentId]
  );

  // Debounce progress writes — 600ms of idle before flushing.
  useEffect(() => {
    if (!submissionIdRef.current || result) return;
    const handle = setTimeout(() => pushProgress(currentQuestionIdx), 600);
    return () => clearTimeout(handle);
  }, [currentQuestionIdx, pushProgress, result]);

  // Track which question is most in view via IntersectionObserver. Falls back
  // to bumping the index whenever the student edits an answer below the
  // current max.
  useEffect(() => {
    if (!questionListRef.current || totalQuestions === 0) return;
    const items = Array.from(
      questionListRef.current.querySelectorAll<HTMLLIElement>("li[data-q-idx]")
    );
    if (items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { idx: number; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number(
            (e.target as HTMLElement).dataset.qIdx ?? "0"
          );
          if (!best || e.intersectionRatio > best.ratio) {
            best = { idx, ratio: e.intersectionRatio };
          }
        }
        if (best) {
          setCurrentQuestionIdx((prev) => Math.max(prev, best!.idx));
        }
      },
      { threshold: [0.25, 0.5, 0.75] }
    );
    for (const it of items) observer.observe(it);
    return () => observer.disconnect();
  }, [totalQuestions]);

  // Any answer change also counts as "still working" — bump activity.
  useEffect(() => {
    if (!submissionIdRef.current || result) return;
    const answered = Object.keys(answers).length;
    if (answered === 0) return;
    setCurrentQuestionIdx((prev) => Math.max(prev, Math.min(answered, totalQuestions - 1)));
  }, [answers, totalQuestions, result]);

  const handleSubmit = async () => {
    if (submitLockRef.current || submitting || result) return;
    if (!studentId) {
      alert("먼저 본인을 골라주세요!");
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    setToastMessage(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const busyMessage =
      "채점 서버에 접속자가 많아요. 작성한 답안은 임시 저장되었으니 1분 뒤에 다시 제출해 주세요.";

    try {
      // 1) Build grading items
      const aiItems = buildAIGradeItems(questions, answers);
      const essayItems = buildEssayGradeItems(questions, answers);
      const pureEssayItems = buildPureEssayGradeItems(questions, answers);

      // 2) Call AI grading APIs (regular + rubric essays together,
      //    pure-essay on the dedicated endpoint) in parallel.
      let aiResults = new Map<string, boolean>();
      let essayResults = new Map<string, RubricGrade>();
      let pureEssayResults = new Map<string, PureEssayGrade>();

      const apiKey =
        typeof window !== "undefined"
          ? localStorage.getItem("ai_api_key") ?? ""
          : "";
      const buildHeaders = (): Record<string, string> => {
        const h: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) h["x-ai-api-key"] = apiKey;
        return h;
      };

      const gradeCall =
        aiItems.length > 0 || essayItems.length > 0
          ? fetch("/api/grade", {
              method: "POST",
              headers: buildHeaders(),
              body: JSON.stringify({ items: aiItems, essayItems }),
              signal: controller.signal,
            })
          : Promise.resolve(null);

      const pureEssayCall =
        pureEssayItems.length > 0
          ? fetch("/api/grade-essay", {
              method: "POST",
              headers: buildHeaders(),
              body: JSON.stringify({ items: pureEssayItems }),
              signal: controller.signal,
            })
          : Promise.resolve(null);

      const [gradeResp, pureEssayResp] = await Promise.all([
        gradeCall,
        pureEssayCall,
      ]);

      // Treat any non-OK (incl. 429) as a grading failure → busy toast.
      if (gradeResp && !gradeResp.ok) throw new GradingBusyError();
      if (pureEssayResp && !pureEssayResp.ok) throw new GradingBusyError();

      const gradeJson = gradeResp ? await gradeResp.json() : null;
      const pureEssayJson = pureEssayResp ? await pureEssayResp.json() : null;

      if (gradeJson) {
        for (const r of gradeJson.results ?? []) {
          if (typeof r.id === "string" && typeof r.correct === "boolean") {
            aiResults.set(r.id, r.correct);
          }
        }
        for (const r of gradeJson.essayResults ?? []) {
          if (typeof r.id === "string" && typeof r.score === "number") {
            essayResults.set(r.id, {
              score: r.score,
              feedback: r.feedback ?? "",
            });
          }
        }
      } else if (aiItems.length > 0 || essayItems.length > 0) {
        aiResults = new Map();
        essayResults = new Map();
      }

      if (pureEssayJson) {
        for (const r of pureEssayJson.results ?? []) {
          if (typeof r.id === "string" && typeof r.score === "number") {
            pureEssayResults.set(r.id, {
              score: r.score,
              feedback: r.feedback ?? "",
              isCorrect: r.isCorrect === true,
            });
          }
        }
      } else if (pureEssayItems.length > 0) {
        pureEssayResults = new Map();
      }

      // 3) Grade with AI + rubric + pure-essay results
      const grade = gradeSubmission(
        questions,
        answers,
        aiResults,
        essayResults,
        pureEssayResults
      );

      // 4) Save to DB (result + submission status)
      const resultId = existingResult?.id ?? id();
      const subId = submissionIdRef.current;
      await db.transact(
        db.tx.results[resultId].update({
          student_id: studentId,
          student_name: loggedIn?.name ?? "",
          test_id: testId,
          score: grade.score,
          submittedAnswers: answers,
          gradedResults: grade.gradedResults,
          submittedAt: Date.now(),
        })
      );
      if (subId) {
        await db.transact(
          db.tx.submissions[subId].update({
            status: "submitted",
            currentQuestionIndex: totalQuestions,
            lastActiveAt: Date.now(),
          })
        );
      }
      setResult({
        score: grade.score,
        correct: grade.correct,
        gradable: grade.gradable,
        essayCount: grade.essayCount,
        overwritten: !!existingResult,
        questionResults: grade.questionResults,
      });
    } catch (err) {
      const isTimeout =
        err instanceof DOMException && err.name === "AbortError";
      const isBusy = err instanceof GradingBusyError;
      const isNetwork = err instanceof TypeError; // fetch network failure
      if (isTimeout || isBusy || isNetwork) {
        console.warn("[submit] grading server busy", err);
        setToastMessage(busyMessage);
      } else {
        console.error("[submit] failed", err);
        alert("제출에 실패했어요. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      clearTimeout(timeoutId);
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sky-50">
        <p className="text-xl text-slate-500">불러오는 중이에요...</p>
      </main>
    );
  }

  if (error || !test) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sky-50 p-6">
        <div className="rounded-3xl bg-white p-8 text-center shadow">
          <p className="text-xl text-slate-700">시험을 찾을 수 없어요.</p>
          <Link
            href="/test"
            className="mt-4 inline-block rounded-xl bg-sky-600 px-5 py-3 text-white"
          >
            시험 목록으로
          </Link>
        </div>
      </main>
    );
  }

  if (result) {
    return <ResultView result={result} />;
  }

  return (
    <main className="min-h-screen bg-sky-50 px-4 py-8">
      {submitting && <GradingOverlay />}
      {toastMessage && (
        <GradingToast
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 text-center">
          <p className="text-sm font-semibold text-sky-700">{test.subject}</p>
          <h1 className="mt-1 text-3xl font-bold text-sky-900">{test.title}</h1>
        </header>

        {loggedIn && (
          <div className="mb-6 flex flex-col gap-4 rounded-3xl border-4 border-sky-200 bg-white p-5 shadow-lg sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-600">
                시험 보는 사람
              </p>
              <p className="mt-1 text-2xl font-extrabold text-sky-900 sm:text-3xl">
                {loggedIn.studentNumber}번 {loggedIn.name}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                clearLoggedInStudent();
                router.replace("/");
              }}
              className="rounded-2xl border-4 border-rose-400 bg-rose-50 px-5 py-3 text-lg font-extrabold text-rose-700 shadow-md transition active:scale-95 hover:bg-rose-100"
            >
              앗! 내가 아니에요
            </button>
          </div>
        )}

        {studentId && existingResult && (
          <div className="mb-6 rounded-2xl border-4 border-amber-300 bg-amber-50 p-5 text-center">
            <p className="text-lg font-bold text-amber-900">
              이미 제출한 시험입니다.
            </p>
            <p className="mt-1 text-sm text-amber-800">
              이전 점수 {existingResult.score}점 · 제출 시각{" "}
              {formatDate(existingResult.submittedAt)}
            </p>
            <p className="mt-2 text-sm text-amber-700">
              다시 제출하면 기존 결과를 덮어쓰기 합니다.
            </p>
          </div>
        )}

        <ol ref={questionListRef} className="space-y-5">
          {questions.map((q, qIdx) => {
            const blankCount = (q.blankCount as number | undefined) ?? null;
            const subItems = (q.subItems as string[] | undefined) ?? null;
            const requiresProcess = (q.requiresProcess as boolean | undefined) ?? false;
            const unit = (q.unit as string | undefined) ?? null;
            const showCircleKb = needsCircleKeyboard(q);

            return (
              <li
                key={q.id}
                data-q-idx={qIdx}
                className="rounded-3xl bg-white p-6 shadow-lg"
              >
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-sky-600 text-xl font-bold text-white">
                    {q.questionNumber}
                  </span>
                  <TypeLabel type={q.type} requiresProcess={requiresProcess} />
                </div>

                {q.materialImage &&
                  (qIdx === 0 ||
                    questions[qIdx - 1]?.materialImage !== q.materialImage) && (
                    <div className="mb-5 overflow-hidden rounded-2xl border-4 border-amber-300 bg-amber-50 p-3">
                      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-amber-800">
                        📖 공통 지문
                      </p>
                      <div className="overflow-hidden rounded-xl border-2 border-amber-200 bg-white">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={q.materialImage}
                          alt="공통 지문"
                          className="block w-full"
                        />
                      </div>
                    </div>
                  )}

                {q.questionImage ? (
                  <div className="mb-5 overflow-hidden rounded-2xl border-2 border-slate-200 bg-slate-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={q.questionImage}
                      alt={`${q.questionNumber}번 문제`}
                      className="block h-auto w-full max-w-full"
                    />
                  </div>
                ) : q.questionText ? (
                  <p className="mb-5 text-2xl font-semibold leading-relaxed text-slate-800">
                    {q.questionText}
                  </p>
                ) : null}

                {/* ── 다중 빈칸 ── */}
                {q.type === "short_answer" && !requiresProcess && blankCount && blankCount >= 2 && !subItems && (
                  <MultiBlankInput
                    count={blankCount}
                    unit={unit}
                    value={
                      Array.isArray(answers[q.id])
                        ? (answers[q.id] as string[])
                        : Array(blankCount).fill("")
                    }
                    onChange={(idx, val) =>
                      setBlankAnswer(q.id, idx, val, blankCount)
                    }
                  />
                )}

                {/* ── 소문항 ── */}
                {q.type === "short_answer" && !requiresProcess && subItems && subItems.length > 0 && (
                  <SubItemsInput
                    subItems={subItems}
                    unit={unit}
                    value={
                      Array.isArray(answers[q.id])
                        ? (answers[q.id] as string[])
                        : Array(subItems.length).fill("")
                    }
                    onChange={(idx, val) =>
                      setSubItemAnswer(q.id, idx, val, subItems.length)
                    }
                  />
                )}

                {/* ── 풀이 과정 + 답 (requiresProcess) ── */}
                {requiresProcess && (
                  <ProcessAnswerInput
                    unit={unit}
                    value={
                      answers[q.id] &&
                      typeof answers[q.id] === "object" &&
                      !Array.isArray(answers[q.id])
                        ? (answers[q.id] as { process: string; answer: string })
                        : { process: "", answer: "" }
                    }
                    onChangeProcess={(v) => setProcessField(q.id, "process", v)}
                    onChangeAnswer={(v) => setProcessField(q.id, "answer", v)}
                  />
                )}

                {/* ── 일반 객관식 ── */}
                {q.type === "multiple_choice" && (
                  <ChoiceButtons
                    optionsCount={resolveOptionsCount(q)}
                    options={Array.isArray(q.options) ? (q.options as string[]) : []}
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(v) => setAnswer(q.id, v)}
                  />
                )}

                {/* ── 복수 선택 ── */}
                {q.type === "multi_select" && (
                  <MultiSelectButtons
                    optionsCount={resolveOptionsCount(q)}
                    options={Array.isArray(q.options) ? (q.options as string[]) : []}
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(v) => setAnswer(q.id, v)}
                  />
                )}

                {/* ── OX ── */}
                {q.type === "ox" && (
                  <OXButtons
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(v) => setAnswer(q.id, v)}
                  />
                )}

                {/* ── 일반 단답형 (빈칸 1개, 소문항 없음, requiresProcess 아닌 경우) ── */}
                {q.type === "short_answer" &&
                  !requiresProcess &&
                  (!blankCount || blankCount < 2) &&
                  (!subItems || subItems.length === 0) && (
                    <ShortAnswerInput
                      value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                      onChange={(v) => setAnswer(q.id, v)}
                      unit={unit}
                      showCircleKeyboard={showCircleKb}
                    />
                  )}

                {/* ── 일반 서술형 (requiresProcess 아닌 경우) ── */}
                {q.type === "essay" && !requiresProcess && (
                  <div>
                    <SpecialSymbolToolbar
                      className="mb-2"
                      onAppend={(ch) => {
                        const current =
                          typeof answers[q.id] === "string"
                            ? (answers[q.id] as string)
                            : "";
                        setAnswer(q.id, current + ch);
                      }}
                    />
                    <textarea
                      value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                      onChange={(e) => setAnswer(q.id, e.target.value)}
                      placeholder="생각을 자유롭게 적어보세요"
                      rows={5}
                      className="w-full resize-none rounded-2xl border-4 border-slate-200 px-6 py-5 text-xl leading-relaxed text-slate-900 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <button
          onClick={handleSubmit}
          disabled={submitting || questions.length === 0 || !studentId}
          className="mt-8 w-full rounded-3xl bg-sky-600 px-6 py-6 text-3xl font-bold text-white shadow-lg transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "채점 중..."
            : existingResult
              ? "다시 제출하기 ✅"
              : "제출하기 ✅"}
        </button>
      </div>
    </main>
  );
}

/* ── Helpers ── */

const CIRCLE_CHARS = ["㉠", "㉡", "㉢", "㉣", "㉤", "㉥", "㉦", "㉧", "㉨", "㉩", "㉪", "㉫", "㉬", "㉭"];

function needsCircleKeyboard(q: { questionText?: string | null; answer: string; options?: unknown }): boolean {
  const text = (q.questionText ?? "") + (q.answer ?? "");
  return CIRCLE_CHARS.some((c) => text.includes(c));
}

/** New image-based tests use `optionsCount`. Legacy tests stored an `options`
 *  array — fall back to its length so old data keeps rendering. */
function resolveOptionsCount(q: {
  optionsCount?: number | null;
  options?: unknown;
}): number {
  if (typeof q.optionsCount === "number" && q.optionsCount > 0) {
    return q.optionsCount;
  }
  if (Array.isArray(q.options)) return q.options.length;
  return 0;
}

/* ── Sub-components ── */

function GradingOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-sky-900/40 px-6 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-6 rounded-3xl border-4 border-sky-200 bg-white px-8 py-10 shadow-2xl">
        <div className="relative h-24 w-24">
          <span className="absolute inset-0 animate-ping rounded-full bg-sky-300 opacity-60" />
          <span className="absolute inset-2 animate-spin rounded-full border-4 border-sky-100 border-t-sky-600" />
          <span className="absolute inset-0 flex items-center justify-center text-4xl">
            🤖
          </span>
        </div>
        <p className="text-center text-xl font-bold leading-relaxed text-sky-900">
          🤖 AI 선생님이 서술형 답안을
          <br />
          꼼꼼히 채점하고 있어요!
        </p>
        <p className="text-center text-base font-medium text-slate-500">
          잠시만 기다려주세요...
        </p>
      </div>
    </div>
  );
}

function GradingToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div
      role="alert"
      className="fixed bottom-6 left-1/2 z-[60] w-[92%] max-w-md -translate-x-1/2"
    >
      <div className="flex items-start gap-3 rounded-2xl border-4 border-amber-300 bg-amber-50 px-5 py-4 shadow-xl">
        <span className="text-2xl leading-none">⚠️</span>
        <p className="flex-1 text-base font-semibold leading-relaxed text-amber-900">
          {message}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="알림 닫기"
          className="rounded-full px-2 py-1 text-lg font-bold text-amber-700 transition hover:bg-amber-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function TypeLabel({ type, requiresProcess }: { type: string; requiresProcess?: boolean }) {
  const map: Record<string, { label: string; cls: string }> = {
    multiple_choice: { label: "객관식", cls: "bg-sky-100 text-sky-800" },
    multi_select: { label: "복수 선택", cls: "bg-indigo-100 text-indigo-800" },
    ox: { label: "OX", cls: "bg-amber-100 text-amber-800" },
    short_answer: { label: "단답형", cls: "bg-emerald-100 text-emerald-800" },
    essay: { label: "서술형", cls: "bg-violet-100 text-violet-800" },
  };
  const { label, cls } = map[type] ?? {
    label: type,
    cls: "bg-slate-100 text-slate-700",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-semibold ${cls}`}>
      {requiresProcess ? `${label} (풀이+답)` : label}
    </span>
  );
}

/* ── 원문자 입력 툴바 ── */
function CircleCharToolbar({ onInsert }: { onInsert: (ch: string) => void }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {CIRCLE_CHARS.slice(0, 6).map((ch) => (
        <button
          key={ch}
          type="button"
          onClick={() => onInsert(ch)}
          className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-teal-200 bg-teal-50 text-xl font-bold text-teal-800 transition active:scale-95 active:bg-teal-100"
        >
          {ch}
        </button>
      ))}
    </div>
  );
}

/* ── 특수기호 간편 입력 툴바 ── */
const SPECIAL_SYMBOLS = ["○", "×", "①", "②", "③", "④", "⑤"];

function SpecialSymbolToolbar({
  onAppend,
  className = "",
}: {
  onAppend: (ch: string) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {SPECIAL_SYMBOLS.map((ch) => (
        <button
          key={ch}
          type="button"
          // Prevent focus loss so the last-focused input stays active — this
          // keeps the mobile keyboard from flicking away between taps.
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={() => onAppend(ch)}
          aria-label={`특수기호 ${ch} 입력`}
          className="flex h-10 min-w-[2.5rem] items-center justify-center rounded-full border border-slate-300 bg-white px-3 text-lg font-semibold text-slate-700 shadow-sm transition active:scale-95 active:bg-sky-50 hover:bg-slate-50"
        >
          {ch}
        </button>
      ))}
    </div>
  );
}

/* ── 일반 단답형 입력 (원문자 키보드 + 단위 표시) ── */
function ShortAnswerInput({
  value,
  onChange,
  unit,
  showCircleKeyboard,
}: {
  value: string;
  onChange: (v: string) => void;
  unit?: string | null;
  showCircleKeyboard?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const insertChar = (ch: string) => {
    const el = inputRef.current;
    if (!el) { onChange(value + ch); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.substring(0, start) + ch + value.substring(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + ch.length;
      el.focus();
    });
  };

  return (
    <div>
      {showCircleKeyboard && <CircleCharToolbar onInsert={insertChar} />}
      <SpecialSymbolToolbar
        className="mb-2"
        onAppend={(ch) => onChange(value + ch)}
      />
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="답을 써보세요"
          className="min-w-0 flex-1 rounded-2xl border-4 border-slate-200 px-6 py-5 text-3xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
        />
        {unit && (
          <span className="flex-none text-3xl font-bold text-slate-500">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── 다중 빈칸 입력 ── */
const CIRCLED_NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function MultiBlankInput({
  count,
  value,
  onChange,
  unit,
}: {
  count: number;
  value: string[];
  onChange: (index: number, val: string) => void;
  unit?: string | null;
}) {
  const [focused, setFocused] = useState(0);
  const appendToFocused = (ch: string) => {
    const idx = Math.min(focused, count - 1);
    const current = value[idx] ?? "";
    onChange(idx, current + ch);
  };
  return (
    <div>
      <p className="mb-3 rounded-lg bg-sky-50 px-4 py-2.5 text-sm font-bold text-sky-700">
        ※ 위에서 아래로, 왼쪽에서 오른쪽 순서대로 빈칸을 채워주세요.
      </p>
      <SpecialSymbolToolbar className="mb-3" onAppend={appendToFocused} />
      <div className="space-y-3">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-sky-600 text-lg font-bold text-white">
              {CIRCLED_NUMS[i] ?? i + 1}
            </span>
            <div className="flex flex-1 items-center gap-2">
              <input
                type="text"
                value={value[i] ?? ""}
                onChange={(e) => onChange(i, e.target.value)}
                onFocus={() => setFocused(i)}
                placeholder={`${CIRCLED_NUMS[i] ?? i + 1}번째 빈칸`}
                className="min-w-0 flex-1 rounded-xl border-4 border-slate-200 px-4 py-4 text-center text-2xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
              />
              {unit && i === count - 1 && (
                <span className="flex-none text-2xl font-bold text-slate-500">
                  {unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 소문항 입력 ── */
function SubItemsInput({
  subItems,
  value,
  onChange,
  unit,
}: {
  subItems: string[];
  value: string[];
  onChange: (index: number, val: string) => void;
  unit?: string | null;
}) {
  const [focused, setFocused] = useState(0);
  const appendToFocused = (ch: string) => {
    const idx = Math.min(focused, subItems.length - 1);
    const current = value[idx] ?? "";
    onChange(idx, current + ch);
  };
  return (
    <div>
      <SpecialSymbolToolbar className="mb-3" onAppend={appendToFocused} />
      <div className="space-y-4">
        {subItems.map((label, i) => (
          <div key={i}>
            <p className="mb-2 text-lg font-semibold text-slate-700">{label}</p>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={value[i] ?? ""}
                onChange={(e) => onChange(i, e.target.value)}
                onFocus={() => setFocused(i)}
                placeholder="답을 써보세요"
                className="min-w-0 flex-1 rounded-xl border-4 border-slate-200 px-5 py-4 text-2xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
              />
              {unit && (
                <span className="flex-none text-2xl font-bold text-slate-500">
                  {unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 풀이 과정 + 답 입력 (수학 기호 툴바 포함) ── */
const MATH_SYMBOLS = [
  { label: "+", value: "+" },
  { label: "-", value: "-" },
  { label: "×", value: "×" },
  { label: "÷", value: "÷" },
  { label: "=", value: "=" },
];

function ProcessAnswerInput({
  value,
  onChangeProcess,
  onChangeAnswer,
  unit,
}: {
  value: { process: string; answer: string };
  onChangeProcess: (v: string) => void;
  onChangeAnswer: (v: string) => void;
  unit?: string | null;
}) {
  const processRef = useRef<HTMLTextAreaElement>(null);

  const insertSymbol = (symbol: string) => {
    const ta = processRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newValue =
      value.process.substring(0, start) +
      symbol +
      value.process.substring(end);
    onChangeProcess(newValue);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + symbol.length;
      ta.focus();
    });
  };

  return (
    <div className="space-y-4">
      {/* 풀이 과정 */}
      <div>
        <label className="mb-2 block text-base font-bold text-violet-700">
          풀이 과정
        </label>
        {/* 수학 기호 입력 툴바 */}
        <div className="mb-2 flex gap-2">
          {MATH_SYMBOLS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => insertSymbol(s.value)}
              className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-violet-200 bg-violet-50 text-2xl font-bold text-violet-700 transition active:scale-95 active:bg-violet-100"
            >
              {s.label}
            </button>
          ))}
        </div>
        <SpecialSymbolToolbar
          className="mb-2"
          onAppend={(ch) => onChangeProcess(value.process + ch)}
        />
        <textarea
          ref={processRef}
          value={value.process}
          onChange={(e) => onChangeProcess(e.target.value)}
          placeholder="풀이 과정을 써보세요"
          rows={6}
          className="w-full resize-none rounded-2xl border-4 border-violet-200 px-6 py-5 text-xl leading-relaxed text-slate-900 focus:border-violet-500 focus:outline-none"
        />
      </div>

      {/* 답 */}
      <div>
        <label className="mb-2 block text-base font-bold text-sky-700">
          답
        </label>
        <SpecialSymbolToolbar
          className="mb-2"
          onAppend={(ch) => onChangeAnswer(value.answer + ch)}
        />
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={value.answer}
            onChange={(e) => onChangeAnswer(e.target.value)}
            placeholder="답을 써보세요"
            className="min-w-0 flex-1 rounded-2xl border-4 border-sky-200 px-6 py-5 text-3xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
          />
          {unit && (
            <span className="flex-none text-3xl font-bold text-slate-500">
              {unit}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const OMR_CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

/** OMR-style single-choice bubble grid. The question image above carries all
 *  the text; these buttons just capture the numbered selection. */
function ChoiceButtons({
  optionsCount,
  options,
  value,
  onChange,
}: {
  optionsCount: number;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (optionsCount <= 0) return null;
  const isLegacyTextMode = options.length === optionsCount;

  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      {Array.from({ length: optionsCount }, (_, idx) => {
        const num = String(idx + 1);
        // Legacy rows saved the full option text as the answer — keep that
        // working by comparing against the same text.
        const storeValue = isLegacyTextMode ? options[idx] : num;
        const selected = value === storeValue;
        return (
          <button
            key={idx}
            type="button"
            aria-label={`${idx + 1}번 선택`}
            onClick={() => onChange(storeValue)}
            className={`flex h-20 w-20 flex-none items-center justify-center rounded-full border-4 text-4xl font-black transition active:scale-95 ${
              selected
                ? "border-sky-600 bg-sky-600 text-white shadow-lg"
                : "border-slate-300 bg-white text-slate-500 hover:border-sky-400"
            }`}
          >
            {OMR_CIRCLED[idx] ?? idx + 1}
          </button>
        );
      })}
    </div>
  );
}

function MultiSelectButtons({
  optionsCount,
  options,
  value,
  onChange,
}: {
  optionsCount: number;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (optionsCount <= 0) return null;
  const isLegacyTextMode = options.length === optionsCount;

  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = new Set(parts);

  const toggle = (storeValue: string) => {
    const next = new Set(selected);
    if (next.has(storeValue)) next.delete(storeValue);
    else next.add(storeValue);
    onChange(Array.from(next).join(","));
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-base font-medium text-indigo-700">
        여러 개를 선택할 수 있어요
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
        {Array.from({ length: optionsCount }, (_, idx) => {
          const num = String(idx + 1);
          const storeValue = isLegacyTextMode ? options[idx] : num;
          const on = selected.has(storeValue);
          return (
            <button
              key={idx}
              type="button"
              aria-label={`${idx + 1}번 선택`}
              onClick={() => toggle(storeValue)}
              className={`flex h-20 w-20 flex-none items-center justify-center rounded-2xl border-4 text-4xl font-black transition active:scale-95 ${
                on
                  ? "border-indigo-600 bg-indigo-600 text-white shadow-lg"
                  : "border-slate-300 bg-white text-slate-500 hover:border-indigo-400"
              }`}
            >
              {OMR_CIRCLED[idx] ?? idx + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OXButtons({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-6">
      {(["O", "X"] as const).map((opt) => {
        const on = value === opt;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`flex h-28 flex-1 items-center justify-center rounded-3xl border-4 text-5xl font-black transition active:scale-95 ${
              opt === "O"
                ? on
                  ? "border-sky-500 bg-sky-100 text-sky-600"
                  : "border-slate-200 bg-white text-slate-400 hover:border-sky-300"
                : on
                  ? "border-rose-500 bg-rose-100 text-rose-600"
                  : "border-slate-200 bg-white text-slate-400 hover:border-rose-300"
            }`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

