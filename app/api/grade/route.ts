import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";
export const maxDuration = 30;

type GradeItem = {
  id: string;
  questionText: string;
  correctAnswer: string;
  studentAnswer: string;
};

type EssayGradeItem = {
  id: string;
  questionText: string;
  correctAnswer: string;
  process: string;
  answer: string;
  rubric?: string;
};

const SYSTEM_PROMPT = `당신은 초등학교 4학년 시험의 채점 보조 AI입니다.
아래 각 항목에 대해, 학생의 답(studentAnswer)이 정답(correctAnswer)과 의미적으로 같은지 판별해 주세요.

판별 기준:
- 표기 방식이 달라도 수학적·국어적으로 의미가 같으면 정답입니다.
  예: "삼백삼십구만구" = "339만 9" = "3,399,000" (모두 같은 수)
  예: "사분의 삼" = "3/4" (같은 분수)
  예: "이십사" = "24" (같은 수)
- 한글 표기와 숫자/기호 표기의 차이는 무시합니다.
- 띄어쓰기, 조사, 단위 표기('명', '개', '원', 'cm' 등) 차이는 문맥상 같은 의미이면 정답입니다.
- 학생이 미응답("")이거나 관련 없는 답을 쓴 경우는 오답입니다.
- 수학 문제에서 약분하지 않은 답(예: 4/8)과 약분한 답(1/2)은 문제에 "기약분수로"라는 지시가 없으면 값이 같으면 정답으로 봅니다.
- 대소문자, 전각/반각 차이는 무시합니다.

반드시 아래 JSON 배열 형식으로만 응답하세요. 설명 문장, 인사말을 포함하지 마세요.

[
  { "id": "항목ID", "correct": true 또는 false }
]`;

const ESSAY_RUBRIC_PROMPT = `당신은 초등학교 수학/국어 선생님입니다.
학생이 제출한 서술형 답안(풀이 과정 + 최종 답)을 평가해 주세요.

평가 기준:
- 100점 (정답): 풀이 과정이 논리적이고 올바르며, 최종 답도 정확함. 풀이 방법이 정석과 다르더라도 수학적으로 올바르면 100점.
- 50점 (부분 점수): 핵심 개념 중 일부는 맞지만 풀이 과정에 오류가 있음, 또는 답은 맞지만 풀이 과정이 불충분함, 또는 풀이는 맞지만 최종 답에서 계산 실수가 있음.
- 0점 (틀림): 풀이 과정과 답 모두 핵심 개념에서 벗어남, 또는 미응답.

주의사항:
- 단순한 텍스트 불일치나 오탈자에는 감점하지 마세요.
- 수학적/논리적 의미가 맞으면 정답 처리하세요.
- feedback은 초등학생 수준에 맞게 친절하고 짧게 (1~2문장) 써 주세요.
- "채점 기준(rubric)"이 제공된 경우, 반드시 그 기준에 따라 채점하세요. 기준에 명시된 핵심 키워드나 풀이 방법이 포함되어야 부분점수 이상을 부여합니다.

반드시 아래 JSON 배열 형식으로만 응답하세요:

[
  { "id": "항목ID", "score": 0 또는 50 또는 100, "feedback": "채점 사유" }
]`;

function stripCodeFence(text: string): string {
  let s = text.trim();
  const tick = String.fromCharCode(96); // backtick
  const fence = tick + tick + tick;
  if (s.startsWith(fence + "json")) s = s.slice(7).trimStart();
  else if (s.startsWith(fence)) s = s.slice(3).trimStart();
  if (s.endsWith(fence)) s = s.slice(0, -3).trimEnd();
  return s;
}

function getApiKey(request: Request): string {
  return (
    request.headers.get("x-ai-api-key") ||
    process.env.GEMINI_API_KEY ||
    ""
  );
}

async function gradeRegularItems(
  items: GradeItem[],
  apiKey: string
): Promise<Array<{ id: string; correct: boolean }>> {
  if (items.length === 0) return [];

  const toGrade = items.filter(
    (item) => item.studentAnswer && item.studentAnswer.trim() !== ""
  );
  const emptyIds = new Set(
    items
      .filter((item) => !item.studentAnswer || item.studentAnswer.trim() === "")
      .map((i) => i.id)
  );

  if (toGrade.length === 0) {
    return items.map((item) => ({ id: item.id, correct: false }));
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const userPrompt = toGrade
    .map(
      (item) =>
        `- id: "${item.id}" | 문제: "${item.questionText}" | 정답: "${item.correctAnswer}" | 학생 답: "${item.studentAnswer}"`
    )
    .join("\n");

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_PROMPT + "\n\n---\n채점할 항목들:\n" + userPrompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  });

  const raw = result.response.text()?.trim() ?? "[]";
  const cleaned = stripCodeFence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = [];
  }

  const aiResults = new Map<string, boolean>();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (typeof r.id === "string" && typeof r.correct === "boolean") {
        aiResults.set(r.id, r.correct);
      }
    }
  }

  return items.map((item) => ({
    id: item.id,
    correct: emptyIds.has(item.id)
      ? false
      : (aiResults.get(item.id) ?? false),
  }));
}

async function gradeEssayItems(
  items: EssayGradeItem[],
  apiKey: string
): Promise<Array<{ id: string; score: number; feedback: string }>> {
  if (items.length === 0) return [];

  // Empty essays → score 0
  const toGrade = items.filter(
    (item) =>
      (item.process && item.process.trim() !== "") ||
      (item.answer && item.answer.trim() !== "")
  );
  const emptyIds = new Set(
    items
      .filter(
        (item) =>
          (!item.process || item.process.trim() === "") &&
          (!item.answer || item.answer.trim() === "")
      )
      .map((i) => i.id)
  );

  if (toGrade.length === 0) {
    return items.map((item) => ({
      id: item.id,
      score: 0,
      feedback: "답안이 제출되지 않았습니다.",
    }));
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const userPrompt = toGrade
    .map((item) => {
      const lines = [
        '- id: "' + item.id + '"',
        '  문제: "' + item.questionText + '"',
        '  정답: "' + item.correctAnswer + '"',
      ];
      if (item.rubric) {
        lines.push('  채점 기준(rubric): "' + item.rubric + '"');
      }
      lines.push('  학생 풀이 과정: "' + (item.process || "(미작성)") + '"');
      lines.push('  학생 최종 답: "' + (item.answer || "(미작성)") + '"');
      return lines.join("\n");
    })
    .join("\n\n");

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              ESSAY_RUBRIC_PROMPT +
              "\n\n---\n채점할 서술형 답안들:\n\n" +
              userPrompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const raw = result.response.text()?.trim() ?? "[]";
  const cleaned = stripCodeFence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = [];
  }

  const aiResults = new Map<
    string,
    { score: number; feedback: string }
  >();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (typeof r.id === "string" && typeof r.score === "number") {
        const score = [0, 50, 100].includes(r.score) ? r.score : 0;
        aiResults.set(r.id, {
          score,
          feedback: typeof r.feedback === "string" ? r.feedback : "",
        });
      }
    }
  }

  return items.map((item) => {
    if (emptyIds.has(item.id)) {
      return { id: item.id, score: 0, feedback: "답안이 제출되지 않았습니다." };
    }
    const ai = aiResults.get(item.id);
    return ai
      ? { id: item.id, score: ai.score, feedback: ai.feedback }
      : { id: item.id, score: 0, feedback: "채점에 실패했습니다." };
  });
}

export async function POST(request: Request) {
  const apiKey = getApiKey(request);

  if (!apiKey) {
    return NextResponse.json(
      { error: "API 키가 필요합니다.", fallback: true },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const items: GradeItem[] = Array.isArray(body?.items) ? body.items : [];
  const essayItems: EssayGradeItem[] = Array.isArray(body?.essayItems)
    ? body.essayItems
    : [];

  if (items.length === 0 && essayItems.length === 0) {
    return NextResponse.json({ results: [], essayResults: [] });
  }

  try {
    // Grade regular and essay items in parallel
    const [results, essayResults] = await Promise.all([
      gradeRegularItems(items, apiKey),
      gradeEssayItems(essayItems, apiKey),
    ]);

    return NextResponse.json({ results, essayResults });
  } catch (err) {
    console.error("[grade] Gemini API error:", err);
    return NextResponse.json(
      { error: "채점 중 오류가 발생했습니다.", fallback: true },
      { status: 500 }
    );
  }
}
