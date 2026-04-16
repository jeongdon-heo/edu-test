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
  aiAnalysis?: string;
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
    aiAnalysis: '{"strength":"큰 수의 자릿값과 읽기를 정확히 이해하고 있습니다.","weakness":"특별한 취약점은 보이지 않으나, 응용 문제에서 실수 가능성이 있습니다.","guidance":"자릿수가 많은 수의 크기 비교 문제를 추가로 풀어보게 하면 좋겠습니다."}',
    submittedAnswers: {},
    submittedAt: Date.UTC(2026, 2, 20, 10, 15),
  },
  {
    id: "r0-s2",
    student_id: "s2",
    test_id: "t0",
    score: 80,
    aiAnalysis: '{"strength":"큰 수 읽기의 기본 원리를 이해하고 있습니다.","weakness":"자릿수가 길어질 때 자리 구분에서 실수가 반복됩니다.","guidance":"네 자리씩 끊어 읽는 연습을 반복하고, 수 카드를 활용한 자릿값 게임을 권장합니다."}',
    submittedAnswers: {},
    submittedAt: Date.UTC(2026, 2, 20, 10, 18),
  },
  {
    id: "r0-s3",
    student_id: "s3",
    test_id: "t0",
    score: 70,
    aiAnalysis: '{"strength":"큰 수의 기본 개념(만, 억 단위)을 이해하고 있습니다.","weakness":"큰 수 크기 비교에서 자릿수 판단 오류가 있습니다.","guidance":"수직선 위에 수를 표시하는 활동으로 크기 감각을 기르는 것이 효과적입니다."}',
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
    aiAnalysis: '{"strength":"분수의 크기 비교, 동분모 덧셈/뺄셈을 정확히 이해하고 있습니다.","weakness":"서술형 답안에서 수학적 근거를 구체적으로 기술하는 부분이 부족합니다.","guidance":"왜 그렇게 풀었는지 말로 설명하는 연습을 시키고, 풀이 과정을 글로 쓰는 활동을 권장합니다."}',
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
    aiAnalysis: '{"strength":"동분모 연산과 서술형 논리 전개가 안정적입니다.","weakness":"그림 해석 문제에서 시각 자료를 꼼꼼히 확인하지 않는 경향이 있습니다.","guidance":"그림/도형 문제에서 조건을 먼저 밑줄 치는 습관을 지도하면 실수를 줄일 수 있습니다."}',
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
