"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";
import {
  checkAnswer,
  formatStudentAnswer,
  isRubricGrade,
  type AnswerValue,
  type RubricGrade,
} from "@/lib/scoring";
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

/* ── Types ── */

type Row = {
  result: MockResult;
  student: MockStudent;
  previousScore: number | undefined;
  delta: number | undefined;
};

type TestSummary = {
  test: MockTest;
  submittedCount: number;
  avgScore: number;
};

/* ── Main Page ── */

export default function TeacherDashboardPage() {
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [trackedStudentId, setTrackedStudentId] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<MockTest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatedAnalyses, setGeneratedAnalyses] = useState<
    Record<string, string>
  >({});

  const teacherId = useTeacherId();
  const teacherScope = teacherId ?? "";

  /* ── Data queries ── */
  const scopedQuery = db.useQuery({
    students: { $: { where: { teacher_id: teacherScope } } },
    tests: { $: { where: { teacher_id: teacherScope } } },
  });

  const remoteStudents = (scopedQuery.data?.students ?? []) as MockStudent[];
  const remoteTests = (scopedQuery.data?.tests ?? []) as MockTest[];
  const testIds = remoteTests.map((t) => t.id);

  // Fetch results by test_id (not student_id) so submissions from demo
  // students — whose student_id never appears in the `students` entity —
  // still show up during the test phase.
  const linkedQuery = db.useQuery({
    results: {
      $: {
        where: {
          test_id: { $in: testIds.length > 0 ? testIds : ["__none__"] },
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

  // Merge real students with synthesized entries for any result whose
  // student_id isn't in the registered roster (e.g. demo-* logins).
  const mergedRemoteStudents = useMemo<MockStudent[]>(() => {
    const existing = new Map(remoteStudents.map((s) => [s.id, s]));
    for (const r of remoteResults) {
      if (!r.student_id || existing.has(r.student_id)) continue;
      const numMatch = r.student_id.match(/(\d+)$/);
      const parsedNumber = numMatch ? parseInt(numMatch[1], 10) : NaN;
      existing.set(r.student_id, {
        id: r.student_id,
        name: r.student_name || "이름 미확인",
        studentNumber: Number.isFinite(parsedNumber) ? parsedNumber : 999,
        teacher_id: teacherScope,
      });
    }
    return Array.from(existing.values());
  }, [remoteStudents, remoteResults, teacherScope]);

  const students = hasRemote ? mergedRemoteStudents : mockStudents;
  const allTests = useMemo(
    () =>
      [...(hasRemote ? remoteTests : [mockPreviousTest, mockTest])].sort(
        (a, b) => b.createdAt - a.createdAt
      ),
    [hasRemote, remoteTests]
  );
  const rawResults = hasRemote
    ? remoteResults
    : [...mockResults, ...mockPreviousResults];
  const allQuestions = hasRemote ? remoteQuestions : mockQuestions;

  const allResults: MockResult[] = rawResults.map((r) =>
    generatedAnalyses[r.id] && !r.aiAnalysis
      ? { ...r, aiAnalysis: generatedAnalyses[r.id] }
      : r
  );

  /* ── Test summaries ── */
  const testSummaries: TestSummary[] = useMemo(() => {
    return allTests.map((test) => {
      const testResults = allResults.filter((r) => r.test_id === test.id);
      const submittedCount = testResults.length;
      const avgScore =
        submittedCount > 0
          ? Math.round(
              testResults.reduce((s, r) => s + r.score, 0) / submittedCount
            )
          : 0;
      return { test, submittedCount, avgScore };
    });
  }, [allTests, allResults]);

  /* ── Selected test ── */
  const currentTest = useMemo(() => {
    if (selectedTestId) return allTests.find((t) => t.id === selectedTestId) ?? allTests[0];
    return allTests[0];
  }, [selectedTestId, allTests]);

  const currentQuestions = useMemo(
    () =>
      [...allQuestions.filter((q) => q.test_id === currentTest?.id)].sort(
        (a, b) => a.questionNumber - b.questionNumber
      ),
    [allQuestions, currentTest]
  );

  const rows: Row[] = useMemo(() => {
    if (!currentTest) return [];
    return students
      .map((student) => {
        const studentResults = allResults
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
  }, [students, allResults, currentTest]);

  const selected = rows.find((r) => r.result.id === selectedResultId) ?? null;
  const missingAnalysisCount = rows.filter((r) => !r.result.aiAnalysis).length;
  const avgScore =
    rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.result.score, 0) / rows.length)
      : 0;
  const highScore =
    rows.length > 0 ? Math.max(...rows.map((r) => r.result.score)) : 0;
  const lowScore =
    rows.length > 0 ? Math.min(...rows.map((r) => r.result.score)) : 0;

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

  const questionAccuracy = useMemo(() => {
    return currentQuestions
      .filter((q) => q.type !== "essay" || q.requiresProcess)
      .map((q) => {
        let correct = 0;
        let total = 0;
        for (const r of rows) {
          const sa = r.result.submittedAnswers?.[q.id];
          if (sa !== undefined) {
            total++;
            const stored = r.result.gradedResults?.[q.id];
            if (stored !== undefined && stored !== null) {
              if (isRubricGrade(stored)) {
                correct += stored.score / 100;
              } else if (stored === true) {
                correct++;
              }
            } else {
              const result = checkAnswer(sa, q.answer ?? "", q);
              if (result === true) correct++;
            }
          }
        }
        const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
        return { questionNumber: q.questionNumber, questionText: q.questionText, type: q.type, rate, correct, total };
      });
  }, [currentQuestions, rows]);

  /* ── Chart data: growth trend ── */
  const chartData = useMemo(() => {
    const sorted = [...allTests].sort((a, b) => a.createdAt - b.createdAt).slice(-10);
    return sorted.map((test) => {
      const testResults = allResults.filter((r) => r.test_id === test.id);
      const classAvg =
        testResults.length > 0
          ? Math.round(testResults.reduce((s, r) => s + r.score, 0) / testResults.length)
          : null;

      const entry: Record<string, unknown> = {
        name: test.title.length > 12 ? test.title.slice(0, 12) + "…" : test.title,
        학급평균: classAvg,
      };

      if (trackedStudentId) {
        const sr = testResults.find((r) => r.student_id === trackedStudentId);
        entry["개인"] = sr?.score ?? null;
      }

      return entry;
    });
  }, [allTests, allResults, trackedStudentId]);

  /* ── Excel export ── */
  const handleExportExcel = () => {
    if (!currentTest || rows.length === 0) return;

    const hasAnalysis = rows.some((r) => r.result.aiAnalysis);
    const header = hasAnalysis
      ? ["번호", "이름", "총점", "제출 일시", "AI 서술형 피드백"]
      : ["번호", "이름", "총점", "제출 일시"];

    const body = [...rows]
      .sort((a, b) => a.student.studentNumber - b.student.studentNumber)
      .map((r) => {
        const base = [
          r.student.studentNumber,
          r.student.name,
          r.result.score,
          formatDate(r.result.submittedAt),
        ];
        return hasAnalysis ? [...base, r.result.aiAnalysis ?? ""] : base;
      });

    const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
    sheet["!cols"] = [
      { wch: 6 },
      { wch: 12 },
      { wch: 8 },
      { wch: 18 },
      ...(hasAnalysis ? [{ wch: 60 }] : []),
    ];

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "성적");

    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    const datePart =
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate());
    const safeTitle = currentTest.title.replace(/[\\/:*?"<>|]/g, "_");
    const filename = `${safeTitle}_우리반성적_${datePart}.xlsx`;
    XLSX.writeFile(book, filename);
  };

  /* ── AI generate all ── */
  const handleGenerateAll = async () => {
    const targets = rows.filter((r) => !r.result.aiAnalysis);
    if (targets.length === 0) return;
    const apiKey =
      typeof window !== "undefined"
        ? localStorage.getItem("ai_api_key") ?? ""
        : "";
    if (!apiKey) {
      alert("Gemini API 키가 설정되지 않았습니다. [AI 설정] 페이지에서 등록해 주세요.");
      return;
    }
    setGenerating(true);
    try {
      const payload = targets.map((row) => {
        const qResults = currentQuestions.map((q) => {
          const rawSa = row.result.submittedAnswers?.[q.id];
          const studentAnswer = formatStudentAnswer(rawSa, q);
          return {
            questionNumber: q.questionNumber,
            questionText: q.questionText,
            type: q.type,
            correctAnswer: q.answer ?? "",
            studentAnswer,
            isCorrect: checkAnswer(rawSa, q.answer ?? "", q),
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
        headers: { "Content-Type": "application/json", "x-ai-api-key": apiKey },
        body: JSON.stringify({ results: payload }),
      });
      const json = await res.json();
      if (!res.ok) { alert(json.error ?? "학습 분석 생성에 실패했습니다."); return; }
      const feedbacks: Array<{ resultId: string; aiAnalysis: string }> = json.feedbacks ?? [];
      const txns = feedbacks.map((f) => db.tx.results[f.resultId].update({ aiAnalysis: f.aiAnalysis }));
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

  /* ── Delete test (cascade) ── */
  const handleDeleteTest = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const testId = deleteTarget.id;
      // 연관 문항 ID
      const qIds = allQuestions.filter((q) => q.test_id === testId).map((q) => q.id);
      // 연관 결과 ID
      const rIds = allResults.filter((r) => r.test_id === testId).map((r) => r.id);

      const txns = [
        ...rIds.map((rid) => db.tx.results[rid].delete()),
        ...qIds.map((qid) => db.tx.questions[qid].delete()),
        db.tx.tests[testId].delete(),
      ];
      if (txns.length > 0) await db.transact(txns);

      // 삭제한 시험이 현재 선택 중이면 선택 해제
      if (selectedTestId === testId) {
        setSelectedTestId(null);
        setSelectedResultId(null);
      }
    } catch (err) {
      console.error("[deleteTest]", err);
      alert("시험 삭제에 실패했습니다.");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  /* ── Render ── */
  return (
    <main className="min-h-screen bg-slate-50 p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">교사 대시보드</h1>
            <p className="mt-1 text-slate-500">학급의 누적 시험 데이터를 한눈에 확인하세요.</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            <Link
              href="/teacher/upload"
              className="inline-flex items-center gap-1.5 rounded-xl border-2 border-sky-500 bg-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-600"
            >
              📤 시험지 업로드
            </Link>
            <Link
              href="/teacher/students"
              className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              👥 학생 명단
            </Link>
            <Link
              href="/teacher/settings"
              className="inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              ⚙️ 설정
            </Link>
          </nav>
        </header>

        {/* ═══ Section 1: Growth Trend Chart ═══ */}
        {allTests.length > 0 && (
          <section className="mb-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-base font-bold text-slate-800">성적 추이 (최근 10회)</h2>
              <select
                value={trackedStudentId}
                onChange={(e) => setTrackedStudentId(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-sky-500 focus:outline-none"
              >
                <option value="">학급 평균만 보기</option>
                {[...students]
                  .sort((a, b) => a.studentNumber - b.studentNumber)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.studentNumber}번 {s.name}
                    </option>
                  ))}
              </select>
            </div>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="학급평균"
                    stroke="#6366f1"
                    strokeWidth={2.5}
                    dot={{ r: 4 }}
                    connectNulls
                  />
                  {trackedStudentId && (
                    <Line
                      type="monotone"
                      dataKey="개인"
                      stroke="#f59e0b"
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      connectNulls
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">
                시험이 2회 이상 실시되면 추이 그래프가 표시됩니다.
              </p>
            )}
          </section>
        )}

        {/* ═══ Section 2: Test History ═══ */}
        <section className="mb-8">
          <h2 className="mb-4 text-base font-bold text-slate-800">시험 이력</h2>
          {testSummaries.length === 0 ? (
            <p className="text-sm text-slate-400">아직 출제된 시험이 없습니다.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {testSummaries.map(({ test, submittedCount, avgScore: tAvg }) => {
                const isActive = currentTest?.id === test.id;
                return (
                  <div
                    key={test.id}
                    onClick={() => {
                      setSelectedTestId(test.id);
                      setSelectedResultId(null);
                    }}
                    className={`relative cursor-pointer rounded-xl border-2 p-4 text-left transition ${
                      isActive
                        ? "border-sky-500 bg-sky-50 shadow-md"
                        : "border-slate-200 bg-white hover:border-sky-300 hover:shadow-sm"
                    }`}
                  >
                    {/* 삭제 버튼 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(test);
                      }}
                      className="absolute right-2 top-2 rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      title="시험 삭제"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                      </svg>
                    </button>
                    <p className="pr-8 text-sm font-bold text-slate-900">{test.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {test.subject} · {formatDate(test.createdAt)}
                    </p>
                    <div className="mt-3 flex items-center gap-4">
                      <span className="text-xs text-slate-500">
                        응시 <span className="font-bold text-slate-800">{submittedCount}</span>/{students.length}명
                      </span>
                      <span className={"rounded-full px-2.5 py-0.5 text-xs font-bold " + scoreBadgeClass(tAvg)}>
                        평균 {submittedCount > 0 ? tAvg + "점" : "-"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ═══ Section 3: Selected Test Detail ═══ */}
        {currentTest && (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{currentTest.title}</h2>
                <p className="mt-0.5 text-sm text-slate-500">
                  {currentTest.subject} · {formatDate(currentTest.createdAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/teacher/live/${currentTest.id}`}
                  className="inline-flex items-center gap-1.5 rounded-xl border-2 border-rose-500 bg-rose-50 px-5 py-2.5 text-sm font-semibold text-rose-700 shadow transition hover:bg-rose-100"
                >
                  <span className="flex h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                  실시간 모니터링
                </Link>
                <button
                  type="button"
                  onClick={handleExportExcel}
                  disabled={rows.length === 0}
                  className="rounded-xl border-2 border-emerald-600 bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  📥 성적 엑셀 다운로드
                </button>
                <button
                  onClick={handleGenerateAll}
                  disabled={generating || missingAnalysisCount === 0}
                  className="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {generating
                    ? "AI 학습 분석 생성 중..."
                    : missingAnalysisCount > 0
                      ? "AI 학습 분석 (" + missingAnalysisCount + "명)"
                      : "학습 분석 완료"}
                </button>
              </div>
            </div>

            {/* Stats row */}
            <section className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatCard label="제출 인원" value={rows.length + "명"} sub={"전체 " + students.length + "명"} accent="bg-sky-500" />
              <StatCard label="평균 점수" value={rows.length > 0 ? avgScore + "점" : "-"} accent="bg-violet-500" />
              <StatCard label="최고 점수" value={rows.length > 0 ? highScore + "점" : "-"} accent="bg-emerald-500" />
              <StatCard label="최저 점수" value={rows.length > 0 ? lowScore + "점" : "-"} accent="bg-amber-500" />
              <StatCard label="분석 대기" value={missingAnalysisCount + "명"} accent="bg-rose-500" />
            </section>

            {/* Charts row */}
            {rows.length > 0 && (
              <section className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-4 text-sm font-semibold text-slate-700">점수 분포</h3>
                  <div className="space-y-3">
                    {scoreDist.map((b) => {
                      const pct = rows.length > 0 ? Math.round((b.count / rows.length) * 100) : 0;
                      return (
                        <div key={b.label} className="flex items-center gap-3">
                          <span className="w-16 text-right text-xs font-medium text-slate-500">{b.label}</span>
                          <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className={"absolute inset-y-0 left-0 rounded-full transition-all duration-500 " + b.color} style={{ width: pct + "%" }} />
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
                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-4 text-sm font-semibold text-slate-700">문항별 정답률</h3>
                  {questionAccuracy.length === 0 ? (
                    <p className="text-sm text-slate-500">문항 데이터가 없습니다.</p>
                  ) : (
                    <div className="space-y-3">
                      {questionAccuracy.map((qa) => {
                        const barColor = qa.rate >= 80 ? "bg-emerald-500" : qa.rate >= 60 ? "bg-sky-500" : qa.rate >= 40 ? "bg-amber-500" : "bg-rose-500";
                        return (
                          <div key={qa.questionNumber} className="flex items-center gap-3">
                            <span className="w-12 text-right text-xs font-medium text-slate-500">{qa.questionNumber}번</span>
                            <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-slate-100">
                              <div className={"absolute inset-y-0 left-0 rounded-full transition-all duration-500 " + barColor} style={{ width: qa.rate + "%" }} />
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
              <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">번호</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">이름</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">점수</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">변화</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">제출 시각</th>
                      <th className="px-4 py-3 text-left font-semibold text-slate-700">학습 분석</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {rows.map((row) => {
                      const isSelected = row.result.id === selectedResultId;
                      return (
                        <tr key={row.result.id} onClick={() => setSelectedResultId(row.result.id)} className={"cursor-pointer transition " + (isSelected ? "bg-sky-50" : "hover:bg-slate-50")}>
                          <td className="px-4 py-4 text-slate-500">{row.student.studentNumber}</td>
                          <td className="px-4 py-4 font-medium text-slate-900">{row.student.name}</td>
                          <td className="px-4 py-4">
                            <span className={"inline-flex rounded-full px-3 py-1 text-xs font-semibold " + scoreBadgeClass(row.result.score)}>
                              {row.result.score}점
                            </span>
                          </td>
                          <td className="px-4 py-4"><TrendIndicator delta={row.delta} /></td>
                          <td className="px-4 py-4 text-slate-600">{formatDate(row.result.submittedAt)}</td>
                          <td className="px-4 py-4">
                            {row.result.aiAnalysis ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />생성됨
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />대기 중
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-slate-500">아직 제출된 답안이 없습니다.</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              <aside className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                {selected ? (
                  <DetailPanel row={selected} questions={currentQuestions} onClose={() => setSelectedResultId(null)} />
                ) : (
                  <div className="flex h-full min-h-[200px] items-center justify-center">
                    <p className="text-center text-sm text-slate-400">
                      왼쪽 표에서 학생을 클릭하면<br />상세 결과와 AI 학습 분석을 볼 수 있어요.
                    </p>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </div>

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-rose-600">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              </span>
              <h3 className="text-lg font-bold text-slate-900">시험 삭제</h3>
            </div>
            <p className="mb-2 text-sm font-semibold text-slate-800">
              &quot;{deleteTarget.title}&quot;
            </p>
            <p className="mb-6 text-sm leading-relaxed text-slate-600">
              정말 이 시험을 삭제하시겠습니까?<br />
              학생들의 응시 기록과 채점 결과도 모두 함께 삭제되며<br />
              <span className="font-bold text-rose-600">복구할 수 없습니다.</span>
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                취소
              </button>
              <button
                onClick={handleDeleteTest}
                disabled={deleting}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-rose-700 disabled:opacity-50"
              >
                {deleting ? "삭제 중..." : "영구 삭제"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ══════════════════════════════════════════════════════════
   Sub-components (unchanged from original)
   ══════════════════════════════════════════════════════════ */

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className={"h-2.5 w-2.5 rounded-full " + accent} />
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function TrendIndicator({ delta }: { delta?: number }) {
  if (delta === undefined) return <span className="text-xs text-slate-400">첫 응시</span>;
  if (delta > 0) return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">▲ {delta}점</span>;
  if (delta < 0) return <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">▼ {Math.abs(delta)}점</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">─ 유지</span>;
}

function DetailPanel({ row, questions, onClose }: { row: Row; questions: MockQuestion[]; onClose: () => void }) {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{row.student.name}</h2>
          <p className="text-sm text-slate-500">출석번호 {row.student.studentNumber}</p>
        </div>
        <button onClick={onClose} className="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700">닫기</button>
      </div>
      <div className="mb-5 rounded-xl bg-gradient-to-br from-sky-50 to-violet-50 p-5">
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-bold text-slate-900">{row.result.score}점</span>
          <TrendIndicator delta={row.delta} />
        </div>
        {row.previousScore !== undefined && (
          <p className="mt-1 text-xs text-slate-500">이전 {row.previousScore}점 → 이번 {row.result.score}점</p>
        )}
      </div>
      <section className="mb-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-600 text-xs font-bold text-white">AI</span>
          <h3 className="text-sm font-bold text-slate-800">학습 분석 리포트</h3>
        </div>
        <AnalysisCards raw={row.result.aiAnalysis} />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">제출 답안</h3>
        <ul className="space-y-2">
          {questions.map((q) => {
            const rawSa: AnswerValue | undefined = row.result.submittedAnswers?.[q.id];
            const displaySa = formatStudentAnswer(rawSa, q);
            const stored = row.result.gradedResults?.[q.id];
            const rubric: RubricGrade | null = stored && isRubricGrade(stored) ? stored : null;
            const correct = rubric ? rubric.score === 100 : stored !== undefined && stored !== null ? (stored as boolean) : checkAnswer(rawSa, q.answer ?? "", q);
            const isPartial = rubric ? rubric.score === 50 : false;
            const isProcess = rawSa && typeof rawSa === "object" && !Array.isArray(rawSa) && "process" in rawSa;
            const borderCls = rubric
              ? rubric.score === 100 ? "border-emerald-200 bg-emerald-50" : rubric.score === 50 ? "border-amber-200 bg-amber-50" : "border-rose-200 bg-rose-50"
              : correct === null ? "border-slate-200 bg-white" : correct ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50";
            return (
              <li key={q.id} className={"rounded-lg border p-3 text-sm " + borderCls}>
                <div className="flex items-start gap-2">
                  {(correct !== null || rubric) && (
                    <span className={"mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold text-white " + (rubric ? (rubric.score === 100 ? "bg-emerald-500" : rubric.score === 50 ? "bg-amber-500" : "bg-rose-500") : correct ? "bg-emerald-500" : "bg-rose-500")}>
                      {rubric ? (rubric.score === 100 ? "O" : rubric.score === 50 ? "△" : "X") : correct ? "O" : "X"}
                    </span>
                  )}
                  <div className="flex-1">
                    <p className="font-medium text-slate-700">{q.questionNumber}. {q.questionText}</p>
                    {isProcess && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">[풀이] {(rawSa as { process: string }).process || "(미작성)"}</p>}
                    <p className="mt-1 text-slate-600">답: {displaySa || "(미응답)"}</p>
                    {rubric && (
                      <div className="mt-2 rounded-md bg-violet-50 p-2.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-bold text-violet-700">AI 채점: {rubric.score}점{isPartial && " (부분 점수)"}</p>
                          <ScoreOverride resultId={row.result.id} questionId={q.id} currentScore={rubric.score} currentFeedback={rubric.feedback} gradedResults={row.result.gradedResults} />
                        </div>
                        {rubric.feedback && <p className="mt-1 text-xs text-violet-600">{rubric.feedback}</p>}
                      </div>
                    )}
                    {!rubric && correct === false && <p className="mt-0.5 text-xs font-medium text-emerald-700">정답: {q.answer}</p>}
                    {!rubric && correct === null && <p className="mt-0.5 text-xs text-slate-400">서술형 (교사 채점)</p>}
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
      <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-5 text-center">
        <p className="text-sm text-slate-400">아직 생성되지 않았어요.</p>
        <p className="mt-1 text-xs text-slate-400">상단의 [AI 학습 분석] 버튼을 눌러 리포트를 생성하세요.</p>
      </div>
    );
  }
  let analysis: { strength?: string; weakness?: string; guidance?: string };
  try { analysis = JSON.parse(raw); } catch {
    return <div className="rounded-xl border border-violet-100 bg-violet-50 p-4 text-sm leading-relaxed text-slate-800">{raw}</div>;
  }
  const sections = [
    { key: "strength", label: "강점 및 성취 수준", icon: "▲", text: analysis.strength || "-", headerBg: "bg-emerald-500", iconBg: "bg-emerald-600", border: "border-emerald-200" },
    { key: "weakness", label: "취약점 및 오개념", icon: "!", text: analysis.weakness || "-", headerBg: "bg-amber-500", iconBg: "bg-amber-600", border: "border-amber-200" },
    { key: "guidance", label: "지도 조언", icon: "→", text: analysis.guidance || "-", headerBg: "bg-sky-500", iconBg: "bg-sky-600", border: "border-sky-200" },
  ];
  return (
    <div className="space-y-3">
      {sections.map((s) => (
        <div key={s.key} className={"overflow-hidden rounded-xl border bg-white shadow-sm " + s.border}>
          <div className={"flex items-center gap-2 px-3.5 py-2 " + s.headerBg}>
            <span className={"flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white/90 " + s.iconBg}>{s.icon}</span>
            <span className="text-xs font-bold text-white">{s.label}</span>
          </div>
          <div className="px-3.5 py-3"><p className="text-sm leading-relaxed text-slate-700">{s.text}</p></div>
        </div>
      ))}
    </div>
  );
}

function ScoreOverride({ resultId, questionId, currentScore, currentFeedback, gradedResults }: {
  resultId: string; questionId: string; currentScore: number; currentFeedback: string; gradedResults?: Record<string, unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(currentScore));
  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    const num = Number(val);
    if (![0, 50, 100].includes(num)) { alert("0, 50, 100 중 하나를 입력해 주세요."); return; }
    setSaving(true);
    try {
      const updated = { ...(gradedResults ?? {}), [questionId]: { score: num, feedback: currentFeedback + " (교사 수정)" } };
      await db.transact(db.tx.results[resultId].update({ gradedResults: updated }));
      setEditing(false);
    } catch { alert("저장에 실패했습니다."); } finally { setSaving(false); }
  };
  if (!editing) return <button onClick={() => setEditing(true)} className="rounded border border-violet-300 bg-white px-2 py-0.5 text-[10px] font-medium text-violet-600 hover:bg-violet-50">점수 수정</button>;
  return (
    <div className="flex items-center gap-1">
      <select value={val} onChange={(e) => setVal(e.target.value)} className="rounded border border-violet-300 bg-white px-1.5 py-0.5 text-xs text-violet-800">
        <option value="0">0점</option><option value="50">50점</option><option value="100">100점</option>
      </select>
      <button onClick={handleSave} disabled={saving} className="rounded bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50">{saving ? "..." : "저장"}</button>
      <button onClick={() => setEditing(false)} className="text-[10px] text-slate-400 hover:text-slate-600">취소</button>
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
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
