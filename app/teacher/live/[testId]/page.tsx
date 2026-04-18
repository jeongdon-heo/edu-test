"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { demoClassStudents } from "@/lib/mockData";

type PageProps = {
  params: Promise<{ testId: string }>;
};

type RosterEntry = {
  id: string;
  name: string;
  studentNumber: number;
};

type Status = "submitted" | "active" | "idle" | "offline";

type LiveRow = {
  student: RosterEntry;
  currentQuestionIndex: number;
  totalQuestions: number;
  status: Status;
  lastActiveAt: number | null;
};

const ACTIVE_THRESHOLD_MS = 45_000; // 45s since last touch = still active

function minutesAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "방금 전";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}시간 전`;
}

export default function LiveMonitorPage({ params }: PageProps) {
  const { testId } = use(params);

  // Re-evaluate "active vs idle" every 15s even when no DB events arrive.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(handle);
  }, []);

  const scopedQuery = db.useQuery({
    tests: { $: { where: { id: testId } } },
    submissions: { $: { where: { test_id: testId } } },
    results: { $: { where: { test_id: testId } } },
    questions: { $: { where: { test_id: testId } } },
  });

  const test = scopedQuery.data?.tests?.[0];
  const teacherId = test?.teacher_id ?? "";

  const studentsQuery = db.useQuery({
    students: { $: { where: { teacher_id: teacherId } } },
  });

  const roster = useMemo<RosterEntry[]>(() => {
    const submissions = scopedQuery.data?.submissions ?? [];
    const results = scopedQuery.data?.results ?? [];
    const real = (studentsQuery.data?.students ?? [])
      .filter(
        (s): s is typeof s & { name: string; studentNumber: number } =>
          typeof s.name === "string" && typeof s.studentNumber === "number"
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        studentNumber: s.studentNumber,
      }));

    const byId = new Map<string, RosterEntry>(real.map((s) => [s.id, s]));

    const addFrom = (id: string, name: string | undefined | null) => {
      if (!id || byId.has(id)) return;
      const numMatch = id.match(/(\d+)$/);
      const n = numMatch ? parseInt(numMatch[1], 10) : NaN;
      byId.set(id, {
        id,
        name: name || "이름 미확인",
        studentNumber: Number.isFinite(n) ? n : 999,
      });
    };
    for (const s of submissions) addFrom(s.student_id, s.student_name);
    for (const r of results) addFrom(r.student_id, r.student_name);

    // If nothing at all — neither real students nor activity — fall back to
    // the 20 demo placeholders so the teacher can see the layout.
    if (byId.size === 0) {
      for (const s of demoClassStudents) {
        byId.set(s.id, {
          id: s.id,
          name: s.name,
          studentNumber: s.studentNumber,
        });
      }
    }

    return Array.from(byId.values()).sort(
      (a, b) => (a.studentNumber ?? 0) - (b.studentNumber ?? 0)
    );
  }, [scopedQuery.data, studentsQuery.data]);

  const totalQuestions = scopedQuery.data?.questions?.length ?? 0;

  const rows = useMemo<LiveRow[]>(() => {
    const submissions = scopedQuery.data?.submissions ?? [];
    const results = scopedQuery.data?.results ?? [];
    const subByStudent = new Map(submissions.map((s) => [s.student_id, s]));
    const resByStudent = new Map(results.map((r) => [r.student_id, r]));

    return roster.map((student) => {
      const sub = subByStudent.get(student.id);
      const res = resByStudent.get(student.id);
      const isSubmitted = !!res || sub?.status === "submitted";
      const lastActiveAt = sub?.lastActiveAt ?? null;
      const total = sub?.totalQuestions ?? totalQuestions;
      const current = isSubmitted
        ? total
        : (sub?.currentQuestionIndex ?? 0);

      let status: Status;
      if (isSubmitted) status = "submitted";
      else if (!sub) status = "offline";
      else if (lastActiveAt && now - lastActiveAt < ACTIVE_THRESHOLD_MS)
        status = "active";
      else status = "idle";

      return {
        student,
        currentQuestionIndex: current,
        totalQuestions: total || 0,
        status,
        lastActiveAt,
      };
    });
  }, [roster, scopedQuery.data, totalQuestions, now]);

  const totals = useMemo(() => {
    const total = rows.length;
    const submitted = rows.filter((r) => r.status === "submitted").length;
    const online = rows.filter(
      (r) => r.status === "active" || r.status === "submitted"
    ).length;
    return { total, online, submitted };
  }, [rows]);

  if (scopedQuery.isLoading || studentsQuery.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">불러오는 중...</p>
      </main>
    );
  }

  if (scopedQuery.error || !test) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="rounded-2xl bg-white p-8 text-center shadow">
          <p className="text-lg text-slate-700">시험을 찾을 수 없어요.</p>
          <Link
            href="/teacher"
            className="mt-4 inline-block rounded-xl bg-slate-900 px-5 py-2.5 text-white"
          >
            대시보드로
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        {/* ── Header ── */}
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link
              href="/teacher"
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              ← 대시보드로
            </Link>
            <h1 className="mt-1 flex items-center gap-3 text-2xl font-extrabold text-slate-900">
              <span className="flex h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
              실시간 모니터링
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {test.subject} · {test.title} · 총 {totalQuestions}문항
            </p>
          </div>
          <Link
            href={`/teacher`}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            상세 결과 보기
          </Link>
        </header>

        {/* ── Summary ── */}
        <section className="mb-6 grid grid-cols-3 gap-3 sm:gap-4">
          <SummaryTile
            label="전체 인원"
            value={totals.total}
            suffix="명"
            accent="border-slate-300 bg-white"
          />
          <SummaryTile
            label="현재 접속자"
            value={totals.online}
            suffix="명"
            accent="border-sky-300 bg-sky-50"
            valueCls="text-sky-700"
          />
          <SummaryTile
            label="제출 완료"
            value={totals.submitted}
            suffix="명"
            accent="border-emerald-300 bg-emerald-50"
            valueCls="text-emerald-700"
          />
        </section>

        {/* ── Grid ── */}
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 md:gap-4 lg:grid-cols-5">
          {rows.map((row) => (
            <li key={row.student.id}>
              <StudentCard row={row} />
            </li>
          ))}
        </ul>

        {rows.length === 0 && (
          <p className="mt-10 text-center text-sm text-slate-500">
            아직 참여한 학생이 없어요.
          </p>
        )}
      </div>
    </main>
  );
}

function SummaryTile({
  label,
  value,
  suffix,
  accent,
  valueCls,
}: {
  label: string;
  value: number;
  suffix: string;
  accent: string;
  valueCls?: string;
}) {
  return (
    <div className={`rounded-2xl border-2 p-4 text-center shadow-sm ${accent}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className={`mt-1 text-3xl font-extrabold ${valueCls ?? "text-slate-900"}`}>
        {value}
        <span className="ml-1 text-base font-bold">{suffix}</span>
      </p>
    </div>
  );
}

function StudentCard({ row }: { row: LiveRow }) {
  const { student, currentQuestionIndex, totalQuestions, status, lastActiveAt } =
    row;
  const pct =
    totalQuestions > 0
      ? Math.min(100, Math.round((currentQuestionIndex / totalQuestions) * 100))
      : 0;

  const cardCls =
    status === "submitted"
      ? "border-emerald-500 bg-emerald-50"
      : status === "active"
        ? "border-sky-500 bg-sky-50"
        : status === "idle"
          ? "border-amber-400 bg-amber-50"
          : "border-slate-300 bg-slate-100 opacity-80";

  const barCls =
    status === "submitted"
      ? "bg-emerald-500"
      : status === "active"
        ? "bg-sky-500"
        : status === "idle"
          ? "bg-amber-400"
          : "bg-slate-400";

  const statusLabel =
    status === "submitted"
      ? "제출함"
      : status === "active"
        ? `${currentQuestionIndex + 1}번 푸는 중`
        : status === "idle"
          ? "잠시 멈춤"
          : "미접속";

  const statusBadgeCls =
    status === "submitted"
      ? "bg-emerald-600 text-white"
      : status === "active"
        ? "bg-sky-600 text-white"
        : status === "idle"
          ? "bg-amber-500 text-white"
          : "bg-slate-400 text-white";

  return (
    <div className={`rounded-2xl border-4 p-4 shadow-sm ${cardCls}`}>
      <div className="flex items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-base font-black text-slate-700 shadow-inner">
          {student.studentNumber}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${statusBadgeCls}`}
        >
          {status === "submitted" ? "✓" : status === "active" ? "●" : "○"}
          <span className="ml-1">{statusLabel}</span>
        </span>
      </div>
      <p className="mt-3 truncate text-lg font-extrabold text-slate-900">
        {student.name}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        진행률 {currentQuestionIndex}/{totalQuestions || "?"}
      </p>
      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-white/60">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barCls}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {lastActiveAt && status !== "offline" && (
        <p className="mt-2 text-[11px] text-slate-500">
          마지막 활동: {minutesAgo(lastActiveAt)}
        </p>
      )}
    </div>
  );
}
