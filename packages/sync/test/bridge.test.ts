import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFilePlan, canonicalize, readRulesDir, reconcilePlans } from "../src/bridge.ts";
import type { RuleSnapshot } from "../src/bridge.ts";

const A1 = JSON.stringify({ id: "a", enabled: true, v: 1 });
const A2 = JSON.stringify({ id: "a", enabled: true, v: 2 });
const A3 = JSON.stringify({ id: "a", enabled: false, v: 3 });
const B1 = JSON.stringify({ id: "b", v: 1 });
const C1 = JSON.stringify({ id: "c", v: 1 });

test("canonicalize: 整形差を吸収し、壊れた JSON は null", () => {
  assert.equal(canonicalize('{\n  "x": 1\n}\n'), '{"x":1}');
  assert.equal(canonicalize("not json"), null);
});

test("readRulesDir: *.json を stem キーで読み、壊れたファイルは errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsukumo-bridge-"));
  writeFileSync(join(dir, "a.json"), '{ "id": "a",\n "enabled": true, "v": 1 }');
  writeFileSync(join(dir, "broken.json"), "{oops");
  writeFileSync(join(dir, "note.txt"), "ignore me");
  const { snapshot, errors } = readRulesDir(dir);
  assert.deepEqual(Object.keys(snapshot), ["a"]);
  assert.equal(snapshot.a, canonicalize(A1));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken\.json/);
});

test("リモート新規: doc にだけある → ファイルへ書く", () => {
  const plan = reconcilePlans({ a: A1 }, {}, {});
  assert.deepEqual(plan.fileOps, [{ type: "write", id: "a", content: A1 }]);
  assert.deepEqual(plan.docOps, []);
  assert.deepEqual(plan.nextApplied, { a: A1 });
});

test("ローカル新規: ファイルにだけある → doc へ取り込む", () => {
  const plan = reconcilePlans({}, { a: A1 }, {});
  assert.deepEqual(plan.fileOps, []);
  assert.deepEqual(plan.docOps, [{ type: "set", id: "a", content: A1 }]);
  assert.deepEqual(plan.nextApplied, { a: A1 });
});

test("リモート更新: ローカル未変更（files==base）→ ファイルへ書く", () => {
  const plan = reconcilePlans({ a: A2 }, { a: A1 }, { a: A1 });
  assert.deepEqual(plan.fileOps, [{ type: "write", id: "a", content: A2 }]);
  assert.deepEqual(plan.docOps, []);
});

test("ローカル編集: doc 未変更（doc==base）→ doc へ。ファイルは上書きされない", () => {
  const plan = reconcilePlans({ a: A1 }, { a: A2 }, { a: A1 });
  assert.deepEqual(plan.fileOps, []); // ← ローカル編集が doc の古い内容で消されないこと
  assert.deepEqual(plan.docOps, [{ type: "set", id: "a", content: A2 }]);
  assert.deepEqual(plan.nextApplied, { a: A2 });
});

test("同時編集: 両方動いた → ローカル優先で doc へ", () => {
  const plan = reconcilePlans({ a: A3 }, { a: A2 }, { a: A1 });
  assert.deepEqual(plan.fileOps, []);
  assert.deepEqual(plan.docOps, [{ type: "set", id: "a", content: A2 }]);
});

test("リモート削除: ローカル編集があっても削除が勝つ", () => {
  const plan = reconcilePlans({}, { a: A2 }, { a: A1 });
  assert.deepEqual(plan.fileOps, [{ type: "delete", id: "a" }]);
  assert.deepEqual(plan.docOps, []);
  assert.deepEqual(plan.nextApplied, {});
});

test("ローカル削除: リモート編集があっても削除が勝つ", () => {
  const plan = reconcilePlans({ a: A2 }, {}, { a: A1 });
  assert.deepEqual(plan.fileOps, []);
  assert.deepEqual(plan.docOps, [{ type: "remove", id: "a" }]);
  assert.deepEqual(plan.nextApplied, {});
});

test("静止状態: 全一致なら操作ゼロ（エコーしない）", () => {
  const plan = reconcilePlans({ a: A1, b: B1 }, { a: A1, b: B1 }, { a: A1, b: B1 });
  assert.deepEqual(plan.fileOps, []);
  assert.deepEqual(plan.docOps, []);
});

test("applyFilePlan: 整形して書き、削除もできる（無いファイルの削除は無害）", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsukumo-apply-"));
  applyFilePlan(dir, [
    { type: "write", id: "a", content: A1 },
    { type: "delete", id: "ghost" },
  ]);
  const written = readFileSync(join(dir, "a.json"), "utf8");
  assert.ok(written.includes("\n  ")); // 整形されている
  assert.ok(written.endsWith("\n"));
  assert.equal(canonicalize(written), A1);
  applyFilePlan(dir, [{ type: "delete", id: "a" }]);
  assert.deepEqual(readdirSync(dir), []);
});

// --- Phase 3 の完成定義（オフライン両側編集 → 復帰 → 収束）のロジック版シミュレーション ---

interface SimNode {
  files: RuleSnapshot;
  lastApplied: RuleSnapshot;
}

/** 共有 doc（Automerge の代役: 逐次適用なので決定的）に対して1ノードを照合する */
function step(doc: RuleSnapshot, node: SimNode): { doc: RuleSnapshot; ops: number } {
  const plan = reconcilePlans(doc, node.files, node.lastApplied);
  for (const op of plan.fileOps) {
    if (op.type === "write") node.files[op.id] = op.content as string;
    else delete node.files[op.id];
  }
  const nextDoc = { ...doc };
  for (const op of plan.docOps) {
    if (op.type === "set") nextDoc[op.id] = op.content as string;
    else delete nextDoc[op.id];
  }
  node.lastApplied = plan.nextApplied;
  return { doc: nextDoc, ops: plan.fileOps.length + plan.docOps.length };
}

test("シミュレーション: オフライン両側編集（編集/追加/削除の混在）が収束し、静止する", () => {
  // 初期状態: ルール a を両ノードが共有済み
  let doc: RuleSnapshot = { a: A1 };
  const node1: SimNode = { files: { a: A1 }, lastApplied: { a: A1 } };
  const node2: SimNode = { files: { a: A1 }, lastApplied: { a: A1 } };

  // オフライン中: node1 は a を編集し b を追加、node2 は a を削除し c を追加
  node1.files.a = A2;
  node1.files.b = B1;
  delete node2.files.a;
  node2.files.c = C1;

  // 復帰: 交互に照合（順序は任意でよい）
  ({ doc } = step(doc, node1));
  ({ doc } = step(doc, node2));
  ({ doc } = step(doc, node1));
  ({ doc } = step(doc, node2));

  // 期待: a は削除が勝ち、b と c は両方に行き渡る
  const expected = { b: B1, c: C1 };
  assert.deepEqual(doc, expected);
  assert.deepEqual(node1.files, expected);
  assert.deepEqual(node2.files, expected);

  // 追加の照合では何も起きない（静止 = エコーやループが無い）
  let ops = 0;
  ({ doc, ops } = step(doc, node1));
  assert.equal(ops, 0);
  ({ doc, ops } = step(doc, node2));
  assert.equal(ops, 0);
});

test("シミュレーション: 同時編集はローカル優先→最後に書いた方へ全ノード収束", () => {
  let doc: RuleSnapshot = { a: A1 };
  const node1: SimNode = { files: { a: A2 }, lastApplied: { a: A1 } }; // A2 に編集
  const node2: SimNode = { files: { a: A3 }, lastApplied: { a: A1 } }; // A3 に編集

  ({ doc } = step(doc, node1)); // doc: A2
  ({ doc } = step(doc, node2)); // node2 はローカル優先 → doc: A3
  ({ doc } = step(doc, node1)); // node1 は base==A2==自分 → doc の A3 を受け入れ
  ({ doc } = step(doc, node2));

  assert.deepEqual(doc, { a: A3 });
  assert.deepEqual(node1.files, { a: A3 });
  assert.deepEqual(node2.files, { a: A3 });
});
