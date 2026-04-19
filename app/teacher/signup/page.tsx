"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { id as instantId } from "@instantdb/react";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { setTeacherSession } from "@/lib/teacherAuth";

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,20}$/;

export default function TeacherSignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const n = name.trim();
    const u = username.trim();
    if (!n) return setError("이름을 입력해 주세요.");
    if (!USERNAME_REGEX.test(u)) {
      return setError(
        "아이디는 영문/숫자/._- 조합 3~20자여야 합니다."
      );
    }
    if (password.length < 8) {
      return setError("비밀번호는 8자 이상이어야 합니다.");
    }
    if (password !== confirm) {
      return setError("비밀번호 확인이 일치하지 않습니다.");
    }

    setSubmitting(true);
    try {
      const existing = await db.queryOnce({
        teachers: { $: { where: { username: u } } },
      });
      if ((existing.data.teachers ?? []).length > 0) {
        setError("이미 사용 중인 아이디입니다.");
        return;
      }

      const { hash, salt } = await hashPassword(password);
      const newId = instantId();
      await db.transact(
        db.tx.teachers[newId].update({
          username: u,
          passwordHash: hash,
          salt,
          name: n,
          createdAt: Date.now(),
        })
      );

      setTeacherSession({ teacherId: newId, username: u, name: n });
      router.replace("/teacher");
    } catch (err) {
      console.error("[teacher signup]", err);
      setError("계정 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-slate-900">교사 계정 만들기</h1>
          <p className="mt-1 text-sm text-slate-500">
            이 계정으로 시험과 학생 명단을 관리합니다.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              이름
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              placeholder="예: 김선생"
            />
          </div>
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
              placeholder="영문/숫자 3~20자"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              비밀번호
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              placeholder="8자 이상"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              비밀번호 확인
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {submitting ? "계정 생성 중..." : "계정 만들기"}
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
            href="/teacher/login"
            className="rounded px-2 py-1 font-medium text-sky-600 hover:bg-sky-50"
          >
            이미 계정이 있으신가요?
          </Link>
        </div>
      </div>
    </main>
  );
}
