"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTeacherSession } from "@/lib/teacherAuth";

const PUBLIC_PATHS = new Set(["/teacher/login", "/teacher/signup"]);

export default function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = useTeacherSession();
  const router = useRouter();
  const pathname = usePathname();
  const isPublic = PUBLIC_PATHS.has(pathname);

  useEffect(() => {
    if (session === undefined) return;
    if (isPublic) return;
    if (!session) router.replace("/teacher/login");
  }, [session, isPublic, router]);

  if (isPublic) return <>{children}</>;

  if (session === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-400">불러오는 중...</p>
      </main>
    );
  }

  if (!session) return null;

  return <>{children}</>;
}
