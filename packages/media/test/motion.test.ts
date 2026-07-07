import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionDetector, frameDiff } from "../src/detect/motion.ts";

const SIZE = 1000;
const zeros = new Uint8Array(SIZE);
const full = new Uint8Array(SIZE).fill(255);
/** 先頭 count 画素だけ 255 のフレーム（zeros との差分 = count/SIZE） */
function partial(count: number): Uint8Array {
  const frame = new Uint8Array(SIZE);
  frame.fill(255, 0, count);
  return frame;
}

test("frameDiff: 同一なら0、全反転なら1、サイズ不一致は例外", () => {
  assert.equal(frameDiff(zeros, zeros), 0);
  assert.equal(frameDiff(zeros, full), 1);
  assert.ok(Math.abs(frameDiff(zeros, partial(100)) - 0.1) < 1e-9);
  assert.throws(() => frameDiff(zeros, new Uint8Array(10)), /mismatch/);
});

test("MotionDetector: 静止→動き→静止のヒステリシスと hold", () => {
  const detector = new MotionDetector({ enterScore: 0.06, exitScore: 0.03, holdMs: 10_000 });

  // 初回フレームと静止は無反応
  assert.equal(detector.push(zeros, 0), undefined);
  assert.equal(detector.push(zeros, 500), undefined);

  // 大きな変化で true
  const enter = detector.push(full, 1_000);
  assert.equal(enter?.to, true);
  assert.ok((enter?.score ?? 0) >= 0.06);

  // 静止しても hold 内は true のまま
  assert.equal(detector.push(full, 2_000), undefined);
  assert.equal(detector.push(full, 10_000), undefined);

  // hold を超えて静止が続いたら false
  const exit = detector.push(full, 11_001);
  assert.equal(exit?.to, false);
  assert.equal(detector.active, false);
});

test("MotionDetector: exit 以上 enter 未満の小さな動きは true を維持し続ける", () => {
  const detector = new MotionDetector({ enterScore: 0.06, exitScore: 0.03, holdMs: 1_000 });
  detector.push(zeros, 0);
  assert.equal(detector.push(full, 100)?.to, true);

  // full ↔ partial(960) の交互 = 差分 0.04（exit 以上 enter 未満）→ lastActive が更新され続ける
  let at = 100;
  let frameToggle = false;
  for (let i = 0; i < 20; i += 1) {
    at += 500;
    const frame = frameToggle ? full : partial(960);
    frameToggle = !frameToggle;
    assert.equal(detector.push(frame, at), undefined);
  }
  assert.equal(detector.active, true);

  // 完全静止に切り替えたら hold 後に false
  const last = frameToggle ? partial(960) : full;
  detector.push(last, at + 100); // 同一フレームを続ける準備
  detector.push(last, at + 200);
  const exit = detector.push(last, at + 1_500);
  assert.equal(exit?.to, false);
});
