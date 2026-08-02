#!/usr/bin/env node
/**
 * tsukumo camera — USB カメラの動体検知デーモン（遠隔 mini PC 向け、Phase 4）。
 *
 * ffmpeg（システムにインストール: `sudo apt install ffmpeg`）でカメラを1本だけ開き、
 * 出力を2系統に分ける:
 *   fd1: 低解像度グレースケール rawvideo → フレーム差分で動体検知 → イベントストアへ
 *   fd3: 1fps の MJPEG → 最新フレームだけメモリ保持 → GET /snapshot で返す（明示要求時のみ）
 *
 * プライバシー原則: 映像は保存も送信もしない。ストアに残るのは
 * 「motion が true/false に変わった」という事実だけ。スナップショットは
 * HTTP で明示的に要求されたときに限り、その瞬間の1枚を返す。
 *
 * 環境変数:
 *   TSUKUMO_STORE_DIR          イベントストア（default: ./data）
 *   TSUKUMO_NODE               ノード名（default: ホスト名）
 *   TSUKUMO_CAMERA_ID          カメラ名（default: "default" → deviceId は camera:default）
 *   TSUKUMO_CAMERA_DEVICE      V4L2 デバイス（default: /dev/video0）
 *   TSUKUMO_CAMERA_SIZE        入力解像度（default: 640x480）
 *   TSUKUMO_CAMERA_FPS         検知フレームレート（default: 2）
 *   TSUKUMO_CAMERA_HTTP_PORT   /snapshot と /healthz を出すポート（省略なら出さない）
 *   TSUKUMO_MOTION_ENTER       動きありに入るスコア（default: 0.06）
 *   TSUKUMO_MOTION_EXIT        動きなし判定スコア（default: 0.03）
 *   TSUKUMO_MOTION_HOLD_MS     false に戻すまでの猶予（default: 10000）
 *   TSUKUMO_MEDIA_DEBUG=1      ffmpeg の stderr を表示
 */
import { createServer } from "node:http";
import { hostname } from "node:os";
import { JsonlEventStore } from "../../core/src/store.ts";
import { FixedChunker, MjpegExtractor, runPipeline } from "./capture.ts";
import { MotionDetector } from "./detect/motion.ts";

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

const node = process.env.TSUKUMO_NODE ?? hostname();
const cameraId = process.env.TSUKUMO_CAMERA_ID ?? "default";
const deviceId = `camera:${cameraId}`;
const device = process.env.TSUKUMO_CAMERA_DEVICE ?? "/dev/video0";
const inputSize = process.env.TSUKUMO_CAMERA_SIZE ?? "640x480";
const fps = Number(process.env.TSUKUMO_CAMERA_FPS ?? 2) || 2;
const httpPort = process.env.TSUKUMO_CAMERA_HTTP_PORT ? Number(process.env.TSUKUMO_CAMERA_HTTP_PORT) : undefined;

// 検知用フレームは 64x48 グレースケール固定（3072 バイト/枚）
const WIDTH = 64;
const HEIGHT = 48;

const store = new JsonlEventStore(process.env.TSUKUMO_STORE_DIR ?? "./data");
const detector = new MotionDetector({
  enterScore: Number(process.env.TSUKUMO_MOTION_ENTER ?? 0.06),
  exitScore: Number(process.env.TSUKUMO_MOTION_EXIT ?? 0.03),
  holdMs: Number(process.env.TSUKUMO_MOTION_HOLD_MS ?? 10_000),
});

const withSnapshot = httpPort !== undefined;
const filterGray = `[0:v]fps=${fps},scale=${WIDTH}:${HEIGHT},format=gray[gray]`;
const args = withSnapshot
  ? [
      "-hide_banner", "-loglevel", "error",
      "-f", "v4l2", "-video_size", inputSize, "-i", device,
      "-filter_complex", `[0:v]split=2[a][b];[a]fps=${fps},scale=${WIDTH}:${HEIGHT},format=gray[gray];[b]fps=1[jpeg]`,
      "-map", "[gray]", "-f", "rawvideo", "pipe:1",
      "-map", "[jpeg]", "-q:v", "5", "-f", "mjpeg", "pipe:3",
    ]
  : [
      "-hide_banner", "-loglevel", "error",
      "-f", "v4l2", "-video_size", inputSize, "-i", device,
      "-filter_complex", filterGray,
      "-map", "[gray]", "-f", "rawvideo", "pipe:1",
    ];

const frames = new FixedChunker(WIDTH * HEIGHT);
const mjpeg = new MjpegExtractor();
let latestJpeg: Buffer | undefined;

const pipeline = runPipeline({
  command: "ffmpeg",
  args,
  debug: process.env.TSUKUMO_MEDIA_DEBUG === "1",
  log,
  onStdout: (chunk) => {
    for (const frame of frames.push(chunk)) {
      const transition = detector.push(new Uint8Array(frame), Date.now());
      if (!transition) continue;
      store.append({
        ts: new Date().toISOString(),
        node,
        source: "camera",
        deviceId,
        deviceName: `カメラ ${cameraId}`,
        kind: "change",
        field: "motion",
        from: !transition.to,
        to: transition.to,
        status: { score: Math.round(transition.score * 1000) / 1000 },
      });
      log(`camera: motion ${transition.to} (score=${transition.score.toFixed(3)})`);
    }
  },
  onFd3: withSnapshot
    ? (chunk) => {
        const jpegs = mjpeg.push(chunk);
        if (jpegs.length > 0) latestJpeg = Buffer.from(jpegs[jpegs.length - 1]);
      }
    : undefined,
});

const server = withSnapshot
  ? createServer((request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
        return;
      }
      if (request.method === "GET" && request.url === "/snapshot") {
        if (!latestJpeg) {
          response.writeHead(503, { "Content-Type": "text/plain" }).end("no frame yet\n");
          return;
        }
        log("camera: snapshot served (explicit request)");
        response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(latestJpeg.length) });
        response.end(latestJpeg);
        return;
      }
      response.writeHead(404).end();
    }).listen(httpPort, () => log(`camera: snapshot endpoint on :${httpPort}（Tailscale 内にだけ開けること）`))
  : undefined;

const shutdown = () => {
  pipeline.stop();
  server?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`camera: start node=${node} id=${cameraId} device=${device} fps=${fps} snapshot=${withSnapshot ? httpPort : "off"}`);
