"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "teacher_id";

export function getOrCreateTeacherId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `teacher-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export function useTeacherId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(getOrCreateTeacherId());
  }, []);
  return id;
}
