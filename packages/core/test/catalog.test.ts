import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../src/store.ts";
import { buildCatalogFromStore, catalogHasField } from "../src/catalog.ts";

test("buildCatalogFromStore: switchbot に加えて camera / mic も語彙になる。rule イベントは載らない", async () => {
  const store = new JsonlEventStore(mkdtempSync(join(tmpdir(), "tsukumo-catalog-")));
  store.append({
    ts: "2026-07-07T10:00:00.000Z",
    node: "home",
    source: "switchbot",
    deviceId: "meter-1",
    deviceType: "MeterPlus",
    kind: "snapshot",
    status: { humidity: 55, temperature: 25 },
  });
  store.append({
    ts: "2026-07-07T10:00:01.000Z",
    node: "remote-camera",
    source: "camera",
    deviceId: "camera:entrance",
    kind: "change",
    field: "motion",
    from: false,
    to: true,
  });
  store.append({
    ts: "2026-07-07T10:00:02.000Z",
    node: "home",
    source: "mic",
    deviceId: "mic:living",
    kind: "change",
    field: "beep:washer",
    from: false,
    to: true,
  });
  store.append({
    ts: "2026-07-07T10:00:03.000Z",
    node: "home",
    source: "kotodama",
    deviceId: "some-rule",
    kind: "rule",
    field: "fired",
    status: {},
  });

  const catalog = await buildCatalogFromStore(store, { since: new Date("2026-07-01T00:00:00Z") });
  assert.deepEqual(
    catalog.devices.map((device) => device.deviceId),
    ["camera:entrance", "meter-1", "mic:living"],
  );
  assert.ok(catalogHasField(catalog, "camera:entrance", "motion"));
  assert.ok(catalogHasField(catalog, "mic:living", "beep:washer"));
  assert.ok(!catalog.devices.some((device) => device.deviceId === "some-rule"));
});
