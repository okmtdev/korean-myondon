import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeepDetector,
  LoudnessDetector,
  dominantFrequencies,
  parseBeepProfiles,
  pcm16ToFloat,
  rms,
  toneAmplitude,
} from "../src/detect/audio.ts";

const RATE = 16_000;

function sine(freqHz: number, amplitude: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / RATE);
  }
  return out;
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] + b[i];
  return out;
}

test("pcm16ToFloat: S16LE を -1..1 に変換する", () => {
  const buffer = Buffer.alloc(6);
  buffer.writeInt16LE(0, 0);
  buffer.writeInt16LE(16384, 2);
  buffer.writeInt16LE(-32768, 4);
  const samples = pcm16ToFloat(buffer);
  assert.equal(samples.length, 3);
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 0.5) < 0.001);
  assert.equal(samples[2], -1);
});

test("rms: 無音は0、振幅0.5の正弦波は約0.354", () => {
  assert.equal(rms(new Float32Array(1024)), 0);
  const level = rms(sine(1000, 0.5, 4096));
  assert.ok(Math.abs(level - 0.5 / Math.SQRT2) < 0.01);
});

test("toneAmplitude (Goertzel): 対象周波数だけが立つ", () => {
  const samples = sine(2000, 0.5, 2048);
  assert.ok(Math.abs(toneAmplitude(samples, RATE, 2000) - 0.5) < 0.05);
  assert.ok(toneAmplitude(samples, RATE, 1000) < 0.02);
  assert.ok(toneAmplitude(samples, RATE, 3000) < 0.02);
  assert.ok(toneAmplitude(new Float32Array(2048), RATE, 2000) < 1e-6);
});

test("dominantFrequencies: 混合音から主要周波数を強い順に出す", () => {
  const samples = mix(sine(700, 0.5, 4096), sine(2100, 0.2, 4096));
  const peaks = dominantFrequencies(samples, RATE, { top: 3 });
  assert.ok(Math.abs(peaks[0].freqHz - 700) <= 25, `top peak was ${peaks[0].freqHz}`);
  assert.ok(peaks.some((peak) => Math.abs(peak.freqHz - 2100) <= 25));
  assert.ok(peaks[0].amplitude > (peaks.find((peak) => Math.abs(peak.freqHz - 2100) <= 25)?.amplitude ?? 1));
});

test("BeepDetector: 持続で1回発火、鳴りっぱなしは cooldown ごと、無音でリセット", () => {
  const detector = new BeepDetector({ name: "washer", freqHz: 2000, minDurationMs: 300, cooldownMs: 3000 });
  const tone = sine(2000, 0.3, 2048);
  const silence = new Float32Array(2048);
  const fired: number[] = [];

  for (const at of [0, 128, 256]) {
    assert.equal(detector.push(tone, RATE, at), undefined, `t=${at} はまだ発火しない`);
  }
  const first = detector.push(tone, RATE, 384);
  assert.equal(first?.name, "washer");
  fired.push(384);

  // 鳴り続けても cooldown 内は再発火しない
  assert.equal(detector.push(tone, RATE, 512), undefined);
  assert.equal(detector.push(tone, RATE, 1000), undefined);

  // 無音でトーン開始がリセットされる
  assert.equal(detector.push(silence, RATE, 1200), undefined);

  // 再び鳴き始め、持続 + cooldown 明けで2回目
  assert.equal(detector.push(tone, RATE, 3200), undefined); // 開始
  assert.equal(detector.push(tone, RATE, 3400), undefined); // 200ms — まだ
  const second = detector.push(tone, RATE, 3600); // 400ms 持続 & 3600-384 >= 3000
  assert.equal(second?.name, "washer");

  assert.deepEqual(fired, [384]);
});

test("BeepDetector: 別周波数には反応しない", () => {
  const detector = new BeepDetector({ name: "washer", freqHz: 2000, minDurationMs: 100 });
  const wrongTone = sine(900, 0.5, 2048);
  for (const at of [0, 128, 256, 384, 512]) {
    assert.equal(detector.push(wrongTone, RATE, at), undefined);
  }
});

test("LoudnessDetector: しきい値と不応期", () => {
  const detector = new LoudnessDetector({ threshold: 0.25, cooldownMs: 10_000 });
  assert.equal(detector.push(0.1, 0), undefined);
  assert.deepEqual(detector.push(0.4, 100), { level: 0.4 });
  assert.equal(detector.push(0.9, 5_000), undefined); // 不応期
  assert.deepEqual(detector.push(0.3, 10_200), { level: 0.3 });
});

test("parseBeepProfiles: 正常系と不正入力", () => {
  const profiles = parseBeepProfiles("washer=2000:800, doorbell=680");
  assert.deepEqual(profiles, [
    { name: "washer", freqHz: 2000, minDurationMs: 800 },
    { name: "doorbell", freqHz: 680, minDurationMs: undefined },
  ]);
  assert.deepEqual(parseBeepProfiles(undefined), []);
  assert.throws(() => parseBeepProfiles("washer"), /形式が不正/);
});
