import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, compileRule } from "../src/compile.ts";
import type { ApiMessage, LlmProvider } from "../src/providers.ts";
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

/** 応答を順番に返すスタブプロバイダ（呼び出し内容も記録する） */
function stubProvider(responses: unknown[]) {
  const calls: Array<{ system: string; messages: ApiMessage[] }> = [];
  const provider: LlmProvider = {
    label: "stub:test",
    complete: async (system, messages) => {
      calls.push({ system, messages: messages.map((message) => ({ ...message })) });
      const payload = responses[Math.min(calls.length - 1, responses.length - 1)];
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
  return { calls, provider };
}

test("buildSystemPrompt: 仕様・カタログ・既存ルールが埋め込まれる", () => {
  const prompt = buildSystemPrompt(CATALOG, []);
  assert.ok(prompt.includes("kotodama"));
  assert.ok(prompt.includes("meter-1"));
  assert.ok(prompt.includes("humidity"));
  assert.ok(prompt.includes("(まだありません)"));
});

test("compileRule: 正常系 — source/compiledAt/model を埋めてバリデーション通過", async () => {
  const { calls, provider } = stubProvider([{ rule: GOOD_RULE, warnings: ["ファン=plug-fan と解釈しました"] }]);
  const result = await compileRule("湿度が60を超えたらサーキュレーターをつけて", CATALOG, [], provider);

  assert.equal(result.error, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(result.rule?.source, "湿度が60を超えたらサーキュレーターをつけて");
  assert.equal(result.rule?.model, "stub:test");
  assert.ok(result.rule?.compiledAt);
  assert.deepEqual(result.warnings, ["ファン=plug-fan と解釈しました"]);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.includes("meter-1"));
  assert.equal(calls[0].messages[0].content, "湿度が60を超えたらサーキュレーターをつけて");
});

test("compileRule: コードフェンス付き出力も受理する", async () => {
  const fenced = "```json\n" + JSON.stringify({ rule: GOOD_RULE, warnings: [] }) + "\n```";
  const { provider } = stubProvider([fenced]);
  const result = await compileRule("湿度でファン", CATALOG, [], provider);
  assert.equal(result.rule?.id, "humid-fan");
});

test("compileRule: バリデーション違反はフィードバックして1回リトライ", async () => {
  const hallucinated = { ...GOOD_RULE, trigger: { deviceId: "ghost-9", field: "humidity" } };
  const { calls, provider } = stubProvider([
    { rule: hallucinated, warnings: [] },
    { rule: GOOD_RULE, warnings: [] },
  ]);
  const result = await compileRule("湿度でファン", CATALOG, [], provider);

  assert.equal(result.attempts, 2);
  assert.equal(result.rule?.id, "humid-fan");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].role, "assistant");
  assert.ok(calls[1].messages[2].content.includes("バリデーションに失敗"));
  assert.ok(calls[1].messages[2].content.includes("ghost-9"));
});

test("compileRule: JSONでない出力もフィードバックしてリトライ", async () => {
  const { calls, provider } = stubProvider(["ルールを作りました！", JSON.stringify({ rule: GOOD_RULE, warnings: [] })]);
  const result = await compileRule("湿度でファン", CATALOG, [], provider);
  assert.equal(result.attempts, 2);
  assert.equal(result.rule?.id, "humid-fan");
  assert.ok(calls[1].messages[2].content.includes("JSON"));
});

test("compileRule: 2回失敗したら error を返す", async () => {
  const broken = { ...GOOD_RULE, trigger: { deviceId: "ghost-9", field: "humidity" } };
  const { provider } = stubProvider([{ rule: broken, warnings: [] }]);
  const result = await compileRule("湿度でファン", CATALOG, [], provider);
  assert.equal(result.rule, undefined);
  assert.match(result.error ?? "", /コンパイルに失敗/);
});

test("compileRule: 表現できない要望は error で正直に断る", async () => {
  const { provider } = stubProvider([{ error: "在宅かどうかを判定できるデバイスがカタログにありません", warnings: [] }]);
  const result = await compileRule("私が家にいるときだけ通知して", CATALOG, [], provider);
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
  const { provider } = stubProvider([{ rule: GOOD_RULE, warnings: [] }]);
  const result = await compileRule("湿度でファン", CATALOG, [existing], provider);
  assert.ok(result.warnings.some((warning) => warning.includes("old-humid")));
});
