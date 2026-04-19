"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "teacher_session";

export type TeacherSession = {
  teacherId: string;
  username: string;
  name: string;
};

type Listener = () => void;
const listeners = new Set<Listener>();

// Snapshot cache — useSyncExternalStore requires getSnapshot to return the
// same reference when the underlying data hasn't changed. Parsing JSON on
// every call would create a new object each render and trigger an infinite
// re-render loop.
let cachedRaw: string | null | undefined = undefined;
let cachedSession: TeacherSession | null = null;

function parse(raw: string | null): TeacherSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TeacherSession>;
    if (
      typeof parsed.teacherId === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.name === "string"
    ) {
      return parsed as TeacherSession;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function readSnapshot(): TeacherSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSession;
  cachedRaw = raw;
  cachedSession = parse(raw);
  return cachedSession;
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

export function getTeacherSession(): TeacherSession | null {
  return readSnapshot();
}

export function setTeacherSession(session: TeacherSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  invalidate();
}

export function clearTeacherSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  invalidate();
}

const UNDEFINED_SNAPSHOT: undefined = undefined;
const getServerSnapshot = (): TeacherSession | null | undefined =>
  UNDEFINED_SNAPSHOT;

/**
 * `undefined` during SSR / first render, then the session or `null` once
 * hydrated. The undefined state prevents flashing "logged out" UI.
 */
export function useTeacherSession(): TeacherSession | null | undefined {
  return useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);
}
