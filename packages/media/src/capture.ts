/**
 * キャプチャまわりの部品。
 * - 純粋部分: バイトストリームの切り出し（固定長フレーム / MJPEG フレーム）
 * - 薄い部分: 外部コマンド（ffmpeg / arecord）を落ちたら再起動しながら回す
 */
import { spawn } from "node:child_process";

/** 固定長チャンクの切り出し（rawvideo のフレームや PCM ウィンドウに使う） */
export class FixedChunker {
  private readonly size: number;
  private buffered: Buffer = Buffer.alloc(0);

  constructor(size: number) {
    this.size = size;
  }

  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const out: Buffer[] = [];
    while (this.buffered.length >= this.size) {
      out.push(this.buffered.subarray(0, this.size));
      this.buffered = this.buffered.subarray(this.size);
    }
    return out;
  }
}

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/** MJPEG ストリームから完全な JPEG フレームを切り出す */
export class MjpegExtractor {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffered.indexOf(JPEG_START);
      if (start === -1) {
        this.buffered = Buffer.alloc(0);
        break;
      }
      const end = this.buffered.indexOf(JPEG_END, start + 2);
      if (end === -1) {
        if (start > 0) this.buffered = this.buffered.subarray(start);
        break;
      }
      frames.push(this.buffered.subarray(start, end + 2));
      this.buffered = this.buffered.subarray(end + 2);
    }
    return frames;
  }
}

export interface PipelineOptions {
  command: string;
  args: string[];
  /** stdout (fd1) のデータ */
  onStdout: (chunk: Buffer) => void;
  /** fd3 のデータ（ffmpeg の第2出力に使う。不要なら省略） */
  onFd3?: (chunk: Buffer) => void;
  log: (message: string) => void;
  restartDelayMs?: number;
  debug?: boolean;
}

/** 外部コマンドを常駐実行する。落ちたら間を置いて再起動。stop() で完全停止 */
export function runPipeline(options: PipelineOptions): { stop: () => void } {
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const start = () => {
    if (stopped) return;
    const stdio: Array<"ignore" | "pipe" | "inherit"> = [
      "ignore",
      "pipe",
      options.debug ? "inherit" : "ignore",
    ];
    if (options.onFd3) stdio.push("pipe");
    child = spawn(options.command, options.args, { stdio });
    options.log(`media: spawn ${options.command} (pid=${child.pid})`);
    child.stdout?.on("data", options.onStdout);
    if (options.onFd3) (child.stdio[3] as NodeJS.ReadableStream | undefined)?.on("data", options.onFd3);
    child.on("error", (cause) => options.log(`media: ${options.command} error: ${cause.message}`));
    child.on("exit", (code) => {
      if (stopped) return;
      options.log(`media: ${options.command} exited (code=${code}) — ${options.restartDelayMs ?? 5000}ms 後に再起動`);
      timer = setTimeout(start, options.restartDelayMs ?? 5000);
    });
  };

  start();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      child?.kill("SIGTERM");
    },
  };
}
