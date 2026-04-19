"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "student_login";

export type LoggedInStudent = {
  id: string;
  name: string;
  studentNumber: number;
  teacherId?: string;
};

type Listener = () => void;
const listeners = new Set<Listener>();

let cachedRaw: string | null | undefined = undefined;
let cachedStudent: LoggedInStudent | null = null;

function parse(raw: string | null): LoggedInStudent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LoggedInStudent>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.studentNumber === "number"
    ) {
      return {
        id: parsed.id,
        name: parsed.name,
        studentNumber: parsed.studentNumber,
        teacherId:
          typeof parsed.teacherId === "string" ? parsed.teacherId : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function readSnapshot(): LoggedInStudent | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedStudent;
  cachedRaw = raw;
  cachedStudent = parse(raw);
  return cachedStudent;
}

function invalidate() {
  cachedRaw = undefined;
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cachedRaw = undefined;
      listener();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function getLoggedInStudent(): LoggedInStudent | null {
  return readSnapshot();
}

export function setLoggedInStudent(student: LoggedInStudent): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(student));
  invalidate();
}

export function clearLoggedInStudent(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  invalidate();
}

const UNDEFINED_SNAPSHOT: undefined = undefined;
const getServerSnapshot = (): LoggedInStudent | null | undefined =>
  UNDEFINED_SNAPSHOT;

/**
 * `undefined` during SSR / first render, then the student or `null` once
 * hydrated. The undefined state prevents flashing "logged out" UI.
 */
export function useLoggedInStudent(): LoggedInStudent | null | undefined {
  return useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);
}
