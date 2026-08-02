import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../src/store.ts";
import { aggregate, collectSamples, queryEvents, thresholdSpans } from "../src/history.ts";
import type { TsukumoEvent } from "../src/events.ts";

function snapshot(ts: string, humidity: number): TsukumoEvent {
  return {
    ts,
    node: "test",
    source: "switchbot",
    deviceId: "meter-1",
    deviceType: "MeterPlus",
    kind: "snapshot",
    status: { humidity, temperature: 25, battery: 90 },
  };
}

function seeded(): JsonlEventStore {
  const store = new JsonlEventStore(mkdtempSync(join(tmpdir(), "tsukumo-history-")));
  // 10:00 55 → 10:30 62 → 11:00 65 → 11:30 58 → 12:00 61（末尾でも超過中）
  store.append(snapshot("2026-07-01T10:00:00.000Z", 55));
  store.append(snapshot("2026-07-01T10:30:00.000Z", 62));
  store.append(snapshot("2026-07-01T11:00:00.000Z", 65));
  store.append(snapshot("2026-07-01T11:30:00.000Z", 58));
  store.append(snapshot("2026-07-01T12:00:00.000Z", 61));
  store.append({
    ts: "2026-07-01T12:30:00.000Z",
    node: "test",
    source: "switchbot",
    deviceId: "plug-1",
    kind: "change",
    field: "power",
    from: "on",
    to: "off",
  });
  return store;
}

test("queryEvents: フィルタと truncation（新しい側を残す）", async () => {
  const store = seeded();
  const all = await queryEvents(store, {});
  assert.equal(all.events.length, 6);
  assert.equal(all.truncated, false);

  const plugOnly = await queryEvents(store, { deviceId: "plug-1", kind: "change" });
  assert.equal(plugOnly.events.length, 1);
  assert.equal(plugOnly.events[0].field, "power");

  const limited = await queryEvents(store, { deviceId: "meter-1" }, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.events.length, 2);
  assert.equal(limited.events[1].ts, "2026-07-01T12:00:00.000Z");
});

test("collectSamples: snapshot と change の両方から数値時系列を作る", async () => {
  const store = seeded();
  store.append({
    ts: "2026-07-01T12:15:00.000Z",
    node: "test",
    source: "switchbot",
    deviceId: "meter-1",
    kind: "change",
    field: "humidity",
    from: 61,
    to: 63,
  });
  const samples = await collectSamples(store, { deviceId: "meter-1", field: "humidity" });
  assert.equal(samples.length, 6);
  // 時系列順: 10:00 55, 10:30 62, 11:00 65, 11:30 58, 12:00 61, 12:15 63(change)
  assert.deepEqual(
    samples.map((sample) => sample.value),
    [55, 62, 65, 58, 61, 63],
  );
});

test("aggregate: 時間バケットごとの min/max/avg/last", async () => {
  const store = seeded();
  const buckets = await aggregate(store, { deviceId: "meter-1", field: "humidity", bucketMinutes: 60 });
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].bucketStart, "2026-07-01T10:00:00.000Z");
  assert.equal(buckets[0].min, 55);
  assert.equal(buckets[0].max, 62);
  assert.equal(buckets[0].avg, 58.5);
  assert.equal(buckets[1].last, 58);
  assert.equal(buckets[2].count, 1);
});

test("thresholdSpans: 60超えの時間帯を検出し、末尾は open", async () => {
  const store = seeded();
  const spans = await thresholdSpans(store, {
    deviceId: "meter-1",
    field: "humidity",
    op: "gt",
    value: 60,
  });
  assert.equal(spans.length, 2);
  assert.equal(spans[0].start, "2026-07-01T10:30:00.000Z");
  assert.equal(spans[0].end, "2026-07-01T11:30:00.000Z");
  assert.equal(spans[0].extreme, 65);
  assert.equal(spans[0].open, false);
  assert.equal(spans[1].start, "2026-07-01T12:00:00.000Z");
  assert.equal(spans[1].open, true);
});
