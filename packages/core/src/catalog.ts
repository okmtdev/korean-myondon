/**
 * イベントカタログ — 「この家で観測できるもの」の一覧。
 *
 * ルールコンパイラ（kotodama）はカタログにある deviceId / field しか使えない。
 * LLM が存在しないデバイスやフィールドを幻覚したら、バリデーションで弾かれる。
 */
import { IGNORED_FIELDS } from "./poller.ts";
import type { JsonlEventStore } from "./store.ts";

/** カタログに載せるイベント源（＝ルールの語彙になれるもの） */
export const CATALOG_SOURCES = new Set(["switchbot", "switchbot-webhook", "camera", "mic"]);

export interface CatalogDevice {
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  fields: string[];
}

export interface Catalog {
  devices: CatalogDevice[];
  generatedAt: string;
}

/** ストアに溜まった観測からカタログを組み立てる */
export async function buildCatalogFromStore(
  store: JsonlEventStore,
  options: { since?: Date } = {},
): Promise<Catalog> {
  const since = options.since ?? new Date(Date.now() - 14 * 86_400_000);
  const devices = new Map<string, { deviceName?: string; deviceType?: string; fields: Set<string> }>();

  for await (const event of store.scan({ since })) {
    if (!CATALOG_SOURCES.has(event.source)) continue;
    let entry = devices.get(event.deviceId);
    if (entry === undefined) {
      entry = { fields: new Set() };
      devices.set(event.deviceId, entry);
    }
    entry.deviceName = event.deviceName ?? entry.deviceName;
    entry.deviceType = event.deviceType ?? entry.deviceType;
    if (event.kind === "snapshot" && event.status !== undefined) {
      for (const [field, value] of Object.entries(event.status)) {
        if (IGNORED_FIELDS.has(field)) continue;
        if (value !== null && typeof value === "object") continue;
        entry.fields.add(field);
      }
    } else if (event.kind === "change" && event.field !== undefined) {
      entry.fields.add(event.field);
    }
  }

  return {
    devices: [...devices.entries()]
      .map(([deviceId, entry]) => ({
        deviceId,
        deviceName: entry.deviceName,
        deviceType: entry.deviceType,
        fields: [...entry.fields].sort(),
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    generatedAt: new Date().toISOString(),
  };
}

export function catalogHasDevice(catalog: Catalog, deviceId: string): boolean {
  return catalog.devices.some((device) => device.deviceId === deviceId);
}

export function catalogHasField(catalog: Catalog, deviceId: string, field: string): boolean {
  const device = catalog.devices.find((candidate) => candidate.deviceId === deviceId);
  return device !== undefined && device.fields.includes(field);
}

/** LLM プロンプトに埋め込むためのコンパクトな表現 */
export function catalogToPromptText(catalog: Catalog): string {
  if (catalog.devices.length === 0) return "(カタログが空です)";
  return catalog.devices
    .map((device) => {
      const label = [device.deviceName, device.deviceType].filter(Boolean).join(", ");
      const fields = device.fields.length > 0 ? device.fields.join(", ") : "(フィールド未観測)";
      return `- deviceId: ${device.deviceId}${label ? ` (${label})` : ""} — fields: ${fields}`;
    })
    .join("\n");
}
