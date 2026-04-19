"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "teacher_session";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
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

export type TeacherSession = {
  teacherId: string;
  username: string;
  name: string;
};

export function getTeacherSession(): TeacherSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
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

export function setTeacherSession(session: TeacherSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  notify();
}

export function clearTeacherSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  notify();
}

/**
 * `undefined` during SSR / first render, then the session or `null` once
 * hydrated. The undefined state prevents flashing "logged out" UI.
 */
export function useTeacherSession(): TeacherSession | null | undefined {
  return useSyncExternalStore(
    subscribe,
    getTeacherSession,
    () => undefined as TeacherSession | null | undefined
  );
}
