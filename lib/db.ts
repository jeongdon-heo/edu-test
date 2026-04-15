import { init, i } from "@instantdb/react";

const APP_ID = process.env.NEXT_PUBLIC_INSTANT_APP_ID ?? "";

export type QuestionType = "multiple_choice" | "short_answer" | "essay";

const schema = i.schema({
  entities: {
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
      questionText: i.string(),
      type: i.string(),
      hasImage: i.boolean(),
      options: i.json(),
      answer: i.string(),
      explanation: i.string(),
      materialImage: i.string().optional(),
    }),
    results: i.entity({
      student_id: i.string().indexed(),
      test_id: i.string().indexed(),
      score: i.number(),
      aiFeedback: i.string().optional(),
      submittedAnswers: i.json(),
      submittedAt: i.number(),
    }),
  },
});

export const db = init({ appId: APP_ID, schema });
export type AppSchema = typeof schema;
