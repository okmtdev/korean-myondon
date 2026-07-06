import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, buildSystemPrompt, compileRule } from "../src/compile.ts";
import type { Catalog } from "../../core/src/catalog.ts";
import type { Rule } from "../../core/src/rules.ts";

const CATALOG: Catalog = {
  devices: [
    { deviceId: "meter-1", deviceName: "寝室温湿度計", deviceType: "MeterPlus", fields: ["temperature", "humidity"] },
    { deviceId: "plug-fan", deviceName: "サーキュレーター", deviceType: "Plug Mini (JP)", fields: ["power"] },
  ],
  generatedAt: "2026-07-01T00:00:00.000Z",
};

const GOOD_RULE = {
  id: "humid-fan",
  enabled: true,
  trigger: { deviceId: "meter-1", field: "humidity", to: { gt: 60 }, from: { lte: 60 } },
  actions: [{ type: "switchbot_command", deviceId: "plug-fan", command: "turnOn" }],
  explanation: "湿度が60を超えた瞬間にサーキュレーターをつける",
};

function apiResponse(payload: unknown): unknown {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

function fakeClaude(responses: unknown[]) {
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: unknown, init: { body: string }) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const payload = responses[Math.min(requests.length - 1, responses.length - 1)];
    return { ok: true, status: 200, json: async () => payload, text: async () => "" };
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const DEPS = { apiKey: "sk-test" };

test("buildSystemPrompt: 仕様・カタログ・既存ルールが埋め込まれる", () => {
  const prompt = buildSystemPrompt(CATALOG, []);
  assert.ok(prompt.includes("kotodama"));
  assert.ok(prompt.includes("meter-1"));
  assert.ok(prompt.includes("humidity"));
  assert.ok(prompt.includes("(まだありません)"));
});

test("compileRule: 正常系 — source/compiledAt/model を埋めてバリデーション通過", async () => {
  const { requests, fetchImpl } = fakeClaude([apiResponse({ rule: GOOD_RULE, warnings: ["ファン=plug-fan と解釈しました"] })]);
  const result = await compileRule("湿度が60を超えたらサーキュレーターをつけて", CATALOG, [], { ...DEPS, fetchImpl });

  assert.equal(result.error, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(result.rule?.source, "湿度が60を超えたらサーキュレーターをつけて");
  assert.equal(result.rule?.model, DEFAULT_MODEL);
  assert.ok(result.rule?.compiledAt);
  assert.deepEqual(result.warnings, ["ファン=plug-fan と解釈しました"]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0].body.temperature, 0);
  assert.ok(String(requests[0].body.system).includes("meter-1"));
  assert.equal(requests[0].body.messages[0].content, "湿度が60を超えたらサーキュレーターをつけて");
});

test("compileRule: コードフェンス付き出力も受理する", async () => {
  const fenced = "```json\n" + JSON.stringify({ rule: GOOD_RULE, warnings: [] }) + "\n```";
  const { fetchImpl } = fakeClaude([apiResponse(fenced)]);
  const result = await compileRule("湿度でファン", CATALOG, [], { ...DEPS, fetchImpl });
  assert.equal(result.rule?.id, "humid-fan");
});

test("compileRule: バリデーション違反はフィードバックして1回リトライ", async () => {
  const hallucinated = { ...GOOD_RULE, trigger: { deviceId: "ghost-9", field: "humidity" } };
  const { requests, fetchImpl } = fakeClaude([
    apiResponse({ rule: hallucinated, warnings: [] }),
    apiResponse({ rule: GOOD_RULE, warnings: [] }),
  ]);
  const result = await compileRule("湿度でファン", CATALOG, [], { ...DEPS, fetchImpl });

  assert.equal(result.attempts, 2);
  assert.equal(result.rule?.id, "humid-fan");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.messages.length, 3);
  assert.ok(String(requests[1].body.messages[2].content).includes("バリデーションに失敗"));
  assert.ok(String(requests[1].body.messages[2].content).includes("ghost-9"));
});

test("compileRule: 2回失敗したら error を返す", async () => {
  const broken = { ...GOOD_RULE, trigger: { deviceId: "ghost-9", field: "humidity" } };
  const { fetchImpl } = fakeClaude([apiResponse({ rule: broken, warnings: [] })]);
  const result = await compileRule("湿度でファン", CATALOG, [], { ...DEPS, fetchImpl });
  assert.equal(result.rule, undefined);
  assert.match(result.error ?? "", /コンパイルに失敗/);
});

test("compileRule: 表現できない要望は error で正直に断る", async () => {
  const { fetchImpl } = fakeClaude([
    apiResponse({ error: "在宅かどうかを判定できるデバイスがカタログにありません", warnings: [] }),
  ]);
  const result = await compileRule("私が家にいるときだけ通知して", CATALOG, [], { ...DEPS, fetchImpl });
  assert.equal(result.rule, undefined);
  assert.match(result.error ?? "", /在宅/);
});

test("compileRule: 既存ルールと同トリガーなら warning を足す", async () => {
  const existing: Rule = {
    ...(GOOD_RULE as unknown as Rule),
    id: "old-humid",
    source: "以前のルール",
    actions: [{ type: "notify", message: "x" }],
  };
  const { fetchImpl } = fakeClaude([apiResponse({ rule: GOOD_RULE, warnings: [] })]);
  const result = await compileRule("湿度でファン", CATALOG, [existing], { ...DEPS, fetchImpl });
  assert.ok(result.warnings.some((warning) => warning.includes("old-humid")));
});

test("compileRule: API エラーは例外", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => "unauthorized",
  })) as unknown as typeof fetch;
  await assert.rejects(() => compileRule("x", CATALOG, [], { ...DEPS, fetchImpl }), /HTTP 401/);
});
