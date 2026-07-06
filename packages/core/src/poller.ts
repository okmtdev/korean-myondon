/**
 * ポーリング結果からイベントを作る純粋ロジック。
 * （実際のポーリングループは packages/agent 側）
 */
import type { TsukumoEvent } from "./events.ts";

/** 変化検知の対象にしないフィールド（ID類・ノイズ源） */
export const IGNORED_FIELDS = new Set([
  "deviceId",
  "deviceMac",
  "deviceType",
  "deviceName",
  "hubDeviceId",
  "version",
  "timeOfSample",
  "timestamp",
  "wifiSignal",
  "rssi",
]);

export interface DeviceMeta {
  node: string;
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  ts: string;
  source?: string;
}

export function buildSnapshotEvent(status: Record<string, unknown>, meta: DeviceMeta): TsukumoEvent {
  return {
    ts: meta.ts,
    node: meta.node,
    source: meta.source ?? "switchbot",
    deviceId: meta.deviceId,
    deviceName: meta.deviceName,
    deviceType: meta.deviceType,
    kind: "snapshot",
    status,
  };
}

/**
 * 前回状態との差分を change イベントにする。
 * 初回観測（prev === undefined）は変化なし扱い。スカラー値のみ比較する。
 */
export function diffStatus(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  meta: DeviceMeta,
): TsukumoEvent[] {
  if (prev === undefined) return [];
  const events: TsukumoEvent[] = [];
  for (const [field, to] of Object.entries(next)) {
    if (IGNORED_FIELDS.has(field)) continue;
    if (to !== null && typeof to === "object") continue;
    const from = prev[field];
    if (from === to) continue;
    events.push({
      ts: meta.ts,
      node: meta.node,
      source: meta.source ?? "switchbot",
      deviceId: meta.deviceId,
      deviceName: meta.deviceName,
      deviceType: meta.deviceType,
      kind: "change",
      field,
      from,
      to,
    });
  }
  return events;
}
