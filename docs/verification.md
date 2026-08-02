# tsukumo 実機検証ガイド

Phase 0〜4 は実装・ユニット/E2Eテスト済みですが、開発環境の制約（外部ネットワーク遮断・実機ハードなし）により、**外部 API とハードウェアに触れる部分は実機での検証待ち**です。このガイドの順に動かせば、全フェーズを最短で答え合わせできます。

つまずいたら、エラー出力をそのまま Claude に貼ってください。どの層の問題かはエラーで切り分けられます。

## 前提

| 必要なもの | 確認コマンド | 備考 |
| --- | --- | --- |
| Node.js 22.18+ | `node --version` | TS をビルドなしで直接実行するため |
| SwitchBot トークン/シークレット | — | アプリ → プロフィール → 設定 → アプリバージョンを10回タップ → 開発者向けオプション |
| Gemini API キー | — | [Google AI Studio](https://aistudio.google.com/) で無料発行（Phase 2 で使用） |
| ffmpeg / alsa-utils | `ffmpeg -version` / `arecord --version` | Phase 4 のみ。`sudo apt install ffmpeg alsa-utils` |

## Step 0: 全テストを手元でも回す（3分）

```bash
node --test packages/*/test/*.test.ts
```

期待: **91 pass / 1 skip**（skip は Automerge E2E。Step 4 で有効化される）。

## Step 1: Phase 0 — Claude から家が見える（5分・最初のドーパミン）

```bash
claude mcp add tsukumo-switchbot \
  -e SWITCHBOT_TOKEN=xxx -e SWITCHBOT_SECRET=yyy \
  -- node /absolute/path/packages/switchbot-mcp/src/index.ts
```

Claude に「**家のデバイス一覧見せて**」→ 実物の SwitchBot 一覧が返れば合格。「寝室いま何度？」「プラグ切って」も試す。

- `HTTP 401` が出たら: 署名まわりの疑い。エラーをそのまま報告（`packages/core/src/switchbot.ts` の `buildAuthHeaders` が容疑者）

## Step 2: Phase 1 — 観測が溜まり、履歴に答えられる（放置30分〜）

```bash
cd packages/agent
SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy TSUKUMO_STORE_DIR=./data TSUKUMO_NODE=home node src/index.ts
```

期待: 起動ログに `devices=N ... estimated X req/day` → 各ポーリングで `poll devices=N snapshots=N ...`。イベントの流れは `tail -f data/events-$(date -u +%F).jsonl` で見える。

30分ほど放置したら、Step 1 の MCP に `-e TSUKUMO_STORE_DIR=/absolute/path/data` を足して再登録し、Claude に「**この30分で湿度はどう動いた？**」→ 実測の集計が返れば合格。

## Step 3: Phase 2 — 日本語がルールになる（10分）

```bash
cd packages/kotodama
GEMINI_API_KEY=... TSUKUMO_STORE_DIR=../agent/data TSUKUMO_NODE=home \
  node src/index.ts compile "湿度が60%を超えたらSlackに知らせて"
```

期待: ルール JSON と説明文が出力され、`data/rules/*.json` に保存 → **agent が動いていれば** `rules reloaded=1` がログに出る。

- 通知を実際に受けるには agent 側に `TSUKUMO_NOTIFY_WEBHOOK`（Slack Incoming Webhook URL）が必要
- 最初は agent を `TSUKUMO_DRY_RUN=1` で起動して様子見が安全
- 「カタログが空です」→ Step 2 を先に（観測がルールの語彙になる）

## Step 4: Phase 3 — 2ノード同期（30分）

```bash
cd packages/sync
npm install        # tsukumo で npm install が要るのはここだけ
npm test           # ← skip されていた実 Automerge の2ノードE2E が走る。まずこれ
```

期待: **bridge テスト + Automerge E2E が全部 pass**。API 名ズレ系のエラーが出たら報告（修正は `src/service.ts` の1ファイルに閉じている）。

通ったら本番配置（詳細は [packages/sync/README.md](../packages/sync/README.md)）:
1. 自宅側: `TSUKUMO_SYNC_LISTEN_PORT=7821 node src/index.ts` → ログの `automerge:xxxx` を控える
2. mini PC 側: `TSUKUMO_SYNC_PEERS=ws://<自宅のTailscale名>:7821 TSUKUMO_SYNC_DOC_URL=automerge:xxxx node src/index.ts`
3. 受け入れデモ: 片側の sync を止める → 両側でルールを編集/追加 → 再起動 → 数秒で `rules/` が一致

## Step 5: Phase 4 — カメラとマイク（各30分）

**マイク（自宅）**: まず較正 → 常駐 → ルール。

```bash
cd packages/media
node src/mic-calibrate.ts 15         # 15秒の間に洗濯機やインターホンを鳴かせる
TSUKUMO_BEEPS="washer=<出た周波数>:500" TSUKUMO_STORE_DIR=../agent/data node src/mic.ts
```

期待: 実際にビープが鳴ると `mic: beep:washer {...}` がログに出て、agent 側で `external mic ...` → ルール発火。

**カメラ（mini PC）**:

```bash
TSUKUMO_STORE_DIR=/var/lib/tsukumo TSUKUMO_NODE=remote-camera \
TSUKUMO_CAMERA_ID=entrance TSUKUMO_CAMERA_HTTP_PORT=8180 node src/camera.ts
```

期待: カメラの前で動くと `camera: motion true` → 静止10秒で `motion false`。`curl http://localhost:8180/snapshot -o /tmp/s.jpg` で1枚取れる。switchbot-mcp に `-e TSUKUMO_CAMERA_URLS=entrance=http://<mini PC>:8180` を足すと、Claude に「玄関カメラ見せて」で画像が返る。

- 誤検知が多い/少ない → `TSUKUMO_MOTION_ENTER`（既定 0.06）を上下

## 全部通ったら

看板デモ「**玄関で動きがあったらリビングのライトをつけて**」（遠隔カメラ × 自宅 SwitchBot × 同期ルール）が組めます。kotodama に日本語で頼むだけです。
