/**
 * tsukumo agent の本体ロジック。
 * ポーリング → snapshot/差分イベント → ルール評価・実行 → ストア追記。
 * エントリポイント（index.ts）が実物の依存と一緒に組み立てる。
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshotEvent, diffStatus } from "../../core/src/poller.ts";
import { validateRule } from "../../core/src/rules.ts";
import type { Rule } from "../../core/src/rules.ts";
import { fireRules } from "../../core/src/runtime.ts";
import type { ActionExecutor } from "../../core/src/runtime.ts";
import type { JsonlEventStore } from "../../core/src/store.ts";
import type { DeviceListBody, SwitchBotClient, SwitchBotDevice } from "../../core/src/switchbot.ts";
import type { TsukumoEvent } from "../../core/src/events.ts";

export interface AgentOptions {
  client: SwitchBotClient;
  store: JsonlEventStore;
  node: string;
  rulesDir: string;
  dryRun?: boolean;
  /** 指定するとこの deviceId 群だけポーリングする */
  deviceFilter?: Set<string>;
  /** notify アクションの宛先（Slack Incoming Webhook 互換: {"text": ...} を POST） */
  notifyWebhook?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface PollStats {
  devices: number;
  snapshots: number;
  changes: number;
  fired: number;
  errors: string[];
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class TsukumoAgent {
  readonly node: string;
  readonly rulesDir: string;
  readonly dryRun: boolean;
  rules: Rule[] = [];
  devices: SwitchBotDevice[] = [];
  readonly lastStatus = new Map<string, Record<string, unknown>>();

  private readonly client: SwitchBotClient;
  private readonly store: JsonlEventStore;
  private readonly deviceFilter?: Set<string>;
  private readonly log: (message: string) => void;
  private readonly executor: ActionExecutor;

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.store = options.store;
    this.node = options.node;
    this.rulesDir = options.rulesDir;
    this.dryRun = options.dryRun === true;
    this.deviceFilter = options.deviceFilter;
    this.log = options.log ?? ((message) => console.error(message));
    mkdirSync(this.rulesDir, { recursive: true });

    const fetchImpl = options.fetchImpl ?? fetch;
    const notifyWebhook = options.notifyWebhook;
    this.executor = {
      sendCommand: (deviceId, command, parameter, commandType) =>
        this.client.sendCommand(deviceId, command, parameter, commandType),
      notify: async (message) => {
        if (!notifyWebhook) throw new Error("TSUKUMO_NOTIFY_WEBHOOK is not set");
        const response = await fetchImpl(notifyWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
        if (!response.ok) throw new Error(`notify webhook returned HTTP ${response.status}`);
      },
      log: (message) => this.log(`[rule] ${message}`),
    };
  }

  /**
   * rules ディレクトリの *.json を読み込む。壊れたルールはスキップして報告。
   * rule.node が指定されていて自ノード名と違うものは「他ノード担当」として除外する
   * （同期で全ノードにルールが配られても、多重発火しないための仕組み）。
   */
  loadRules(): { loaded: number; skipped: number; errors: string[] } {
    const errors: string[] = [];
    const rules: Rule[] = [];
    let skipped = 0;
    for (const name of readdirSync(this.rulesDir).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.rulesDir, name), "utf8")) as unknown;
        const problems = validateRule(parsed, null);
        if (problems.length > 0) {
          errors.push(`${name}: ${problems.join(" / ")}`);
          continue;
        }
        const rule = parsed as Rule;
        if (rule.node !== undefined && rule.node !== this.node) {
          skipped += 1;
          continue;
        }
        rules.push(rule);
      } catch (cause) {
        errors.push(`${name}: ${describeError(cause)}`);
      }
    }
    this.rules = rules;
    return { loaded: rules.length, skipped, errors };
  }

  /** デバイス一覧を取り直す（物理デバイスのみ）。戻り値は台数 */
  async refreshDevices(): Promise<number> {
    const body = (await this.client.listDevices()) as DeviceListBody;
    let devices = body?.deviceList ?? [];
    if (this.deviceFilter !== undefined) {
      devices = devices.filter((device) => this.deviceFilter?.has(device.deviceId));
    }
    this.devices = devices;
    return devices.length;
  }

  /** 全デバイスを1周ポーリングする。デバイス単位の失敗は握って続行 */
  async pollOnce(): Promise<PollStats> {
    const stats: PollStats = { devices: this.devices.length, snapshots: 0, changes: 0, fired: 0, errors: [] };
    for (const device of this.devices) {
      try {
        const status = (await this.client.getDeviceStatus(device.deviceId)) as Record<string, unknown>;
        const meta = {
          node: this.node,
          deviceId: device.deviceId,
          deviceName: typeof device.deviceName === "string" ? device.deviceName : undefined,
          deviceType: typeof device.deviceType === "string" ? device.deviceType : undefined,
          ts: new Date().toISOString(),
        };
        this.store.append(buildSnapshotEvent(status, meta));
        stats.snapshots += 1;

        const changes = diffStatus(this.lastStatus.get(device.deviceId), status, meta);
        this.lastStatus.set(device.deviceId, status);
        for (const change of changes) {
          this.store.append(change);
          stats.changes += 1;
          stats.fired += await this.fire(change);
        }
      } catch (cause) {
        stats.errors.push(`${device.deviceId}: ${describeError(cause)}`);
      }
    }
    return stats;
  }

  /**
   * SwitchBot Webhook の受信ボディを change イベント化してルールを回す。
   * Webhook は「変化の通知」なので、初見のフィールドも from: undefined の変化として扱う。
   */
  async handleWebhookBody(body: unknown): Promise<{ changes: number; fired: number }> {
    const context = (body as { context?: unknown })?.context;
    if (context === null || typeof context !== "object") {
      throw new Error("webhook body has no context object");
    }
    const record = context as Record<string, unknown>;
    const deviceId = String(record.deviceMac ?? record.deviceId ?? "");
    if (deviceId === "") throw new Error("webhook context has no deviceMac/deviceId");

    const status: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      if (value === null || typeof value !== "object") status[field] = value;
    }
    const prev = this.lastStatus.get(deviceId);
    const meta = {
      node: this.node,
      deviceId,
      deviceType: typeof record.deviceType === "string" ? record.deviceType : undefined,
      ts: new Date().toISOString(),
      source: "switchbot-webhook",
    };
    const changes = diffStatus(prev ?? {}, status, meta);
    this.lastStatus.set(deviceId, { ...(prev ?? {}), ...status });

    let fired = 0;
    for (const change of changes) {
      this.store.append(change);
      fired += await this.fire(change);
    }
    return { changes: changes.length, fired };
  }

  private async fire(change: TsukumoEvent): Promise<number> {
    const ruleEvents = await fireRules(
      this.rules,
      change,
      { latest: (deviceId) => this.lastStatus.get(deviceId), now: new Date() },
      this.executor,
      { node: this.node, dryRun: this.dryRun },
    );
    for (const ruleEvent of ruleEvents) {
      this.store.append(ruleEvent);
      this.log(
        `[rule] fired: ${ruleEvent.deviceId} (trigger: ${change.deviceId}.${change.field} ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}${this.dryRun ? ", dry-run" : ""})`,
      );
    }
    return ruleEvents.length;
  }
}
