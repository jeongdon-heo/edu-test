"use client";

import Link from "next/link";
import { db } from "@/lib/db";

export default function TestListPage() {
  const { isLoading, error, data } = db.useQuery({ tests: {} });

  const tests = [...(data?.tests ?? [])].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
  );

  return (
    <main className="min-h-screen bg-sky-50 px-6 py-10">
      <div className="mx-auto max-w-2xl">
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

        {!isLoading && !error && tests.length === 0 && (
          <div className="rounded-3xl bg-white p-10 text-center shadow">
            <p className="text-xl text-slate-600">아직 등록된 시험이 없어요.</p>
            <p className="mt-2 text-sm text-slate-400">
              선생님이 시험지를 올릴 때까지 조금만 기다려 주세요.
            </p>
          </div>
        )}

        <ul className="space-y-4">
          {tests.map((test) => (
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
      </div>
    </main>
  );
}
