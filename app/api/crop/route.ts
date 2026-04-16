import { NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";

type BBox = [number, number, number, number]; // [y_min, x_min, y_max, x_max] 0~1000

export async function POST(request: Request) {
  try {
    const { image, bbox, padding: paddingParam } = (await request.json()) as {
      image?: string;
      bbox?: BBox;
      padding?: number;
    };

    if (
      !image ||
      !bbox ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((v) => typeof v !== "number" || !Number.isFinite(v))
    ) {
      return NextResponse.json(
        { error: "image(base64/dataURL)와 bbox([y_min,x_min,y_max,x_max])가 필요합니다." },
        { status: 400 }
      );
    }

    const base64 = image.replace(/^data:image\/[a-z]+;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    const img = sharp(buffer);
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) {
      return NextResponse.json(
        { error: "이미지를 읽을 수 없습니다." },
        { status: 400 }
      );
    }

    const [yMin, xMin, yMax, xMax] = bbox;
    const PAD =
      typeof paddingParam === "number"
        ? Math.max(0, Math.min(100, Math.round(paddingParam)))
        : 0;
    const top = Math.max(0, Math.floor((yMin / 1000) * h) - PAD);
    const left = Math.max(0, Math.floor((xMin / 1000) * w) - PAD);
    const bottom = Math.min(h, Math.ceil((yMax / 1000) * h) + PAD);
    const right = Math.min(w, Math.ceil((xMax / 1000) * w) + PAD);
    const cropW = right - left;
    const cropH = bottom - top;

    if (cropW <= 4 || cropH <= 4) {
      return NextResponse.json(
        { error: "선택 영역이 너무 작습니다." },
        { status: 400 }
      );
    }

    const cropped = await img
      .extract({ left, top, width: cropW, height: cropH })
      .jpeg({ quality: 85 })
      .toBuffer();

    return NextResponse.json({
      croppedImage: `data:image/jpeg;base64,${cropped.toString("base64")}`,
    });
  } catch (err) {
    console.error("[crop] error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "크롭 중 오류 발생" },
      { status: 500 }
    );
  }
}
