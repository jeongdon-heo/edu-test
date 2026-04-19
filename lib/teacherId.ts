"use client";

import { useTeacherSession } from "./teacherAuth";

/**
 * Returns the logged-in teacher's id, or `null` while hydrating / logged out.
 * Route guards in /teacher/* handle redirecting unauthenticated visitors.
 */
export function useTeacherId(): string | null {
  const session = useTeacherSession();
  if (session === undefined) return null;
  return session?.teacherId ?? null;
}
