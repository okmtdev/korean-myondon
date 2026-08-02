/**
 * kotodama（言霊）— 自然言語 → ルール IR コンパイラ。
 *
 * LLM を使うのは「コンパイル時」のここだけ。プロバイダ（Claude / Gemini）は
 * providers.ts の抽象越しに呼ぶので、本体はどちらが相手かを知らない。
 * 出力されたルールはバリデータ（カタログ照合つき）を通らない限り受理されない。
 * バリデーション違反は LLM にフィードバックして 1 回だけリトライする。
 */
import { type Catalog, catalogToPromptText } from "../../core/src/catalog.ts";
import { type Rule, validateRule } from "../../core/src/rules.ts";
import type { ApiMessage, LlmProvider } from "./providers.ts";

export const RULE_IR_SPEC = `Rule = {
  "id": "英小文字・数字・ハイフンの slug（内容が分かる名前）",
  "source": "元の自然言語（そのまま写す）",
  "enabled": true,
  "trigger": {
    "deviceId": "...", "field": "...",
    "to"?:   値 | {"eq"|"ne": 値} | {"gt"|"gte"|"lt"|"lte": 数値},
    "from"?: 同上
  },
  "condition"?: Condition,
  "actions": [Action, ...],   // 上から順に実行される
  "explanation": "いつ・何が起きたら・何をするか（日本語1〜3文）"
}
Condition = 次のうち「ちょうど1つ」のキーを持つオブジェクト:
  {"allOf": [Condition, ...]}   すべて真
  {"anyOf": [Condition, ...]}   いずれか真
  {"not": Condition}
  {"device": {"deviceId": "...", "field": "...", "equals"|"ne"|"gt"|"gte"|"lt"|"lte": 値}}  そのデバイスの最新観測値への述語
  {"time": {"after"?: "HH:MM", "before"?: "HH:MM"}}  ローカル時刻の時間帯 [after, before)。日またぎ可
Action = 次のいずれか:
  {"type": "switchbot_command", "deviceId": "...", "command": "turnOn 等", "parameter"?: 値, "commandType"?: "command"|"customize"}
  {"type": "notify", "message": "..."}   通知Webhookへ送る
  {"type": "log", "message": "..."}
トリガーの意味論: 指定デバイスの指定フィールドが「変化」し、from / to の条件を満たした瞬間に1回発火する。
例: プラグがOFFになった → {"deviceId":"XX","field":"power","to":"off","from":"on"}
例: 湿度が60を上回った瞬間 → {"deviceId":"XX","field":"humidity","to":{"gt":60},"from":{"lte":60}}`;

export interface CompileResult {
  rule?: Rule;
  warnings: string[];
  error?: string;
  attempts: number;
}

export function buildSystemPrompt(catalog: Catalog, existingRules: Rule[]): string {
  const existing =
    existingRules.length === 0
      ? "(まだありません)"
      : existingRules
          .map(
            (rule) =>
              `- ${rule.id}${rule.enabled ? "" : " (無効)"}: trigger=${rule.trigger.deviceId}.${rule.trigger.field} — ${rule.source}`,
          )
          .join("\n");

  return `あなたは tsukumo の「kotodama」ルールコンパイラです。ユーザーが自然言語で書いたホームオートメーションの要望を、決定的なルール IR（JSON）へ1回だけ変換します。実行時にあなたは存在しないので、曖昧さを実行時に持ち越すことはできません。

# 出力形式（これ以外を一切出力しない。コードフェンスも説明文も書かない）
成功:     {"rule": { ... }, "warnings": ["解釈に自信がない点があれば日本語で"]}
変換不能: {"error": "できない理由（日本語）", "warnings": []}

# ルール IR の仕様
${RULE_IR_SPEC}

# イベントカタログ — 使ってよい deviceId / field はこれが全てです
${catalogToPromptText(catalog)}

# 既存ルール（id の重複を避け、明らかな衝突は warnings で指摘）
${existing}

# 指針
- カタログにない語彙が必要なら、推測せずに error で正直に断る（例: 在宅判定できるデバイスがない）
- トリガーは「1つのデバイスの1フィールドの変化」だけ。定時実行や「N分経過したら」は v0 では表現できない → error
- しきい値の「超えた瞬間」は from と to の両方で挟んで表現する（上の湿度の例を参照）
- notify の message は日本語で簡潔に
- 解釈に幅があるときは、最も安全な解釈を選び、その旨を warnings に書く`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

function overlapWarnings(rule: Rule, existingRules: Rule[]): string[] {
  const warnings: string[] = [];
  for (const existing of existingRules) {
    if (!existing.enabled) continue;
    if (existing.trigger.deviceId === rule.trigger.deviceId && existing.trigger.field === rule.trigger.field) {
      warnings.push(`既存ルール "${existing.id}" と同じトリガー（${rule.trigger.deviceId}.${rule.trigger.field}）です。両方発火します。`);
    }
  }
  return warnings;
}

export async function compileRule(
  naturalLanguage: string,
  catalog: Catalog,
  existingRules: Rule[],
  provider: LlmProvider,
): Promise<CompileResult> {
  const system = buildSystemPrompt(catalog, existingRules);
  const messages: ApiMessage[] = [{ role: "user", content: naturalLanguage }];

  let lastProblems: string[] = [];
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const text = await provider.complete(system, messages);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripFences(text)) as Record<string, unknown>;
    } catch {
      lastProblems = ["出力が JSON として解釈できませんでした"];
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: "出力が JSON として解釈できませんでした。指定の形式の JSON だけを出力し直してください。",
      });
      continue;
    }

    if (typeof parsed.error === "string") {
      return {
        error: parsed.error,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
        attempts: attempt,
      };
    }

    const candidate = (parsed.rule ?? {}) as Record<string, unknown>;
    candidate.source = naturalLanguage;
    candidate.compiledAt = new Date().toISOString();
    candidate.model = provider.label;
    if (candidate.enabled === undefined) candidate.enabled = true;

    const problems = validateRule(candidate, catalog);
    if (problems.length === 0) {
      const rule = candidate as unknown as Rule;
      const warnings = [
        ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []),
        ...overlapWarnings(rule, existingRules),
      ];
      return { rule, warnings, attempts: attempt };
    }

    lastProblems = problems;
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `そのルールはバリデーションに失敗しました。修正して JSON だけを出力し直してください:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    });
  }

  return {
    error: `コンパイルに失敗しました（${maxAttempts}回試行）: ${lastProblems.join(" / ")}`,
    warnings: [],
    attempts: maxAttempts,
  };
}
