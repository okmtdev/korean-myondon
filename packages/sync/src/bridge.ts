/**
 * rules ディレクトリ ⇄ Automerge ドキュメントの橋渡しロジック（純粋部分）。
 *
 * Automerge には一切依存しない。ここが正しければ同期の振る舞いは決まるので、
 * このモジュールだけで徹底的にテストする（Automerge API は service.ts に隔離）。
 *
 * 設計:
 * - ルールは「ファイル名の stem = ルールID、内容 = 正規化した JSON 文字列」として扱う
 * - ドキュメント側も {rules: {id: jsonString}}。ルール1件を不可分な文字列にすることで、
 *   同時編集は「どちらかが丸ごと勝つ」（キメラルールを作らない。docs/crdt-choice.md 参照）
 * - lastApplied = 前回の照合で両者が一致した状態（git の merge-base に相当）。
 *   これを基準に「どちらが動いたか」を判定する:
 *     files == lastApplied != doc   → リモートの変更 → ファイルへ書く
 *     files != lastApplied == doc   → ローカルの編集 → doc へ取り込む
 *     両方動いた（同時編集）        → ローカル優先で doc へ（相手の版は Automerge の履歴に残る）
 *     削除 vs 編集                  → 削除が勝つ（自動化は「止まる」方向が安全）
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ruleId → 正規化(コンパクト) JSON 文字列 */
export type RuleSnapshot = Record<string, string>;

/** JSON 文字列を比較用に正規化する（パース不能なら null） */
export function canonicalize(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

/** rules ディレクトリを読み、スナップショットにする。壊れた JSON は errors に回す */
export function readRulesDir(dir: string): { snapshot: RuleSnapshot; errors: string[] } {
  mkdirSync(dir, { recursive: true });
  const snapshot: RuleSnapshot = {};
  const errors: string[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const id = name.slice(0, -".json".length);
    const canonical = canonicalize(readFileSync(join(dir, name), "utf8"));
    if (canonical === null) {
      errors.push(`${name}: JSON として読めないためスキップ`);
      continue;
    }
    snapshot[id] = canonical;
  }
  return { snapshot, errors };
}

export interface FilePlanOp {
  type: "write" | "delete";
  id: string;
  content?: string;
}

export interface DocPlanOp {
  type: "set" | "remove";
  id: string;
  content?: string;
}

export interface ReconcileResult {
  /** ファイルへ適用する操作（applyFilePlan へ） */
  fileOps: FilePlanOp[];
  /** doc へ適用する操作（service.ts が handle.change で適用） */
  docOps: DocPlanOp[];
  /** 次回照合の基準（永続化しておく） */
  nextApplied: RuleSnapshot;
}

/**
 * 1回の照合。doc / files / lastApplied の3つから、
 * 両者を一致させるための操作を決定論的に計画する。
 */
export function reconcilePlans(
  doc: RuleSnapshot,
  files: RuleSnapshot,
  lastApplied: RuleSnapshot,
): ReconcileResult {
  const fileOps: FilePlanOp[] = [];
  const docOps: DocPlanOp[] = [];
  const ids = new Set([...Object.keys(doc), ...Object.keys(files), ...Object.keys(lastApplied)]);

  for (const id of ids) {
    const inDoc = doc[id];
    const inFiles = files[id];
    const base = lastApplied[id];

    if (inDoc === inFiles) continue; // 一致（両方 undefined も含む）

    if (inDoc === undefined) {
      // doc に無い
      if (base !== undefined) {
        // 以前は共有されていた → リモートで削除された。削除が勝つ（ローカル編集があっても消す）
        if (inFiles !== undefined) fileOps.push({ type: "delete", id });
      } else {
        // 共有されたことがない → 新しいローカルルール → doc へ
        docOps.push({ type: "set", id, content: inFiles });
      }
      continue;
    }

    if (inFiles === undefined) {
      // ファイルに無い
      if (base !== undefined) {
        // 以前は持っていた → ローカルで削除された。削除が勝つ（リモート編集があっても消す）
        docOps.push({ type: "remove", id });
      } else {
        // まだ受け取っていないだけ → リモートの新ルール → ファイルへ
        fileOps.push({ type: "write", id, content: inDoc });
      }
      continue;
    }

    // 両方に存在して内容が違う
    if (inFiles === base) {
      // ローカルは動いていない → リモートの変更 → ファイルへ
      fileOps.push({ type: "write", id, content: inDoc });
    } else {
      // ローカルが動いた（doc も動いた同時編集を含む）→ ローカル優先で doc へ
      // 同時編集で負けた側の内容は Automerge の履歴から取り出せる
      docOps.push({ type: "set", id, content: inFiles });
    }
  }

  // 適用後は files と doc が同じ内容に収束する予定なので、その姿を次回の基準にする
  const nextApplied: RuleSnapshot = { ...files };
  for (const op of fileOps) {
    if (op.type === "write") nextApplied[op.id] = op.content as string;
    else delete nextApplied[op.id];
  }
  for (const op of docOps) {
    if (op.type === "set") nextApplied[op.id] = op.content as string;
    else delete nextApplied[op.id];
  }

  return { fileOps, docOps, nextApplied };
}

/** ファイル計画を適用する。書き込みは人間が読みやすい整形 JSON にする */
export function applyFilePlan(dir: string, ops: FilePlanOp[]): void {
  mkdirSync(dir, { recursive: true });
  for (const op of ops) {
    const path = join(dir, `${op.id}.json`);
    if (op.type === "write") {
      writeFileSync(path, JSON.stringify(JSON.parse(op.content ?? "null"), null, 2) + "\n");
    } else {
      try {
        unlinkSync(path);
      } catch {
        // 既に無ければそれでよい
      }
    }
  }
}
