/**
 * イベントストアに対する履歴クエリ。
 * 「先週、湿度が60%を超えた時間帯は？」に答えるための道具箱。
 */
import type { TsukumoEvent } from "./events.ts";
import type { JsonlEventStore } from "./store.ts";

export interface EventFilter {
  since?: Date;
  until?: Date;
  deviceId?: string;
  field?: string;
  kind?: string;
  source?: string;
}

export interface QueryResult {
  events: TsukumoEvent[];
  /** limit で切り詰めた場合 true（新しい側を残す） */
  truncated: boolean;
}

export async function queryEvents(
  store: JsonlEventStore,
  filter: EventFilter = {},
  limit: number = 200,
): Promise<QueryResult> {
  const events: TsukumoEvent[] = [];
  let truncated = false;
  for await (const event of store.scan({ since: filter.since, until: filter.until })) {
    if (filter.deviceId !== undefined && event.deviceId !== filter.deviceId) continue;
    if (filter.field !== undefined && event.field !== filter.field) continue;
    if (filter.kind !== undefined && event.kind !== filter.kind) continue;
    if (filter.source !== undefined && event.source !== filter.source) continue;
    events.push(event);
    if (events.length > limit) {
      events.shift();
      truncated = true;
    }
  }
  return { events, truncated };
}

export interface Sample {
  /** epoch ms */
  t: number;
  value: number;
}

/**
 * デバイスの1フィールドを数値時系列として取り出す。
 * snapshot の status[field] と change の to の両方をサンプルにする。
 */
export async function collectSamples(
  store: JsonlEventStore,
  query: { deviceId: string; field: string; since?: Date; until?: Date },
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for await (const event of store.scan({ since: query.since, until: query.until })) {
    if (event.deviceId !== query.deviceId) continue;
    let raw: unknown;
    if (event.kind === "snapshot" && event.status !== undefined) {
      raw = event.status[query.field];
    } else if (event.kind === "change" && event.field === query.field) {
      raw = event.to;
    } else {
      continue;
    }
    const value = typeof raw === "number" ? raw : Number(raw);
    if (raw === undefined || raw === null || Number.isNaN(value)) continue;
    samples.push({ t: Date.parse(event.ts), value });
  }
  samples.sort((a, b) => a.t - b.t);
  return samples;
}

export interface Bucket {
  bucketStart: string;
  count: number;
  min: number;
  max: number;
  avg: number;
  last: number;
}

/** 時間バケットごとの min/max/avg/last */
export async function aggregate(
  store: JsonlEventStore,
  query: { deviceId: string; field: string; since?: Date; until?: Date; bucketMinutes?: number },
): Promise<Bucket[]> {
  const bucketMs = Math.max(1, query.bucketMinutes ?? 60) * 60_000;
  const samples = await collectSamples(store, query);
  const buckets = new Map<number, { count: number; min: number; max: number; sum: number; last: number }>();
  for (const sample of samples) {
    const key = Math.floor(sample.t / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { count: 1, min: sample.value, max: sample.value, sum: sample.value, last: sample.value });
    } else {
      bucket.count += 1;
      bucket.min = Math.min(bucket.min, sample.value);
      bucket.max = Math.max(bucket.max, sample.value);
      bucket.sum += sample.value;
      bucket.last = sample.value;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, bucket]) => ({
      bucketStart: new Date(key).toISOString(),
      count: bucket.count,
      min: bucket.min,
      max: bucket.max,
      avg: Math.round((bucket.sum / bucket.count) * 1000) / 1000,
      last: bucket.last,
    }));
}

export type ThresholdOp = "gt" | "gte" | "lt" | "lte" | "eq" | "ne";

function compare(op: ThresholdOp, value: number, threshold: number): boolean {
  switch (op) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "ne":
      return value !== threshold;
  }
}

export interface ThresholdSpan {
  start: string;
  end: string;
  /** 期間内の最も極端な値（gt/gte なら最大、lt/lte なら最小） */
  extreme: number;
  samples: number;
  /** データ末尾まで条件が続いていた（=まだ終わっていないかもしれない）場合 true */
  open: boolean;
}

/** 条件が連続して成立していた時間帯の一覧 */
export async function thresholdSpans(
  store: JsonlEventStore,
  query: { deviceId: string; field: string; op: ThresholdOp; value: number; since?: Date; until?: Date },
): Promise<ThresholdSpan[]> {
  const samples = await collectSamples(store, query);
  const preferMax = query.op === "gt" || query.op === "gte";
  const spans: ThresholdSpan[] = [];
  let current: { start: number; last: number; extreme: number; samples: number } | null = null;

  for (const sample of samples) {
    if (compare(query.op, sample.value, query.value)) {
      if (current === null) {
        current = { start: sample.t, last: sample.t, extreme: sample.value, samples: 1 };
      } else {
        current.last = sample.t;
        current.samples += 1;
        current.extreme = preferMax
          ? Math.max(current.extreme, sample.value)
          : Math.min(current.extreme, sample.value);
      }
    } else if (current !== null) {
      spans.push({
        start: new Date(current.start).toISOString(),
        end: new Date(sample.t).toISOString(),
        extreme: current.extreme,
        samples: current.samples,
        open: false,
      });
      current = null;
    }
  }
  if (current !== null) {
    spans.push({
      start: new Date(current.start).toISOString(),
      end: new Date(current.last).toISOString(),
      extreme: current.extreme,
      samples: current.samples,
      open: true,
    });
  }
  return spans;
}
