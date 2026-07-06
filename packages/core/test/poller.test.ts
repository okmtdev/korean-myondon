import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotEvent, diffStatus } from "../src/poller.ts";

const META = {
  node: "test",
  deviceId: "meter-1",
  deviceName: "寝室温湿度計",
  deviceType: "MeterPlus",
  ts: "2026-07-01T10:00:00.000Z",
};

test("buildSnapshotEvent: snapshot イベントの形", () => {
  const event = buildSnapshotEvent({ humidity: 55 }, META);
  assert.equal(event.kind, "snapshot");
  assert.equal(event.source, "switchbot");
  assert.deepEqual(event.status, { humidity: 55 });
});

test("diffStatus: 初回観測は変化なし扱い", () => {
  assert.deepEqual(diffStatus(undefined, { humidity: 55 }, META), []);
});

test("diffStatus: スカラー値の変化だけを change にする", () => {
  const events = diffStatus(
    { humidity: 55, temperature: 25, power: "on", nested: { a: 1 } },
    { humidity: 62, temperature: 25, power: "off", nested: { a: 2 } },
    META,
  );
  assert.equal(events.length, 2);
  const humidity = events.find((event) => event.field === "humidity");
  assert.deepEqual({ from: humidity?.from, to: humidity?.to }, { from: 55, to: 62 });
  const power = events.find((event) => event.field === "power");
  assert.deepEqual({ from: power?.from, to: power?.to }, { from: "on", to: "off" });
});

test("diffStatus: ID類・ノイズ源フィールドは無視する", () => {
  const events = diffStatus(
    { deviceId: "a", version: "1", timeOfSample: 1, wifiSignal: -50, humidity: 50 },
    { deviceId: "b", version: "2", timeOfSample: 2, wifiSignal: -60, humidity: 50 },
    META,
  );
  assert.deepEqual(events, []);
});

test("diffStatus: source を上書きできる（webhook用）", () => {
  const events = diffStatus({ power: "on" }, { power: "off" }, { ...META, source: "switchbot-webhook" });
  assert.equal(events[0].source, "switchbot-webhook");
});
