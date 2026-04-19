"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function TeacherError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[teacher error boundary]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-rose-200 bg-white p-8 shadow-lg">
        <h1 className="text-xl font-bold text-rose-700">
          문제가 발생했습니다
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          이 화면을 캡처해서 개발자에게 보내 주세요.
        </p>
        <div className="mt-4 rounded-lg bg-slate-900 p-4 text-xs text-rose-200">
          <p className="font-mono font-semibold">{error.name}: {error.message}</p>
          {error.digest && (
            <p className="mt-1 text-[10px] text-slate-400">
              digest: {error.digest}
            </p>
          )}
          {error.stack && (
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">
              {error.stack}
            </pre>
          )}
        </div>
        <div className="mt-5 flex gap-2">
          <button
            onClick={reset}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
          >
            다시 시도
          </button>
          <Link
            href="/teacher/login"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            로그인으로
          </Link>
        </div>
      </div>
    </main>
  );
}
