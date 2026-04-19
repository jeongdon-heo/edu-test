import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";
export const maxDuration = 30;

type PureEssayItem = {
  id: string;
  questionText: string;
  modelAnswer: string;
  explanation?: string;
  rubric?: string;
  studentAnswer: string;
};

const SYSTEM_PROMPT = `너는 다정하고 꼼꼼한 초등학교 4학년 담임 선생님이야.
제공된 [문제], [모범 답안], [채점 기준]을 바탕으로 [학생의 답안]을 평가해 줘.

채점 원칙:
- 단순한 오탈자나 띄어쓰기 실수는 너그럽게 넘어가.
- 핵심 개념(키워드)이 포함되어 있는지 문맥을 파악해 줘.
- 답안이 비어 있으면 score: 0, isCorrect: false로 처리해.
- 완전히 일치할 필요는 없어. 핵심 아이디어가 맞으면 높은 점수를 줘.
- 피드백은 초등학생 눈높이에 맞게 다정하게 1~2문장으로 써 줘. 잘한 점 하나, 보완할 점 하나 포함해.

반드시 아래 JSON 배열 형식으로만 응답해. 설명 문장, 인사말, 코드 펜스 모두 금지.

[
  {
    "id": "항목ID",
    "isCorrect": true 또는 false,
    "score": 0~100 사이 정수,
    "feedback": "초등학생 눈높이 피드백"
  }
]`;

function stripCodeFence(text: string): string {
  let s = text.trim();
  const tick = String.fromCharCode(96);
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

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
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
  const items: PureEssayItem[] = Array.isArray(body?.items) ? body.items : [];

  if (items.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // Empty answers → score 0 with a canned message, no AI call.
  const toGrade = items.filter(
    (it) => it.studentAnswer && it.studentAnswer.trim() !== ""
  );
  const emptyIds = new Set(
    items
      .filter((it) => !it.studentAnswer || it.studentAnswer.trim() === "")
      .map((i) => i.id)
  );

  const emptyResults = [...emptyIds].map((id) => ({
    id,
    isCorrect: false,
    score: 0,
    feedback: "답안이 비어 있어요. 생각을 적어서 다시 도전해 볼까요?",
  }));

  if (toGrade.length === 0) {
    return NextResponse.json({ results: emptyResults });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const userPrompt = toGrade
      .map((it) => {
        const lines = [
          '- id: "' + it.id + '"',
          '  [문제]: "' + it.questionText + '"',
          '  [모범 답안]: "' + it.modelAnswer + '"',
        ];
        if (it.rubric) lines.push('  [채점 기준]: "' + it.rubric + '"');
        if (it.explanation) lines.push('  [해설]: "' + it.explanation + '"');
        lines.push('  [학생의 답안]: "' + it.studentAnswer + '"');
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
                SYSTEM_PROMPT +
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

    const aiMap = new Map<
      string,
      { isCorrect: boolean; score: number; feedback: string }
    >();
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (!r || typeof r.id !== "string") continue;
        aiMap.set(r.id, {
          isCorrect: r.isCorrect === true,
          score: clampScore(r.score),
          feedback: typeof r.feedback === "string" ? r.feedback : "",
        });
      }
    }

    const gradedResults = toGrade.map((it) => {
      const ai = aiMap.get(it.id);
      return ai
        ? {
            id: it.id,
            isCorrect: ai.isCorrect,
            score: ai.score,
            feedback: ai.feedback,
          }
        : {
            id: it.id,
            isCorrect: false,
            score: 0,
            feedback: "채점에 실패했어요. 선생님께 확인 부탁드려요.",
          };
    });

    return NextResponse.json({ results: [...gradedResults, ...emptyResults] });
  } catch (err) {
    console.error("[grade-essay] Gemini API error:", err);
    return NextResponse.json(
      { error: "서술형 채점 중 오류가 발생했습니다.", fallback: true },
      { status: 500 }
    );
  }
}
