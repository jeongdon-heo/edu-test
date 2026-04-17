"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import {
  gradeSubmission,
  buildAIGradeItems,
  buildEssayGradeItems,
  type AnswerValue,
  type RubricGrade,
  type QuestionResult,
} from "@/lib/scoring";

type PageProps = {
  params: Promise<{ testId: string }>;
};

type SubmitResult = {
  score: number;
  correct: number;
  gradable: number;
  essayCount: number;
  overwritten: boolean;
  questionResults: QuestionResult[];
};

function formatDate(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TakeTestPage({ params }: PageProps) {
  const { testId } = use(params);

  const [studentId, setStudentId] = useState("");
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const testScopedQuery = db.useQuery({
    tests: { $: { where: { id: testId } } },
    questions: { $: { where: { test_id: testId } } },
    results: { $: { where: { test_id: testId } } },
  });

  const test = testScopedQuery.data?.tests?.[0];
  const testTeacherId = test?.teacher_id ?? "";

  const studentsQuery = db.useQuery({
    students: { $: { where: { teacher_id: testTeacherId } } },
  });

  const isLoading = testScopedQuery.isLoading || studentsQuery.isLoading;
  const error = testScopedQuery.error ?? studentsQuery.error;

  const questions = useMemo(
    () =>
      [...(testScopedQuery.data?.questions ?? [])].sort(
        (a, b) => (a.questionNumber ?? 0) - (b.questionNumber ?? 0)
      ),
    [testScopedQuery.data]
  );
  const students = useMemo(
    () =>
      [...(studentsQuery.data?.students ?? [])].sort(
        (a, b) => (a.studentNumber ?? 0) - (b.studentNumber ?? 0)
      ),
    [studentsQuery.data]
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

  const handleSubmit = async () => {
    if (submitting || result) return;
    if (!studentId) {
      alert("먼저 본인을 골라주세요!");
      return;
    }

    setSubmitting(true);

    try {
      // 1) Build grading items
      const aiItems = buildAIGradeItems(questions, answers);
      const essayItems = buildEssayGradeItems(questions, answers);

      // 2) Call AI grading API
      let aiResults = new Map<string, boolean>();
      let essayResults = new Map<string, RubricGrade>();

      if (aiItems.length > 0 || essayItems.length > 0) {
        try {
          const apiKey =
            typeof window !== "undefined"
              ? localStorage.getItem("ai_api_key") ?? ""
              : "";
          const res = await fetch("/api/grade", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { "x-ai-api-key": apiKey } : {}),
            },
            body: JSON.stringify({ items: aiItems, essayItems }),
          });
          if (res.ok) {
            const json = await res.json();
            for (const r of json.results ?? []) {
              if (typeof r.id === "string" && typeof r.correct === "boolean") {
                aiResults.set(r.id, r.correct);
              }
            }
            for (const r of json.essayResults ?? []) {
              if (typeof r.id === "string" && typeof r.score === "number") {
                essayResults.set(r.id, {
                  score: r.score,
                  feedback: r.feedback ?? "",
                });
              }
            }
          }
        } catch {
          aiResults = new Map();
          essayResults = new Map();
        }
      }

      // 3) Grade with AI + rubric results
      const grade = gradeSubmission(questions, answers, aiResults, essayResults);

      // 4) Save to DB
      const resultId = existingResult?.id ?? id();
      await db.transact(
        db.tx.results[resultId].update({
          student_id: studentId,
          test_id: testId,
          score: grade.score,
          submittedAnswers: answers,
          gradedResults: grade.gradedResults,
          submittedAt: Date.now(),
        })
      );
      setResult({
        score: grade.score,
        correct: grade.correct,
        gradable: grade.gradable,
        essayCount: grade.essayCount,
        overwritten: !!existingResult,
        questionResults: grade.questionResults,
      });
    } catch (err) {
      console.error("[submit] failed", err);
      alert("제출에 실패했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
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
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 text-center">
          <p className="text-sm font-semibold text-sky-700">{test.subject}</p>
          <h1 className="mt-1 text-3xl font-bold text-sky-900">{test.title}</h1>
        </header>

        <div className="mb-6 rounded-3xl bg-white p-6 shadow">
          <label className="block">
            <span className="text-base font-semibold text-slate-700">내 이름</span>
            {students.length === 0 ? (
              <p className="mt-3 rounded-xl bg-slate-100 px-4 py-3 text-slate-500">
                학생 명단이 등록되어 있지 않아요. 선생님께 말씀해 주세요.
              </p>
            ) : (
              <select
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="mt-3 w-full rounded-2xl border-4 border-slate-200 bg-white px-5 py-4 text-2xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
              >
                <option value="">-- 본인을 골라주세요 --</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.studentNumber}번 - {s.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

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

        <ol className="space-y-5">
          {questions.map((q) => {
            const blankCount = (q.blankCount as number | undefined) ?? null;
            const subItems = (q.subItems as string[] | undefined) ?? null;
            const requiresProcess = (q.requiresProcess as boolean | undefined) ?? false;
            const unit = (q.unit as string | undefined) ?? null;
            const showCircleKb = needsCircleKeyboard(q);

            return (
              <li key={q.id} className="rounded-3xl bg-white p-6 shadow-lg">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-sky-600 text-xl font-bold text-white">
                    {q.questionNumber}
                  </span>
                  <TypeLabel type={q.type} requiresProcess={requiresProcess} />
                </div>

                {q.materialImage && (
                  <div className="mb-5 overflow-hidden rounded-2xl border-4 border-slate-200 bg-slate-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={q.materialImage}
                      alt={`${q.questionNumber}번 지문/자료`}
                      className="block w-full"
                    />
                  </div>
                )}

                <p className="mb-5 text-2xl font-semibold leading-relaxed text-slate-800">
                  {q.questionText}
                </p>

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
                    options={Array.isArray(q.options) ? (q.options as string[]) : []}
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(v) => setAnswer(q.id, v)}
                  />
                )}

                {/* ── 복수 선택 ── */}
                {q.type === "multi_select" && (
                  <MultiSelectButtons
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
                  <textarea
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                    placeholder="생각을 자유롭게 적어보세요"
                    rows={5}
                    className="w-full resize-none rounded-2xl border-4 border-slate-200 px-6 py-5 text-xl leading-relaxed text-slate-900 focus:border-sky-500 focus:outline-none"
                  />
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
            ? "채점 중... 잠시만 기다려 주세요"
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

function needsCircleKeyboard(q: { questionText: string; answer: string; options?: unknown }): boolean {
  const text = q.questionText + (q.answer ?? "");
  return CIRCLE_CHARS.some((c) => text.includes(c));
}

/* ── Sub-components ── */

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
  return (
    <div>
      <p className="mb-3 rounded-lg bg-sky-50 px-4 py-2.5 text-sm font-bold text-sky-700">
        ※ 위에서 아래로, 왼쪽에서 오른쪽 순서대로 빈칸을 채워주세요.
      </p>
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
  return (
    <div className="space-y-4">
      {subItems.map((label, i) => (
        <div key={i}>
          <p className="mb-2 text-lg font-semibold text-slate-700">{label}</p>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={value[i] ?? ""}
              onChange={(e) => onChange(i, e.target.value)}
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

function ChoiceButtons({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {options.map((opt, idx) => {
        const selected = value === opt;
        return (
          <button
            key={`${opt}-${idx}`}
            onClick={() => onChange(opt)}
            className={`flex items-center gap-4 rounded-2xl border-4 px-5 py-5 text-left text-2xl font-medium transition active:scale-[0.98] ${
              selected
                ? "border-sky-500 bg-sky-100 text-sky-900"
                : "border-slate-200 bg-white text-slate-700 hover:border-sky-300"
            }`}
          >
            <span
              className={`flex h-14 w-14 flex-none items-center justify-center rounded-full text-2xl font-bold ${
                selected
                  ? "bg-sky-600 text-white"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {idx + 1}
            </span>
            <span className="flex-1">{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

function MultiSelectButtons({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const toggle = (opt: string) => {
    const next = new Set(selected);
    next.has(opt) ? next.delete(opt) : next.add(opt);
    onChange(Array.from(next).join(","));
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-medium text-indigo-700">
        여러 개를 선택할 수 있어요
      </p>
      {options.map((opt, idx) => {
        const on = selected.has(opt);
        return (
          <button
            key={`${opt}-${idx}`}
            onClick={() => toggle(opt)}
            className={`flex items-center gap-4 rounded-2xl border-4 px-5 py-5 text-left text-2xl font-medium transition active:scale-[0.98] ${
              on
                ? "border-indigo-500 bg-indigo-100 text-indigo-900"
                : "border-slate-200 bg-white text-slate-700 hover:border-indigo-300"
            }`}
          >
            <span
              className={`flex h-14 w-14 flex-none items-center justify-center rounded-lg text-2xl font-bold ${
                on
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {on ? "V" : idx + 1}
            </span>
            <span className="flex-1">{opt}</span>
          </button>
        );
      })}
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

function ResultView({ result }: { result: SubmitResult }) {
  const scoreColor =
    result.score >= 90
      ? "text-emerald-600"
      : result.score >= 70
        ? "text-sky-600"
        : "text-amber-600";

  return (
    <main className="min-h-screen bg-sky-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* Score hero */}
        <div className="rounded-3xl bg-white p-10 text-center shadow-xl">
          <p className="text-lg font-medium text-slate-500">
            {result.overwritten ? "다시 제출했어요!" : "수고했어요!"}
          </p>
          <p className={`mt-5 text-7xl font-bold ${scoreColor}`}>
            {result.score}점
          </p>
          <p className="mt-4 text-lg text-slate-700">
            채점 {result.gradable}문제 중{" "}
            <span className="font-bold text-emerald-600">{result.correct}</span>
            개 정답
          </p>
          {result.essayCount > 0 && (
            <p className="mt-2 text-sm text-slate-500">
              서술형 {result.essayCount}문제는 선생님이 따로 채점해요.
            </p>
          )}
        </div>

        {/* Per-question results */}
        <h2 className="mb-4 mt-8 text-xl font-bold text-slate-800">
          문항별 결과
        </h2>
        <ol className="space-y-3">
          {result.questionResults.map((qr) => {
            const hasPartial =
              qr.partialScore !== undefined &&
              qr.partialScore > 0 &&
              !qr.isCorrect;
            const borderCls =
              qr.isCorrect === null
                ? "border-slate-200 bg-slate-50"
                : qr.isCorrect
                  ? "border-emerald-200 bg-emerald-50"
                  : hasPartial
                    ? "border-amber-200 bg-amber-50"
                    : "border-rose-200 bg-rose-50";
            const badgeCls =
              qr.isCorrect === null
                ? "bg-slate-400"
                : qr.isCorrect
                  ? "bg-emerald-500"
                  : hasPartial
                    ? "bg-amber-500"
                    : "bg-rose-500";
            return (
              <li
                key={qr.questionId}
                className={`rounded-2xl border-4 p-5 ${borderCls}`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex h-10 w-10 flex-none items-center justify-center rounded-full text-lg font-bold text-white ${badgeCls}`}
                  >
                    {qr.isCorrect === null
                      ? qr.questionNumber
                      : qr.isCorrect
                        ? "O"
                        : hasPartial
                          ? "△"
                          : "X"}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-lg font-semibold text-slate-800">
                        {qr.questionNumber}번. {qr.questionText}
                      </p>
                      {hasPartial && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          부분 정답 ({Math.round(qr.partialScore! * 100)}%)
                        </span>
                      )}
                    </div>
                    <div className="mt-2 space-y-1 text-base">
                      <p className="text-slate-600">
                        <span className="font-medium">내 답:</span>{" "}
                        {qr.studentAnswer || "(미응답)"}
                      </p>
                      {qr.rubricScore !== undefined && (
                        <div className="mt-1 rounded-lg bg-violet-50 p-2.5">
                          <p className="text-sm font-semibold text-violet-700">
                            AI 채점: {qr.rubricScore}점
                          </p>
                          {qr.rubricFeedback && (
                            <p className="mt-0.5 text-sm text-violet-600">
                              {qr.rubricFeedback}
                            </p>
                          )}
                        </div>
                      )}
                      {qr.isCorrect === false && !qr.rubricScore && (
                        <p className="font-medium text-emerald-700">
                          정답: {qr.correctAnswer}
                        </p>
                      )}
                      {qr.isCorrect === null && (
                        <p className="text-sm text-slate-500">
                          서술형 - 선생님이 채점해요
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 text-center">
          <Link
            href="/test"
            className="inline-block rounded-2xl bg-slate-900 px-8 py-4 text-xl font-semibold text-white shadow"
          >
            시험 목록으로
          </Link>
        </div>
      </div>
    </main>
  );
}
