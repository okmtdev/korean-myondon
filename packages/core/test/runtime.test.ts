import { test } from "node:test";
import assert from "node:assert/strict";
import { fireRules } from "../src/runtime.ts";
import type { ActionExecutor } from "../src/runtime.ts";
import type { Rule } from "../src/rules.ts";
import type { TsukumoEvent } from "../src/events.ts";

const CHANGE: TsukumoEvent = {
  ts: "2026-07-01T10:30:00.000Z",
  node: "test",
  source: "switchbot",
  deviceId: "plug-washer",
  kind: "change",
  field: "power",
  from: "on",
  to: "off",
};

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "washer-done",
    source: "洗濯機が終わったら通知して、ライトをつけて",
    enabled: true,
    trigger: { deviceId: "plug-washer", field: "power", to: "off", from: "on" },
    actions: [
      { type: "notify", message: "洗濯終わったよ" },
      { type: "switchbot_command", deviceId: "plug-light", command: "turnOn" },
    ],
    explanation: "洗濯機プラグがONからOFFに変わったら通知してライトをつける",
    ...overrides,
  };
}

function makeExecutor(options: { failNotify?: boolean } = {}) {
  const calls: string[] = [];
  const executor: ActionExecutor = {
    sendCommand: async (deviceId, command) => {
      calls.push(`cmd:${deviceId}:${command}`);
      return {};
    },
    notify: async (message) => {
      if (options.failNotify) throw new Error("webhook down");
      calls.push(`notify:${message}`);
    },
    log: (message) => {
      calls.push(`log:${message}`);
    },
  };
  return { calls, executor };
}

const CTX = { latest: () => undefined, now: new Date("2026-07-01T10:30:01.000Z") };

test("fireRules: マッチしたルールのアクションを順に実行し、rule イベントを返す", async () => {
  const { calls, executor } = makeExecutor();
  const fired = await fireRules([makeRule()], CHANGE, CTX, executor, { node: "test" });

  assert.deepEqual(calls, ["notify:洗濯終わったよ", "cmd:plug-light:turnOn"]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].kind, "rule");
  assert.equal(fired[0].deviceId, "washer-done");
  const status = fired[0].status as Record<string, any>;
  assert.equal(status.dryRun, false);
  assert.deepEqual(status.trigger, { deviceId: "plug-washer", field: "power", from: "on", to: "off" });
  assert.equal(status.results.every((result: { ok: boolean }) => result.ok), true);
});

test("fireRules: 条件を満たさない・無効・トリガー不一致は発火しない", async () => {
  const { calls, executor } = makeExecutor();
  const rules = [
    makeRule({ id: "disabled", enabled: false }),
    makeRule({ id: "wrong-field", trigger: { deviceId: "plug-washer", field: "voltage" } }),
    makeRule({
      id: "night-only",
      condition: { time: { after: "22:00", before: "06:00" } },
    }),
  ];
  const daytime = { latest: () => undefined, now: new Date(2026, 6, 1, 12, 0) };
  const fired = await fireRules(rules, CHANGE, daytime, executor, { node: "test" });
  assert.equal(fired.length, 0);
  assert.deepEqual(calls, []);
});

test("fireRules: dry-run はアクションを実行せず skipped で記録する", async () => {
  const { calls, executor } = makeExecutor();
  const fired = await fireRules([makeRule()], CHANGE, CTX, executor, { node: "test", dryRun: true });
  assert.deepEqual(calls, []);
  const status = fired[0].status as Record<string, any>;
  assert.equal(status.dryRun, true);
  assert.equal(status.results.every((result: { skipped?: boolean }) => result.skipped === true), true);
});

test("fireRules: アクションの失敗は握って記録し、残りは実行する", async () => {
  const { calls, executor } = makeExecutor({ failNotify: true });
  const fired = await fireRules([makeRule()], CHANGE, CTX, executor, { node: "test" });
  assert.deepEqual(calls, ["cmd:plug-light:turnOn"]);
  const results = (fired[0].status as Record<string, any>).results;
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /webhook down/);
  assert.equal(results[1].ok, true);
});

test("fireRules: condition が最新状態を参照する", async () => {
  const { calls, executor } = makeExecutor();
  const rule = makeRule({
    condition: { device: { deviceId: "meter-1", field: "humidity", gt: 60 } },
  });
  const dry = { latest: (id: string) => (id === "meter-1" ? { humidity: 50 } : undefined), now: new Date() };
  const humid = { latest: (id: string) => (id === "meter-1" ? { humidity: 70 } : undefined), now: new Date() };

  assert.equal((await fireRules([rule], CHANGE, dry, executor, { node: "test" })).length, 0);
  assert.equal((await fireRules([rule], CHANGE, humid, executor, { node: "test" })).length, 1);
  assert.equal(calls.length, 2);
});
