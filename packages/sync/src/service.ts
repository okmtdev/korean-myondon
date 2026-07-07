/**
 * Automerge との接続部分。tsukumo 全体で Automerge API はこのファイルにだけ現れる。
 *
 * 注意: この開発環境では npm が使えず実行検証できていないため、
 * automerge-repo 1.x / 2.x のどちらの API 名でも動くよう防御的に書いてある
 * （クラス名のフォールバック、find の同期/非同期両対応など）。
 * 実物での検証は test/automerge.test.ts（npm install 後に有効化される）で行う。
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFilePlan, readRulesDir, reconcilePlans } from "./bridge.ts";
import type { RuleSnapshot } from "./bridge.ts";

export interface SyncConfig {
  rulesDir: string;
  /** Automerge ストレージ・doc URL・lastApplied を置く場所 */
  stateDir: string;
  nodeName: string;
  /** 指定するとこのポートで WebSocket を待ち受ける（ハブ側） */
  listenPort?: number;
  /** 接続先 ws://host:port の一覧（クライアント側） */
  peers: string[];
  /** 既存の制御ドキュメント URL（2台目以降は必須） */
  docUrl?: string;
  log: (message: string) => void;
}

export interface SyncService {
  docUrl: string;
  /** 現在の doc 側ルールスナップショット（テスト・status 用） */
  snapshot: () => Promise<RuleSnapshot>;
  /** 手動で1回照合する（テスト用） */
  reconcileNow: () => Promise<void>;
  stop: () => Promise<void>;
}

async function maybeAwait<T>(value: T | Promise<T>): Promise<T> {
  return typeof (value as { then?: unknown })?.then === "function" ? await (value as Promise<T>) : (value as T);
}

export async function startSyncService(config: SyncConfig): Promise<SyncService> {
  // --- Automerge モジュール群（動的 import。未インストールならここで分かりやすく落ちる） ---
  const repoMod = (await import("@automerge/automerge-repo")) as Record<string, any>;
  const wsMod = (await import("@automerge/automerge-repo-network-websocket")) as Record<string, any>;
  const storageMod = (await import("@automerge/automerge-repo-storage-nodefs")) as Record<string, any>;

  const Repo = repoMod.Repo;
  const isValidAutomergeUrl: (url: string) => boolean = repoMod.isValidAutomergeUrl ?? (() => true);
  // v1: NodeWSServerAdapter / BrowserWebSocketClientAdapter, v2: WebSocketServerAdapter / WebSocketClientAdapter
  const ServerAdapter = wsMod.NodeWSServerAdapter ?? wsMod.WebSocketServerAdapter;
  const ClientAdapter = wsMod.WebSocketClientAdapter ?? wsMod.BrowserWebSocketClientAdapter;
  const StorageAdapter = storageMod.NodeFSStorageAdapter;

  mkdirSync(config.stateDir, { recursive: true });
  mkdirSync(config.rulesDir, { recursive: true });

  const network: unknown[] = [];
  let webSocketServer: { close: () => void } | undefined;
  if (config.listenPort !== undefined) {
    const { WebSocketServer } = await import("ws");
    webSocketServer = new WebSocketServer({ port: config.listenPort }) as unknown as { close: () => void };
    network.push(new ServerAdapter(webSocketServer));
  }
  for (const peer of config.peers) network.push(new ClientAdapter(peer));

  const repo = new Repo({
    network,
    storage: new StorageAdapter(join(config.stateDir, "automerge")),
    peerId: `tsukumo-${config.nodeName}`,
  });

  // --- 制御ドキュメントの取得 or 新規作成 ---
  const docUrlFile = join(config.stateDir, "doc-url.txt");
  let docUrl = config.docUrl ?? (existsSync(docUrlFile) ? readFileSync(docUrlFile, "utf8").trim() : "");
  let handle: any;
  if (docUrl !== "") {
    if (!isValidAutomergeUrl(docUrl)) throw new Error(`不正なドキュメント URL です: ${docUrl}`);
    handle = await maybeAwait(repo.find(docUrl));
  } else {
    handle = repo.create();
    handle.change((doc: any) => {
      if (!doc.rules) doc.rules = {};
    });
    docUrl = handle.url;
    config.log(`sync: 新しい制御ドキュメントを作成しました: ${docUrl}`);
    config.log("sync: 他のノードには TSUKUMO_SYNC_DOC_URL としてこの URL を渡してください");
  }
  writeFileSync(docUrlFile, docUrl + "\n");
  if (typeof handle.whenReady === "function") await handle.whenReady();

  const readDoc = async (): Promise<any> => {
    const raw = typeof handle.docSync === "function" ? handle.docSync() : handle.doc();
    return await maybeAwait(raw);
  };

  const docSnapshot = async (): Promise<RuleSnapshot> => {
    const value = (await readDoc()) ?? {};
    const rules: RuleSnapshot = {};
    for (const [id, content] of Object.entries(value.rules ?? {})) {
      if (typeof content === "string") rules[id] = content;
    }
    return rules;
  };

  // --- lastApplied（前回両者が一致した状態）の永続化 ---
  const stateFile = join(config.stateDir, "last-applied.json");
  let lastApplied: RuleSnapshot = {};
  try {
    lastApplied = JSON.parse(readFileSync(stateFile, "utf8")) as RuleSnapshot;
  } catch {
    // 初回はファイルが無い
  }

  let running = true;
  let reconciling = false;
  let pendingReason: string | undefined;

  const reconcile = async (why: string): Promise<void> => {
    if (!running) return;
    if (reconciling) {
      pendingReason = why;
      return;
    }
    reconciling = true;
    try {
      const docRules = await docSnapshot();
      const files = readRulesDir(config.rulesDir);
      for (const error of files.errors) config.log(`sync: ${error}`);

      const plan = reconcilePlans(docRules, files.snapshot, lastApplied);
      if (plan.fileOps.length > 0) applyFilePlan(config.rulesDir, plan.fileOps);
      if (plan.docOps.length > 0) {
        handle.change((doc: any) => {
          if (!doc.rules) doc.rules = {};
          for (const op of plan.docOps) {
            if (op.type === "set") doc.rules[op.id] = op.content;
            else delete doc.rules[op.id];
          }
        });
      }
      lastApplied = plan.nextApplied;
      writeFileSync(stateFile, JSON.stringify(lastApplied, null, 2) + "\n");
      if (plan.fileOps.length > 0 || plan.docOps.length > 0) {
        config.log(`sync: reconcile(${why}) files=${plan.fileOps.length} doc=${plan.docOps.length}`);
      }
    } catch (cause) {
      config.log(`sync: reconcile error: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      reconciling = false;
      if (pendingReason !== undefined) {
        const reason = pendingReason;
        pendingReason = undefined;
        void reconcile(reason);
      }
    }
  };

  // doc の変更（リモートからの同期含む）→ 照合
  if (typeof handle.on === "function") {
    handle.on("change", () => void reconcile("doc-change"));
  }

  // ファイルの変更（kotodama や手編集）→ 照合（デバウンス）
  let watchTimer: NodeJS.Timeout | undefined;
  const watcher = watch(config.rulesDir, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => void reconcile("fs-watch"), 500);
  });

  // 保険の定期照合（watch 漏れ・切断復帰対策）
  const interval = setInterval(() => void reconcile("interval"), 30_000);

  await reconcile("startup");
  config.log(
    `sync: 稼働中 node=${config.nodeName} doc=${docUrl} listen=${config.listenPort ?? "-"} peers=${config.peers.join(",") || "-"}`,
  );

  return {
    docUrl,
    snapshot: docSnapshot,
    reconcileNow: () => reconcile("manual"),
    stop: async () => {
      running = false;
      clearInterval(interval);
      clearTimeout(watchTimer);
      watcher.close();
      webSocketServer?.close();
      if (typeof repo.shutdown === "function") await repo.shutdown();
    },
  };
}
