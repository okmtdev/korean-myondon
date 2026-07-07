# tsukumo — 付喪神

> 長く使われた道具には、魂が宿る。

自宅のデバイス群に LLM という魂を宿す、**個人スケールの IoT 基盤**です。クラウド SaaS でも 1000 台のフリート管理でもなく、「自分の家と、遠くに置いた数台のマシン」だけを幸せにします。

**3本柱**

1. **読める** — 家の状態と履歴を Claude が文脈として持てる（MCP サーバー）
2. **書ける** — 家電・カーテン・プラグを LLM や自作コードから操作できる
3. **任せられる** — 日本語で書いたルールを *コンパイル時だけ* LLM で決定的なルールに変換し、ローカルで動かし続ける（実行時 LLM レス）

設計の全体像は [docs/design.md](docs/design.md) にあります。

## いま動くもの

全パッケージ**依存ゼロ**（`npm install` 不要）。Node 22.18+ で `git clone` して即動きます。

| パッケージ | フェーズ | 説明 |
| --- | --- | --- |
| [`packages/core`](packages/core/) | — | 共有部品：自前 MCP 実装、SwitchBot クライアント、JSONL イベントストア、履歴クエリ、ルールエンジン |
| [`packages/switchbot-mcp`](packages/switchbot-mcp/) | 0+1 | Claude から家を読み書きする MCP サーバー。`TSUKUMO_STORE_DIR` を渡すと履歴クエリツールも生える |
| [`packages/agent`](packages/agent/) | 1+2 | 常駐デーモン。ポーリング/Webhook で観測を溜め、コンパイル済みルールをローカル実行する |
| [`packages/kotodama`](packages/kotodama/) | 2 | 言霊：日本語 → ルール IR コンパイラ（LLM はコンパイル時だけ） |

## クイックスタート

```bash
git clone <this-repo> && cd korean-myondon
export SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy

# ① 観測を溜め始める（別ターミナルで常駐）
TSUKUMO_STORE_DIR=./data node packages/agent/src/index.ts

# ② Claude Code から家を読める・動かせる・履歴を聞けるようにする
claude mcp add tsukumo-switchbot \
  -e SWITCHBOT_TOKEN=xxx -e SWITCHBOT_SECRET=yyy \
  -e TSUKUMO_STORE_DIR=/absolute/path/to/data \
  -- node /absolute/path/to/packages/switchbot-mcp/src/index.ts

# ③ 日本語でルールを書く（LLM はこの瞬間だけ。実行は agent がローカルで）
#    GEMINI_API_KEY か ANTHROPIC_API_KEY のどちらかがあれば OK
GEMINI_API_KEY=... TSUKUMO_STORE_DIR=./data \
  node packages/kotodama/src/index.ts compile \
  "湿度が60%を超えたらサーキュレーターをつけて通知して"
```

詳細は各パッケージの README と [docs/design.md](docs/design.md) へ。

---

※ リポジトリ名 `korean-myondon` に意味はありません。歴史的事情です。
