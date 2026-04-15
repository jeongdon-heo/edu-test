import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60;

export type ParsedQuestion = {
  questionNumber: number;
  questionText: string;
  type: "multiple_choice" | "short_answer" | "essay";
  hasImage: boolean;
  options: string[];
  answer: string;
  explanation: string;
  materialImage: string | null;
};

type Provider = "anthropic" | "gemini";

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] normalized 0~1000

type AIQuestion = Omit<ParsedQuestion, "materialImage"> & {
  materialImageBBox: BBox | null;
};

export const systemPrompt = `당신은 대한민국 초등학교 4학년(만 10세) 학생용 시험지를 분석하는 OCR·문서 구조화 전문가입니다.
제공된 시험지 페이지 이미지에서 문항과 각 문항이 가리키는 참고 자료(지문·그림·표)를 분리하고 아래 규칙을 엄격히 지켜 구조화된 JSON을 반환하세요.

[분리·추출 규칙]
1. 문항 번호: 이미지에 표시된 각 문항의 번호(1, 2, 3…)를 questionNumber 필드에 숫자(number)로 담으세요. 번호가 누락된 경우 페이지 상단부터 등장 순서대로 1부터 매기세요.
2. 지문(questionText): 각 문항의 질문 본문을 공백·줄바꿈을 정리해 한 문자열로 담으세요. 문항 번호, 보기 기호(①②③④ 또는 1)·2)), 배점 표기는 제외합니다.
3. 문제 유형(type) — 4학년 수준에서 스스로 판별하세요.
   - "multiple_choice": ①②③④ 혹은 1)·2)·3)·4) 같은 번호가 매겨진 보기가 제시된 객관식.
   - "short_answer": 숫자, 한 단어, 짧은 구(句)로 답하는 단답형·빈칸 채우기·계산 결과 쓰기.
   - "essay": 이유·근거를 설명하거나 여러 문장으로 답하는 서술형.
4. 그림 포함 여부(hasImage):
   - 표, 그래프, 도형, 그림, 사진, 다이어그램, 지도, 수직선, 수 모형처럼 텍스트가 아닌 시각 자료가 문제와 연관되어 있으면 true.
   - 순수 텍스트와 수식(기호)만으로 이루어진 문제는 false.
   판단이 애매한 경우에는 true로 설정하세요.
5. 보기(options):
   - "multiple_choice": 보기 텍스트만 순서대로 담되, 앞의 번호·기호(①, 1., 가. 등)는 제거합니다.
   - "short_answer", "essay": 반드시 빈 배열([])로 두세요.
6. 정답(answer): 초등학교 4학년 수준에 맞춰 문제를 직접 풀이한 정답을 문자열로 담으세요.
   - "multiple_choice": 정답에 해당하는 보기 텍스트를 그대로(번호·기호 없이) 담으세요.
   - "short_answer": 예상 정답(숫자·단어·짧은 구)만 간결하게 담으세요.
   - "essay": 모범 답안의 핵심을 한두 문장으로 요약해 담으세요.
7. 해설(explanation): 왜 그 답이 정답인지 초등학교 4학년 학생이 이해할 수 있도록 한두 문장으로 친근하게 풀이하세요.

8. 참고 자료 영역 감지(materialImageBBox) — 매우 중요:
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
      "type": "multiple_choice" | "short_answer" | "essay",
      "hasImage": boolean,
      "options": string[],
      "answer": string,
      "explanation": string,
      "materialImageBBox": [number, number, number, number] | null
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
        q.type === "short_answer" ||
        q.type === "essay"
          ? q.type
          : "short_answer",
      hasImage: Boolean(q.hasImage),
      options: Array.isArray(q.options) ? (q.options as string[]) : [],
      answer: typeof q.answer === "string" ? q.answer : "",
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      materialImageBBox: parseBBox(q.materialImageBBox),
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
    // 방향별 차등 패딩.
    // - 상단: 지문 안내 문구(※ 등)가 잘리지 않도록 넉넉히(40px) 확보.
    // - 하단: 아래쪽 문제·선택지가 딸려 들어오지 않도록 최소(5px).
    // - 좌우: 균형 있게 30px.
    // 원본 범위를 벗어나지 않도록 Math.max / Math.min 으로 클램프.
    const PAD_TOP = 40;
    const PAD_BOTTOM = 5;
    const PAD_LEFT = 30;
    const PAD_RIGHT = 30;
    const top = Math.max(0, Math.floor((y_min / 1000) * height) - PAD_TOP);
    const left = Math.max(0, Math.floor((x_min / 1000) * width) - PAD_LEFT);
    const bottom = Math.min(
      height,
      Math.ceil((y_max / 1000) * height) + PAD_BOTTOM
    );
    const right = Math.min(
      width,
      Math.ceil((x_max / 1000) * width) + PAD_RIGHT
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
    });
  }

  return results;
}

async function analyzeWithAnthropic(
  image: { mediaType: "image/png" | "image/jpeg"; data: string },
  apiKey: string
): Promise<ParsedQuestion[]> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.data,
            },
          },
          { type: "text", text: "이 시험지 페이지에서 문항과 참고 자료 영역을 추출하세요." },
        ],
      },
    ],
  });

  const text = response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  const aiQuestions = extractQuestions(text);
  return attachMaterialImages(aiQuestions, image.data);
}

async function analyzeWithGemini(
  image: { mediaType: "image/png" | "image/jpeg"; data: string },
  apiKey: string
): Promise<ParsedQuestion[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemPrompt,
    generationConfig: { responseMimeType: "application/json" },
  });
  const result = await model.generateContent([
    { inlineData: { mimeType: image.mediaType, data: image.data } },
    { text: "이 시험지 페이지에서 문항과 참고 자료 영역을 추출하세요." },
  ]);
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
    };

    if (typeof body.image !== "string" || body.image.length === 0) {
      return NextResponse.json(
        { error: "image 필드가 필요합니다. (dataURL 또는 base64 문자열)" },
        { status: 400 }
      );
    }

    const image = stripDataUrl(body.image);

    const questions =
      provider === "anthropic"
        ? await analyzeWithAnthropic(image, apiKey)
        : await analyzeWithGemini(image, apiKey);

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
