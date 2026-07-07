/**
 * 実物の Automerge を使った2ノード E2E。
 * `cd packages/sync && npm install` 済みの環境でだけ走る（未インストールなら skip）。
 * これが通れば Phase 3 の完成定義（別ノードへのルール伝播）が実証される。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let automergeAvailable = true;
try {
  await import("@automerge/automerge-repo");
} catch {
  automergeAvailable = false;
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout: ${label}`);
}

test(
  "二台構成: ノードAのルールがWebSocket越しにノードBへ伝播し、B側の追加もAへ戻る",
  { skip: !automergeAvailable ? "Automerge が未インストール（cd packages/sync && npm install で有効化）" : false, timeout: 60_000 },
  async () => {
    const { startSyncService } = await import("../src/service.ts");
    const port = 47100 + (process.pid % 500);

    const dirA = mkdtempSync(join(tmpdir(), "tsukumo-sync-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "tsukumo-sync-b-"));
    const rulesA = join(dirA, "rules");
    const rulesB = join(dirB, "rules");

    // ノードA: ハブとして起動し、ルールを1本置く
    const ruleA = { id: "from-a", enabled: true, note: "created on A" };
    const serviceA = await startSyncService({
      rulesDir: rulesA,
      stateDir: join(dirA, "sync"),
      nodeName: "node-a",
      listenPort: port,
      peers: [],
      log: () => {},
    });
    writeFileSync(join(rulesA, "from-a.json"), JSON.stringify(ruleA, null, 2) + "\n");
    await serviceA.reconcileNow();
    await waitFor(async () => "from-a" in (await serviceA.snapshot()), "A: ファイル → doc 取り込み");

    // ノードB: A に接続して起動（doc URL は A から共有された体）
    const serviceB = await startSyncService({
      rulesDir: rulesB,
      stateDir: join(dirB, "sync"),
      nodeName: "node-b",
      peers: [`ws://127.0.0.1:${port}`],
      docUrl: serviceA.docUrl,
      log: () => {},
    });

    try {
      // A のルールが B のファイルに現れる
      await waitFor(() => readdirSync(rulesB).includes("from-a.json"), "B: doc → ファイル 実体化");

      // B で追加したルールが A に戻る
      const ruleB = { id: "from-b", enabled: true, note: "created on B" };
      writeFileSync(join(rulesB, "from-b.json"), JSON.stringify(ruleB, null, 2) + "\n");
      await serviceB.reconcileNow();
      await waitFor(() => readdirSync(rulesA).includes("from-b.json"), "A: 逆方向の伝播");

      // 両ノードの doc スナップショットが一致する
      await waitFor(async () => {
        const a = await serviceA.snapshot();
        const b = await serviceB.snapshot();
        return JSON.stringify(a) === JSON.stringify(b) && "from-a" in a && "from-b" in a;
      }, "doc の収束");

      assert.ok(true);
    } finally {
      await serviceB.stop();
      await serviceA.stop();
    }
  },
);
