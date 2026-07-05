# @tsukumo/switchbot-mcp

SwitchBot デバイス群を MCP (Model Context Protocol) ツールとして公開する stdio サーバー。**依存ゼロ**（`npm install` 不要）で、Node.js 22.18+ だけで動きます。MCP の stdio プロトコル（JSON-RPC 2.0 / LF 区切り）自体を [`src/mcp.ts`](src/mcp.ts) で自前実装しています。

Claude に繋ぐとこうなります：

- 「寝室いま何度？湿度は？」 → 温湿度計を読んで答える
- 「サーキュレーターのプラグ切っといて」 → プラグを操作する
- 「おやすみシーン実行して」 → シーンを実行する

## 必要なもの

- Node.js **22.18 以上**（`node --version` で確認。TypeScript をビルドなしで直接実行するため）
- SwitchBot のトークンとシークレット
  1. SwitchBot アプリ → プロフィール → 設定
  2. 「アプリバージョン」を **10 回タップ** → 「開発者向けオプション」が出現
  3. トークンとクライアントシークレットを控える

## 動作確認（デバイス一覧が返れば成功）

```bash
export SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"switchbot_list_devices","arguments":{}}}' \
  | node src/index.ts
```

## Claude Code に繋ぐ

```bash
claude mcp add tsukumo-switchbot \
  -e SWITCHBOT_TOKEN=xxx -e SWITCHBOT_SECRET=yyy \
  -- node /absolute/path/to/packages/switchbot-mcp/src/index.ts
```

## Claude Desktop に繋ぐ

`claude_desktop_config.json` に追記：

```json
{
  "mcpServers": {
    "tsukumo-switchbot": {
      "command": "node",
      "args": ["/absolute/path/to/packages/switchbot-mcp/src/index.ts"],
      "env": {
        "SWITCHBOT_TOKEN": "xxx",
        "SWITCHBOT_SECRET": "yyy"
      }
    }
  }
}
```

## ツール一覧

| ツール | 種別 | 説明 |
| --- | --- | --- |
| `switchbot_list_devices` | 読み取り | 物理デバイスと赤外線リモコンの一覧。まずこれで deviceId を調べる |
| `switchbot_get_device_status` | 読み取り | 温度・湿度・CO2・バッテリー・電源状態・カーテン位置など（IR リモコンには無い） |
| `switchbot_send_command` | **操作** | `turnOn` / `turnOff` / `press` / `setPosition`、IR エアコンの `setAll` など |
| `switchbot_list_scenes` | 読み取り | アプリで作った手動シーンの一覧 |
| `switchbot_execute_scene` | **操作** | シーン実行 |

## テスト

```bash
node --test test/*.test.ts
```

## 注意

- SwitchBot API **v1.1**（cloud 経由）を使います。レート制限は 1 日 10,000 リクエスト目安
- 署名ロジック（HMAC-SHA256 → base64 → 大文字化）はゴールデンテストで固定していますが、**実機での疎通はまだ未検証**です。`HTTP 401` が返る場合は署名まわりを疑い、一次情報 <https://github.com/OpenWonderLabs/SwitchBotAPI> と突き合わせてください
- stdout は MCP プロトコル専用です。デバッグログを足すときは必ず `console.error`（stderr）へ
