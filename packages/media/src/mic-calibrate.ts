#!/usr/bin/env node
/**
 * ビープ周波数の較正 CLI。
 *
 *   node src/mic-calibrate.ts [録音秒数=10]
 *
 * 実行したら、その間に対象の家電を鳴かせる（洗濯機の終了音、インターホン等）。
 * 音量の大きい瞬間の支配的な周波数を表示するので、その値を TSUKUMO_BEEPS に書く。
 */
import { spawn } from "node:child_process";
import { dominantFrequencies, pcm16ToFloat, rms } from "./detect/audio.ts";
import { FixedChunker } from "./capture.ts";

const seconds = Number(process.argv[2] ?? 10) || 10;
const alsaDevice = process.env.TSUKUMO_MIC_DEVICE ?? "default";
const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = 4_096; // 256ms（較正は長めの窓で周波数分解能を上げる）

console.error(`${seconds}秒 録音します。その間にビープを鳴らしてください...（device=${alsaDevice}）`);

const child = spawn("arecord", ["-D", alsaDevice, "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-q", "-d", String(seconds)], {
  stdio: ["ignore", "pipe", "inherit"],
});

const windows = new FixedChunker(WINDOW_SAMPLES * 2);
const loudWindows: Array<{ level: number; peaks: Array<{ freqHz: number; amplitude: number }> }> = [];

child.stdout.on("data", (chunk: Buffer) => {
  for (const window of windows.push(chunk)) {
    const samples = pcm16ToFloat(window);
    const level = rms(samples);
    if (level < 0.02) continue; // 無音はスキップ
    loudWindows.push({ level, peaks: dominantFrequencies(samples, SAMPLE_RATE, { top: 3 }) });
  }
});

child.on("exit", () => {
  if (loudWindows.length === 0) {
    console.error("音が拾えませんでした。マイクデバイス（arecord -L）と音量を確認してください。");
    process.exit(1);
  }
  // 周波数ごとに登場回数と最大振幅を集計
  const tally = new Map<number, { count: number; maxAmplitude: number }>();
  for (const window of loudWindows) {
    for (const peak of window.peaks) {
      if (peak.amplitude < 0.03) continue;
      const bucket = Math.round(peak.freqHz / 25) * 25;
      const entry = tally.get(bucket) ?? { count: 0, maxAmplitude: 0 };
      entry.count += 1;
      entry.maxAmplitude = Math.max(entry.maxAmplitude, peak.amplitude);
      tally.set(bucket, entry);
    }
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  console.log("\n検出された周波数（登場回数順）:");
  for (const [freqHz, entry] of ranked) {
    console.log(`  ${freqHz} Hz  (${entry.count}回, 最大振幅 ${entry.maxAmplitude.toFixed(3)})`);
  }
  if (ranked.length > 0) {
    console.log(`\n例: TSUKUMO_BEEPS="washer=${ranked[0][0]}:500" のように設定してください。`);
  }
});
