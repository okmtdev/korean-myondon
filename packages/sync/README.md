# @tsukumo/sync

**Phase 3** — ルール（`rules/*.json`）を Automerge CRDT でノード間同期する常駐プロセス。

tsukumo で**唯一、依存を持つパッケージ**です（理由と比較検討は [docs/crdt-choice.md](../../docs/crdt-choice.md)）。agent / switchbot-mcp / kotodama は依存ゼロのまま変わりません。sync は別プロセスなので、sync が死んでもルール実行は止まりません（ローカルファースト）。

## しくみ

```
kotodama がファイルを書く
        │ fs.watch
        ▼
[node A] rules/*.json ⇄ Automerge doc ⇄ (WebSocket / Tailscale) ⇄ Automerge doc ⇄ rules/*.json [node B]
                                                                            │ 書き込み
                                                                            ▼
                                                              node B の agent がホットリロード
```

- ルール 1 件 = doc 内の**不可分な JSON 文字列**。同時編集は「どちらかが丸ごと勝つ」ので、trigger と action が別人の編集で混ざった「キメラルール」は生まれない（負けた側も Automerge の履歴に残る）
- ファイル ⇄ doc の突き合わせは 3-way（`lastApplied` = 前回一致した状態を基準）。**削除は編集に勝つ**（自動化は止まる方向が安全）、**同時編集はローカル優先**
- どのノードで実行するかはルールの `node` フィールドで制御（`TSUKUMO_NODE` を設定して kotodama でコンパイルすると自動で刻印）。全ノードに配られても多重発火しない

## セットアップ

```bash
cd packages/sync
npm install   # tsukumo で npm install が要るのはここだけ
```

### 1台目（ハブ。自宅の常時起動マシン推奨）

```bash
TSUKUMO_STORE_DIR=/var/lib/tsukumo TSUKUMO_NODE=home \
TSUKUMO_SYNC_LISTEN_PORT=7821 \
node src/index.ts
```

起動ログに `automerge:xxxxxxxx` という**制御ドキュメント URL** が出ます。これを控える（`<store>/sync/doc-url.txt` にも保存されます）。

### 2台目以降（遠隔 mini PC など。Tailscale 経由）

```bash
TSUKUMO_STORE_DIR=/var/lib/tsukumo TSUKUMO_NODE=remote-camera \
TSUKUMO_SYNC_PEERS=ws://<ハブのTailscale名>:7821 \
TSUKUMO_SYNC_DOC_URL=automerge:xxxxxxxx \
node src/index.ts
```

ポートは Tailscale 内にだけ開けてください（インターネットへ公開しない）。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `TSUKUMO_STORE_DIR` | `./data` | ストア。rules と sync 状態はこの下 |
| `TSUKUMO_RULES_DIR` | `<store>/rules` | 同期対象のルール置き場（agent と同じ値にする） |
| `TSUKUMO_SYNC_STATE_DIR` | `<store>/sync` | Automerge ストレージ・doc URL・lastApplied |
| `TSUKUMO_NODE` | ホスト名 | ノード名（peerId にも使われる） |
| `TSUKUMO_SYNC_LISTEN_PORT` | なし | WebSocket 待ち受け（ハブ側） |
| `TSUKUMO_SYNC_PEERS` | なし | 接続先 `ws://host:port`（カンマ区切り） |
| `TSUKUMO_SYNC_DOC_URL` | 保存値 or 新規作成 | 制御ドキュメント URL（2台目以降は必須） |

## Phase 3 受け入れデモ（オフライン編集 → 復帰マージ）

1. 両ノードで sync + agent を起動し、ルールが行き渡ることを確認
2. mini PC 側の sync を止める（オフラインを再現）
3. 自宅側でルール X を編集、mini PC 側でルール Y を追加
4. mini PC 側の sync を再起動
5. → 数秒で両ノードの `rules/` が同一になる（X の編集も Y も残る）。agent はホットリロードで追従

## テスト

```bash
node --test test/*.test.ts
```

- `bridge.test.ts` — 突き合わせロジックの全ケース＋2ノード収束シミュレーション（**依存ゼロでどこでも走る**）
- `automerge.test.ts` — 実物の Automerge で 2 ノードを WebSocket 接続する E2E。`npm install` 済みの環境でだけ実行される（未インストールなら skip）。**install 後にまずこれを回してください**

## 注意（正直な話）

- この実装を書いた開発環境は npm が遮断されており、**Automerge 実物での実行は未検証**です。API 呼び出しは automerge-repo 1.x / 2.x どちらの名前でも動くよう防御的に書いてあり（`src/service.ts` に完全隔離、約200行）、ズレていても修正は局所的です。`npm install && npm test` の結果を見てください
- 同期の意味論（削除が勝つ・同時編集はローカル優先・ルール単位の不可分性）は `bridge.test.ts` で固定済みで、こちらは環境によらず保証されます
