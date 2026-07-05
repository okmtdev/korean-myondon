# tsukumo — 付喪神

> 長く使われた道具には、魂が宿る。

自宅のデバイス群に LLM という魂を宿す、**個人スケールの IoT 基盤**です。クラウド SaaS でも 1000 台のフリート管理でもなく、「自分の家と、遠くに置いた数台のマシン」だけを幸せにします。

**3本柱**

1. **読める** — 家の状態と履歴を Claude が文脈として持てる（MCP サーバー）
2. **書ける** — 家電・カーテン・プラグを LLM や自作コードから操作できる
3. **任せられる** — 日本語で書いたルールを *コンパイル時だけ* LLM で決定的なルールに変換し、ローカルで動かし続ける（実行時 LLM レス）

設計の全体像は [docs/design.md](docs/design.md) にあります。

## いま動くもの

| パッケージ | フェーズ | 説明 |
| --- | --- | --- |
| [`packages/switchbot-mcp`](packages/switchbot-mcp/) | Phase 0 | SwitchBot デバイス群を Claude から読み書きできる MCP サーバー。**依存ゼロ**（`npm install` 不要）、Node 22.18+ だけで動く |

## クイックスタート（Phase 0）

```bash
git clone <this-repo> && cd korean-myondon
SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy node packages/switchbot-mcp/src/index.ts
```

Claude Code に繋ぐなら：

```bash
claude mcp add tsukumo-switchbot \
  -e SWITCHBOT_TOKEN=xxx -e SWITCHBOT_SECRET=yyy \
  -- node /absolute/path/to/packages/switchbot-mcp/src/index.ts
```

トークンの取り方など詳細は [packages/switchbot-mcp/README.md](packages/switchbot-mcp/README.md) へ。

---

※ リポジトリ名 `korean-myondon` に意味はありません。歴史的事情です。
