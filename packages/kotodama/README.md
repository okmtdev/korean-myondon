# @tsukumo/kotodama

**言霊** — 日本語で書いたルールを、ローカルで動く決定的なルール IR（JSON）にコンパイルする。

LLM（Claude API）を使うのは**コンパイル時のこの一瞬だけ**。できあがったルールは agent が 24 時間ローカルで実行し、実行時に LLM は登場しません（速い・タダ・オフライン OK・再現可能）。

## 使い方

```bash
cd packages/kotodama

# 1. まず agent を動かして観測を溜めておく（カタログの材料になる）

# 2. 日本語でコンパイル
ANTHROPIC_API_KEY=sk-... node src/index.ts compile \
  "湿度が60%を超えたらサーキュレーターをつけて、Slackに知らせて"

# 3. 管理
node src/index.ts list
node src/index.ts show <id>
node src/index.ts disable <id>   # / enable <id>
node src/index.ts remove <id>
```

コンパイル結果は `TSUKUMO_RULES_DIR`（既定 `<store>/rules/`）に `<id>.json` として保存され、**agent が動いていればホットリロードで即座に有効**になります。いきなり本番が怖ければ agent 側を `TSUKUMO_DRY_RUN=1` にして様子見できます。

## 幻覚防止のしくみ

- コンパイラに渡るのは**イベントカタログ**（agent が実際に観測した deviceId / field の一覧）だけ。カタログ外の語彙を使ったルールは**バリデーションで機械的に弾かれ**、エラー内容を LLM にフィードバックして 1 回だけリトライします
- 表現できない要望（「在宅のときだけ」→在宅判定できるデバイスがない、定時実行 等）は、推測せず**「できない」と正直に断る**よう指示しています
- 解釈に幅があった場合は warnings として表示されます

## ルール IR の例

「湿度が60%を超えたらサーキュレーターをつけて通知」はこうコンパイルされます：

```json
{
  "id": "humidity-fan-notify",
  "source": "湿度が60%を超えたらサーキュレーターをつけて、Slackに知らせて",
  "enabled": true,
  "trigger": {
    "deviceId": "C12345ABCDE",
    "field": "humidity",
    "to": { "gt": 60 },
    "from": { "lte": 60 }
  },
  "actions": [
    { "type": "switchbot_command", "deviceId": "PLUG567890", "command": "turnOn" },
    { "type": "notify", "message": "湿度が60%を超えたよ" }
  ],
  "explanation": "寝室の湿度が60%を上回った瞬間に、サーキュレーターのプラグをONにして通知します。"
}
```

`from` と `to` で挟むことで「超えた**瞬間**に1回だけ」発火します（60%超えのあいだ連打されない）。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | （compile に必須） | Claude API キー |
| `TSUKUMO_COMPILE_MODEL` | `claude-sonnet-5` | コンパイルに使うモデル |
| `TSUKUMO_STORE_DIR` | `./data` | イベントストア（カタログの材料） |
| `TSUKUMO_RULES_DIR` | `<store>/rules` | ルール保存先 |

## v0 の既知の限界

- トリガーは「1デバイス1フィールドの変化」のみ。**定時実行**や「**N分間続いたら**」はまだ表現できない（コンパイラは正直に断る）
- 条件に使える状態は SwitchBot の観測値のみ（「在宅」などの仮想状態は将来のイベント源で）
- 発火のデバウンス（値が閾値付近で揺れたときの連打抑制）は未実装。`from`/`to` で挟む書き方で大半は回避できる

## テスト

```bash
node --test test/*.test.ts
```

Claude API はモックで、正常系・フェンス付き出力・バリデーション違反のリトライ・変換不能・既存ルールとの重複警告・API エラーを検証しています。
