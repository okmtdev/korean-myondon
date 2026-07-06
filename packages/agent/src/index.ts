#!/usr/bin/env node
/**
 * tsukumo agent — 常駐デーモンのエントリポイント。
 *
 * SwitchBot をポーリングして snapshot / change イベントをストアへ追記し、
 * change に対してコンパイル済みルール（rules/*.json）をローカルで実行する。
 * ネットが切れてもループは止まらない。復帰したら勝手に続きから動く。
 *
 * 環境変数:
 *   SWITCHBOT_TOKEN / SWITCHBOT_SECRET  必須
 *   TSUKUMO_STORE_DIR      イベントストア (default: ./data)
 *   TSUKUMO_RULES_DIR      ルール置き場   (default: <store>/rules)
 *   TSUKUMO_NODE           ノード名       (default: ホスト名)
 *   TSUKUMO_POLL_SECONDS   ポーリング間隔 (default: 300, min: 30)
 *   TSUKUMO_DEVICE_IDS     カンマ区切りで対象デバイスを絞る
 *   TSUKUMO_NOTIFY_WEBHOOK notify アクションの宛先 (Slack Incoming Webhook 互換)
 *   TSUKUMO_DRY_RUN=1      ルールのアクションを実行せず記録だけ
 *   TSUKUMO_WEBHOOK_PORT   SwitchBot Webhook 受信ポート（省略なら受けない）
 *   TSUKUMO_SWITCHBOT_BASE_URL  APIベースURL上書き（テスト用）
 */
import { watch } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../../core/src/store.ts";
import { SwitchBotClient } from "../../core/src/switchbot.ts";
import { TsukumoAgent } from "./agent.ts";

const token = process.env.SWITCHBOT_TOKEN;
const secret = process.env.SWITCHBOT_SECRET;
if (!token || !secret) {
  console.error("tsukumo-agent: SWITCHBOT_TOKEN と SWITCHBOT_SECRET を環境変数で渡してください。");
  process.exit(1);
}

const storeDir = process.env.TSUKUMO_STORE_DIR ?? "./data";
const rulesDir = process.env.TSUKUMO_RULES_DIR ?? join(storeDir, "rules");
const node = process.env.TSUKUMO_NODE ?? hostname();
const pollSeconds = Math.max(30, Number(process.env.TSUKUMO_POLL_SECONDS ?? 300) || 300);
const deviceIds = process.env.TSUKUMO_DEVICE_IDS;
const dryRun = process.env.TSUKUMO_DRY_RUN === "1" || process.env.TSUKUMO_DRY_RUN === "true";

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

const client = new SwitchBotClient(
  { token, secret },
  process.env.TSUKUMO_SWITCHBOT_BASE_URL ? { baseUrl: process.env.TSUKUMO_SWITCHBOT_BASE_URL } : {},
);
const store = new JsonlEventStore(storeDir);
const agent = new TsukumoAgent({
  client,
  store,
  node,
  rulesDir,
  dryRun,
  deviceFilter: deviceIds ? new Set(deviceIds.split(",").map((id) => id.trim()).filter(Boolean)) : undefined,
  notifyWebhook: process.env.TSUKUMO_NOTIFY_WEBHOOK,
  log,
});

// --- ルール読み込み + ホットリロード -----------------------------------
const initialRules = agent.loadRules();
log(`tsukumo-agent: rules loaded=${initialRules.loaded}${dryRun ? " (dry-run)" : ""}`);
for (const error of initialRules.errors) log(`tsukumo-agent: rule error: ${error}`);

let reloadTimer: NodeJS.Timeout | undefined;
watch(rulesDir, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const result = agent.loadRules();
    log(`tsukumo-agent: rules reloaded=${result.loaded}`);
    for (const error of result.errors) log(`tsukumo-agent: rule error: ${error}`);
  }, 500);
});

// --- SwitchBot Webhook 受信（任意） -------------------------------------
const webhookPort = Number(process.env.TSUKUMO_WEBHOOK_PORT ?? 0);
const webhookServer = webhookPort
  ? createServer((request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 512 * 1024) request.destroy();
      });
      request.on("end", async () => {
        try {
          const result = await agent.handleWebhookBody(JSON.parse(body));
          log(`tsukumo-agent: webhook changes=${result.changes} fired=${result.fired}`);
          response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          log(`tsukumo-agent: webhook error: ${message}`);
          response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: message }));
        }
      });
    }).listen(webhookPort, () => log(`tsukumo-agent: webhook listening on :${webhookPort} (GET /healthz あり)`))
  : undefined;

// --- ポーリングループ -----------------------------------------------------
let stopped = false;
let deviceRefreshedAt = 0;
const DEVICE_REFRESH_MS = 60 * 60 * 1000;

async function loop(): Promise<void> {
  while (!stopped) {
    try {
      if (Date.now() - deviceRefreshedAt > DEVICE_REFRESH_MS) {
        const count = await agent.refreshDevices();
        deviceRefreshedAt = Date.now();
        const estimated = Math.round((count * 86_400) / pollSeconds) + 24;
        log(`tsukumo-agent: devices=${count} poll=${pollSeconds}s estimated ${estimated} req/day (limit ~10000)`);
        if (estimated > 8000) log("tsukumo-agent: WARNING: レート制限に近い。TSUKUMO_POLL_SECONDS を増やすか TSUKUMO_DEVICE_IDS で絞ってください");
      }
      const stats = await agent.pollOnce();
      log(
        `tsukumo-agent: poll devices=${stats.devices} snapshots=${stats.snapshots} changes=${stats.changes} fired=${stats.fired}${stats.errors.length > 0 ? ` errors=${stats.errors.length}` : ""}`,
      );
      for (const error of stats.errors) log(`tsukumo-agent: poll error: ${error}`);
    } catch (cause) {
      // クラウド全断でもループは殺さない（ローカルファースト）
      log(`tsukumo-agent: poll cycle failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

function shutdown(signal: string): void {
  log(`tsukumo-agent: ${signal} received, shutting down`);
  stopped = true;
  webhookServer?.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`tsukumo-agent: start node=${node} store=${storeDir} rules=${rulesDir}`);
loop();
