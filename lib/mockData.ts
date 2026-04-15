import type { QuestionType } from "./db";

export const MOCK_TEACHER_ID = "mock-teacher";

export type MockStudent = {
  id: string;
  name: string;
  studentNumber: number;
  teacher_id: string;
};

export type MockTest = {
  id: string;
  title: string;
  subject: string;
  createdAt: number;
  teacher_id: string;
};

export type MockQuestion = {
  id: string;
  test_id: string;
  questionNumber: number;
  questionText: string;
  type: QuestionType;
  hasImage: boolean;
  options: string[];
  answer: string;
  explanation: string;
  materialImage?: string;
};

export type MockResult = {
  id: string;
  student_id: string;
  test_id: string;
  score: number;
  aiFeedback?: string;
  submittedAnswers: Record<string, string>;
  submittedAt: number;
};

export const mockStudents: MockStudent[] = [
  { id: "s1", name: "김민지", studentNumber: 1, teacher_id: MOCK_TEACHER_ID },
  { id: "s2", name: "이준호", studentNumber: 2, teacher_id: MOCK_TEACHER_ID },
  { id: "s3", name: "박서연", studentNumber: 3, teacher_id: MOCK_TEACHER_ID },
];

export const mockPreviousTest: MockTest = {
  id: "t0",
  title: "4학년 2학기 - 큰 수",
  subject: "수학",
  createdAt: Date.UTC(2026, 2, 20),
  teacher_id: MOCK_TEACHER_ID,
};

export const mockTest: MockTest = {
  id: "t1",
  title: "4학년 2학기 - 분수의 덧셈과 뺄셈",
  subject: "수학",
  createdAt: Date.UTC(2026, 3, 15),
  teacher_id: MOCK_TEACHER_ID,
};

export const mockQuestions: MockQuestion[] = [
  {
    id: "q1",
    test_id: "t1",
    questionNumber: 1,
    questionText: "다음 중 분수 1/2 과 크기가 같은 것은 무엇인가요?",
    type: "multiple_choice",
    hasImage: false,
    options: ["1/3", "2/4", "3/5", "1/4"],
    answer: "2/4",
    explanation: "분자와 분모에 같은 수(2)를 곱해도 분수의 크기는 그대로예요. 1/2 = 2/4.",
  },
  {
    id: "q2",
    test_id: "t1",
    questionNumber: 2,
    questionText: "아래 그림에서 색칠된 부분이 나타내는 분수로 알맞은 것은?",
    type: "multiple_choice",
    hasImage: true,
    options: ["1/4", "2/4", "3/4", "4/4"],
    answer: "3/4",
    explanation: "전체가 4칸으로 나뉘어 있고 그중 3칸이 색칠되어 있으니 3/4이에요.",
  },
  {
    id: "q3",
    test_id: "t1",
    questionNumber: 3,
    questionText: "3/5 + 1/5 의 값을 기약분수로 쓰세요.",
    type: "short_answer",
    hasImage: false,
    options: [],
    answer: "4/5",
    explanation: "분모가 같으면 분자끼리 더해요. 3/5 + 1/5 = 4/5 (이미 기약분수).",
  },
  {
    id: "q4",
    test_id: "t1",
    questionNumber: 4,
    questionText: "1 - 2/7 의 값을 분수로 쓰세요.",
    type: "short_answer",
    hasImage: false,
    options: [],
    answer: "5/7",
    explanation: "1을 7/7로 바꾸고 2/7을 빼면 5/7이 돼요.",
  },
  {
    id: "q5",
    test_id: "t1",
    questionNumber: 5,
    questionText:
      "분수의 덧셈을 공부하면서 가장 재미있었던 점과 어려웠던 점을 한 문단으로 써 보세요.",
    type: "essay",
    hasImage: false,
    options: [],
    answer:
      "분수를 그림으로 나타내어 보는 활동이 재미있었고, 기약분수로 바꾸는 과정이 어려웠다는 내용을 예시로 제시할 수 있어요.",
    explanation:
      "정해진 정답이 없는 서술형이에요. 분수 학습 경험과 느낀 점을 구체적으로 쓰면 됩니다.",
  },
];

export const mockPreviousResults: MockResult[] = [
  {
    id: "r0-s1",
    student_id: "s1",
    test_id: "t0",
    score: 90,
    aiFeedback: "큰 수의 자릿값을 정확히 파악하고 있어요.",
    submittedAnswers: {},
    submittedAt: Date.UTC(2026, 2, 20, 10, 15),
  },
  {
    id: "r0-s2",
    student_id: "s2",
    test_id: "t0",
    score: 80,
    aiFeedback: "큰 수를 읽는 데 익숙하지만, 자릿수 세기가 길면 실수가 생깁니다.",
    submittedAnswers: {},
    submittedAt: Date.UTC(2026, 2, 20, 10, 18),
  },
  {
    id: "r0-s3",
    student_id: "s3",
    test_id: "t0",
    score: 70,
    aiFeedback: "기본 개념은 이해했으나 큰 수 비교에서 어려움을 보였습니다.",
    submittedAnswers: {},
    submittedAt: Date.UTC(2026, 2, 20, 10, 22),
  },
];

export const mockResults: MockResult[] = [
  {
    id: "r1",
    student_id: "s1",
    test_id: "t1",
    score: 95,
    aiFeedback:
      "분수의 크기 비교와 같은 분모 덧셈을 정확히 이해하고 있어요. 다만 서술형에서 문장을 더 구체적으로 설명하면 더 좋아질 거예요.",
    submittedAnswers: {
      q1: "2/4",
      q2: "3/4",
      q3: "4/5",
      q4: "5/7",
      q5: "분수를 색칠해서 배울 때가 가장 재미있었고, 기약분수로 바꾸는 게 조금 어려웠어요.",
    },
    submittedAt: Date.UTC(2026, 3, 15, 10, 24),
  },
  {
    id: "r2",
    student_id: "s2",
    test_id: "t1",
    score: 72,
    submittedAnswers: {
      q1: "2/4",
      q2: "2/4",
      q3: "4/5",
      q4: "5/8",
      q5: "색칠하는 건 쉬웠는데 계산이 어려웠어요.",
    },
    submittedAt: Date.UTC(2026, 3, 15, 10, 28),
  },
  {
    id: "r3",
    student_id: "s3",
    test_id: "t1",
    score: 88,
    aiFeedback:
      "전반적으로 안정적이며 서술형 답안의 논리가 좋습니다. 그림 해석 문제에서 한 번 더 확인하는 습관을 들이면 완벽해질 거예요.",
    submittedAnswers: {
      q1: "2/4",
      q2: "3/4",
      q3: "4/5",
      q4: "5/7",
      q5: "분수를 그림으로 보면 이해가 잘 되고, 뺄셈에서 1을 분수로 바꾸는 게 어려웠어요.",
    },
    submittedAt: Date.UTC(2026, 3, 15, 10, 31),
  },
];
