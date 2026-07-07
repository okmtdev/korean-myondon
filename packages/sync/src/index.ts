#!/usr/bin/env node
/**
 * tsukumo sync — ルールをノード間で同期する常駐プロセス（Phase 3）。
 * tsukumo で唯一、依存（Automerge）を持つパッケージ。初回のみ:
 *
 *   cd packages/sync && npm install
 *
 * 使い方（1台目 = ハブ）:
 *   TSUKUMO_SYNC_LISTEN_PORT=7821 node src/index.ts
 *   → 起動ログに出る automerge:xxxx の URL を控える
 *
 * 使い方（2台目以降）:
 *   TSUKUMO_SYNC_PEERS=ws://<ハブのTailscale名>:7821 \
 *   TSUKUMO_SYNC_DOC_URL=automerge:xxxx node src/index.ts
 *
 * 環境変数:
 *   TSUKUMO_STORE_DIR        ストア（default: ./data）
 *   TSUKUMO_RULES_DIR        ルール置き場（default: <store>/rules）
 *   TSUKUMO_SYNC_STATE_DIR   同期状態 + Automerge ストレージ（default: <store>/sync）
 *   TSUKUMO_NODE             ノード名（default: ホスト名）
 *   TSUKUMO_SYNC_LISTEN_PORT WebSocket 待ち受けポート（ハブ側）
 *   TSUKUMO_SYNC_PEERS       接続先 ws://host:port（カンマ区切り）
 *   TSUKUMO_SYNC_DOC_URL     制御ドキュメント URL（2台目以降は必須）
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { startSyncService } from "./service.ts";

const storeDir = process.env.TSUKUMO_STORE_DIR ?? "./data";
const listenPortRaw = process.env.TSUKUMO_SYNC_LISTEN_PORT;

startSyncService({
  rulesDir: process.env.TSUKUMO_RULES_DIR ?? join(storeDir, "rules"),
  stateDir: process.env.TSUKUMO_SYNC_STATE_DIR ?? join(storeDir, "sync"),
  nodeName: process.env.TSUKUMO_NODE ?? hostname(),
  listenPort: listenPortRaw ? Number(listenPortRaw) : undefined,
  peers: (process.env.TSUKUMO_SYNC_PEERS ?? "")
    .split(",")
    .map((peer) => peer.trim())
    .filter(Boolean),
  docUrl: process.env.TSUKUMO_SYNC_DOC_URL,
  log: (message) => console.error(`${new Date().toISOString()} ${message}`),
})
  .then((service) => {
    const shutdown = () => {
      void service.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`tsukumo-sync: 起動に失敗しました: ${message}`);
    if (/Cannot find (package|module)/i.test(message)) {
      console.error("tsukumo-sync: 依存が未インストールです。cd packages/sync && npm install を実行してください。");
    }
    process.exit(1);
  });
