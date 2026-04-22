import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60;

export type ParsedQuestion = {
  questionNumber: number;
  type: "multiple_choice" | "multi_select" | "ox" | "short_answer" | "essay";
  optionsCount: number | null;
  answer: string;
  explanation: string;
  materialImage: string | null;
  materialImageBBox: [number, number, number, number] | null;
  questionImage: string | null;
  questionImageBBox: [number, number, number, number] | null;
};

type Provider = "anthropic" | "gemini";

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] normalized 0~1000

type AIQuestion = {
  questionNumber: number;
  type: ParsedQuestion["type"];
  optionsCount: number | null;
  answer: string;
  explanation: string;
  materialImageBBox: BBox | null;
  questionImageBBox: BBox | null;
};

export const systemPrompt = `당신은 대한민국 초등학교 4학년(만 10세) 학생용 시험지 이미지를 분석하는 **레이아웃 분석 전문가**입니다.
이 작업은 **순수 이미지 기반** 파이프라인입니다. 학생과 교사에게는 잘려진 이미지만 노출되고, 문제 본문·보기 텍스트는 전혀 사용되지 않습니다.

[절대 금지 규칙 — 위반 시 작업 실패]
- **문제 본문(questionText)·보기(options) 텍스트·지문 텍스트를 절대 전사(transcribe)하지 마세요.**
- 문제의 한국어 문장을 따라 쓰거나 요약하지 마세요. <보기> 박스나 표 안의 글자도 옮기지 마세요.
- 보기 텍스트는 세지 않고, 오직 '번호 붙은 선택지의 개수'만 세어 숫자로 반환하세요.
- 답(answer)은 짧은 값(숫자, 한두 글자, 기호)에 한정해야 하며, 긴 문장은 출력 금지입니다.

[추출 규칙 — 오직 아래 6개 필드만 채우세요]
1. questionNumber (number):
   - 이미지에 표시된 각 문항 번호를 그대로 숫자로 반환합니다.

2. type (string): 다음 5개 중 하나
   - "multiple_choice": ①②③④ 등 번호가 매겨진 보기가 있고 단일 정답
   - "multi_select": 번호가 매겨진 보기가 있고 "두 개 고르시오"처럼 복수 정답
   - "ox": ○/× 중 하나로 답하는 문항
   - "short_answer": 숫자·단어·짧은 구로 답하는 단답형/빈칸 채우기/계산 결과 쓰기
   - "essay": 문장으로 서술하는 서술형

3. optionsCount (number | null):
   - multiple_choice·multi_select: 이미지에 보이는 **번호 붙은 선택지의 개수만** 숫자로 반환 (예: 4 또는 5).
   - ox: 2로 고정.
   - short_answer·essay: null.
   - **중요:** 보기의 글자는 절대 읽지 말고, 개수만 세세요.

4. answer (string) — 짧은 값만 허용:
   - multiple_choice: 정답 번호만 문자열로 ("1"·"2"·"3"·"4"·"5" 중 하나).
   - multi_select: 정답 번호들을 쉼표로 구분 (예: "1,3").
   - ox: "O" 또는 "X" 한 글자.
   - short_answer: 숫자·한 단어·짧은 구(20자 이내) 정도로 간결하게.
   - essay: 모범 답안의 핵심 키워드 한두 단어만 (긴 문장 금지).
   - 정답을 모르면 빈 문자열 "".

5. explanation (string):
   - 왜 그 답이 정답인지 초등학교 4학년이 이해할 정도로 **한 문장** 풀이.
   - 모르면 빈 문자열 "".

6. 좌표 필드 — 크롭용 BBox, 0~1000 정수로 정규화된 [y_min, x_min, y_max, x_max]:
   좌표계: 페이지 좌상단이 (0,0), 우하단이 (1000,1000). y는 세로(위→아래), x는 가로(왼→오른).

   **[A] 다단(多段) 레이아웃 규칙 — 매우 중요, 반드시 준수:**
   - 대부분의 한국 초등 시험지는 **2단(좌/우 두 컬럼) 구성**입니다. 단 경계는 페이지 가로 중앙(x=500) 근처.
   - 2단 레이아웃일 때:
     · **왼쪽 단(좌측 컬럼)** 문항의 x 범위: x_min은 0~60, x_max는 480~520. 폭 ≈ 460~500.
     · **오른쪽 단(우측 컬럼)** 문항의 x 범위: x_min은 480~520, x_max는 940~1000. 폭 ≈ 460~500.
   - 3단이면 각 단 폭 ≈ 333.
   - 단 경계를 절대 혼동하지 마세요. 오른쪽 단 문항에 왼쪽 단 좌표([...0~500])를 반환하면 명백한 오류입니다.
   - 단을 판단할 때: 문항 번호가 이미지 가로 중앙보다 오른쪽에 찍혀 있으면 오른쪽 단입니다.

   **[B] questionImageBBox — 각 문항을 타이트하게 둘러싸는 박스 (필수, null 불가):**
   - **시작(좌상단 = y_min, x_min):** 반드시 해당 **문항 번호(예: "1.", "8.", "9.")가 찍힌 줄의 바로 위**를 포함합니다.
     · y_min은 번호 줄보다 약간(10~20) 위.
     · x_min은 해당 단의 **왼쪽 여백**에 맞추세요 — 좌단이면 0~20, 우단이면 480~520. 번호 글자 바로 옆부터 시작해서 x_min을 크게 주지 마세요 (폭이 반절로 줄어듭니다).
   - **끝(우하단 = y_max, x_max):** 해당 문항의 **마지막 선택지(④ 또는 ⑤)나 그림/표의 아래**까지 포함합니다.
     · 다음 문항 번호는 절대 포함 금지.
     · x_max는 해당 단의 **오른쪽 끝**까지. 좌단이면 480~520, 우단이면 940~1000.
   - **최소 크기:** 세로 200, 가로 400 이상. 문항 번호만 둘러싸는 초소형 박스(세로 50, 가로 50 등)는 절대 반환하지 마세요.
   - 폭은 해당 단의 **전체 폭**을 덮어야 합니다. 보기 텍스트가 짧아도 박스는 컬럼 폭만큼 펼치세요.
   - **공통 지문(materialImageBBox) 영역은 포함하지 마세요.**
   - 모든 문항이 반드시 이 필드를 채웁니다.

   **[C] materialImageBBox — 공유 지문/표/그림만, 없으면 null:**
   - 여러 문항이 공유하는 독립 지문/표/그림이 있을 때만 그 영역 좌표.
   - 시작(y_min): 지문 안내 문구(예: "※ [1~3] 다음 글을 읽고 …")가 있으면 그 위부터 포함.
   - 끝(y_max): 지문의 마지막 줄까지만. 그 아래의 문제 번호·발문·선택지는 절대 포함 금지.
   - 같은 지문을 공유하는 모든 문항에 동일한 좌표를 복사해 담으세요.

[정답지 이미지가 함께 제공된 경우]
- 두 번째 이후 이미지는 정답지/해설지입니다.
- answer와 explanation은 반드시 정답지에 적힌 내용을 바탕으로 채우세요 (스스로 계산 금지).
- 정답지의 문제 번호와 시험지 문제 번호를 정확히 매칭하세요.

[출력 규칙]
- 아래 스키마에 정확히 맞는 JSON 하나만 출력합니다. 마크다운 펜스·주석·설명 문장·인사말 절대 금지.
- 문항이 없으면 "questions"를 빈 배열로 반환하세요.

{
  "questions": [
    {
      "questionNumber": number,
      "type": "multiple_choice" | "multi_select" | "ox" | "short_answer" | "essay",
      "optionsCount": number | null,
      "answer": string,
      "explanation": string,
      "materialImageBBox": [number, number, number, number] | null,
      "questionImageBBox": [number, number, number, number]
    }
  ]
}`;

function stripDataUrl(dataUrl: string): {
  mediaType: "image/png" | "image/jpeg";
  data: string;
} {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.+)$/);
  if (match) {
    const mediaType =
      match[1] === "image/jpg"
        ? "image/jpeg"
        : (match[1] as "image/png" | "image/jpeg");
    return { mediaType, data: match[2] };
  }
  return { mediaType: "image/png", data: dataUrl };
}

const BBOX_MIN_WIDTH = 300; // 0~1000 space — ~30% of page
const BBOX_MIN_HEIGHT = 200; // 0~1000 space — ~20% of page

function clampUnit(v: number): number {
  return Math.max(0, Math.min(1000, Math.round(v)));
}

/** Parse, clamp, and un-invert a bbox from AI output. Swaps y_min/y_max or
 *  x_min/x_max if the AI returned them in the wrong order — a surprisingly
 *  common failure mode for right-column questions where the model confuses
 *  itself about which side is "start". */
function parseBBox(value: unknown): BBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  const [y1, x1, y2, x2] = nums;
  const cy1 = clampUnit(Math.min(y1, y2));
  const cy2 = clampUnit(Math.max(y1, y2));
  const cx1 = clampUnit(Math.min(x1, x2));
  const cx2 = clampUnit(Math.max(x1, x2));
  return [cy1, cx1, cy2, cx2];
}

/** Expand a bbox so it meets a reasonable minimum size, centered on its
 *  current midpoint. Rescues undersized AI outputs (e.g. a box wrapping only
 *  the question number) before they reach sharp.extract. */
function enforceMinBBoxSize(bbox: BBox): BBox {
  const [y1, x1, y2, x2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  let ny1 = y1, nx1 = x1, ny2 = y2, nx2 = x2;

  if (w < BBOX_MIN_WIDTH) {
    const cx = (x1 + x2) / 2;
    const half = BBOX_MIN_WIDTH / 2;
    nx1 = Math.max(0, Math.min(cx - half, 1000 - BBOX_MIN_WIDTH));
    nx2 = nx1 + BBOX_MIN_WIDTH;
  }
  if (h < BBOX_MIN_HEIGHT) {
    const cy = (y1 + y2) / 2;
    const half = BBOX_MIN_HEIGHT / 2;
    ny1 = Math.max(0, Math.min(cy - half, 1000 - BBOX_MIN_HEIGHT));
    ny2 = ny1 + BBOX_MIN_HEIGHT;
  }

  return [clampUnit(ny1), clampUnit(nx1), clampUnit(ny2), clampUnit(nx2)];
}

function extractQuestions(raw: string): AIQuestion[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      questions?: Partial<AIQuestion>[];
    };
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions.map((q, idx) => {
      const rawCount = (q as Record<string, unknown>).optionsCount;
      const optionsCount =
        typeof rawCount === "number" && Number.isFinite(rawCount)
          ? Math.round(rawCount)
          : null;
      return {
        questionNumber:
          typeof q.questionNumber === "number" ? q.questionNumber : idx + 1,
        type:
          q.type === "multiple_choice" ||
          q.type === "multi_select" ||
          q.type === "ox" ||
          q.type === "short_answer" ||
          q.type === "essay"
            ? q.type
            : "short_answer",
        optionsCount,
        answer: typeof q.answer === "string" ? q.answer : "",
        explanation: typeof q.explanation === "string" ? q.explanation : "",
        materialImageBBox: parseBBox(q.materialImageBBox),
        questionImageBBox: (() => {
          const parsed = parseBBox(
            (q as Record<string, unknown>).questionImageBBox
          );
          return parsed ? enforceMinBBoxSize(parsed) : null;
        })(),
      };
    });
  } catch (err) {
    console.warn("[parse-pdf] JSON parse failed", err, cleaned.slice(0, 200));
    return [];
  }
}

async function cropBBox(
  base64: string,
  bbox: BBox
): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, "base64");
    const image = sharp(buffer);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;

    const [y_min, x_min, y_max, x_max] = bbox;
    const PAD = 0;
    const top = Math.max(0, Math.floor((y_min / 1000) * height) - PAD);
    const left = Math.max(0, Math.floor((x_min / 1000) * width) - PAD);
    const bottom = Math.min(
      height,
      Math.ceil((y_max / 1000) * height) + PAD
    );
    const right = Math.min(
      width,
      Math.ceil((x_max / 1000) * width) + PAD
    );
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth <= 4 || cropHeight <= 4) return null;

    const cropped = await image
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .jpeg({ quality: 85 })
      .toBuffer();

    return `data:image/jpeg;base64,${cropped.toString("base64")}`;
  } catch (err) {
    console.warn("[parse-pdf] crop failed", err);
    return null;
  }
}

async function attachCroppedImages(
  aiQuestions: AIQuestion[],
  originalBase64: string
): Promise<ParsedQuestion[]> {
  const cache = new Map<string, string | null>();
  const results: ParsedQuestion[] = [];

  const cropCached = async (bbox: BBox | null): Promise<string | null> => {
    if (!bbox) return null;
    const key = bbox.join(",");
    if (cache.has(key)) return cache.get(key) ?? null;
    const cropped = await cropBBox(originalBase64, bbox);
    cache.set(key, cropped);
    return cropped;
  };

  for (const q of aiQuestions) {
    const materialImage = await cropCached(q.materialImageBBox);
    const questionImage = await cropCached(q.questionImageBBox);
    results.push({
      questionNumber: q.questionNumber,
      type: q.type,
      optionsCount: q.optionsCount,
      answer: q.answer,
      explanation: q.explanation,
      materialImage,
      materialImageBBox: q.materialImageBBox,
      questionImage,
      questionImageBBox: q.questionImageBBox,
    });
  }

  return results;
}

type ImagePart = { mediaType: "image/png" | "image/jpeg"; data: string };

function buildUserText(hasAnswerKey: boolean): string {
  return hasAnswerKey
    ? "첫 번째 이미지는 시험지 페이지, 이후는 정답지/해설지입니다. 본문·보기 텍스트는 절대 전사하지 말고, 각 문항의 번호·유형·보기 개수·정답·해설·크롭 좌표만 JSON으로 반환하세요."
    : "이 시험지 페이지 이미지에서 본문·보기 텍스트는 절대 전사하지 말고, 각 문항의 번호·유형·보기 개수·정답·해설·크롭 좌표만 JSON으로 반환하세요.";
}

async function analyzeWithAnthropic(
  image: ImagePart,
  apiKey: string,
  answerKeyImages: ImagePart[] = []
): Promise<ParsedQuestion[]> {
  const hasKey = answerKeyImages.length > 0;
  const client = new Anthropic({ apiKey });

  const contentParts: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    },
    ...answerKeyImages.map(
      (ak): Anthropic.Messages.ContentBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: ak.mediaType, data: ak.data },
      })
    ),
    { type: "text", text: buildUserText(hasKey) },
  ];

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: contentParts }],
  });

  const text = response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  const aiQuestions = extractQuestions(text);
  return attachCroppedImages(aiQuestions, image.data);
}

async function analyzeWithGemini(
  image: ImagePart,
  apiKey: string,
  answerKeyImages: ImagePart[] = []
): Promise<ParsedQuestion[]> {
  const hasKey = answerKeyImages.length > 0;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemPrompt,
    generationConfig: { responseMimeType: "application/json" },
  });

  const parts = [
    { inlineData: { mimeType: image.mediaType, data: image.data } },
    ...answerKeyImages.map((ak) => ({
      inlineData: { mimeType: ak.mediaType, data: ak.data },
    })),
    { text: buildUserText(hasKey) },
  ];

  const result = await model.generateContent(parts);
  const text = result.response.text();
  const aiQuestions = extractQuestions(text);
  return attachCroppedImages(aiQuestions, image.data);
}

export async function POST(request: Request) {
  try {
    const provider = request.headers.get("x-ai-provider") as Provider | null;
    const apiKey = request.headers.get("x-ai-api-key");

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "API 키가 전달되지 않았습니다. 설정 페이지에서 먼저 등록해 주세요." },
        { status: 401 }
      );
    }
    if (provider !== "anthropic" && provider !== "gemini") {
      return NextResponse.json(
        { error: `지원하지 않는 provider입니다: ${provider}` },
        { status: 400 }
      );
    }

    const body = (await request.json()) as {
      image?: string;
      pageIndex?: number;
      answerKeyImages?: string[];
    };

    if (typeof body.image !== "string" || body.image.length === 0) {
      return NextResponse.json(
        { error: "image 필드가 필요합니다. (dataURL 또는 base64 문자열)" },
        { status: 400 }
      );
    }

    const image = stripDataUrl(body.image);
    const answerKeyParts: ImagePart[] = (body.answerKeyImages ?? [])
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => stripDataUrl(s));

    const questions =
      provider === "anthropic"
        ? await analyzeWithAnthropic(image, apiKey, answerKeyParts)
        : await analyzeWithGemini(image, apiKey, answerKeyParts);

    return NextResponse.json({
      pageIndex: body.pageIndex ?? 0,
      provider,
      questions,
    });
  } catch (err) {
    console.error("[parse-pdf] error", err);
    const message =
      err instanceof Error ? err.message : "PDF 분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
