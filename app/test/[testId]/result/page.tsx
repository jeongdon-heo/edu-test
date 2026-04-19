"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { db } from "@/lib/db";
import type { AnswerValue } from "@/lib/scoring";
import { useLoggedInStudent } from "@/lib/studentLogin";
import {
  ResultView,
  reconstructResult,
  type SubmitResult,
} from "../../_components/ResultView";

type PageProps = {
  params: Promise<{ testId: string }>;
};

type StoredResult = {
  id: string;
  student_id: string;
  score: number;
  submittedAnswers?: Record<string, AnswerValue>;
  gradedResults?: Record<string, unknown>;
};

type StoredQuestion = {
  id: string;
  questionNumber: number;
  questionText: string;
  type: string;
  answer?: string;
  requiresProcess?: boolean;
  subItems?: string[] | null;
};

export default function TestResultReviewPage({ params }: PageProps) {
  const { testId } = use(params);
  const router = useRouter();
  const loggedIn = useLoggedInStudent();
  const studentId = loggedIn?.id ?? "";

  useEffect(() => {
    if (loggedIn === null) router.replace("/");
  }, [loggedIn, router]);

  const query = db.useQuery({
    tests: { $: { where: { id: testId } } },
    questions: { $: { where: { test_id: testId } } },
    results: { $: { where: { test_id: testId } } },
  });

  const test = query.data?.tests?.[0];
  const questions = (query.data?.questions ?? []) as StoredQuestion[];
  const resultsForTest = (query.data?.results ?? []) as StoredResult[];

  const myResult = useMemo(
    () => (studentId ? resultsForTest.find((r) => r.student_id === studentId) : undefined),
    [resultsForTest, studentId]
  );

  const summary: SubmitResult | null = useMemo(() => {
    if (!myResult || questions.length === 0) return null;
    return reconstructResult({
      questions,
      submittedAnswers: myResult.submittedAnswers,
      gradedResults: myResult.gradedResults,
      score: myResult.score,
    });
  }, [myResult, questions]);

  if (loggedIn === undefined || query.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sky-50">
        <p className="text-lg text-slate-500">불러오는 중이에요...</p>
      </main>
    );
  }

  if (query.error || !test) {
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

  if (!summary) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sky-50 p-6">
        <div className="rounded-3xl bg-white p-8 text-center shadow">
          <p className="text-xl text-slate-700">아직 제출한 답안이 없어요.</p>
          <p className="mt-2 text-sm text-slate-500">
            시험을 먼저 풀고 제출하면 결과를 볼 수 있어요.
          </p>
          <Link
            href={`/test/${testId}`}
            className="mt-4 inline-block rounded-xl bg-sky-600 px-5 py-3 text-white"
          >
            문제 풀러 가기
          </Link>
        </div>
      </main>
    );
  }

  return <ResultView result={summary} />;
}
