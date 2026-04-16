import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";
export const maxDuration = 30;

type QuestionDetail = {
  questionNumber: number;
  questionText: string;
  type: string;
  correctAnswer: string;
  studentAnswer: string;
  isCorrect: boolean | null;
};

type StudentResult = {
  resultId: string;
  studentName: string;
  score: number;
  totalQuestions: number;
  gradableQuestions: number;
  correctCount: number;
  questions: QuestionDetail[];
};

export type AiAnalysis = {
  strength: string;
  weakness: string;
  guidance: string;
};

const SYSTEM_PROMPT = `당신은 초등학교 교사를 돕는 교육 분석 AI입니다.
제출된 학생의 단원평가 결과(맞은 문제, 틀린 문제의 유형, 주관식 오답 내용 등)를 바탕으로,
담임 교사가 학생 지도에 즉각적으로 참고할 수 있는 '학습 분석 리포트'를 작성해 주세요.

어조는 전문적이고 객관적이어야 하며, 반드시 아래 JSON 형식으로만 응답하세요.
마크다운 코드 블록, 설명 문장, 인사말을 절대 포함하지 마세요.

{
  "strength": "강점 및 성취 수준 (1~2문장): 정답을 바탕으로 학생이 잘 이해하고 있는 핵심 개념",
  "weakness": "취약점 및 오개념 (1~2문장): 오답을 바탕으로 학생이 헷갈려 하거나 부족한 부분",
  "guidance": "지도 조언 (1~2문장): 이 학생을 위해 교사가 어떤 부분을 보충 지도하거나 어떤 발문을 던지면 좋을지"
}`;

function buildUserPrompt(r: StudentResult): string {
  const wrong = r.questions.filter((q) => q.isCorrect === false);
  const correct = r.questions.filter((q) => q.isCorrect === true);
  const essay = r.questions.filter((q) => q.isCorrect === null);

  let p = `학생: ${r.studentName}\n`;
  p += `점수: ${r.score}점 (채점 대상 ${r.gradableQuestions}문제 중 ${r.correctCount}개 정답)\n\n`;

  if (correct.length > 0) {
    p += `맞은 문제:\n`;
    for (const q of correct)
      p += `- ${q.questionNumber}번 [${q.type}]: "${q.questionText}"\n`;
  }

  if (wrong.length > 0) {
    p += `\n틀린 문제:\n`;
    for (const q of wrong)
      p += `- ${q.questionNumber}번 [${q.type}]: "${q.questionText}" (학생 답: "${q.studentAnswer || "미응답"}", 정답: "${q.correctAnswer}")\n`;
  } else {
    p += `\n모든 채점 대상 문제를 맞혔습니다.\n`;
  }

  if (essay.length > 0) {
    p += `\n서술형 ${essay.length}문제는 별도 채점 대상입니다.\n`;
  }

  return p;
}

function parseAnalysis(text: string): AiAnalysis {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      strength: typeof parsed.strength === "string" ? parsed.strength : "",
      weakness: typeof parsed.weakness === "string" ? parsed.weakness : "",
      guidance: typeof parsed.guidance === "string" ? parsed.guidance : "",
    };
  } catch {
    // Fallback: treat whole text as guidance
    return { strength: "", weakness: "", guidance: cleaned };
  }
}

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-ai-api-key") ?? "";

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "API 키가 필요합니다. 설정 페이지에서 Gemini API 키를 등록해 주세요.",
      },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const results: StudentResult[] = Array.isArray(body?.results)
    ? body.results
    : [];

  if (results.length === 0) {
    return NextResponse.json({ feedbacks: [] });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const feedbacks = await Promise.all(
      results.map(async (r) => {
        const userPrompt = buildUserPrompt(r);
        const result = await model.generateContent({
          contents: [
            {
              role: "user",
              parts: [{ text: SYSTEM_PROMPT + "\n\n---\n\n" + userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 400,
            responseMimeType: "application/json",
          },
        });
        const raw = result.response.text()?.trim() ?? "{}";
        const analysis = parseAnalysis(raw);
        return {
          resultId: r.resultId,
          aiAnalysis: JSON.stringify(analysis),
        };
      })
    );

    return NextResponse.json({ feedbacks });
  } catch (err) {
    console.error("[feedback/generate] Gemini API error:", err);
    const message =
      err instanceof Error
        ? err.message
        : "AI 학습 분석 생성 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
