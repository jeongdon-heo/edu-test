"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { setTeacherSession } from "@/lib/teacherAuth";

type TeacherRecord = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  name: string;
};

export default function TeacherLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const u = username.trim();
    if (!u || !password) {
      setError("아이디와 비밀번호를 모두 입력해 주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const query = await db.queryOnce({
        teachers: { $: { where: { username: u } } },
      });
      const match = (query.data.teachers ?? [])[0] as
        | TeacherRecord
        | undefined;
      if (!match) {
        setError("아이디 또는 비밀번호가 올바르지 않습니다.");
        return;
      }
      const ok = await verifyPassword(password, match.passwordHash, match.salt);
      if (!ok) {
        setError("아이디 또는 비밀번호가 올바르지 않습니다.");
        return;
      }
      setTeacherSession({
        teacherId: match.id,
        username: match.username,
        name: match.name,
      });
      router.replace("/teacher");
    } catch (err) {
      console.error("[teacher login]", err);
      setError("로그인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-slate-900">선생님용 로그인</h1>
          <p className="mt-1 text-sm text-slate-500">
            교사 계정으로 로그인해 주세요.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              아이디
            </label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              placeholder="예: teacher01"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              비밀번호
            </label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "로그인 중..." : "로그인"}
          </button>
        </form>

        <div className="mt-5 flex items-center justify-between text-xs text-slate-500">
          <Link
            href="/"
            className="rounded px-2 py-1 hover:bg-slate-100 hover:text-slate-700"
          >
            ← 학생 화면으로
          </Link>
          <Link
            href="/teacher/signup"
            className="rounded px-2 py-1 font-medium text-sky-600 hover:bg-sky-50"
          >
            계정 만들기
          </Link>
        </div>
      </div>
    </main>
  );
}
