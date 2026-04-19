"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import {
  clearLoggedInStudent,
  useLoggedInStudent,
} from "@/lib/studentLogin";

type TestRow = {
  id: string;
  title?: string;
  subject?: string;
  createdAt?: number;
  teacher_id?: string;
};

type SubmissionRow = {
  test_id?: string;
  student_id?: string;
  status?: string;
};

type ResultRow = {
  test_id?: string;
  student_id?: string;
};

export default function TestListPage() {
  const router = useRouter();
  const loggedIn = useLoggedInStudent();
  const [completedOpen, setCompletedOpen] = useState(false);

  // Mirror the teacher dashboard's scoping: only show tests belonging to the
  // classroom the student picked from the home page.
  const teacherScope = loggedIn?.teacherId ?? "";
  const studentId = loggedIn?.id ?? "";

  const { isLoading, error, data } = db.useQuery({
    tests: {
      $: { where: { teacher_id: teacherScope || "__none__" } },
    },
    submissions: {
      $: { where: { student_id: studentId || "__none__" } },
    },
    results: {
      $: { where: { student_id: studentId || "__none__" } },
    },
  });

  useEffect(() => {
    if (loggedIn === null) router.replace("/");
  }, [loggedIn, router]);

  useEffect(() => {
    // Legacy sessions without teacherId can't resolve a classroom — bounce
    // back to the picker so the student re-selects.
    if (loggedIn && !loggedIn.teacherId) {
      clearLoggedInStudent();
      router.replace("/");
    }
  }, [loggedIn, router]);

  const handleWrongPerson = () => {
    clearLoggedInStudent();
    router.replace("/");
  };

  const { pendingTests, completedTests } = useMemo(() => {
    const tests = (data?.tests ?? []) as TestRow[];
    const subs = (data?.submissions ?? []) as SubmissionRow[];
    const results = (data?.results ?? []) as ResultRow[];

    const submittedTestIds = new Set<string>();
    for (const r of results) {
      if (r.test_id) submittedTestIds.add(r.test_id);
    }
    for (const s of subs) {
      if (s.test_id && s.status === "submitted") submittedTestIds.add(s.test_id);
    }

    const valid = tests.filter(
      (t): t is TestRow & { title: string; subject: string } =>
        t.teacher_id === teacherScope &&
        typeof t.title === "string" &&
        typeof t.subject === "string"
    );
    const sorted = [...valid].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );

    return {
      pendingTests: sorted.filter((t) => !submittedTestIds.has(t.id)),
      completedTests: sorted.filter((t) => submittedTestIds.has(t.id)),
    };
  }, [data, teacherScope]);

  const totalCount = pendingTests.length + completedTests.length;

  return (
    <main className="min-h-screen bg-sky-50 px-6 py-10">
      <div className="mx-auto max-w-2xl">
        {loggedIn && (
          <section className="mb-8 rounded-3xl border-4 border-sky-200 bg-white p-6 shadow-lg">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-center sm:text-left">
                <p className="text-sm font-semibold uppercase tracking-wide text-sky-600">
                  환영합니다
                </p>
                <p className="mt-2 text-3xl font-extrabold text-sky-900 sm:text-4xl">
                  {loggedIn.studentNumber}번 {loggedIn.name} 학생,
                  <br className="sm:hidden" /> 환영합니다!
                </p>
              </div>
              <button
                type="button"
                onClick={handleWrongPerson}
                className="flex-none rounded-2xl border-4 border-rose-400 bg-rose-50 px-6 py-4 text-xl font-extrabold text-rose-700 shadow-md transition active:scale-95 hover:bg-rose-100 hover:shadow-lg"
              >
                앗! 내가 아니에요
              </button>
            </div>
          </section>
        )}

        <header className="mb-10 text-center">
          <h1 className="text-4xl font-bold text-sky-900">시험을 골라주세요</h1>
          <p className="mt-3 text-lg text-sky-700">
            풀고 싶은 시험을 눌러볼까요?
          </p>
        </header>

        {isLoading && (
          <p className="text-center text-lg text-slate-500">불러오는 중이에요...</p>
        )}

        {error && (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center text-rose-700">
            시험 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
          </p>
        )}

        {!isLoading && !error && totalCount === 0 && (
          <div className="rounded-3xl bg-white p-10 text-center shadow">
            <p className="text-xl text-slate-600">아직 등록된 시험이 없어요.</p>
            <p className="mt-2 text-sm text-slate-400">
              선생님이 시험지를 올릴 때까지 조금만 기다려 주세요.
            </p>
          </div>
        )}

        {!isLoading && !error && totalCount > 0 && (
          <>
            <section className="mb-10">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-extrabold text-sky-900">
                  📝 지금 풀어야 할 시험
                </h2>
                <span className="rounded-full bg-sky-600 px-3 py-1 text-sm font-bold text-white">
                  {pendingTests.length}개
                </span>
              </div>
              {pendingTests.length === 0 ? (
                <div className="rounded-3xl border-4 border-dashed border-sky-200 bg-white p-8 text-center">
                  <p className="text-lg font-bold text-sky-800">
                    모든 시험을 풀었어요! 🎉
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    아래에서 결과를 다시 확인할 수 있어요.
                  </p>
                </div>
              ) : (
                <ul className="space-y-4">
                  {pendingTests.map((test) => (
                    <li key={test.id}>
                      <Link
                        href={`/test/${test.id}`}
                        className="flex items-center justify-between gap-4 rounded-3xl bg-white p-6 shadow-lg transition hover:bg-sky-50 active:scale-[0.99]"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-sky-600">
                            {test.subject}
                          </p>
                          <p className="mt-1 truncate text-2xl font-bold text-slate-900">
                            {test.title}
                          </p>
                        </div>
                        <span className="flex flex-none items-center gap-2 rounded-full bg-sky-600 px-5 py-3 text-lg font-bold text-white shadow">
                          문제 풀러가기 🚀
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {completedTests.length > 0 && (
              <section className="opacity-80">
                <button
                  type="button"
                  onClick={() => setCompletedOpen((v) => !v)}
                  className="mb-4 flex w-full items-center justify-between rounded-2xl border-2 border-slate-200 bg-white px-5 py-4 text-left shadow-sm transition hover:bg-slate-50"
                  aria-expanded={completedOpen}
                >
                  <span className="flex items-center gap-2 text-xl font-bold text-slate-700">
                    ✅ 완료한 시험
                    <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-sm font-bold text-slate-700">
                      {completedTests.length}
                    </span>
                  </span>
                  <span
                    className={`text-slate-400 transition-transform ${
                      completedOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden
                  >
                    ▼
                  </span>
                </button>

                {completedOpen && (
                  <ul className="space-y-3">
                    {completedTests.map((test) => (
                      <li key={test.id}>
                        <Link
                          href={`/test/${test.id}/result`}
                          className="flex items-center justify-between gap-4 rounded-3xl bg-white p-5 shadow-md transition hover:bg-emerald-50 active:scale-[0.99]"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
                              제출 완료
                            </p>
                            <p className="mt-1 truncate text-xl font-bold text-slate-800">
                              {test.title}
                            </p>
                            <p className="mt-0.5 text-sm text-slate-500">
                              {test.subject}
                            </p>
                          </div>
                          <span className="flex flex-none items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow">
                            📊 내 결과(오답) 다시 보기
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
