import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60;

export type ParsedQuestion = {
  questionNumber: number;
  questionText: string;
  type: "multiple_choice" | "multi_select" | "ox" | "short_answer" | "essay";
  hasImage: boolean;
  options: string[];
  answer: string;
  explanation: string;
  materialImage: string | null;
  materialImageBBox: [number, number, number, number] | null;
  blankCount: number | null;
  subItems: string[] | null;
  requiresProcess: boolean;
  unit: string | null;
  rubric: string | null;
};

type Provider = "anthropic" | "gemini";

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] normalized 0~1000

type AIQuestion = Omit<ParsedQuestion, "materialImage"> & {
  materialImageBBox: BBox | null;
  blankCount: number | null;
  subItems: string[] | null;
  requiresProcess: boolean;
  unit: string | null;
  rubric: string | null;
};

export const systemPrompt = `당신은 대한민국 초등학교 4학년(만 10세) 학생용 시험지를 분석하는 OCR·문서 구조화 전문가입니다.
제공된 시험지 페이지 이미지에서 문항과 각 문항이 가리키는 참고 자료(지문·그림·표)를 분리하고 아래 규칙을 엄격히 지켜 구조화된 JSON을 반환하세요.

[분리·추출 규칙]
1. 문항 번호: 이미지에 표시된 각 문항의 번호(1, 2, 3…)를 questionNumber 필드에 숫자(number)로 담으세요. 번호가 누락된 경우 페이지 상단부터 등장 순서대로 1부터 매기세요.

2. 지문(questionText) — **매우 중요, 절대 누락 금지:**
   - 각 문항의 질문 본문을 공백·줄바꿈을 정리해 한 문자열로 담으세요.
   - **<보기> 박스, 표, 조건표, 추가 설명 등 문제를 풀기 위해 필요한 모든 텍스트 정보를 반드시 questionText에 포함하세요.**
   - 예: "보기에서 골라", "보기의 내용을 비교해" 같은 문구가 있을 때, 해당 <보기> 박스의 내용(㉠, ㉡, ㉢ 등)을 통째로 questionText에 넣어야 합니다.
   - 문항 번호, 선택지 기호(①②③④ 또는 1)·2)), 배점 표기만 제외합니다.

3. 문제 유형(type) — 5가지 중 하나로 판별하세요:
   - "multiple_choice": ①②③④ 혹은 1)·2)·3)·4) 같은 번호가 매겨진 보기가 제시된 객관식. **단일 정답.**
   - "multi_select": 객관식이되 "두 가지를 고르시오", "모두 고르시오", "두 개를 골라" 등 **복수 정답**을 요구하는 문항. options는 동일하게 담되, answer에는 정답들을 쉼표(,)로 구분하여 담으세요 (예: "보기1,보기3").
   - "ox": "○표를 하시오", "×표를 하시오", "맞으면 ○, 틀리면 ×" 등 O/X(참/거짓)로 답하는 문항. options는 ["O", "X"]로 고정하세요.
   - "short_answer": 숫자, 한 단어, 짧은 구(句)로 답하는 단답형·빈칸 채우기·계산 결과 쓰기.
   - "essay": 이유·근거를 설명하거나 여러 문장으로 답하는 서술형.

   **특수 변환 규칙 (반드시 따르세요):**
   - 정답이 원문자(㉠, ㉡, ㉢, ㉣ 등)이거나, "기호를 쓰시오"라는 문구가 있으면, type을 "short_answer"가 아니라 **"multiple_choice"**로 설정하고, options에 해당 원문자들(["㉠", "㉡", "㉢", "㉣"] 등)을 담으세요.

4. 기호 원형 보존 — **절대 규칙:**
   - 원문자(㉠, ㉡, ㉢, ㉣), 동그라미 번호(①, ②, ③, ④), 로마 숫자(Ⅰ, Ⅱ) 등 이미지에 있는 특수 기호를 절대로 ㄱ/ㄴ/ㄷ, 1/2/3, a/b/c 등 다른 문자로 변환하지 마세요.
   - 반드시 이미지에 표시된 기호 형태 그대로 추출하여 questionText, options 배열, answer에 담으세요.
   - 예: 이미지에 "㉠, ㉡, ㉢"이 있으면 options에도 ["㉠ …", "㉡ …", "㉢ …"]으로, answer에도 "㉠" 형태 그대로 담아야 합니다.

5. 그림 포함 여부(hasImage):
   - 표, 그래프, 도형, 그림, 사진, 다이어그램, 지도, 수직선, 수 모형처럼 텍스트가 아닌 시각 자료가 문제와 연관되어 있으면 true.
   - 순수 텍스트와 수식(기호)만으로 이루어진 문제는 false.
   판단이 애매한 경우에는 true로 설정하세요.
6. 보기(options):
   - "multiple_choice", "multi_select": 보기 텍스트만 순서대로 담되, 앞의 번호·기호(①, 1., 가. 등)는 제거합니다.
   - "ox": 반드시 ["O", "X"]로 담으세요.
   - "short_answer", "essay": 반드시 빈 배열([])로 두세요.
7. 정답(answer) — 정답지 없이 분석하는 경우:
   초등학교 4학년 수준에 맞춰 문제를 직접 풀이한 정답을 문자열로 담으세요.
   - "multiple_choice": 정답에 해당하는 보기 텍스트를 그대로(번호·기호 없이) 담으세요.
   - "multi_select": 정답 보기 텍스트들을 쉼표(,)로 구분해 담으세요. (예: "보기1,보기3")
   - "ox": "O" 또는 "X"만 담으세요.
   - "short_answer": 예상 정답(숫자·단어·짧은 구)만 간결하게 담으세요.
   - "essay": 모범 답안의 핵심을 한두 문장으로 요약해 담으세요.
   - 다중 빈칸(blankCount≥2)이나 소문항(subItems)이 있는 문제: 각 정답을 ";;"(세미콜론 두 개)으로 구분해 담으세요. (예: "답1;;답2;;답3")
8. 해설(explanation): 왜 그 답이 정답인지 초등학교 4학년 학생이 이해할 수 있도록 한두 문장으로 친근하게 풀이하세요.

9. 다중 빈칸 감지(blankCount):
   - 문제에 네모 칸(□), 빈 괄호(  ), 밑줄(___) 등 빈칸이 2개 이상 있는 경우, 빈칸의 총 개수를 blankCount에 숫자로 담으세요.
   - 빈칸이 1개이거나 빈칸 문제가 아닌 경우 blankCount를 null로 두세요.
   - type은 "short_answer"로 설정하세요.

10. 소문항 분리(subItems):
    - 문제 안에 (1), (2), ①, ② 등 번호가 매겨진 소문항이 2개 이상 있으면, 각 소문항의 텍스트를 배열로 담으세요.
    - 예: ["(1) 3/5 + 1/5 =", "(2) 7/8 - 3/8 ="]
    - answer에는 각 소문항의 정답을 ";;"으로 구분하세요. (예: "4/5;;1/2")
    - 소문항이 없는 문제는 subItems를 null로 두세요.
    - subItems가 있는 문제의 type은 "short_answer"로 설정하세요.

11. 풀이 과정 필요 여부(requiresProcess):
    - "풀이 과정을 쓰시오", "풀이 과정과 답을 구하시오", "풀이", "어떻게 구했는지 쓰시오" 등 풀이 과정을 별도로 요구하는 문제는 requiresProcess를 true로 설정하세요.
    - 그 외의 문제는 requiresProcess를 false로 두세요.

12. 정답 단위 분리(unit):
    - 문제가 특정 단위를 포함한 답을 기대할 때(예: "몇 년", "몇 일", "몇 개", "몇 원", "몇 명", "몇 cm" 등), 해당 단위를 unit 필드에 담으세요. (예: "년", "일", "개", "원", "명", "cm")
    - 이 경우 answer 필드에는 단위를 제외한 값만 담으세요. (예: answer: "5", unit: "년")
    - 단위가 필요 없는 문제는 unit을 null로 두세요.
    - 객관식(multiple_choice, multi_select), OX, 서술형(essay)에는 unit을 null로 두세요.

13. 참고 자료 영역 감지(materialImageBBox) — 매우 중요:
   - 문제(No.) 번호만 찾지 말고, 해당 문제를 **풀기 위해 반드시 참고해야 하는** 독립 지문([A]·[가] 같은 박스 지문, 시·이야기 본문), 표, 그래프, 도형, 지도, 그림, 사진의 영역을 찾아내세요.
   - 여러 문항이 같은 지문/그림을 공유하는 국어 시험지 형태가 흔합니다. 이 경우 공유 중인 모든 문항에 **동일한 좌표**를 복사해 담으세요.
   - 좌표 형식: [y_min, x_min, y_max, x_max], 0~1000 범위로 정규화된 정수.
     - 이미지의 좌상단이 (0,0), 우하단이 (1000,1000).
     - y는 세로(위→아래), x는 가로(왼→오른).
   - **영역 경계 규칙 (반드시 지켜야 함):**
     - 시작(y_min): 지문/자료를 안내하는 문구(예: "※ [1~3] 다음 글을 읽고 …", "[가]", "다음 지도를 보고 …")가 있으면 그 문구의 맨 윗줄부터 포함합니다.
     - 끝(y_max): 지문/자료의 **마지막 내용 줄까지만** 포함합니다. 그 아래에 이어지는 문제 번호(1., 2., 3.…), 문제 지문, 선택지(①②③④)는 **절대 포함하지 마세요.**
     - 즉, 자료 박스와 첫 번째 문제 사이의 빈 공간이 있으면 그 빈 공간 '위쪽'에서 y_max를 끊으세요.
   - 문제 자체에 포함된 작은 그림(예: 본문 중간에 삽입된 도형 1개)도 참고가 필요하면 좌표를 담으세요.
   - 참고 자료가 없고 문제 텍스트만으로 풀 수 있는 문항은 materialImageBBox를 null로 두세요.

[출력 규칙]
- 반드시 아래 스키마에 정확히 맞는 JSON 하나만 출력합니다.
- 마크다운 코드 블록(\`\`\`), 주석, 설명 문장, 인사말을 절대 포함하지 마세요.
- 문항이 하나도 없으면 "questions"를 빈 배열로 반환하세요.

{
  "questions": [
    {
      "questionNumber": number,
      "questionText": string,
      "type": "multiple_choice" | "multi_select" | "ox" | "short_answer" | "essay",
      "hasImage": boolean,
      "options": string[],
      "answer": string,
      "explanation": string,
      "materialImageBBox": [number, number, number, number] | null,
      "blankCount": number | null,
      "subItems": string[] | null,
      "requiresProcess": boolean,
      "unit": string | null
    }
  ]
}`;

/** 정답지가 함께 제공되었을 때, systemPrompt의 7번·8번 규칙을 대체하는 보충 지시문 */
const ANSWER_KEY_OVERRIDE = `

[정답지/해설지 활용 규칙 — 최우선, 절대 규칙]
이번 요청에는 시험지 이미지(첫 번째)와 함께 정답지/해설지 이미지(두 번째부터)가 제공되었습니다.

** 7번·8번 규칙을 다음으로 완전히 대체합니다: **

7. 정답(answer) — 정답지 참조 모드:
   - 각 문항의 정답은 반드시 정답지/해설지에 적힌 내용을 그대로 옮겨 적으세요.
   - 절대 스스로 계산하거나 추론하여 정답을 만들지 마세요.
   - 정답지의 문항 번호와 시험지의 문항 번호를 정확히 매칭하세요.
   - 복수 정답이나 인정 답안이 정답지에 기재되어 있다면 모두 포함하세요.
   - "multiple_choice": 정답에 해당하는 보기 텍스트를 시험지에서 찾아 그대로(번호·기호 없이) 담으세요.
   - "multi_select": 정답 보기 텍스트들을 쉼표(,)로 구분해 담으세요.
   - "ox": "O" 또는 "X"만 담으세요.
   - "short_answer": 정답지에 적힌 정답을 그대로 옮기세요.
   - "essay": 정답지에 적힌 모범 답안을 그대로 옮기세요.
   - 다중 빈칸(blankCount≥2)이나 소문항(subItems)이 있는 문제: 정답지의 각 답을 ";;"으로 구분해 담으세요.

8. 해설(explanation):
   - 정답지/해설지에 해설이 있으면 그 내용을 그대로 옮겨 적으세요.
   - 해설이 없으면 빈 문자열("")로 두세요. 해설을 직접 지어내지 마세요.
`;

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

function parseBBox(value: unknown): BBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums as BBox;
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
      questions?: Partial<AIQuestion & { materialImageBBox: unknown }>[];
    };
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions.map((q, idx) => ({
      questionNumber:
        typeof q.questionNumber === "number" ? q.questionNumber : idx + 1,
      questionText: typeof q.questionText === "string" ? q.questionText : "",
      type:
        q.type === "multiple_choice" ||
        q.type === "multi_select" ||
        q.type === "ox" ||
        q.type === "short_answer" ||
        q.type === "essay"
          ? q.type
          : "short_answer",
      hasImage: Boolean(q.hasImage),
      options: Array.isArray(q.options) ? (q.options as string[]) : [],
      answer: typeof q.answer === "string" ? q.answer : "",
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      materialImageBBox: parseBBox(q.materialImageBBox),
      blankCount:
        typeof (q as Record<string, unknown>).blankCount === "number"
          ? ((q as Record<string, unknown>).blankCount as number)
          : null,
      subItems:
        Array.isArray((q as Record<string, unknown>).subItems)
          ? ((q as Record<string, unknown>).subItems as string[])
          : null,
      requiresProcess: Boolean((q as Record<string, unknown>).requiresProcess),
      unit:
        typeof (q as Record<string, unknown>).unit === "string"
          ? ((q as Record<string, unknown>).unit as string)
          : null,
      rubric:
        typeof (q as Record<string, unknown>).rubric === "string"
          ? ((q as Record<string, unknown>).rubric as string)
          : null,
    }));
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
    // 패딩 0: 선생님이 지정한 영역(또는 AI bbox)이 1:1 그대로 잘림.
    // 원본 범위를 벗어나지 않도록 Math.max / Math.min 으로 클램프.
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

async function attachMaterialImages(
  aiQuestions: AIQuestion[],
  originalBase64: string
): Promise<ParsedQuestion[]> {
  const cache = new Map<string, string | null>();
  const results: ParsedQuestion[] = [];

  for (const q of aiQuestions) {
    let materialImage: string | null = null;
    if (q.materialImageBBox) {
      const key = q.materialImageBBox.join(",");
      if (cache.has(key)) {
        materialImage = cache.get(key) ?? null;
      } else {
        materialImage = await cropBBox(originalBase64, q.materialImageBBox);
        cache.set(key, materialImage);
      }
    }
    results.push({
      questionNumber: q.questionNumber,
      questionText: q.questionText,
      type: q.type,
      hasImage: q.hasImage,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      materialImage,
      materialImageBBox: q.materialImageBBox,
      blankCount: q.blankCount,
      subItems: q.subItems,
      requiresProcess: q.requiresProcess,
      unit: q.unit,
      rubric: q.rubric,
    });
  }

  return results;
}

type ImagePart = { mediaType: "image/png" | "image/jpeg"; data: string };

function buildPrompt(hasAnswerKey: boolean): string {
  return hasAnswerKey ? systemPrompt + ANSWER_KEY_OVERRIDE : systemPrompt;
}

function buildUserText(hasAnswerKey: boolean, pageText?: string): string {
  let text = hasAnswerKey
    ? "첫 번째 이미지는 시험지 페이지이고, 이후 이미지들은 정답지/해설지입니다. 시험지에서 문항과 참고 자료 영역을 추출하되, 정답과 해설은 반드시 정답지에서 가져오세요."
    : "이 시험지 페이지에서 문항과 참고 자료 영역을 추출하세요.";

  if (pageText) {
    text += `\n\n[PDF 텍스트 레이어 — 100% 정확한 원본 텍스트]
아래는 PDF에서 직접 추출한 텍스트입니다. OCR 오류가 없으므로 questionText, options 등 텍스트 필드를 채울 때 이 데이터를 우선 사용하세요.
이미지 분석(AI 비전)은 그림/표/도형 영역(materialImageBBox) 파악과 문항 구조 분석에 집중하세요.
텍스트 레이어에 없는 시각 자료(그래프, 도형, 사진 등)는 이미지에서 직접 확인하세요.

--- 추출된 텍스트 ---
${pageText}
--- 끝 ---`;
  }

  return text;
}

async function analyzeWithAnthropic(
  image: ImagePart,
  apiKey: string,
  answerKeyImages: ImagePart[] = [],
  pageText?: string
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
    { type: "text", text: buildUserText(hasKey, pageText) },
  ];

  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildPrompt(hasKey),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: contentParts }],
  });

  const text = response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  const aiQuestions = extractQuestions(text);
  return attachMaterialImages(aiQuestions, image.data);
}

async function analyzeWithGemini(
  image: ImagePart,
  apiKey: string,
  answerKeyImages: ImagePart[] = [],
  pageText?: string
): Promise<ParsedQuestion[]> {
  const hasKey = answerKeyImages.length > 0;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: buildPrompt(hasKey),
    generationConfig: { responseMimeType: "application/json" },
  });

  const parts = [
    { inlineData: { mimeType: image.mediaType, data: image.data } },
    ...answerKeyImages.map((ak) => ({
      inlineData: { mimeType: ak.mediaType, data: ak.data },
    })),
    { text: buildUserText(hasKey, pageText) },
  ];

  const result = await model.generateContent(parts);
  const text = result.response.text();
  const aiQuestions = extractQuestions(text);
  return attachMaterialImages(aiQuestions, image.data);
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
      pageText?: string;
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

    const pageText =
      typeof body.pageText === "string" && body.pageText.trim()
        ? body.pageText
        : undefined;

    const questions =
      provider === "anthropic"
        ? await analyzeWithAnthropic(image, apiKey, answerKeyParts, pageText)
        : await analyzeWithGemini(image, apiKey, answerKeyParts, pageText);

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
