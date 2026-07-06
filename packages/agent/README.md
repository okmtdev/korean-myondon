# @tsukumo/agent

tsukumo の常駐デーモン。**依存ゼロ**（`npm install` 不要）、Node 22.18+ だけで動きます。

やること：

1. SwitchBot を定期ポーリングして、状態全体（snapshot）と変化（change）を JSONL ストアへ追記する
2. change イベントに対して、コンパイル済みルール（`rules/*.json`）を**ローカルで**評価・実行する（実行時 LLM レス）
3. （任意）SwitchBot Webhook を受信して、ポーリングの合間の変化も拾う

ネットが切れてもループは止まりません。復帰したら勝手に続きから動きます（ローカルファースト）。

## 起動

```bash
cd packages/agent
SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy node src/index.ts
```

イベントが流れているかは、ストアを直接覗けば見えます：

```bash
tail -f data/events-$(date -u +%F).jsonl
```

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` | （必須） | SwitchBot API 認証情報 |
| `TSUKUMO_STORE_DIR` | `./data` | イベントストア（JSONL、日付分割） |
| `TSUKUMO_RULES_DIR` | `<store>/rules` | ルール置き場。変更はホットリロードされる |
| `TSUKUMO_NODE` | ホスト名 | イベントに記録するノード名（例: `home`, `remote-camera`） |
| `TSUKUMO_POLL_SECONDS` | `300` | ポーリング間隔（最小 30）。デバイス数×頻度のレート試算を起動時にログする |
| `TSUKUMO_DEVICE_IDS` | 全デバイス | カンマ区切りで対象を絞る |
| `TSUKUMO_NOTIFY_WEBHOOK` | なし | `notify` アクションの宛先。Slack Incoming Webhook 互換（`{"text": ...}` を POST） |
| `TSUKUMO_DRY_RUN` | なし | `1` でアクションを実行せず記録だけ（新ルールの様子見に） |
| `TSUKUMO_WEBHOOK_PORT` | なし | SwitchBot Webhook 受信ポート。`GET /healthz` も生える（死活監視用） |
| `TSUKUMO_SWITCHBOT_BASE_URL` | 本番 API | テスト用の差し替え口 |

## systemd で常駐させる（mini PC 向け）

`/etc/tsukumo.env` に認証情報を置いて：

```ini
# /etc/systemd/system/tsukumo-agent.service
[Unit]
Description=tsukumo agent
After=network-online.target

[Service]
WorkingDirectory=/opt/tsukumo/packages/agent
EnvironmentFile=/etc/tsukumo.env
Environment=TSUKUMO_STORE_DIR=/var/lib/tsukumo
ExecStart=/usr/bin/node src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tsukumo-agent
journalctl -u tsukumo-agent -f
```

## SwitchBot Webhook（任意・推奨）

ポーリングだけでも動きますが、Webhook を足すと変化が即座に届き、ポーリング間隔を伸ばせます（レート制限にも優しい）。

1. agent を `TSUKUMO_WEBHOOK_PORT=18280` などで起動
2. インターネットから届く URL を用意（Tailscale Funnel や cloudflared が手軽）
3. SwitchBot 側に登録：

```bash
SWITCHBOT_TOKEN=xxx SWITCHBOT_SECRET=yyy \
  node src/webhook-setup.ts setup https://your-endpoint.example/webhook
node src/webhook-setup.ts query          # 確認
node src/webhook-setup.ts delete <url>   # 解除
```

## テスト

```bash
node --test test/*.test.ts
```

E2E テストは偽の SwitchBot API サーバーを立てて「ポーリング → 変化検知 → ルール発火（コマンド送信・通知）→ 履歴クエリ」まで一気通貫で検証しています。
