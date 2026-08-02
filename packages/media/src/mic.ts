#!/usr/bin/env node
/**
 * tsukumo mic — マイクのビープ音・大きな音検知デーモン（自宅ノード向け、Phase 4）。
 *
 * arecord（ALSA）で 16kHz mono PCM を流し、Goertzel でビープ周波数だけを監視する。
 * 音声そのものは保存も送信もしない。ストアに残るのは
 * 「beep:washer が鳴った」「大きな音がした」という事実だけ。
 *
 * ビープの周波数は付属の較正 CLI で調べられる:
 *   node src/mic-calibrate.ts 10   # 10秒録って主要な周波数を表示。その間に家電を鳴かせる
 *
 * 環境変数:
 *   TSUKUMO_STORE_DIR   イベントストア（default: ./data）
 *   TSUKUMO_NODE        ノード名（default: ホスト名）
 *   TSUKUMO_MIC_ID      マイク名（default: "default" → deviceId は mic:default）
 *   TSUKUMO_MIC_DEVICE  ALSA デバイス（default: "default"。`arecord -L` で一覧）
 *   TSUKUMO_BEEPS       ビーププロファイル。"名前=周波数Hz[:持続ms]" のカンマ区切り
 *                       例: "washer=2000:800,doorbell=680:300"
 *   TSUKUMO_LOUD_THRESHOLD  大きな音の RMS しきい値（default: 0.25。0 で無効）
 *   TSUKUMO_MEDIA_DEBUG=1   arecord の stderr を表示
 */
import { hostname } from "node:os";
import { JsonlEventStore } from "../../core/src/store.ts";
import { FixedChunker, runPipeline } from "./capture.ts";
import { BeepDetector, LoudnessDetector, parseBeepProfiles, pcm16ToFloat, rms } from "./detect/audio.ts";

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

const node = process.env.TSUKUMO_NODE ?? hostname();
const micId = process.env.TSUKUMO_MIC_ID ?? "default";
const deviceId = `mic:${micId}`;
const alsaDevice = process.env.TSUKUMO_MIC_DEVICE ?? "default";

const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = 2_048; // 128ms

const profiles = parseBeepProfiles(process.env.TSUKUMO_BEEPS);
if (profiles.length === 0) {
  log("mic: TSUKUMO_BEEPS が空です。ビープ検知なし（大きな音のみ）で動きます。例: TSUKUMO_BEEPS=washer=2000:800");
}
const beepDetectors = profiles.map((profile) => new BeepDetector(profile));
const loudThreshold = Number(process.env.TSUKUMO_LOUD_THRESHOLD ?? 0.25);
const loudness = loudThreshold > 0 ? new LoudnessDetector({ threshold: loudThreshold }) : undefined;

const store = new JsonlEventStore(process.env.TSUKUMO_STORE_DIR ?? "./data");
const windows = new FixedChunker(WINDOW_SAMPLES * 2); // S16LE = 2 bytes/sample

function emitPulse(field: string, status: Record<string, unknown>): void {
  store.append({
    ts: new Date().toISOString(),
    node,
    source: "mic",
    deviceId,
    deviceName: `マイク ${micId}`,
    kind: "change",
    field,
    from: false,
    to: true,
    status,
  });
  log(`mic: ${field} ${JSON.stringify(status)}`);
}

const pipeline = runPipeline({
  command: "arecord",
  args: ["-D", alsaDevice, "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-q"],
  debug: process.env.TSUKUMO_MEDIA_DEBUG === "1",
  log,
  onStdout: (chunk) => {
    for (const window of windows.push(chunk)) {
      const samples = pcm16ToFloat(window);
      const at = Date.now();
      for (const detector of beepDetectors) {
        const pulse = detector.push(samples, SAMPLE_RATE, at);
        if (pulse) emitPulse(`beep:${pulse.name}`, { freqHz: pulse.freqHz, amplitude: Math.round(pulse.amplitude * 1000) / 1000 });
      }
      if (loudness) {
        const loud = loudness.push(rms(samples), at);
        if (loud) emitPulse("loud", { level: loud.level });
      }
    }
  },
});

const shutdown = () => {
  pipeline.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(
  `mic: start node=${node} id=${micId} device=${alsaDevice} beeps=[${profiles.map((profile) => `${profile.name}@${profile.freqHz}Hz`).join(", ") || "なし"}] loud=${loudThreshold > 0 ? loudThreshold : "off"}`,
);
