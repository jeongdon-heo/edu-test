"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Provider = "anthropic" | "gemini";

const PROVIDERS: {
  value: Provider;
  label: string;
  hint: string;
  pattern: RegExp;
}[] = [
  {
    value: "anthropic",
    label: "Anthropic Claude 3.5 Sonnet",
    hint: "sk-ant-...",
    pattern: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
  },
  {
    value: "gemini",
    label: "Google Gemini 2.0 Flash",
    hint: "AIza...",
    pattern: /^AIza[A-Za-z0-9_\-]{20,}$/,
  },
];

export default function SettingsPage() {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const storedProvider = localStorage.getItem("ai_provider");
    const storedKey = localStorage.getItem("ai_api_key") ?? "";
    if (storedProvider === "anthropic" || storedProvider === "gemini") {
      setProvider(storedProvider);
    }
    setApiKey(storedKey);
    setHydrated(true);
  }, []);

  const currentProvider =
    PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("API 키를 입력해 주세요.");
      setSaved(false);
      return;
    }
    if (!currentProvider.pattern.test(trimmed)) {
      setError(
        `${currentProvider.label}의 API 키 형식이 올바르지 않습니다. (예: ${currentProvider.hint})`
      );
      setSaved(false);
      return;
    }
    localStorage.setItem("ai_provider", provider);
    localStorage.setItem("ai_api_key", trimmed);
    setApiKey(trimmed);
    setError(null);
    setSaved(true);
  };

  const handleClear = () => {
    localStorage.removeItem("ai_provider");
    localStorage.removeItem("ai_api_key");
    setApiKey("");
    setProvider("anthropic");
    setSaved(false);
    setError(null);
  };

  if (!hydrated) {
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <p className="text-sm text-slate-500">로딩 중...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-slate-900">AI 설정</h1>
          <p className="mt-1 text-slate-600">
            사용할 AI 모델과 본인의 API 키를 등록하세요. 키는 이 브라우저의 localStorage에만 저장되고, 분석 요청 시에만 서버로 전송됩니다.
          </p>
        </header>

        <form
          onSubmit={handleSave}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label className="block">
            <span className="text-sm font-semibold text-slate-700">AI 모델</span>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as Provider);
                setError(null);
                setSaved(false);
              }}
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 focus:border-sky-500 focus:outline-none"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-5 block">
            <span className="text-sm font-semibold text-slate-700">API 키</span>
            <div className="mt-2 flex gap-2">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError(null);
                  setSaved(false);
                }}
                placeholder={currentProvider.hint}
                autoComplete="off"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 font-mono text-sm text-slate-900 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="rounded-lg border border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-100"
              >
                {showKey ? "숨기기" : "보이기"}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              공용 PC에서는 저장하지 말고, 사용 후에는 [저장된 키 삭제]를 눌러 주세요.
            </p>
          </label>

          {error && (
            <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              저장되었습니다.
            </p>
          )}

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={handleClear}
              className="text-sm font-medium text-slate-500 hover:text-slate-700"
            >
              저장된 키 삭제
            </button>
            <div className="flex gap-3">
              <Link
                href="/teacher/upload"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                업로드로 이동
              </Link>
              <button
                type="submit"
                className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-sky-700"
              >
                저장
              </button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
