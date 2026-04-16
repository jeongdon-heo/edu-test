export function normalizeAnswer(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function isCorrect(student: string, answer: string): boolean {
  const s = normalizeAnswer(student);
  const a = normalizeAnswer(answer);
  return s.length > 0 && a.length > 0 && s === a;
}

/** multi_select: compare comma-separated sets (order-independent) */
export function isMultiSelectCorrect(student: string, answer: string): boolean {
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

export type QuestionResult = {
  questionId: string;
  questionNumber: number;
  questionText: string;
  type: string;
  correctAnswer: string;
  studentAnswer: string;
  isCorrect: boolean | null; // null = essay (not auto-graded)
};

export type GradeResult = {
  score: number;
  correct: number;
  gradable: number;
  essayCount: number;
  questionResults: QuestionResult[];
};

export function gradeSubmission(
  questions: Array<{
    id: string;
    questionNumber: number;
    questionText: string;
    type: string;
    answer: string;
  }>,
  answers: Record<string, string>
): GradeResult {
  let correct = 0;
  let gradable = 0;
  let essayCount = 0;
  const questionResults: QuestionResult[] = [];

  for (const q of questions) {
    const studentAnswer = answers[q.id] ?? "";
    if (q.type === "essay") {
      essayCount++;
      questionResults.push({
        questionId: q.id,
        questionNumber: q.questionNumber,
        questionText: q.questionText,
        type: q.type,
        correctAnswer: q.answer ?? "",
        studentAnswer,
        isCorrect: null,
      });
      continue;
    }
    gradable++;
    const correct_ =
      q.type === "multi_select"
        ? isMultiSelectCorrect(studentAnswer, q.answer ?? "")
        : isCorrect(studentAnswer, q.answer ?? "");
    if (correct_) correct++;
    questionResults.push({
      questionId: q.id,
      questionNumber: q.questionNumber,
      questionText: q.questionText,
      type: q.type,
      correctAnswer: q.answer ?? "",
      studentAnswer,
      isCorrect: correct_,
    });
  }

  const score = gradable > 0 ? Math.round((correct / gradable) * 100) : 0;
  return { score, correct, gradable, essayCount, questionResults };
}
