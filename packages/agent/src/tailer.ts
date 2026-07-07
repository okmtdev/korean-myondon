/**
 * イベントストアの tail — ストアを「イベントバス」として使うための口。
 *
 * camera / mic などの別プロセスがストアへ追記した change イベントを拾い、
 * agent のルールエンジンへ流す。起動時点までの履歴は読み飛ばし、
 * それ以降の追記だけを処理する（再起動のたびに過去のイベントで発火しない）。
 *
 * agent 自身が書く switchbot イベントや rule イベントは sources フィルタで
 * 対象外なので、エコー（自分の書き込みで自分が発火）は起きない。
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import type { TsukumoEvent } from "../../core/src/events.ts";

export class StoreTailer {
  private readonly dir: string;
  private readonly sources: Set<string>;
  private readonly onEvent: (event: TsukumoEvent) => void | Promise<void>;
  private readonly log: (message: string) => void;
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();
  private watcher?: ReturnType<typeof watch>;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private pendingPoll = false;

  constructor(
    dir: string,
    sources: Set<string>,
    onEvent: (event: TsukumoEvent) => void | Promise<void>,
    log: (message: string) => void = () => {},
  ) {
    this.dir = dir;
    this.sources = sources;
    this.onEvent = onEvent;
    this.log = log;
  }

  start(intervalMs = 2_000): void {
    // 起動時点の既存分は読み飛ばす
    for (const name of this.eventFiles()) {
      this.offsets.set(name, statSync(join(this.dir, name)).size);
    }
    this.watcher = watch(this.dir, () => void this.pollNow());
    this.timer = setInterval(() => void this.pollNow(), intervalMs);
  }

  stop(): void {
    this.watcher?.close();
    clearInterval(this.timer);
  }

  private eventFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();
  }

  /** 追記分を読み、対象イベントをハンドラへ流す（テストからも直接呼べる） */
  async pollNow(): Promise<void> {
    if (this.polling) {
      this.pendingPoll = true;
      return;
    }
    this.polling = true;
    try {
      for (const name of this.eventFiles()) {
        const path = join(this.dir, name);
        const size = statSync(path).size;
        const offset = this.offsets.get(name) ?? 0;
        if (size <= offset) continue;

        const fd = openSync(path, "r");
        let appended: string;
        try {
          const buffer = Buffer.alloc(size - offset);
          readSync(fd, buffer, 0, buffer.length, offset);
          appended = buffer.toString("utf8");
        } finally {
          closeSync(fd);
        }
        this.offsets.set(name, size);

        const lines = ((this.partial.get(name) ?? "") + appended).split("\n");
        this.partial.set(name, lines.pop() ?? "");
        for (const line of lines) {
          if (line.trim() === "") continue;
          let event: TsukumoEvent;
          try {
            event = JSON.parse(line) as TsukumoEvent;
          } catch {
            continue;
          }
          if (event.kind !== "change") continue;
          if (!this.sources.has(event.source)) continue;
          try {
            await this.onEvent(event);
          } catch (cause) {
            this.log(`tailer: handler error: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
      }
    } catch (cause) {
      this.log(`tailer: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        void this.pollNow();
      }
    }
  }
}
