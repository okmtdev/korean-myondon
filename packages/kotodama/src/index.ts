#!/usr/bin/env node
/**
 * kotodama CLI — 日本語のルールをコンパイルして rules/ ディレクトリへ置く。
 * agent がホットリロードで拾って即座に動き出す。
 *
 *   GEMINI_API_KEY=... node src/index.ts compile "洗濯機のプラグがOFFになったら通知して"
 *   node src/index.ts list
 *   node src/index.ts show <id> | enable <id> | disable <id> | remove <id>
 *
 * 環境変数:
 *   TSUKUMO_STORE_DIR         イベントストア（カタログの材料。default: ./data）
 *   TSUKUMO_RULES_DIR         ルール置き場（default: <store>/rules）
 *   GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY  compile にいずれか必須
 *   TSUKUMO_COMPILE_PROVIDER  gemini | anthropic（両方のキーがあるときの明示指定）
 *   TSUKUMO_COMPILE_MODEL     使用モデル（default: gemini-2.5-flash / claude-sonnet-5）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalogFromStore } from "../../core/src/catalog.ts";
import { validateRule } from "../../core/src/rules.ts";
import type { Rule } from "../../core/src/rules.ts";
import { JsonlEventStore } from "../../core/src/store.ts";
import { compileRule } from "./compile.ts";
import { createProviderFromEnv } from "./providers.ts";

const storeDir = process.env.TSUKUMO_STORE_DIR ?? "./data";
const rulesDir = process.env.TSUKUMO_RULES_DIR ?? join(storeDir, "rules");
mkdirSync(rulesDir, { recursive: true });

function loadRules(): Rule[] {
  const rules: Rule[] = [];
  for (const name of readdirSync(rulesDir).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(rulesDir, name), "utf8")) as unknown;
      if (validateRule(parsed, null).length === 0) rules.push(parsed as Rule);
    } catch {
      // 壊れたファイルは無視（agent 側でも警告される）
    }
  }
  return rules;
}

function rulePath(id: string): string {
  return join(rulesDir, `${id}.json`);
}

function requireIdArg(): string {
  const id = process.argv[3];
  if (!id) {
    console.error("usage: index.ts <show|enable|disable|remove> <rule-id>");
    process.exit(1);
  }
  return id;
}

async function commandCompile(): Promise<void> {
  const text = process.argv.slice(3).join(" ").trim();
  if (text === "") {
    console.error('usage: index.ts compile "<自然言語のルール>"');
    process.exit(1);
  }

  let provider;
  try {
    provider = createProviderFromEnv();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }

  const store = new JsonlEventStore(storeDir);
  const catalog = await buildCatalogFromStore(store, { since: new Date(Date.now() - 30 * 86_400_000) });
  if (catalog.devices.length === 0) {
    console.error(
      `イベントカタログが空です（store: ${storeDir}）。先に agent を動かして観測を溜めてください。\n` +
        "カタログにあるデバイス・フィールドしかルールには使えません（幻覚防止）。",
    );
    process.exit(1);
  }

  const existing = loadRules();
  console.error(
    `kotodama: ${provider.label} / カタログ ${catalog.devices.length} デバイス / 既存ルール ${existing.length} 件でコンパイルします...`,
  );
  const result = await compileRule(text, catalog, existing, provider);

  for (const warning of result.warnings) console.error(`⚠ ${warning}`);
  if (result.error !== undefined || result.rule === undefined) {
    console.error(`✗ コンパイル不能: ${result.error ?? "unknown"}`);
    process.exit(1);
  }

  const rule = result.rule;
  let id = rule.id;
  let suffix = 2;
  while (existsSync(rulePath(id))) {
    id = `${rule.id}-${suffix}`;
    suffix += 1;
  }
  rule.id = id;

  writeFileSync(rulePath(id), JSON.stringify(rule, null, 2) + "\n");
  console.log(JSON.stringify(rule, null, 2));
  console.error(`✓ 保存しました: ${rulePath(id)}（attempts: ${result.attempts}）`);
  console.error(`  説明: ${rule.explanation}`);
  console.error("  agent が動いていればホットリロードで即有効になります。");
}

function commandList(): void {
  const rules = loadRules();
  if (rules.length === 0) {
    console.log("(ルールはまだありません)");
    return;
  }
  for (const rule of rules) {
    const source = rule.source.length > 60 ? `${rule.source.slice(0, 60)}…` : rule.source;
    console.log(`${rule.enabled ? "●" : "○"} ${rule.id}  [${rule.trigger.deviceId}.${rule.trigger.field}]  ${source}`);
  }
}

function commandShow(): void {
  console.log(readFileSync(rulePath(requireIdArg()), "utf8"));
}

function commandSetEnabled(enabled: boolean): void {
  const id = requireIdArg();
  const rule = JSON.parse(readFileSync(rulePath(id), "utf8")) as Rule;
  rule.enabled = enabled;
  writeFileSync(rulePath(id), JSON.stringify(rule, null, 2) + "\n");
  console.log(`${enabled ? "有効化" : "無効化"}: ${id}`);
}

function commandRemove(): void {
  const id = requireIdArg();
  unlinkSync(rulePath(id));
  console.log(`削除: ${id}`);
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "compile":
      await commandCompile();
      break;
    case "list":
      commandList();
      break;
    case "show":
      commandShow();
      break;
    case "enable":
      commandSetEnabled(true);
      break;
    case "disable":
      commandSetEnabled(false);
      break;
    case "remove":
      commandRemove();
      break;
    default:
      console.error('usage: index.ts <compile "<text>" | list | show <id> | enable <id> | disable <id> | remove <id>>');
      process.exit(1);
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
