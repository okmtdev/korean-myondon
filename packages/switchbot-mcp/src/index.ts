#!/usr/bin/env node
/**
 * tsukumo switchbot-mcp — SwitchBot デバイス群を MCP ツールとして公開する stdio サーバー。
 *
 * 使い方:
 *   SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy node src/index.ts
 *
 * 注意: stdout は MCP プロトコル専用。ログはすべて stderr へ。
 */
import { McpServer } from "./mcp.ts";
import { SwitchBotClient } from "./switchbot.ts";
import { createSwitchBotTools } from "./tools.ts";

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
const server = new McpServer(
  { name: "tsukumo-switchbot", version: "0.1.0" },
  createSwitchBotTools(client),
);

server.attach(process.stdin, process.stdout);
console.error("tsukumo switchbot-mcp: ready (stdio)");
