"use client";

import Link from "next/link";
import {
  formatStudentAnswer,
  isRubricGrade,
  type AnswerValue,
  type QuestionResult,
} from "@/lib/scoring";

export type SubmitResult = {
  score: number;
  correct: number;
  gradable: number;
  essayCount: number;
  overwritten: boolean;
  questionResults: QuestionResult[];
};

type QuestionInput = {
  id: string;
  questionNumber: number;
  questionText?: string | null;
  type: string;
  answer?: string;
  requiresProcess?: boolean;
  subItems?: string[] | null;
};

/**
 * Rebuild a SubmitResult from a persisted results row. Used by the review
 * page so the student can re-open a past submission without re-running the
 * AI grader.
 */
export function reconstructResult(params: {
  questions: QuestionInput[];
  submittedAnswers: Record<string, AnswerValue> | undefined;
  gradedResults: Record<string, unknown> | undefined;
  score: number;
}): SubmitResult {
  const { questions, submittedAnswers, gradedResults, score } = params;
  const sorted = [...questions].sort(
    (a, b) => (a.questionNumber ?? 0) - (b.questionNumber ?? 0)
  );

  let correct = 0;
  let gradable = 0;
  let essayCount = 0;
  const questionResults: QuestionResult[] = [];

  for (const q of sorted) {
    const sa = submittedAnswers?.[q.id];
    const studentAnswer = formatStudentAnswer(sa, q);
    const stored = gradedResults?.[q.id];

    const isPureEssay = q.type === "essay" && !q.requiresProcess;
    if (isPureEssay) {
      essayCount++;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText ?? "",
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer,
        isCorrect: null,
      });
      continue;
    }

    gradable++;

    if (isRubricGrade(stored)) {
      // Unified handling for rubric (0/50/100) and continuous pure-essay
      // (0~100) scores. Treat >=80 as correct, fractional otherwise.
      correct += stored.score / 100;
      const right = stored.score >= 80;
      const fraction = stored.score / 100;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText ?? "",
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer,
        isCorrect: right,
        partialScore: !right && stored.score > 0 ? fraction : undefined,
        rubricScore: stored.score,
        rubricFeedback: stored.feedback,
      });
      continue;
    }

    if (typeof stored === "boolean") {
      if (stored) correct += 1;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText ?? "",
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer,
        isCorrect: stored,
      });
      continue;
    }

    // Unscored — treat as pending (teacher will grade).
    questionResults.push({
      questionId: q.id,
      questionNumber: q.questionNumber,
      questionText: q.questionText ?? "",
      type: q.type,
      correctAnswer: q.answer ?? "",
      studentAnswer,
      isCorrect: null,
    });
  }

  return {
    score,
    correct: Math.round(correct),
    gradable,
    essayCount,
    overwritten: false,
    questionResults,
  };
}

export function ResultView({ result }: { result: SubmitResult }) {
  const tier =
    result.score === 100
      ? {
          emoji: "🏆",
          headline: "완벽해요! 최고예요!",
          sub: "한 문제도 놓치지 않았어요.",
          scoreColor: "text-amber-500",
          heroBg: "from-amber-100 via-yellow-50 to-amber-100",
        }
      : result.score >= 80
        ? {
            emoji: "👏",
            headline: "정말 잘했어요!",
            sub: "조금만 더 하면 만점이에요!",
            scoreColor: "text-emerald-600",
            heroBg: "from-emerald-100 via-sky-50 to-emerald-100",
          }
        : result.score >= 60
          ? {
              emoji: "💪",
              headline: "수고했어요!",
              sub: "틀린 문제를 다시 보면서 배워봐요.",
              scoreColor: "text-sky-600",
              heroBg: "from-sky-100 via-blue-50 to-sky-100",
            }
          : {
              emoji: "💪",
              headline: "포기하지 마세요!",
              sub: "오답을 다시 풀어보면 꼭 실력이 늘어요.",
              scoreColor: "text-rose-500",
              heroBg: "from-rose-100 via-amber-50 to-rose-100",
            };

  return (
    <main className="min-h-screen bg-sky-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <section
          className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${tier.heroBg} p-10 text-center shadow-xl`}
        >
          {result.overwritten && (
            <span className="absolute left-4 top-4 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-slate-600">
              다시 제출했어요
            </span>
          )}
          <p className="text-6xl sm:text-7xl" aria-hidden>
            {tier.emoji}
          </p>
          <p className="mt-2 text-xl font-bold text-slate-700 sm:text-2xl">
            {tier.headline}
          </p>
          <p className="mt-1 text-sm text-slate-500">{tier.sub}</p>
          <p
            className={`mt-5 text-8xl font-black leading-none sm:text-9xl ${tier.scoreColor}`}
          >
            {result.score}
            <span className="ml-1 text-4xl font-bold sm:text-5xl">점</span>
          </p>
          <p className="mt-4 text-lg text-slate-700">
            채점 {result.gradable}문제 중{" "}
            <span className="font-extrabold text-emerald-600">
              {result.correct}
            </span>
            개 정답
          </p>
          {result.essayCount > 0 && (
            <p className="mt-2 text-sm text-slate-500">
              서술형 {result.essayCount}문제는 선생님이 따로 채점해요.
            </p>
          )}
        </section>

        <h2 className="mb-4 mt-10 text-2xl font-extrabold text-slate-800">
          📝 문항별 결과
        </h2>
        <ol className="space-y-4">
          {result.questionResults.map((qr) => (
            <QuestionResultCard key={qr.questionId} qr={qr} />
          ))}
        </ol>

        <div className="mt-10 text-center">
          <Link
            href="/test"
            className="inline-flex items-center justify-center gap-2 rounded-3xl bg-sky-600 px-10 py-5 text-2xl font-extrabold text-white shadow-xl transition active:scale-95 hover:bg-sky-700"
          >
            📋 다른 시험 보러 가기
          </Link>
        </div>
      </div>
    </main>
  );
}

function QuestionResultCard({ qr }: { qr: QuestionResult }) {
  const hasPartial =
    qr.partialScore !== undefined && qr.partialScore > 0 && !qr.isCorrect;
  const isPending = qr.isCorrect === null;
  const isWrong = qr.isCorrect === false;
  const isRight = qr.isCorrect === true;

  const cardCls = isPending
    ? "border-slate-200 bg-slate-50"
    : isRight
      ? "border-emerald-300 bg-emerald-50"
      : hasPartial
        ? "border-amber-300 bg-amber-50"
        : "border-rose-300 bg-rose-50";

  return (
    <li className={`rounded-3xl border-4 p-5 shadow-sm ${cardCls}`}>
      <div className="flex items-start gap-4">
        <ResultMark state={isPending ? "pending" : isRight ? "right" : "wrong"} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-white text-sm font-black text-slate-600 shadow">
              {qr.questionNumber}
            </span>
            <span className="min-w-0 truncate">{qr.questionText}</span>
          </p>
          {hasPartial && (
            <p className="mt-2 inline-block rounded-full bg-amber-200/70 px-3 py-1 text-xs font-bold text-amber-800">
              부분 정답 ({Math.round(qr.partialScore! * 100)}%)
            </p>
          )}

          <div className="mt-3 space-y-2">
            {isRight && (
              <AnswerRow
                label="내 답"
                value={qr.studentAnswer || "(미응답)"}
                tone="right"
              />
            )}

            {isWrong && (
              <>
                <AnswerRow
                  label="내가 쓴 답"
                  value={qr.studentAnswer || "(미응답)"}
                  tone="wrong"
                />
                {qr.correctAnswer && (
                  <AnswerRow
                    label="진짜 정답"
                    value={qr.correctAnswer}
                    tone="correct"
                  />
                )}
              </>
            )}

            {isPending && (
              <AnswerRow
                label="내 답"
                value={qr.studentAnswer || "(미응답)"}
                tone="pending"
              />
            )}
            {isPending && (
              <p className="rounded-xl bg-white/70 px-4 py-2 text-sm font-medium text-slate-500">
                선생님이 따로 채점하는 문제예요.
              </p>
            )}

            {qr.rubricScore !== undefined && (
              <div className="relative mt-3 rounded-2xl border-2 border-violet-200 bg-violet-50 p-4 shadow-sm">
                <span
                  className="absolute -top-2 left-5 h-3 w-3 rotate-45 border-l-2 border-t-2 border-violet-200 bg-violet-50"
                  aria-hidden
                />
                <p className="text-sm font-extrabold text-violet-800">
                  🤖 AI 선생님의 코멘트 · {qr.rubricScore}점
                </p>
                {qr.rubricFeedback && (
                  <p className="mt-1 text-sm leading-relaxed text-violet-700">
                    {qr.rubricFeedback}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function ResultMark({ state }: { state: "right" | "wrong" | "pending" }) {
  if (state === "pending") {
    return (
      <span className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-slate-200 text-2xl font-black text-slate-600 shadow-inner">
        ...
      </span>
    );
  }
  if (state === "right") {
    return (
      <span
        aria-label="정답"
        className="flex h-14 w-14 flex-none items-center justify-center rounded-full border-4 border-emerald-500 bg-white text-3xl shadow-md"
      >
        ⭕
      </span>
    );
  }
  return (
    <span
      aria-label="오답"
      className="flex h-14 w-14 flex-none items-center justify-center rounded-full border-4 border-rose-500 bg-white text-3xl font-black text-rose-500 shadow-md"
    >
      ❌
    </span>
  );
}

function AnswerRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "right" | "wrong" | "correct" | "pending";
}) {
  const cls =
    tone === "right"
      ? "border-emerald-200 bg-white text-slate-800"
      : tone === "wrong"
        ? "border-rose-200 bg-rose-50/70 text-rose-700 line-through decoration-rose-400 decoration-2"
        : tone === "correct"
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 font-bold"
          : "border-slate-200 bg-white text-slate-700";
  const labelCls =
    tone === "wrong"
      ? "text-rose-600"
      : tone === "correct"
        ? "text-emerald-700"
        : "text-slate-500";
  return (
    <div className={`rounded-xl border-2 px-4 py-3 ${cls}`}>
      <p className={`text-xs font-bold uppercase tracking-wide ${labelCls}`}>
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
