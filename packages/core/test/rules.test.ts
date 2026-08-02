import { test } from "node:test";
import assert from "node:assert/strict";
import { evalCondition, matchValue, matchesTrigger, validateRule } from "../src/rules.ts";
import type { Rule } from "../src/rules.ts";
import type { Catalog } from "../src/catalog.ts";
import type { TsukumoEvent } from "../src/events.ts";

const CATALOG: Catalog = {
  devices: [
    {
      deviceId: "meter-1",
      deviceName: "寝室温湿度計",
      deviceType: "MeterPlus",
      fields: ["temperature", "humidity", "battery"],
    },
    { deviceId: "plug-1", deviceName: "洗濯機プラグ", deviceType: "Plug Mini (JP)", fields: ["power", "voltage"] },
  ],
  generatedAt: "2026-07-01T00:00:00.000Z",
};

function validRule(): Rule {
  return {
    id: "humidity-notify",
    source: "湿度が60を超えたら通知して",
    enabled: true,
    trigger: { deviceId: "meter-1", field: "humidity", to: { gt: 60 }, from: { lte: 60 } },
    condition: { time: { after: "08:00", before: "22:00" } },
    actions: [{ type: "notify", message: "湿度が高いよ" }],
    explanation: "湿度が60%を上回った瞬間、日中なら通知する",
  };
}

test("validateRule: 正しいルールは合格する", () => {
  assert.deepEqual(validateRule(validRule(), CATALOG), []);
});

test("validateRule: カタログ外の deviceId / field を弾く（幻覚防止）", () => {
  const unknownDevice = validRule();
  unknownDevice.trigger.deviceId = "ghost-9";
  assert.ok(validateRule(unknownDevice, CATALOG).some((error) => error.includes("カタログにありません")));

  const unknownField = validRule();
  unknownField.trigger.field = "co2";
  assert.ok(validateRule(unknownField, CATALOG).some((error) => error.includes("観測がありません")));

  const unknownActionDevice = validRule();
  unknownActionDevice.actions = [{ type: "switchbot_command", deviceId: "ghost-9", command: "turnOn" }];
  assert.ok(validateRule(unknownActionDevice, CATALOG).some((error) => error.includes("カタログにありません")));
});

test("validateRule: 構造エラーを具体的に返す", () => {
  const bad = validRule() as unknown as Record<string, unknown>;
  bad.id = "Bad ID!";
  bad.actions = [];
  bad.condition = { time: { after: "25:99" }, device: { deviceId: "meter-1", field: "humidity", gt: 1 } };
  const errors = validateRule(bad, CATALOG);
  assert.ok(errors.some((error) => error.startsWith("id:")));
  assert.ok(errors.some((error) => error.startsWith("actions:")));
  assert.ok(errors.some((error) => error.includes("どれか1つだけ")));
});

test("validateRule: catalog なしなら構造チェックのみ", () => {
  const rule = validRule();
  rule.trigger.deviceId = "anything";
  assert.deepEqual(validateRule(rule, null), []);
});

test("validateRule: node は任意だが、指定するなら空でない文字列", () => {
  const withNode = validRule();
  withNode.node = "home";
  assert.deepEqual(validateRule(withNode, CATALOG), []);

  const empty = validRule() as unknown as Record<string, unknown>;
  empty.node = "";
  assert.ok(validateRule(empty, CATALOG).some((error) => error.startsWith("node:")));
});

test("matchValue: プリミティブ一致と比較演算", () => {
  assert.equal(matchValue(undefined, "on"), true);
  assert.equal(matchValue("off", "off"), true);
  assert.equal(matchValue("off", "on"), false);
  assert.equal(matchValue({ gt: 60 }, 65), true);
  assert.equal(matchValue({ gt: 60 }, 60), false);
  assert.equal(matchValue({ gte: 60, lte: 70 }, 60), true);
  assert.equal(matchValue({ lt: 5 }, "3"), true);
  assert.equal(matchValue({ lt: 5 }, "abc"), false);
  assert.equal(matchValue({ ne: "on" }, "on"), false);
});

test("matchesTrigger: change イベントのみ・デバイスとフィールドが一致", () => {
  const trigger = { deviceId: "meter-1", field: "humidity", to: { gt: 60 }, from: { lte: 60 } };
  const change: TsukumoEvent = {
    ts: "2026-07-01T10:30:00.000Z",
    node: "test",
    source: "switchbot",
    deviceId: "meter-1",
    kind: "change",
    field: "humidity",
    from: 55,
    to: 65,
  };
  assert.equal(matchesTrigger(trigger, change), true);
  assert.equal(matchesTrigger(trigger, { ...change, kind: "snapshot" }), false);
  assert.equal(matchesTrigger(trigger, { ...change, field: "temperature" }), false);
  assert.equal(matchesTrigger(trigger, { ...change, from: 62 }), false); // すでに60超えからの変化は発火しない
});

test("evalCondition: allOf / anyOf / not / device / time", () => {
  const latest = (deviceId: string) =>
    deviceId === "plug-1" ? { power: "on", voltage: 100 } : deviceId === "meter-1" ? { humidity: 65 } : undefined;
  const daytime = { latest, now: new Date(2026, 6, 1, 12, 0) };
  const night = { latest, now: new Date(2026, 6, 1, 23, 30) };

  assert.equal(evalCondition(undefined, daytime), true);
  assert.equal(evalCondition({ device: { deviceId: "plug-1", field: "power", equals: "on" } }, daytime), true);
  assert.equal(evalCondition({ device: { deviceId: "plug-1", field: "power", equals: "off" } }, daytime), false);
  assert.equal(evalCondition({ device: { deviceId: "ghost-9", field: "power", equals: "on" } }, daytime), false);
  assert.equal(evalCondition({ device: { deviceId: "meter-1", field: "humidity", gte: 60, lte: 70 } }, daytime), true);
  assert.equal(evalCondition({ not: { device: { deviceId: "plug-1", field: "power", equals: "on" } } }, daytime), false);
  assert.equal(
    evalCondition(
      {
        allOf: [
          { device: { deviceId: "plug-1", field: "power", equals: "on" } },
          { time: { after: "08:00", before: "22:00" } },
        ],
      },
      daytime,
    ),
    true,
  );
  assert.equal(evalCondition({ time: { after: "22:00", before: "06:00" } }, night), true);
  assert.equal(evalCondition({ time: { after: "22:00", before: "06:00" } }, daytime), false);
  assert.equal(
    evalCondition(
      {
        anyOf: [
          { device: { deviceId: "plug-1", field: "power", equals: "off" } },
          { device: { deviceId: "meter-1", field: "humidity", gt: 60 } },
        ],
      },
      daytime,
    ),
    true,
  );
});
