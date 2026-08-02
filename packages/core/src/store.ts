/**
 * JSONL イベントストア。
 *
 * 1 イベント = 1 行の JSON を、UTC 日付ごとのファイル（events-YYYY-MM-DD.jsonl）へ追記する。
 * - 依存ゼロ・どの Node 22 でも動く（node:sqlite の実験フラグ事情に依存しない）
 * - `tail -f data/events-*.jsonl` でイベントの流れが見える
 * - 書き手（agent）と読み手（MCPサーバー）が別プロセスでも安全（追記 + スキャン）
 *
 * 量が痛くなったら SQLite 等へ差し替える。読み書きはこのクラスに閉じている。
 */
import { appendFileSync, createReadStream, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { TsukumoEvent } from "./events.ts";

const FILE_PREFIX = "events-";
const FILE_SUFFIX = ".jsonl";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ScanRange {
  since?: Date;
  until?: Date;
}

export class JsonlEventStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  append(event: TsukumoEvent): void {
    const day = event.ts.slice(0, 10);
    const file = join(this.dir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
    appendFileSync(file, JSON.stringify(event) + "\n");
  }

  /** ストアに存在する日付（YYYY-MM-DD、昇順） */
  days(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .map((name) => name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length))
      .sort();
  }

  /** 期間内のイベントを時系列順に流す。壊れた行は黙ってスキップする。 */
  async *scan(range: ScanRange = {}): AsyncGenerator<TsukumoEvent> {
    const sinceDay = range.since ? isoDay(range.since) : undefined;
    const untilDay = range.until ? isoDay(range.until) : undefined;
    const sinceMs = range.since?.getTime();
    const untilMs = range.until?.getTime();

    for (const day of this.days()) {
      if (sinceDay !== undefined && day < sinceDay) continue;
      if (untilDay !== undefined && day > untilDay) continue;
      const file = join(this.dir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let event: TsukumoEvent;
        try {
          event = JSON.parse(trimmed) as TsukumoEvent;
        } catch {
          continue;
        }
        const at = Date.parse(event.ts);
        if (Number.isNaN(at)) continue;
        if (sinceMs !== undefined && at < sinceMs) continue;
        if (untilMs !== undefined && at > untilMs) continue;
        yield event;
      }
    }
  }
}
