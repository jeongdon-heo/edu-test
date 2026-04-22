import { init, i } from "@instantdb/react";

const APP_ID = process.env.NEXT_PUBLIC_INSTANT_APP_ID ?? "";

export type QuestionType =
  | "multiple_choice"
  | "multi_select"
  | "ox"
  | "short_answer"
  | "essay";

const schema = i.schema({
  entities: {
    teachers: i.entity({
      username: i.string().indexed(),
      passwordHash: i.string(),
      salt: i.string(),
      name: i.string(),
      createdAt: i.number(),
    }),
    students: i.entity({
      name: i.string(),
      studentNumber: i.number(),
      teacher_id: i.string().indexed(),
    }),
    tests: i.entity({
      title: i.string(),
      subject: i.string(),
      createdAt: i.number(),
      teacher_id: i.string().indexed(),
    }),
    questions: i.entity({
      test_id: i.string().indexed(),
      questionNumber: i.number(),
      questionText: i.string().optional(),
      type: i.string(),
      hasImage: i.boolean().optional(),
      options: i.json().optional(),
      optionsCount: i.number().optional(),
      answer: i.string(),
      explanation: i.string(),
      materialImage: i.string().optional(),
      questionImage: i.string().optional(),
      blankCount: i.number().optional(),
      subItems: i.json().optional(),
      requiresProcess: i.boolean().optional(),
      unit: i.string().optional(),
      rubric: i.string().optional(),
    }),
    results: i.entity({
      student_id: i.string().indexed(),
      student_name: i.string().optional(),
      test_id: i.string().indexed(),
      score: i.number(),
      aiAnalysis: i.string().optional(),
      submittedAnswers: i.json(),
      gradedResults: i.json().optional(),
      submittedAt: i.number(),
    }),
    submissions: i.entity({
      student_id: i.string().indexed(),
      student_name: i.string().optional(),
      test_id: i.string().indexed(),
      currentQuestionIndex: i.number(),
      totalQuestions: i.number(),
      status: i.string(), // "in_progress" | "submitted"
      startedAt: i.number(),
      lastActiveAt: i.number().indexed(),
    }),
  },
});

export const db = init({ appId: APP_ID, schema });
export type AppSchema = typeof schema;
