"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import { isCorrect } from "@/lib/scoring";

type PageProps = {
  params: Promise<{ testId: string }>;
};

type SubmitResult = {
  score: number;
  correct: number;
  gradable: number;
  essayCount: number;
  overwritten: boolean;
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
  const [answers, setAnswers] = useState<Record<string, string>>({});
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
        setAnswers(prev as Record<string, string>);
        return;
      }
    }
    setAnswers({});
  }, [studentId, existingResult?.id]);

  const setAnswer = (qId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: value }));
  };

  const handleSubmit = async () => {
    if (submitting || result) return;
    if (!studentId) {
      alert("먼저 본인을 골라주세요!");
      return;
    }

    setSubmitting(true);

    let correct = 0;
    let gradable = 0;
    let essayCount = 0;
    for (const q of questions) {
      if (q.type === "essay") {
        essayCount++;
        continue;
      }
      gradable++;
      if (isCorrect(answers[q.id] ?? "", q.answer ?? "")) correct++;
    }
    const score = gradable > 0 ? Math.round((correct / gradable) * 100) : 0;

    try {
      const resultId = existingResult?.id ?? id();
      await db.transact(
        db.tx.results[resultId].update({
          student_id: studentId,
          test_id: testId,
          score,
          submittedAnswers: answers,
          submittedAt: Date.now(),
        })
      );
      setResult({
        score,
        correct,
        gradable,
        essayCount,
        overwritten: !!existingResult,
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
          {questions.map((q) => (
            <li key={q.id} className="rounded-3xl bg-white p-6 shadow-lg">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-sky-600 text-xl font-bold text-white">
                  {q.questionNumber}
                </span>
                <TypeLabel type={q.type} />
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

              {q.type === "multiple_choice" && (
                <ChoiceButtons
                  options={Array.isArray(q.options) ? (q.options as string[]) : []}
                  value={answers[q.id] ?? ""}
                  onChange={(v) => setAnswer(q.id, v)}
                />
              )}

              {q.type === "short_answer" && (
                <input
                  type="text"
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                  placeholder="답을 써보세요"
                  className="w-full rounded-2xl border-4 border-slate-200 px-6 py-5 text-3xl font-medium text-slate-900 focus:border-sky-500 focus:outline-none"
                />
              )}

              {q.type === "essay" && (
                <textarea
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                  placeholder="생각을 자유롭게 적어보세요"
                  rows={5}
                  className="w-full resize-none rounded-2xl border-4 border-slate-200 px-6 py-5 text-xl leading-relaxed text-slate-900 focus:border-sky-500 focus:outline-none"
                />
              )}
            </li>
          ))}
        </ol>

        <button
          onClick={handleSubmit}
          disabled={submitting || questions.length === 0 || !studentId}
          className="mt-8 w-full rounded-3xl bg-sky-600 px-6 py-6 text-3xl font-bold text-white shadow-lg transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "제출 중..."
            : existingResult
              ? "다시 제출하기 ✅"
              : "제출하기 ✅"}
        </button>
      </div>
    </main>
  );
}

function TypeLabel({ type }: { type: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    multiple_choice: { label: "객관식", cls: "bg-sky-100 text-sky-800" },
    short_answer: { label: "단답형", cls: "bg-emerald-100 text-emerald-800" },
    essay: { label: "서술형", cls: "bg-violet-100 text-violet-800" },
  };
  const { label, cls } = map[type] ?? {
    label: type,
    cls: "bg-slate-100 text-slate-700",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-sm font-semibold ${cls}`}>
      {label}
    </span>
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

function ResultView({ result }: { result: SubmitResult }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sky-50 px-6">
      <div className="w-full max-w-md text-center">
        <div className="rounded-3xl bg-white p-10 shadow-xl">
          <p className="text-lg font-medium text-slate-500">
            {result.overwritten ? "다시 제출했어요! ✍️" : "수고했어요! 👏"}
          </p>
          <p className="mt-5 text-7xl font-bold text-sky-600">{result.score}점</p>
          <p className="mt-4 text-lg text-slate-700">
            채점 {result.gradable}문제 중{" "}
            <span className="font-bold text-emerald-600">{result.correct}</span>개 정답
          </p>
          {result.essayCount > 0 && (
            <p className="mt-2 text-sm text-slate-500">
              서술형 {result.essayCount}문제는 선생님이 따로 채점해요.
            </p>
          )}
        </div>

        <Link
          href="/test"
          className="mt-6 inline-block rounded-2xl bg-slate-900 px-8 py-4 text-xl font-semibold text-white shadow"
        >
          시험 목록으로
        </Link>
      </div>
    </main>
  );
}
