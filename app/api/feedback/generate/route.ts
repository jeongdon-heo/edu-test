import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const resultIds: string[] = Array.isArray(body?.resultIds) ? body.resultIds : [];

  if (resultIds.length === 0) {
    return NextResponse.json({ feedbacks: [] });
  }

  // TODO: 실제 구현 단계
  // 1) InstantDB admin SDK로 resultIds에 해당하는 결과 + 학생 + 문항 + 정답 조회
  // 2) 각 학생별로 submittedAnswers와 문항/정답을 Anthropic API에 전달하여 피드백 생성
  //    - 모델: claude-sonnet-4-6 또는 claude-haiku-4-5
  //    - 프롬프트: 4학년 눈높이에 맞춘 "잘한 점 / 부족한 점" 1문단 요청
  // 3) 생성된 피드백을 results.aiFeedback 필드로 db.transact 업데이트

  const feedbacks = resultIds.map((id) => ({
    id,
    aiFeedback:
      "(자동 생성 예시) 이번 단원에서 잘한 점과 조금 더 연습하면 좋을 부분이 여기에 요약됩니다.",
  }));

  return NextResponse.json({ feedbacks });
}
