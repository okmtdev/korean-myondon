import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../src/store.ts";
import type { TsukumoEvent } from "../src/events.ts";

function makeEvent(ts: string, deviceId = "meter-1", to: unknown = 1): TsukumoEvent {
  return { ts, node: "test", source: "switchbot", deviceId, kind: "change", field: "humidity", from: 0, to };
}

function makeStore(): JsonlEventStore {
  return new JsonlEventStore(mkdtempSync(join(tmpdir(), "tsukumo-store-")));
}

async function collect(store: JsonlEventStore, range?: { since?: Date; until?: Date }): Promise<TsukumoEvent[]> {
  const events: TsukumoEvent[] = [];
  for await (const event of store.scan(range)) events.push(event);
  return events;
}

test("append/scan: 日付ごとのファイルに分かれて時系列で読める", async () => {
  const store = makeStore();
  store.append(makeEvent("2026-07-01T10:00:00.000Z"));
  store.append(makeEvent("2026-07-01T11:00:00.000Z"));
  store.append(makeEvent("2026-07-02T09:00:00.000Z"));

  assert.deepEqual(store.days(), ["2026-07-01", "2026-07-02"]);
  const events = await collect(store);
  assert.equal(events.length, 3);
  assert.equal(events[0].ts, "2026-07-01T10:00:00.000Z");
  assert.equal(events[2].ts, "2026-07-02T09:00:00.000Z");
});

test("scan: since/until で日単位スキップ + 秒単位フィルタ", async () => {
  const store = makeStore();
  store.append(makeEvent("2026-07-01T10:00:00.000Z"));
  store.append(makeEvent("2026-07-02T10:00:00.000Z"));
  store.append(makeEvent("2026-07-02T12:00:00.000Z"));
  store.append(makeEvent("2026-07-03T10:00:00.000Z"));

  const events = await collect(store, {
    since: new Date("2026-07-02T11:00:00.000Z"),
    until: new Date("2026-07-03T00:00:00.000Z"),
  });
  assert.deepEqual(
    events.map((event) => event.ts),
    ["2026-07-02T12:00:00.000Z"],
  );
});

test("scan: 壊れた行と空行は黙ってスキップする", async () => {
  const store = makeStore();
  store.append(makeEvent("2026-07-01T10:00:00.000Z"));
  appendFileSync(join(store.dir, "events-2026-07-01.jsonl"), "this is not json\n\n");
  store.append(makeEvent("2026-07-01T11:00:00.000Z"));

  const events = await collect(store);
  assert.equal(events.length, 2);
});
