export function normalizeAnswer(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function isCorrect(student: string, answer: string): boolean {
  const s = normalizeAnswer(student);
  const a = normalizeAnswer(answer);
  return s.length > 0 && a.length > 0 && s === a;
}
