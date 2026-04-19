"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { db } from "@/lib/db";
import { demoClassStudents } from "@/lib/mockData";
import { setLoggedInStudent } from "@/lib/studentLogin";
import { useTeacherSession } from "@/lib/teacherAuth";

type NameTagStudent = {
  id: string;
  name: string;
  studentNumber: number;
};

type TeacherRow = { id: string; createdAt?: number };
type StudentRow = {
  id: string;
  name?: string;
  studentNumber?: number;
  teacher_id?: string;
};

const BADGE_COLORS = [
  "bg-sky-100 text-sky-900 border-sky-300",
  "bg-amber-100 text-amber-900 border-amber-300",
  "bg-emerald-100 text-emerald-900 border-emerald-300",
  "bg-rose-100 text-rose-900 border-rose-300",
  "bg-violet-100 text-violet-900 border-violet-300",
  "bg-teal-100 text-teal-900 border-teal-300",
];

export default function Home() {
  const router = useRouter();
  const session = useTeacherSession();

  const teachersQuery = db.useQuery({ teachers: {} });
  const studentsQuery = db.useQuery({ students: {} });

  const activeTeacherId = useMemo(() => {
    const teachers = (teachersQuery.data?.teachers ?? []) as TeacherRow[];
    const allStudents = (studentsQuery.data?.students ?? []) as StudentRow[];
    if (teachers.length === 0) return null;
    const teacherIds = new Set(teachers.map((t) => t.id));

    // 1) Prefer the logged-in teacher if they're still in the teachers table.
    if (session?.teacherId && teacherIds.has(session.teacherId)) {
      return session.teacherId;
    }

    // 2) Pick the teacher with the most registered students.
    const counts = new Map<string, number>();
    for (const s of allStudents) {
      const tid = s.teacher_id;
      if (tid && teacherIds.has(tid)) {
        counts.set(tid, (counts.get(tid) ?? 0) + 1);
      }
    }

    const ranked = [...teachers].sort((a, b) => {
      const countDiff = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
      if (countDiff !== 0) return countDiff;
      // 3) Tiebreak — newest teacher wins.
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });

    return ranked[0].id;
  }, [teachersQuery.data, studentsQuery.data, session]);

  const classRoster = useMemo<NameTagStudent[]>(() => {
    if (!activeTeacherId) return [];
    const allStudents = (studentsQuery.data?.students ?? []) as StudentRow[];
    return allStudents
      .filter(
        (s): s is StudentRow & { name: string; studentNumber: number } =>
          s.teacher_id === activeTeacherId &&
          typeof s.name === "string" &&
          typeof s.studentNumber === "number"
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        studentNumber: s.studentNumber,
      }))
      .sort((a, b) => a.studentNumber - b.studentNumber);
  }, [studentsQuery.data, activeTeacherId]);

  const isLoading = teachersQuery.isLoading || studentsQuery.isLoading;
  const hasRealRoster = classRoster.length > 0;
  const showingDemo = !isLoading && !hasRealRoster;

  const students: NameTagStudent[] = hasRealRoster
    ? classRoster
    : [...demoClassStudents].sort((a, b) => a.studentNumber - b.studentNumber);

  const handleLogin = (student: NameTagStudent) => {
    setLoggedInStudent(student);
    router.push("/test");
  };

  return (
    <main className="relative min-h-screen bg-gradient-to-b from-sky-50 to-blue-100 px-4 py-10">
      <Link
        href="/teacher/login"
        className="absolute right-4 top-4 rounded-full border border-slate-300 bg-white/80 px-3 py-1.5 text-xs font-medium text-slate-500 shadow-sm transition hover:bg-white hover:text-slate-700"
      >
        선생님용 로그인
      </Link>

      <div className="mx-auto max-w-4xl">
        <header className="mb-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-sky-600">
            4학년 우리 반
          </p>
          <h1 className="mt-2 text-4xl font-extrabold text-sky-900 sm:text-5xl">
            내 번호를 눌러 주세요
          </h1>
          <p className="mt-3 text-lg text-sky-700">
            출석 번호를 터치하면 바로 시험 목록으로 이동해요.
          </p>
        </header>

        {isLoading && (
          <p className="text-center text-lg text-slate-500">
            우리 반 친구들을 불러오는 중이에요...
          </p>
        )}

        {!isLoading && (
          <>
            {showingDemo && (
              <p className="mb-5 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-800">
                아직 반 학생이 등록되지 않아서 예시 명단을 보여주고 있어요.
                선생님이 <span className="font-bold">학생 명단</span>을
                저장하면 실제 학생 이름표로 바뀝니다.
              </p>
            )}

            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 md:gap-4 lg:grid-cols-5">
              {students.map((student, idx) => {
                const color = BADGE_COLORS[idx % BADGE_COLORS.length];
                return (
                  <li key={student.id}>
                    <button
                      type="button"
                      aria-label={`${student.studentNumber}번`}
                      onClick={() => handleLogin(student)}
                      className={`flex aspect-square w-full flex-col items-center justify-center rounded-3xl border-4 bg-white p-4 shadow-md transition active:scale-[0.97] hover:-translate-y-0.5 hover:shadow-lg ${color}`}
                    >
                      <span className="text-5xl font-black leading-none sm:text-6xl">
                        {student.studentNumber}
                      </span>
                      <span className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
                        번
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
