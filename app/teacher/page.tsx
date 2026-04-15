"use client";

import { useMemo, useState } from "react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import {
  mockStudents,
  mockTest,
  mockPreviousTest,
  mockQuestions,
  mockResults,
  mockPreviousResults,
  type MockQuestion,
  type MockResult,
  type MockStudent,
  type MockTest,
} from "@/lib/mockData";

type Row = {
  result: MockResult;
  student: MockStudent;
  previousScore: number | undefined;
  delta: number | undefined;
};

export default function TeacherDashboardPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedFeedbacks, setGeneratedFeedbacks] = useState<
    Record<string, string>
  >({});

  const teacherId = useTeacherId();
  const teacherScope = teacherId ?? "";

  const scopedQuery = db.useQuery({
    students: { $: { where: { teacher_id: teacherScope } } },
    tests: { $: { where: { teacher_id: teacherScope } } },
  });

  const remoteStudents = (scopedQuery.data?.students ?? []) as MockStudent[];
  const remoteTests = (scopedQuery.data?.tests ?? []) as MockTest[];
  const studentIds = remoteStudents.map((s) => s.id);
  const testIds = remoteTests.map((t) => t.id);

  const linkedQuery = db.useQuery({
    results: {
      $: {
        where: {
          student_id: { $in: studentIds.length > 0 ? studentIds : ["__none__"] },
        },
      },
    },
    questions: {
      $: {
        where: {
          test_id: { $in: testIds.length > 0 ? testIds : ["__none__"] },
        },
      },
    },
  });

  const remoteResults = (linkedQuery.data?.results ?? []) as MockResult[];
  const remoteQuestions = (linkedQuery.data?.questions ?? []) as MockQuestion[];

  const hasRemote = remoteStudents.length > 0 || remoteTests.length > 0;
  const students = hasRemote ? remoteStudents : mockStudents;
  const tests = hasRemote ? remoteTests : [mockPreviousTest, mockTest];
  const rawResults = hasRemote
    ? remoteResults
    : [...mockResults, ...mockPreviousResults];
  const questions = hasRemote ? remoteQuestions : mockQuestions;

  const results: MockResult[] = rawResults.map((r) =>
    generatedFeedbacks[r.id] && !r.aiFeedback
      ? { ...r, aiFeedback: generatedFeedbacks[r.id] }
      : r
  );

  const currentTest = useMemo(
    () => [...tests].sort((a, b) => b.createdAt - a.createdAt)[0],
    [tests]
  );

  const rows: Row[] = useMemo(() => {
    if (!currentTest) return [];
    return students
      .map((student) => {
        const studentResults = results
          .filter((r) => r.student_id === student.id)
          .sort((a, b) => b.submittedAt - a.submittedAt);
        const current = studentResults.find(
          (r) => r.test_id === currentTest.id
        );
        if (!current) return null;
        const previous = studentResults.find(
          (r) => r.id !== current.id && r.submittedAt < current.submittedAt
        );
        return {
          result: current,
          student,
          previousScore: previous?.score,
          delta: previous ? current.score - previous.score : undefined,
        };
      })
      .filter((r): r is Row => r !== null)
      .sort((a, b) => a.student.studentNumber - b.student.studentNumber);
  }, [students, results, currentTest]);

  const selected = rows.find((r) => r.result.id === selectedId) ?? null;
  const currentQuestions = questions.filter(
    (q) => q.test_id === currentTest?.id
  );
  const missingFeedbackCount = rows.filter((r) => !r.result.aiFeedback).length;
  const avgScore =
    rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.result.score, 0) / rows.length)
      : 0;

  const handleGenerateAll = async () => {
    const targetIds = rows
      .filter((r) => !r.result.aiFeedback)
      .map((r) => r.result.id);
    if (targetIds.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/feedback/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultIds: targetIds }),
      });
      const json: { feedbacks: Array<{ id: string; aiFeedback: string }> } =
        await res.json();
      // TODO: 실제 연동 시 db.transact 로 results.aiFeedback 를 서버에도 기록.
      const patch: Record<string, string> = {};
      for (const f of json.feedbacks) patch[f.id] = f.aiFeedback;
      setGeneratedFeedbacks((prev) => ({ ...prev, ...patch }));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">교사 대시보드</h1>
            {currentTest && (
              <p className="mt-1 text-slate-600">
                {currentTest.subject} · {currentTest.title}
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleGenerateAll}
              disabled={generating || missingFeedbackCount === 0}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-sky-700"
            >
              {generating
                ? "생성 중..."
                : missingFeedbackCount > 0
                  ? `전체 피드백 생성 (${missingFeedbackCount})`
                  : "피드백 모두 생성됨"}
            </button>
          </div>
        </header>

        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard label="제출 인원" value={`${rows.length} 명`} />
          <StatCard label="평균 점수" value={rows.length ? `${avgScore} 점` : "-"} />
          <StatCard label="피드백 대기" value={`${missingFeedbackCount} 명`} />
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    번호
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    이름
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    점수
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    변화
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    제출 시각
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    피드백
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((row) => {
                  const isSelected = row.result.id === selectedId;
                  return (
                    <tr
                      key={row.result.id}
                      onClick={() => setSelectedId(row.result.id)}
                      className={`cursor-pointer transition ${
                        isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <td className="px-4 py-4 text-slate-500">
                        {row.student.studentNumber}
                      </td>
                      <td className="px-4 py-4 font-medium text-slate-900">
                        {row.student.name}
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${scoreBadgeClass(
                            row.result.score
                          )}`}
                        >
                          {row.result.score} 점
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <TrendIndicator delta={row.delta} />
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        {formatDate(row.result.submittedAt)}
                      </td>
                      <td className="px-4 py-4">
                        {row.result.aiFeedback ? (
                          <span className="text-xs font-medium text-emerald-700">
                            생성됨
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-amber-700">
                            대기 중
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-sm text-slate-500"
                    >
                      아직 제출된 답안이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <aside className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {selected ? (
              <DetailPanel
                row={selected}
                questions={currentQuestions}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <p className="text-sm text-slate-500">
                왼쪽 표에서 학생을 클릭하면 상세 결과와 AI 피드백을 여기서 볼 수 있어요.
              </p>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function TrendIndicator({ delta }: { delta?: number }) {
  if (delta === undefined) {
    return <span className="text-xs text-slate-400">첫 응시</span>;
  }
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        ▲ {delta}점
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
        ▼ {Math.abs(delta)}점
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
      ─ 유지
    </span>
  );
}

function DetailPanel({
  row,
  questions,
  onClose,
}: {
  row: Row;
  questions: MockQuestion[];
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            {row.student.name}
          </h2>
          <p className="text-sm text-slate-500">
            출석번호 {row.student.studentNumber}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          닫기
        </button>
      </div>

      <div className="mb-4 rounded-lg bg-slate-50 p-4">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold text-slate-900">
            {row.result.score}점
          </span>
          <TrendIndicator delta={row.delta} />
        </div>
        {row.previousScore !== undefined && (
          <p className="mt-1 text-xs text-slate-500">
            이전 시험 {row.previousScore}점 → 이번 시험 {row.result.score}점
          </p>
        )}
      </div>

      <section className="mb-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">AI 피드백</h3>
        <div className="rounded-lg border border-sky-100 bg-sky-50 p-4 text-sm leading-relaxed text-slate-800">
          {row.result.aiFeedback ?? (
            <span className="text-slate-500">
              아직 생성되지 않았어요. 상단의 [전체 피드백 생성] 버튼을 눌러 주세요.
            </span>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">제출 답안</h3>
        <ul className="space-y-3">
          {questions.map((q, idx) => (
            <li
              key={q.id}
              className="rounded-lg border border-slate-200 p-3 text-sm"
            >
              <p className="font-medium text-slate-700">
                {idx + 1}. {q.questionText}
              </p>
              <p className="mt-1 text-slate-600">
                답: {row.result.submittedAnswers[q.id] ?? "(미응답)"}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function scoreBadgeClass(score: number) {
  if (score >= 90) return "bg-emerald-100 text-emerald-800";
  if (score >= 70) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}

function formatDate(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
