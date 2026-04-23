export type AnswerValue =
  | string
  | string[]
  | { process: string; answer: string };

/** Rubric / AI-grade shape for essay questions. `editedByTeacher` flips
 *  when a teacher overrides the AI result via the detail panel. */
export type RubricGrade = {
  score: number;
  feedback: string;
  editedByTeacher?: boolean;
};

/** Per-question grading result stored in DB */
export type GradedResultValue = boolean | null | RubricGrade;

export function normalizeAnswer(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function isCorrect(student: string, answer: string): boolean {
  const s = normalizeAnswer(student);
  const a = normalizeAnswer(answer);
  return s.length > 0 && a.length > 0 && s === a;
}

/** multi_select: compare comma-separated sets (order-independent) */
export function isMultiSelectCorrect(
  student: string,
  answer: string
): boolean {
  const toSet = (v: string) =>
    new Set(
      v
        .split(",")
        .map((s) => normalizeAnswer(s))
        .filter(Boolean)
    );
  const ss = toSet(student);
  const as_ = toSet(answer);
  if (ss.size === 0 || as_.size === 0) return false;
  if (ss.size !== as_.size) return false;
  for (const a of as_) if (!ss.has(a)) return false;
  return true;
}

/** How many answer parts a short-answer question expects. subItems/blankCount
 *  take precedence; otherwise fall back to counting ';;'-joined segments of
 *  the answer. Shared by the student input UI and the grader so both sides
 *  agree on the shape of the answer array. */
export function inferAnswerPartCount(q: {
  answer?: string | null;
  blankCount?: number | null;
  subItems?: unknown;
}): number {
  if (Array.isArray(q.subItems) && (q.subItems as unknown[]).length > 0) {
    return (q.subItems as unknown[]).length;
  }
  if (typeof q.blankCount === "number" && q.blankCount >= 2) return q.blankCount;
  const parts = (q.answer ?? "").split(";;").filter((s) => s.length > 0);
  return parts.length >= 2 ? parts.length : 1;
}

export function isRubricGrade(v: unknown): v is RubricGrade {
  return (
    v !== null &&
    typeof v === "object" &&
    "score" in (v as Record<string, unknown>) &&
    "feedback" in (v as Record<string, unknown>)
  );
}

/**
 * Local (exact-match) answer checker — used as fallback when AI grading
 * is unavailable and for objective question types.
 */
export function checkAnswer(
  studentAnswer: AnswerValue | undefined,
  correctAnswer: string,
  q: {
    type: string;
    blankCount?: number | null;
    subItems?: string[] | null;
    requiresProcess?: boolean | null;
  }
): boolean | null {
  if (q.type === "essay" && !q.requiresProcess) return null;

  if (q.requiresProcess) {
    const ans =
      studentAnswer &&
      typeof studentAnswer === "object" &&
      !Array.isArray(studentAnswer)
        ? studentAnswer.answer
        : typeof studentAnswer === "string"
          ? studentAnswer
          : "";
    return isCorrect(ans, correctAnswer);
  }

  const partCount = inferAnswerPartCount({
    answer: correctAnswer,
    blankCount: q.blankCount,
    subItems: q.subItems,
  });
  if (partCount >= 2) {
    const parts = correctAnswer.split(";;");
    const studentParts = Array.isArray(studentAnswer)
      ? studentAnswer
      : typeof studentAnswer === "string" && studentAnswer
        ? [studentAnswer]
        : [];
    if (studentParts.length === 0) return false;
    if (parts.length !== studentParts.length) return false;
    return parts.every((p, i) => isCorrect(studentParts[i] ?? "", p));
  }

  const saStr =
    typeof studentAnswer === "string"
      ? studentAnswer
      : String(studentAnswer ?? "");

  if (q.type === "multi_select") {
    return isMultiSelectCorrect(saStr, correctAnswer);
  }

  return isCorrect(saStr, correctAnswer);
}

/** Format an AnswerValue for display as a plain string */
export function formatStudentAnswer(
  sa: AnswerValue | undefined,
  q?: { subItems?: string[] | null }
): string {
  if (sa === undefined || sa === "") return "";
  if (typeof sa === "string") return sa;
  if (Array.isArray(sa)) {
    if (q?.subItems && q.subItems.length === sa.length) {
      return sa
        .map((v, i) => {
          const label =
            q.subItems![i].match(/^\(?\d+\)?/)?.[0] ?? `(${i + 1})`;
          return `${label} ${v}`;
        })
        .join(", ");
    }
    return sa.join(", ");
  }
  if (typeof sa === "object" && "answer" in sa) {
    return sa.answer || "";
  }
  return "";
}

export type QuestionResult = {
  questionId: string;
  questionNumber: number;
  questionText: string;
  type: string;
  correctAnswer: string;
  studentAnswer: string;
  isCorrect: boolean | null;
  partialScore?: number; // 0~1 fraction for multi-part questions
  rubricScore?: number; // 0, 50, or 100 for essay rubric
  rubricFeedback?: string;
};

export type GradeResult = {
  score: number;
  correct: number;
  gradable: number;
  essayCount: number;
  questionResults: QuestionResult[];
  gradedResults: Record<string, GradedResultValue>;
};

type QuestionInput = {
  id: string;
  questionNumber: number;
  questionText?: string | null;
  type: string;
  answer: string;
  blankCount?: number | null;
  subItems?: string[] | null;
  requiresProcess?: boolean | null;
  rubric?: string | null;
  explanation?: string | null;
};

/** Pure-essay AI grade (type="essay" without requiresProcess). Uses a
 *  continuous 0–100 score distinct from the 0/50/100 rubric scheme. */
export type PureEssayGrade = {
  score: number; // 0~100
  feedback: string;
  isCorrect: boolean;
};

/**
 * Build regular grading items (short_answer without requiresProcess).
 * requiresProcess items go through essay grading instead.
 */
export function buildAIGradeItems(
  questions: QuestionInput[],
  answers: Record<string, AnswerValue>
): Array<{
  id: string;
  questionText: string;
  correctAnswer: string;
  studentAnswer: string;
}> {
  const items: Array<{
    id: string;
    questionText: string;
    correctAnswer: string;
    studentAnswer: string;
  }> = [];

  for (const q of questions) {
    if (q.type !== "short_answer") continue;
    if (q.requiresProcess) continue;

    const sa = answers[q.id];
    const correctAnswer = q.answer ?? "";

    const partCount = inferAnswerPartCount(q);
    if (partCount >= 2) {
      const parts = correctAnswer.split(";;");
      const studentParts = Array.isArray(sa) ? sa : [];
      for (let i = 0; i < partCount; i++) {
        items.push({
          id: `${q.id}::${i}`,
          questionText: q.subItems?.[i] ?? q.questionText ?? "",
          correctAnswer: parts[i] ?? "",
          studentAnswer: studentParts[i] ?? "",
        });
      }
    } else {
      items.push({
        id: q.id,
        questionText: q.questionText ?? "",
        correctAnswer,
        studentAnswer: typeof sa === "string" ? sa : "",
      });
    }
  }

  return items;
}

/**
 * Build grading items for pure essay questions (type="essay" without
 * requiresProcess). Sent to /api/grade-essay for continuous 0–100 scoring.
 */
export function buildPureEssayGradeItems(
  questions: QuestionInput[],
  answers: Record<string, AnswerValue>
): Array<{
  id: string;
  questionText: string;
  modelAnswer: string;
  explanation: string;
  rubric: string;
  studentAnswer: string;
}> {
  const items: Array<{
    id: string;
    questionText: string;
    modelAnswer: string;
    explanation: string;
    rubric: string;
    studentAnswer: string;
  }> = [];

  for (const q of questions) {
    if (q.type !== "essay") continue;
    if (q.requiresProcess) continue;

    const sa = answers[q.id];
    const studentAnswer = typeof sa === "string" ? sa : "";

    items.push({
      id: q.id,
      questionText: q.questionText ?? "",
      modelAnswer: q.answer ?? "",
      explanation: q.explanation ?? "",
      rubric: q.rubric ?? "",
      studentAnswer,
    });
  }

  return items;
}

/**
 * Build essay grading items for requiresProcess questions.
 * These include full process + answer for rubric-based grading.
 */
export function buildEssayGradeItems(
  questions: QuestionInput[],
  answers: Record<string, AnswerValue>
): Array<{
  id: string;
  questionText: string;
  correctAnswer: string;
  process: string;
  answer: string;
  rubric: string;
}> {
  const items: Array<{
    id: string;
    questionText: string;
    correctAnswer: string;
    process: string;
    answer: string;
    rubric: string;
  }> = [];

  for (const q of questions) {
    if (!q.requiresProcess) continue;

    const sa = answers[q.id];
    const process =
      sa && typeof sa === "object" && !Array.isArray(sa) ? sa.process : "";
    const answer =
      sa && typeof sa === "object" && !Array.isArray(sa)
        ? sa.answer
        : typeof sa === "string"
          ? sa
          : "";

    items.push({
      id: q.id,
      questionText: q.questionText ?? "",
      correctAnswer: q.answer ?? "",
      process,
      answer,
      rubric: q.rubric ?? "",
    });
  }

  return items;
}

/**
 * Grade a submission. Accepts AI results for regular items and
 * rubric results for essay items.
 */
export function gradeSubmission(
  questions: QuestionInput[],
  answers: Record<string, AnswerValue>,
  aiResults?: Map<string, boolean>,
  essayResults?: Map<string, RubricGrade>,
  pureEssayResults?: Map<string, PureEssayGrade>
): GradeResult {
  let correctScore = 0;
  let gradable = 0;
  let essayCount = 0;
  const questionResults: QuestionResult[] = [];
  const gradedResults: Record<string, GradedResultValue> = {};

  for (const q of questions) {
    const studentAnswer: AnswerValue | undefined = answers[q.id];

    // Pure essay (no requiresProcess) — AI-graded via /api/grade-essay with
    // continuous 0~100 score. Falls back to teacher review if no AI result.
    if (q.type === "essay" && !q.requiresProcess) {
      const ai = pureEssayResults?.get(q.id);
      if (ai) {
        gradable++;
        const fraction = ai.score / 100;
        correctScore += fraction;
        // Store as RubricGrade shape so existing render + recon paths
        // light up the 🤖 feedback card automatically.
        gradedResults[q.id] = { score: ai.score, feedback: ai.feedback };
        const isPartial = !ai.isCorrect && ai.score > 0;
        questionResults.push({
          questionId: q.id,
          questionNumber: q.questionNumber,
          questionText: q.questionText ?? "",
          type: q.type,
          correctAnswer: q.answer ?? "",
          studentAnswer: formatStudentAnswer(studentAnswer, q),
          isCorrect: ai.isCorrect,
          partialScore: isPartial ? fraction : undefined,
          rubricScore: ai.score,
          rubricFeedback: ai.feedback,
        });
        continue;
      }
      essayCount++;
      gradedResults[q.id] = null;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText ?? "",
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer: formatStudentAnswer(studentAnswer, q),
        isCorrect: null,
      });
      continue;
    }

    gradable++;

    // --- requiresProcess → rubric grading ---
    if (q.requiresProcess) {
      const rubric = essayResults?.get(q.id);
      if (rubric) {
        const fraction = rubric.score / 100;
        correctScore += fraction;
        gradedResults[q.id] = rubric;
        questionResults.push({
          questionId: q.id,
          questionNumber: q.questionNumber,
          questionText: q.questionText ?? "",
          type: q.type,
          correctAnswer: q.answer ?? "",
          studentAnswer: formatStudentAnswer(studentAnswer, q),
          isCorrect: rubric.score === 100,
          partialScore: rubric.score === 50 ? 0.5 : undefined,
          rubricScore: rubric.score,
          rubricFeedback: rubric.feedback,
        });
        continue;
      }
      // Fallback: exact match on answer part
      const fallback = checkAnswer(studentAnswer, q.answer ?? "", q) ?? false;
      correctScore += fallback ? 1 : 0;
      gradedResults[q.id] = fallback;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText ?? "",
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer: formatStudentAnswer(studentAnswer, q),
        isCorrect: fallback,
      });
      continue;
    }

    // --- Regular questions ---
    const useAI =
      aiResults && aiResults.size > 0 && q.type === "short_answer";

    let qCorrect: boolean;
    let partialScore: number | undefined;

    const partCount =
      q.type === "short_answer" ? inferAnswerPartCount(q) : 1;
    if (useAI && partCount >= 2) {
      let correctParts = 0;
      for (let i = 0; i < partCount; i++) {
        if (aiResults!.get(`${q.id}::${i}`)) correctParts++;
      }
      partialScore = correctParts / partCount;
      qCorrect = correctParts === partCount;
    } else if (useAI) {
      qCorrect = aiResults!.get(q.id) ?? false;
    } else {
      qCorrect = checkAnswer(studentAnswer, q.answer ?? "", q) ?? false;
    }

    if (partialScore !== undefined) {
      correctScore += partialScore;
    } else {
      correctScore += qCorrect ? 1 : 0;
    }

    gradedResults[q.id] = qCorrect;

    questionResults.push({
      questionId: q.id,
      questionNumber: q.questionNumber,
      questionText: q.questionText ?? "",
      type: q.type,
      correctAnswer: q.answer ?? "",
      studentAnswer: formatStudentAnswer(studentAnswer, q),
      isCorrect: qCorrect,
      partialScore,
    });
  }

  const score =
    gradable > 0 ? Math.round((correctScore / gradable) * 100) : 0;
  const correct = questionResults.filter((r) => r.isCorrect === true).length;
  return { score, correct, gradable, essayCount, questionResults, gradedResults };
}
