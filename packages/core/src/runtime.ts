/**
 * ルールランタイム — change イベントに対してルール群を評価・実行する。
 * ここが「実行時 LLM レス」の実行時。決定的なコードだけで動く。
 */
import { type ConditionContext, type Rule, evalCondition, matchesTrigger } from "./rules.ts";
import type { TsukumoEvent } from "./events.ts";

export interface ActionExecutor {
  sendCommand(deviceId: string, command: string, parameter: unknown, commandType: string): Promise<unknown>;
  notify(message: string): Promise<void>;
  log(message: string): void;
}

export interface FireOptions {
  node: string;
  /** true ならアクションを実行せず記録だけする */
  dryRun?: boolean;
}

export interface ActionOutcome {
  action: Record<string, unknown>;
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

/**
 * 1つの change イベントに対して全ルールを評価し、
 * 発火したルールごとに rule イベント（記録用）を返す。
 */
export async function fireRules(
  rules: Rule[],
  event: TsukumoEvent,
  ctx: ConditionContext,
  executor: ActionExecutor,
  options: FireOptions,
): Promise<TsukumoEvent[]> {
  const fired: TsukumoEvent[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesTrigger(rule.trigger, event)) continue;
    if (!evalCondition(rule.condition, ctx)) continue;

    const results: ActionOutcome[] = [];
    for (const action of rule.actions) {
      const record = { ...action } as Record<string, unknown>;
      if (options.dryRun) {
        results.push({ action: record, ok: true, skipped: true });
        continue;
      }
      try {
        if (action.type === "switchbot_command") {
          await executor.sendCommand(
            action.deviceId,
            action.command,
            action.parameter ?? "default",
            action.commandType ?? "command",
          );
        } else if (action.type === "notify") {
          await executor.notify(action.message);
        } else {
          executor.log(action.message);
        }
        results.push({ action: record, ok: true });
      } catch (cause) {
        results.push({
          action: record,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    fired.push({
      ts: ctx.now.toISOString(),
      node: options.node,
      source: "kotodama",
      deviceId: rule.id,
      kind: "rule",
      field: "fired",
      status: {
        trigger: { deviceId: event.deviceId, field: event.field, from: event.from, to: event.to },
        dryRun: options.dryRun === true,
        results,
      },
    });
  }

  return fired;
}
