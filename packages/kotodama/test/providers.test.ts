import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  GeminiProvider,
  createProviderFromEnv,
} from "../src/providers.ts";
import type { ApiMessage } from "../src/providers.ts";

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, any>;
}

function fakeFetch(payload: unknown, capture: Captured, ok = true, status = 200): typeof fetch {
  return (async (url: unknown, init: { headers: Record<string, string>; body: string }) => {
    capture.url = String(url);
    capture.headers = init.headers;
    capture.body = JSON.parse(init.body);
    return { ok, status, json: async () => payload, text: async () => "boom-detail" };
  }) as unknown as typeof fetch;
}

const MESSAGES: ApiMessage[] = [
  { role: "user", content: "こんにちは" },
  { role: "assistant", content: "前回の出力" },
  { role: "user", content: "直して" },
];

test("AnthropicProvider: リクエスト形とテキスト抽出", async () => {
  const capture: Captured = {};
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetchImpl: fakeFetch({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }, capture),
  });

  assert.equal(provider.label, `anthropic:${DEFAULT_ANTHROPIC_MODEL}`);
  const text = await provider.complete("system-prompt", MESSAGES);
  assert.equal(text, "AB");
  assert.equal(capture.url, "https://api.anthropic.com/v1/messages");
  assert.equal(capture.headers?.["x-api-key"], "sk-test");
  assert.equal(capture.headers?.["anthropic-version"], "2023-06-01");
  assert.equal(capture.body?.system, "system-prompt");
  assert.equal(capture.body?.temperature, 0);
  assert.deepEqual(
    capture.body?.messages.map((message: ApiMessage) => message.role),
    ["user", "assistant", "user"],
  );
});

test("GeminiProvider: リクエスト形（role変換・system・JSONモード）とテキスト抽出", async () => {
  const capture: Captured = {};
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetchImpl: fakeFetch(
      { candidates: [{ content: { parts: [{ text: "{\"ok\":" }, { text: "true}" }] }, finishReason: "STOP" }] },
      capture,
    ),
  });

  assert.equal(provider.label, `gemini:${DEFAULT_GEMINI_MODEL}`);
  const text = await provider.complete("system-prompt", MESSAGES);
  assert.equal(text, '{"ok":true}');
  assert.equal(capture.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(capture.headers?.["x-goog-api-key"], "g-test");
  assert.equal(capture.body?.systemInstruction.parts[0].text, "system-prompt");
  assert.deepEqual(
    capture.body?.contents.map((content: { role: string }) => content.role),
    ["user", "model", "user"], // assistant → model に変換される
  );
  assert.equal(capture.body?.contents[1].parts[0].text, "前回の出力");
  assert.equal(capture.body?.generationConfig.temperature, 0);
  assert.equal(capture.body?.generationConfig.responseMimeType, "application/json");
});

test("GeminiProvider: candidates が空なら理由つきで例外", async () => {
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetchImpl: fakeFetch({ promptFeedback: { blockReason: "SAFETY" } }, {}),
  });
  await assert.rejects(() => provider.complete("s", [{ role: "user", content: "x" }]), /SAFETY/);
});

test("HTTP エラーは本文つきで例外（両プロバイダ）", async () => {
  const anthropic = new AnthropicProvider({ apiKey: "k", fetchImpl: fakeFetch({}, {}, false, 401) });
  await assert.rejects(() => anthropic.complete("s", [{ role: "user", content: "x" }]), /HTTP 401.*boom-detail/);

  const gemini = new GeminiProvider({ apiKey: "k", fetchImpl: fakeFetch({}, {}, false, 400) });
  await assert.rejects(() => gemini.complete("s", [{ role: "user", content: "x" }]), /HTTP 400.*boom-detail/);
});

test("createProviderFromEnv: キーによる自動選択とモデル上書き", () => {
  assert.equal(createProviderFromEnv({ GEMINI_API_KEY: "g" }).label, `gemini:${DEFAULT_GEMINI_MODEL}`);
  assert.equal(createProviderFromEnv({ GOOGLE_API_KEY: "g" }).label, `gemini:${DEFAULT_GEMINI_MODEL}`);
  assert.equal(createProviderFromEnv({ ANTHROPIC_API_KEY: "a" }).label, `anthropic:${DEFAULT_ANTHROPIC_MODEL}`);
  // 両方あるときの既定は anthropic、TSUKUMO_COMPILE_PROVIDER で明示切り替え
  assert.ok(createProviderFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" }).label.startsWith("anthropic:"));
  assert.ok(
    createProviderFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", TSUKUMO_COMPILE_PROVIDER: "gemini" }).label.startsWith(
      "gemini:",
    ),
  );
  assert.equal(
    createProviderFromEnv({ GEMINI_API_KEY: "g", TSUKUMO_COMPILE_MODEL: "gemini-2.5-pro" }).label,
    "gemini:gemini-2.5-pro",
  );
});

test("createProviderFromEnv: キーなし・不正指定は分かるエラー", () => {
  assert.throws(() => createProviderFromEnv({}), /GEMINI_API_KEY/);
  assert.throws(() => createProviderFromEnv({ TSUKUMO_COMPILE_PROVIDER: "openai" }), /不明/);
  assert.throws(() => createProviderFromEnv({ TSUKUMO_COMPILE_PROVIDER: "gemini" }), /GEMINI_API_KEY/);
  assert.throws(() => createProviderFromEnv({ TSUKUMO_COMPILE_PROVIDER: "anthropic", GEMINI_API_KEY: "g" }), /ANTHROPIC_API_KEY/);
});
