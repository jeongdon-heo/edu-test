"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "student_login";

export type LoggedInStudent = {
  id: string;
  name: string;
  studentNumber: number;
};

export function getLoggedInStudent(): LoggedInStudent | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LoggedInStudent>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.studentNumber === "number"
    ) {
      return parsed as LoggedInStudent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function setLoggedInStudent(student: LoggedInStudent): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(student));
}

export function clearLoggedInStudent(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Hook returns `undefined` until hydration completes, then `null` (logged out)
 * or the student object. The undefined state lets callers avoid flashing a
 * "not logged in" view on first render.
 */
export function useLoggedInStudent(): LoggedInStudent | null | undefined {
  const [state, setState] = useState<LoggedInStudent | null | undefined>(
    undefined
  );
  useEffect(() => {
    setState(getLoggedInStudent());
  }, []);
  return state;
}
