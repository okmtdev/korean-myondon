# @tsukumo/core

tsukumo の共有ライブラリ。**デーモンや CLI は入っていません**（それらは agent / switchbot-mcp / kotodama / sync / media に）。他パッケージからは相対パス（`../../core/src/*.ts`）で import されます。依存ゼロ。

## モジュール一覧

| モジュール | 責務 |
| --- | --- |
| [`src/mcp.ts`](src/mcp.ts) | MCP (Model Context Protocol) stdio サーバーの最小自前実装。JSON-RPC 2.0 / LF 区切り。text と image のツール結果に対応 |
| [`src/switchbot.ts`](src/switchbot.ts) | SwitchBot API v1.1 クライアント。HMAC-SHA256 署名、デバイス/シーン/コマンド/Webhook 管理 |
| [`src/events.ts`](src/events.ts) | イベントモデル（snapshot / change / rule）。tsukumo の共通言語 |
| [`src/store.ts`](src/store.ts) | JSONL イベントストア（日付分割・追記専用）。書き手と読み手が別プロセスでも安全 |
| [`src/history.ts`](src/history.ts) | 履歴クエリ：フィルタ、時間バケット集計、しきい値超過時間帯の検出 |
| [`src/poller.ts`](src/poller.ts) | ポーリング結果の差分検知（純粋ロジック）と無視フィールド定義 |
| [`src/catalog.ts`](src/catalog.ts) | イベントカタログ：観測済みの deviceId / field 一覧。kotodama の語彙＝幻覚防止の根拠 |
| [`src/rules.ts`](src/rules.ts) | ルール IR v0 の型・バリデータ（カタログ照合）・トリガー/条件の評価 |
| [`src/runtime.ts`](src/runtime.ts) | ルールランタイム：change イベント → マッチ → 条件評価 → アクション実行（dry-run 対応） |
| [`src/time.ts`](src/time.ts) | 相対時刻（`-24h` 等）のパースと時間帯判定（日またぎ対応） |

## テスト

```bash
node --test test/*.test.ts
```

署名のゴールデンベクタ、MCP プロトコル往復、ストア・履歴・差分・バリデータ・ランタイムをカバー。
