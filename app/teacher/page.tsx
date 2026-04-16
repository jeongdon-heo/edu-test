"use client";

import { useMemo, useState } from "react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import { isCorrect } from "@/lib/scoring";
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
  const [generatedAnalyses, setGeneratedAnalyses] = useState<
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
          student_id: {
            $in: studentIds.length > 0 ? studentIds : ["__none__"],
          },
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
    generatedAnalyses[r.id] && !r.aiAnalysis
      ? { ...r, aiAnalysis: generatedAnalyses[r.id] }
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
  const currentQuestions = useMemo(
    () =>
      [...questions.filter((q) => q.test_id === currentTest?.id)].sort(
        (a, b) => a.questionNumber - b.questionNumber
      ),
    [questions, currentTest]
  );
  const missingAnalysisCount = rows.filter((r) => !r.result.aiAnalysis).length;
  const avgScore =
    rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.result.score, 0) / rows.length)
      : 0;
  const highScore =
    rows.length > 0 ? Math.max(...rows.map((r) => r.result.score)) : 0;
  const lowScore =
    rows.length > 0 ? Math.min(...rows.map((r) => r.result.score)) : 0;

  // Score distribution buckets
  const scoreDist = useMemo(() => {
    const buckets = [
      { label: "90~100", min: 90, max: 100, count: 0, color: "bg-emerald-500" },
      { label: "80~89", min: 80, max: 89, count: 0, color: "bg-sky-500" },
      { label: "70~79", min: 70, max: 79, count: 0, color: "bg-amber-500" },
      { label: "60~69", min: 60, max: 69, count: 0, color: "bg-orange-500" },
      { label: "0~59", min: 0, max: 59, count: 0, color: "bg-rose-500" },
    ];
    for (const r of rows) {
      const b = buckets.find(
        (b) => r.result.score >= b.min && r.result.score <= b.max
      );
      if (b) b.count++;
    }
    return buckets;
  }, [rows]);

  // Per-question accuracy
  const questionAccuracy = useMemo(() => {
    return currentQuestions
      .filter((q) => q.type !== "essay")
      .map((q) => {
        let correct = 0;
        let total = 0;
        for (const r of rows) {
          const sa = r.result.submittedAnswers?.[q.id];
          if (sa !== undefined) {
            total++;
            if (isCorrect(sa, q.answer ?? "")) correct++;
          }
        }
        const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
        return {
          questionNumber: q.questionNumber,
          questionText: q.questionText,
          type: q.type,
          rate,
          correct,
          total,
        };
      });
  }, [currentQuestions, rows]);

  const handleGenerateAll = async () => {
    const targets = rows.filter((r) => !r.result.aiAnalysis);
    if (targets.length === 0) return;

    const apiKey =
      typeof window !== "undefined"
        ? localStorage.getItem("ai_api_key") ?? ""
        : "";
    if (!apiKey) {
      alert(
        "Gemini API 키가 설정되지 않았습니다. [AI 설정] 페이지에서 등록해 주세요."

      );
      return;
    }

    setGenerating(true);
    try {
      const payload = targets.map((row) => {
        const qResults = currentQuestions.map((q) => {
          const studentAnswer = row.result.submittedAnswers?.[q.id] ?? "";
          return {
            questionNumber: q.questionNumber,
            questionText: q.questionText,
            type: q.type,
            correctAnswer: q.answer ?? "",
            studentAnswer,
            isCorrect:
              q.type === "essay"
                ? null
                : isCorrect(studentAnswer, q.answer ?? ""),
          };
        });
        const gradable = qResults.filter((q) => q.isCorrect !== null);
        const correctCount = gradable.filter((q) => q.isCorrect === true).length;
        return {
          resultId: row.result.id,
          studentName: row.student.name,
          score: row.result.score,
          totalQuestions: qResults.length,
          gradableQuestions: gradable.length,
          correctCount,
          questions: qResults,
        };
      });

      const res = await fetch("/api/feedback/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ai-api-key": apiKey,
        },
        body: JSON.stringify({ results: payload }),
      });
      const json = await res.json();

      if (!res.ok) {
        alert(json.error ?? "학습 분석 생성에 실패했습니다.");
        return;
      }

      const feedbacks: Array<{ resultId: string; aiAnalysis: string }> =
        json.feedbacks ?? [];

      // Save to InstantDB
      const txns = feedbacks.map((f) =>
        db.tx.results[f.resultId].update({ aiAnalysis: f.aiAnalysis })
      );
      if (txns.length > 0) await db.transact(txns);

      const patch: Record<string, string> = {};
      for (const f of feedbacks) patch[f.resultId] = f.aiAnalysis;
      setGeneratedAnalyses((prev) => ({ ...prev, ...patch }));
    } catch (err) {
      console.error("[generateAll]", err);
      alert("학습 분석 생성 중 오류가 발생했습니다.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">
              교사 대시보드
            </h1>
            {currentTest && (
              <p className="mt-1 text-slate-600">
                {currentTest.subject} &middot; {currentTest.title}
              </p>
            )}
          </div>
          <button
            onClick={handleGenerateAll}
            disabled={generating || missingAnalysisCount === 0}
            className="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {generating
              ? "AI 학습 분석 생성 중..."
              : missingAnalysisCount > 0
                ? `AI 학습 분석 (${missingAnalysisCount}명)`
                : "학습 분석 완료"}
          </button>
        </header>

        {/* Stats row */}
        <section className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard
            label="제출 인원"
            value={`${rows.length}명`}
            sub={`전체 ${students.length}명`}
            accent="bg-sky-500"
          />
          <StatCard
            label="평균 점수"
            value={rows.length > 0 ? `${avgScore}점` : "-"}
            accent="bg-violet-500"
          />
          <StatCard
            label="최고 점수"
            value={rows.length > 0 ? `${highScore}점` : "-"}
            accent="bg-emerald-500"
          />
          <StatCard
            label="최저 점수"
            value={rows.length > 0 ? `${lowScore}점` : "-"}
            accent="bg-amber-500"
          />
          <StatCard
            label="분석 대기"
            value={`${missingAnalysisCount}명`}
            accent="bg-rose-500"
          />
        </section>

        {/* Charts row */}
        {rows.length > 0 && (
          <section className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Score distribution */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="mb-4 text-sm font-semibold text-slate-700">
                점수 분포
              </h3>
              <div className="space-y-3">
                {scoreDist.map((b) => {
                  const pct =
                    rows.length > 0
                      ? Math.round((b.count / rows.length) * 100)
                      : 0;
                  return (
                    <div key={b.label} className="flex items-center gap-3">
                      <span className="w-16 text-right text-xs font-medium text-slate-500">
                        {b.label}
                      </span>
                      <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`absolute inset-y-0 left-0 rounded-full ${b.color} transition-all duration-500`}
                          style={{ width: `${pct}%` }}
                        />
                        {b.count > 0 && (
                          <span className="absolute inset-0 flex items-center px-3 text-xs font-semibold text-white mix-blend-difference">
                            {b.count}명 ({pct}%)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Per-question accuracy */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="mb-4 text-sm font-semibold text-slate-700">
                문항별 정답률
              </h3>
              {questionAccuracy.length === 0 ? (
                <p className="text-sm text-slate-500">문항 데이터가 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {questionAccuracy.map((qa) => {
                    const barColor =
                      qa.rate >= 80
                        ? "bg-emerald-500"
                        : qa.rate >= 60
                          ? "bg-sky-500"
                          : qa.rate >= 40
                            ? "bg-amber-500"
                            : "bg-rose-500";
                    return (
                      <div key={qa.questionNumber} className="flex items-center gap-3">
                        <span className="w-12 text-right text-xs font-medium text-slate-500">
                          {qa.questionNumber}번
                        </span>
                        <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`absolute inset-y-0 left-0 rounded-full ${barColor} transition-all duration-500`}
                            style={{ width: `${qa.rate}%` }}
                          />
                          <span className="absolute inset-0 flex items-center px-3 text-xs font-semibold text-white mix-blend-difference">
                            {qa.rate}% ({qa.correct}/{qa.total})
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Table + Detail */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* Student results table */}
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
                    학습 분석
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
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${scoreBadgeClass(row.result.score)}`}
                        >
                          {row.result.score}점
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <TrendIndicator delta={row.delta} />
                      </td>
                      <td className="px-4 py-4 text-slate-600">
                        {formatDate(row.result.submittedAt)}
                      </td>
                      <td className="px-4 py-4">
                        {row.result.aiAnalysis ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            생성됨
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
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
                      className="px-4 py-12 text-center text-sm text-slate-500"
                    >
                      아직 제출된 답안이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Detail panel */}
          <aside className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {selected ? (
              <DetailPanel
                row={selected}
                questions={currentQuestions}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <div className="flex h-full min-h-[200px] items-center justify-center">
                <p className="text-center text-sm text-slate-400">
                  왼쪽 표에서 학생을 클릭하면
                  <br />
                  상세 결과와 AI 학습 분석을 볼 수 있어요.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

/* ── Sub-components ── */

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
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

      {/* Score */}
      <div className="mb-5 rounded-xl bg-gradient-to-br from-sky-50 to-violet-50 p-5">
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-bold text-slate-900">
            {row.result.score}점
          </span>
          <TrendIndicator delta={row.delta} />
        </div>
        {row.previousScore !== undefined && (
          <p className="mt-1 text-xs text-slate-500">
            이전 {row.previousScore}점 → 이번 {row.result.score}점
          </p>
        )}
      </div>

      {/* AI Learning Analysis */}
      <section className="mb-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          AI 학습 분석
        </h3>
        <AnalysisCards raw={row.result.aiAnalysis} />
      </section>

      {/* Submitted answers */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          제출 답안
        </h3>
        <ul className="space-y-2">
          {questions.map((q) => {
            const sa = row.result.submittedAnswers?.[q.id] ?? "";
            const correct =
              q.type === "essay"
                ? null
                : sa
                  ? isCorrect(sa, q.answer ?? "")
                  : false;
            return (
              <li
                key={q.id}
                className={`rounded-lg border p-3 text-sm ${
                  correct === null
                    ? "border-slate-200 bg-white"
                    : correct
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-rose-200 bg-rose-50"
                }`}
              >
                <div className="flex items-start gap-2">
                  {correct !== null && (
                    <span
                      className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold text-white ${
                        correct ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                    >
                      {correct ? "O" : "X"}
                    </span>
                  )}
                  <div className="flex-1">
                    <p className="font-medium text-slate-700">
                      {q.questionNumber}. {q.questionText}
                    </p>
                    <p className="mt-1 text-slate-600">
                      답: {sa || "(미응답)"}
                    </p>
                    {correct === false && (
                      <p className="mt-0.5 text-xs font-medium text-emerald-700">
                        정답: {q.answer}
                      </p>
                    )}
                    {correct === null && (
                      <p className="mt-0.5 text-xs text-slate-400">
                        서술형 (교사 채점)
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function AnalysisCards({ raw }: { raw?: string }) {
  if (!raw) {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-500">
        아직 생성되지 않았어요. 상단의 [AI 학습 분석] 버튼을 눌러 주세요.
      </div>
    );
  }

  let analysis: { strength?: string; weakness?: string; guidance?: string };
  try {
    analysis = JSON.parse(raw);
  } catch {
    // legacy plain-text fallback
    return (
      <div className="rounded-xl border border-violet-100 bg-violet-50 p-4 text-sm leading-relaxed text-slate-800">
        {raw}
      </div>
    );
  }

  const sections: Array<{
    key: string;
    label: string;
    icon: string;
    text: string;
    border: string;
    bg: string;
    iconBg: string;
  }> = [
    {
      key: "strength",
      label: "강점 및 성취",
      icon: "▲",
      text: analysis.strength || "-",
      border: "border-emerald-200",
      bg: "bg-emerald-50",
      iconBg: "bg-emerald-500",
    },
    {
      key: "weakness",
      label: "취약점 및 오개념",
      icon: "!",
      text: analysis.weakness || "-",
      border: "border-amber-200",
      bg: "bg-amber-50",
      iconBg: "bg-amber-500",
    },
    {
      key: "guidance",
      label: "지도 방안",
      icon: "→",
      text: analysis.guidance || "-",
      border: "border-sky-200",
      bg: "bg-sky-50",
      iconBg: "bg-sky-500",
    },
  ];

  return (
    <div className="space-y-2.5">
      {sections.map((s) => (
        <div
          key={s.key}
          className={`rounded-xl border ${s.border} ${s.bg} p-3.5`}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white ${s.iconBg}`}
            >
              {s.icon}
            </span>
            <span className="text-xs font-semibold text-slate-700">
              {s.label}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-slate-700">{s.text}</p>
        </div>
      ))}
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
