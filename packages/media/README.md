# @tsukumo/media

**Phase 4** — カメラとマイクをイベント源にする。npm 依存ゼロ（キャプチャはシステムの `ffmpeg` / `arecord` を使う）。

**プライバシー原則**: 映像・音声の生データは保存も送信もしない。ストアに残るのは「動きがあった」「洗濯機が鳴いた」という**事実（イベント）だけ**。カメラのスナップショットは MCP から明示的に要求された瞬間の1枚だけが返る。

## しくみ（ストア＝イベントバス）

```
camera.ts / mic.ts ──(change イベント追記)──▶ イベントストア(JSONL) ──(tail)──▶ agent がルール発火
                                                     │
                                                     └────▶ 履歴クエリ（MCP）にもそのまま載る
```

agent は `TSUKUMO_TAIL_SOURCES`（既定 `camera,mic`）のイベントをストア経由で拾ってルールを回します。つまり media デーモンはストアに書くだけでよく、agent の再起動とも独立です。

## カメラ（遠隔 mini PC の監視カメラ）

必要なもの: `sudo apt install ffmpeg`、USB カメラ（`/dev/video0`）。

```bash
cd packages/media
TSUKUMO_STORE_DIR=/var/lib/tsukumo TSUKUMO_NODE=remote-camera \
TSUKUMO_CAMERA_ID=entrance TSUKUMO_CAMERA_HTTP_PORT=8180 \
node src/camera.ts
```

- ffmpeg がカメラを**1本だけ**開き、出力を2系統に分ける：低解像度グレースケール（動体検知用。フレーム差分＋ヒステリシス）と 1fps の MJPEG（最新1枚だけメモリ保持）
- 動体検知は `camera:entrance` の `motion` フィールドの true/false 遷移としてストアへ。ルール例：「玄関で動きがあったら通知」
- `GET :8180/snapshot` で最新の1枚（**Tailscale 内にだけ開けること**）。`GET /healthz` は死活監視用
- しきい値調整: `TSUKUMO_MOTION_ENTER`（既定 0.06）/ `TSUKUMO_MOTION_EXIT`（0.03）/ `TSUKUMO_MOTION_HOLD_MS`（10000）

Claude から見る場合は switchbot-mcp に `TSUKUMO_CAMERA_URLS=entrance=http://<mini PCのTailscale名>:8180` を渡すと `tsukumo_camera_snapshot` ツールが生えます（画像は MCP の image content で返る）。

## マイク（自宅のビープ検知）

必要なもの: `arecord`（`alsa-utils`）、マイク（USB マイクや Web カメラ内蔵ので十分）。

哲学: v0 は音分類 ML を使いません。家電は決まった周波数で「ピー」と鳴くので、**Goertzel アルゴリズム**（特定周波数の振幅だけを O(N) で計算）でビープを検知します。洗濯機・炊飯器・電子レンジ・インターホンはだいたいこれで拾えます。

### 1. 較正 — 家電の鳴き声の周波数を調べる

```bash
node src/mic-calibrate.ts 15   # 15秒録音するので、その間に洗濯機を鳴かせる
# → 「2000 Hz (12回, 最大振幅 0.31)」のように表示される
```

### 2. 常駐させる

```bash
TSUKUMO_STORE_DIR=./data TSUKUMO_NODE=home \
TSUKUMO_BEEPS="washer=2000:800,doorbell=680:300" \
node src/mic.ts
```

- `mic:default` の `beep:washer` / `beep:doorbell` がパルスイベント（false→true）として流れる
- おまけで `loud`（大きな音。RMS しきい値 `TSUKUMO_LOUD_THRESHOLD`、既定 0.25）も検知

### 3. ルールにする

```bash
GEMINI_API_KEY=... TSUKUMO_NODE=home node ../kotodama/src/index.ts compile \
  "洗濯機のビープが鳴ったらSlackに知らせて"
```

イベントが一度でも流れればカタログに `mic:default — beep:washer` が載るので、kotodama がそのまま使えます。

## テスト

```bash
node --test test/*.test.ts
```

検知コア（フレーム差分・Goertzel・ビープ状態機械・MJPEG 切り出し）はすべて純粋関数で、合成フレーム・合成正弦波により検証済み。ffmpeg / arecord の実機キャプチャ部分だけが手元検証になります。

## 将来（このフェーズではやらない）

- 人物検知（動体との区別）・汎用の音イベント分類（YAMNet 系）— ML ランタイムの依存が必要になるため、`sync` と同じ「依存を持つ別パッケージ」として増設する
