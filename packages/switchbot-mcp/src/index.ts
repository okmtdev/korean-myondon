#!/usr/bin/env node
/**
 * tsukumo switchbot-mcp — SwitchBot デバイス群を MCP ツールとして公開する stdio サーバー。
 *
 * 使い方:
 *   SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy node src/index.ts
 *
 * TSUKUMO_STORE_DIR を設定すると、agent が溜めたイベント履歴への
 * クエリツール（tsukumo_*）も有効になる。
 *
 * 注意: stdout は MCP プロトコル専用。ログはすべて stderr へ。
 */
import { McpServer } from "../../core/src/mcp.ts";
import { SwitchBotClient } from "../../core/src/switchbot.ts";
import { JsonlEventStore } from "../../core/src/store.ts";
import { createSwitchBotTools } from "./tools.ts";
import { createHistoryTools } from "./history-tools.ts";
import { createCameraTools, parseCameraUrls } from "./camera-tools.ts";

const token = process.env.SWITCHBOT_TOKEN;
const secret = process.env.SWITCHBOT_SECRET;

if (!token || !secret) {
  console.error(
    "switchbot-mcp: SWITCHBOT_TOKEN と SWITCHBOT_SECRET を環境変数で渡してください。\n" +
      "取得方法: SwitchBot アプリ → プロフィール → 設定 → アプリバージョンを10回タップ → 開発者向けオプション",
  );
  process.exit(1);
}

const client = new SwitchBotClient({ token, secret });
const tools = createSwitchBotTools(client);

const storeDir = process.env.TSUKUMO_STORE_DIR;
if (storeDir) {
  tools.push(...createHistoryTools(new JsonlEventStore(storeDir)));
}

const cameraUrls = parseCameraUrls(process.env.TSUKUMO_CAMERA_URLS);
if (Object.keys(cameraUrls).length > 0) {
  tools.push(...createCameraTools(cameraUrls));
}

const server = new McpServer({ name: "tsukumo-switchbot", version: "0.3.0" }, tools);

server.attach(process.stdin, process.stdout);
console.error(
  `tsukumo switchbot-mcp: ready (stdio, ${tools.length} tools${storeDir ? `, history store: ${storeDir}` : ", history disabled — set TSUKUMO_STORE_DIR"})`,
);
