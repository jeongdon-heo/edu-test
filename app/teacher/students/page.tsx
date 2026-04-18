"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { id } from "@instantdb/react";
import { db } from "@/lib/db";
import { useTeacherId } from "@/lib/teacherId";

type ParsedEntry = { studentNumber: number; name: string };

function parseStudentList(raw: string): ParsedEntry[] {
  const tokens = raw
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: ParsedEntry[] = [];
  let autoNum = 1;
  for (const token of tokens) {
    const match = token.match(/^(\d+)\s*(?:번|\.|:|\))?\s*(.+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const name = match[2].trim();
      if (name) {
        entries.push({ studentNumber: num, name });
        autoNum = num + 1;
        continue;
      }
    }
    entries.push({ studentNumber: autoNum, name: token });
    autoNum++;
  }
  return entries;
}

export default function StudentsPage() {
  const teacherId = useTeacherId();
  const [bulkInput, setBulkInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<
    { type: "success" | "error"; text: string } | null
  >(null);

  const { data, isLoading } = db.useQuery({
    students: {
      $: { where: { teacher_id: teacherId ?? "" } },
    },
  });

  const students = useMemo(
    () =>
      [...(data?.students ?? [])].sort(
        (a, b) => (a.studentNumber ?? 0) - (b.studentNumber ?? 0)
      ),
    [data]
  );

  const preview = useMemo(() => parseStudentList(bulkInput), [bulkInput]);

  const handleBulkAdd = async () => {
    if (!teacherId) return;
    if (preview.length === 0) {
      setMessage({ type: "error", text: "유효한 학생 명단이 없어요." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await db.transact(
        preview.map((entry) =>
          db.tx.students[id()].update({
            name: entry.name,
            studentNumber: entry.studentNumber,
            teacher_id: teacherId,
          })
        )
      );
      setMessage({
        type: "success",
        text: `${preview.length}명을 추가했어요.`,
      });
      setBulkInput("");
    } catch (err) {
      console.error("[students] bulk add failed", err);
      setMessage({ type: "error", text: "저장에 실패했어요. 다시 시도해 주세요." });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (studentId: string, name: string) => {
    if (!confirm(`${name} 학생을 삭제할까요?`)) return;
    try {
      await db.transact(db.tx.students[studentId].delete());
    } catch (err) {
      console.error("[students] delete failed", err);
      alert("삭제에 실패했어요.");
    }
  };

  if (!teacherId) {
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <p className="text-sm text-slate-500">로딩 중...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <Link
            href="/teacher"
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            ← 대시보드로
          </Link>
          <h1 className="mt-1 text-3xl font-bold text-slate-900">학생 관리</h1>
          <p className="mt-1 text-slate-600">
            내 반 학생 명단을 관리하세요. 현재 등록된 학생 {students.length}명.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            교사 ID: <span className="font-mono">{teacherId}</span>
          </p>
        </header>

        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">학생 일괄 등록</h2>
          <p className="mt-1 text-sm text-slate-500">
            줄바꿈 또는 쉼표로 구분해 입력하세요. 번호가 없으면 자동으로 매겨집니다.
          </p>
          <textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            placeholder={"예시)\n1번 김민준\n2번 이서연\n3번 박지우"}
            rows={8}
            className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 font-mono text-sm text-slate-900 focus:border-sky-500 focus:outline-none"
          />

          {preview.length > 0 && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
              <p className="mb-2 font-semibold text-slate-700">
                미리보기 ({preview.length}명)
              </p>
              <ul className="flex flex-wrap gap-2">
                {preview.map((e, i) => (
                  <li
                    key={i}
                    className="rounded-full bg-white px-3 py-1 text-xs text-slate-700 ring-1 ring-slate-200"
                  >
                    {e.studentNumber}번 {e.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            {message && (
              <p
                className={`text-sm ${
                  message.type === "success"
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
              >
                {message.text}
              </p>
            )}
            <button
              onClick={handleBulkAdd}
              disabled={saving || preview.length === 0}
              className="ml-auto rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-sky-700"
            >
              {saving ? "추가 중..." : "추가하기"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-4">
            <h2 className="text-lg font-semibold text-slate-900">학생 목록</h2>
          </div>
          {isLoading ? (
            <p className="p-6 text-sm text-slate-500">불러오는 중...</p>
          ) : students.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">
              아직 등록된 학생이 없어요. 위 입력창으로 명단을 한 번에 추가해 보세요.
            </p>
          ) : (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="w-20 px-4 py-3 text-left font-semibold text-slate-700">
                    번호
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-700">
                    이름
                  </th>
                  <th className="w-24 px-4 py-3 text-right font-semibold text-slate-700">
                    동작
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">{s.studentNumber}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {s.name}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(s.id, s.name)}
                        className="text-sm font-medium text-rose-600 hover:underline"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
