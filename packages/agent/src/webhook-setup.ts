#!/usr/bin/env node
/**
 * SwitchBot Webhook 登録の管理 CLI。
 *
 *   SWITCHBOT_TOKEN=... SWITCHBOT_SECRET=... node src/webhook-setup.ts setup https://example.com/webhook
 *   node src/webhook-setup.ts query
 *   node src/webhook-setup.ts delete https://example.com/webhook
 */
import { SwitchBotClient } from "../../core/src/switchbot.ts";

const token = process.env.SWITCHBOT_TOKEN;
const secret = process.env.SWITCHBOT_SECRET;
if (!token || !secret) {
  console.error("SWITCHBOT_TOKEN と SWITCHBOT_SECRET を環境変数で渡してください。");
  process.exit(1);
}

const [command, url] = process.argv.slice(2);
const client = new SwitchBotClient(
  { token, secret },
  process.env.TSUKUMO_SWITCHBOT_BASE_URL ? { baseUrl: process.env.TSUKUMO_SWITCHBOT_BASE_URL } : {},
);

async function main(): Promise<void> {
  switch (command) {
    case "setup": {
      if (!url) throw new Error("usage: webhook-setup.ts setup <url>");
      console.log(JSON.stringify(await client.setupWebhook(url), null, 2));
      break;
    }
    case "query": {
      console.log(JSON.stringify(await client.queryWebhook(), null, 2));
      break;
    }
    case "delete": {
      if (!url) throw new Error("usage: webhook-setup.ts delete <url>");
      console.log(JSON.stringify(await client.deleteWebhook(url), null, 2));
      break;
    }
    default:
      throw new Error("usage: webhook-setup.ts <setup|query|delete> [url]");
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
