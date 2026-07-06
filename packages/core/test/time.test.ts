import { test } from "node:test";
import assert from "node:assert/strict";
import { inTimeWindow, parseWhen } from "../src/time.ts";

test("parseWhen: 相対指定・ISO・now・fallback", () => {
  const fallback = new Date("2026-01-01T00:00:00Z");
  assert.equal(parseWhen(undefined, fallback), fallback);
  assert.equal(parseWhen("", fallback), fallback);

  const iso = parseWhen("2026-07-01T10:00:00Z");
  assert.equal(iso?.toISOString(), "2026-07-01T10:00:00.000Z");

  const before = Date.now() - 2 * 3_600_000;
  const relative = parseWhen("-2h");
  assert.ok(relative !== undefined && Math.abs(relative.getTime() - before) < 5_000);

  const now = parseWhen("now");
  assert.ok(now !== undefined && Math.abs(now.getTime() - Date.now()) < 5_000);

  assert.throws(() => parseWhen("yesterday"), /invalid time/);
  assert.throws(() => parseWhen("-3w"), /invalid time/);
});

test("inTimeWindow: 通常区間・日またぎ・境界 [after, before)", () => {
  const at = (hour: number, minute = 0) => new Date(2026, 6, 1, hour, minute);

  assert.equal(inTimeWindow(at(12)), true);

  assert.equal(inTimeWindow(at(9), "08:00", "22:00"), true);
  assert.equal(inTimeWindow(at(8, 0), "08:00", "22:00"), true);
  assert.equal(inTimeWindow(at(22, 0), "08:00", "22:00"), false);
  assert.equal(inTimeWindow(at(23), "08:00", "22:00"), false);

  // 日またぎ 22:00〜06:00
  assert.equal(inTimeWindow(at(23), "22:00", "06:00"), true);
  assert.equal(inTimeWindow(at(3), "22:00", "06:00"), true);
  assert.equal(inTimeWindow(at(12), "22:00", "06:00"), false);

  // 片側のみ
  assert.equal(inTimeWindow(at(23), "22:00"), true);
  assert.equal(inTimeWindow(at(21), "22:00"), false);
  assert.equal(inTimeWindow(at(5), undefined, "06:00"), true);
  assert.equal(inTimeWindow(at(7), undefined, "06:00"), false);

  assert.throws(() => inTimeWindow(at(0), "25:00"), /invalid time of day/);
});
