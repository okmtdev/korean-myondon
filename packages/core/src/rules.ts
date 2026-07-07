/**
 * ルール IR（中間表現）v0。
 *
 * kotodama（LLM コンパイラ）の出力であり、agent が実行する決定的なルール。
 * 実行時に LLM は一切登場しない。
 *
 * v0 の意味論:
 * - trigger: change イベント（デバイスのフィールド遷移）へのマッチ
 * - condition: 発火時点の「他デバイスの最新状態」と「時間帯」への述語
 * - actions: SwitchBot コマンド / 通知 / ログ を順に実行
 */
import { inTimeWindow } from "./time.ts";
import { type Catalog, catalogHasDevice, catalogHasField } from "./catalog.ts";
import type { TsukumoEvent } from "./events.ts";

export type Primitive = string | number | boolean;

/** 値マッチャ。プリミティブなら厳密一致、オブジェクトなら比較演算 */
export type ValueMatcher =
  | Primitive
  | {
      eq?: Primitive;
      ne?: Primitive;
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
    };

export interface Trigger {
  deviceId: string;
  field: string;
  /** 変化後の値の条件（省略なら任意の変化） */
  to?: ValueMatcher;
  /** 変化前の値の条件 */
  from?: ValueMatcher;
}

export interface DeviceCondition {
  deviceId: string;
  field: string;
  equals?: Primitive;
  ne?: Primitive;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface Condition {
  allOf?: Condition[];
  anyOf?: Condition[];
  not?: Condition;
  device?: DeviceCondition;
  /** ローカル時刻の時間帯 [after, before)。日またぎ可 */
  time?: { after?: string; before?: string };
}

export type Action =
  | {
      type: "switchbot_command";
      deviceId: string;
      command: string;
      parameter?: unknown;
      commandType?: "command" | "customize";
    }
  | { type: "notify"; message: string }
  | { type: "log"; message: string };

export interface Rule {
  /** 英小文字・数字・ハイフンの slug */
  id: string;
  /** 元の自然言語 */
  source: string;
  enabled: boolean;
  trigger: Trigger;
  condition?: Condition;
  actions: Action[];
  /** いつ・なぜ発火するかの人間向け説明（コンパイラが生成） */
  explanation: string;
  /**
   * 実行ノードの指定。設定するとそのノード名の agent だけが実行する。
   * 未設定なら全ノードで実行（複数ノードが同じイベント源を見ていると多重発火するので注意）。
   */
  node?: string;
  compiledAt?: string;
  model?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const HHMM_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMatcher(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || isPrimitive(value)) return;
  if (!isRecord(value)) {
    errors.push(`${path}: プリミティブか比較オブジェクト（eq/ne/gt/gte/lt/lte）にしてください`);
    return;
  }
  const allowed = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
  const keys = Object.keys(value);
  if (keys.length === 0) errors.push(`${path}: 比較オブジェクトが空です`);
  for (const key of keys) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: 未知の比較演算子です`);
    else if ((key === "gt" || key === "gte" || key === "lt" || key === "lte") && typeof value[key] !== "number") {
      errors.push(`${path}.${key}: 数値にしてください`);
    }
  }
}

function validateCondition(value: unknown, path: string, errors: string[], catalog: Catalog | null): void {
  if (!isRecord(value)) {
    errors.push(`${path}: オブジェクトにしてください`);
    return;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  const known = new Set(["allOf", "anyOf", "not", "device", "time"]);
  for (const key of keys) if (!known.has(key)) errors.push(`${path}.${key}: 未知の条件です`);
  if (keys.length !== 1) {
    errors.push(`${path}: 条件は allOf / anyOf / not / device / time のどれか1つだけを持ちます`);
    return;
  }
  if (Array.isArray(value.allOf)) {
    value.allOf.forEach((child, index) => validateCondition(child, `${path}.allOf[${index}]`, errors, catalog));
  } else if (value.allOf !== undefined) {
    errors.push(`${path}.allOf: 配列にしてください`);
  }
  if (Array.isArray(value.anyOf)) {
    if (value.anyOf.length === 0) errors.push(`${path}.anyOf: 空の anyOf は常に偽です`);
    value.anyOf.forEach((child, index) => validateCondition(child, `${path}.anyOf[${index}]`, errors, catalog));
  } else if (value.anyOf !== undefined) {
    errors.push(`${path}.anyOf: 配列にしてください`);
  }
  if (value.not !== undefined) validateCondition(value.not, `${path}.not`, errors, catalog);
  if (value.device !== undefined) {
    if (!isRecord(value.device)) {
      errors.push(`${path}.device: オブジェクトにしてください`);
    } else {
      const device = value.device;
      if (typeof device.deviceId !== "string" || device.deviceId === "") errors.push(`${path}.device.deviceId: 必須です`);
      if (typeof device.field !== "string" || device.field === "") errors.push(`${path}.device.field: 必須です`);
      const ops = ["equals", "ne", "gt", "gte", "lt", "lte"].filter((op) => device[op] !== undefined);
      if (ops.length === 0) errors.push(`${path}.device: equals/ne/gt/gte/lt/lte のいずれかが必要です`);
      if (catalog && typeof device.deviceId === "string" && !catalogHasDevice(catalog, device.deviceId)) {
        errors.push(`${path}.device.deviceId: "${device.deviceId}" はカタログにありません`);
      } else if (
        catalog &&
        typeof device.deviceId === "string" &&
        typeof device.field === "string" &&
        !catalogHasField(catalog, device.deviceId, device.field)
      ) {
        errors.push(`${path}.device.field: "${device.deviceId}" に "${device.field}" の観測がありません`);
      }
    }
  }
  if (value.time !== undefined) {
    if (!isRecord(value.time)) {
      errors.push(`${path}.time: オブジェクトにしてください`);
    } else {
      const { after, before } = value.time;
      if (after === undefined && before === undefined) errors.push(`${path}.time: after か before が必要です`);
      for (const [name, hhmm] of [
        ["after", after],
        ["before", before],
      ] as const) {
        if (hhmm !== undefined && (typeof hhmm !== "string" || !HHMM_PATTERN.test(hhmm))) {
          errors.push(`${path}.time.${name}: "HH:MM" 形式にしてください`);
        }
      }
    }
  }
}

/**
 * ルールを検証してエラー一覧を返す（空配列なら合格）。
 * catalog を渡すと deviceId / field の実在チェックも行う。
 */
export function validateRule(value: unknown, catalog: Catalog | null): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["rule: オブジェクトにしてください"];

  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    errors.push('id: 英小文字・数字・ハイフンの slug（例 "washer-done-notify"）にしてください');
  }
  if (typeof value.source !== "string" || value.source === "") errors.push("source: 元の自然言語を入れてください");
  if (typeof value.enabled !== "boolean") errors.push("enabled: boolean にしてください");
  if (typeof value.explanation !== "string" || value.explanation === "") {
    errors.push("explanation: 発火条件の人間向け説明を入れてください");
  }
  if (value.node !== undefined && (typeof value.node !== "string" || value.node === "")) {
    errors.push("node: 指定するなら空でないノード名にしてください");
  }

  if (!isRecord(value.trigger)) {
    errors.push("trigger: オブジェクトにしてください");
  } else {
    const trigger = value.trigger;
    if (typeof trigger.deviceId !== "string" || trigger.deviceId === "") errors.push("trigger.deviceId: 必須です");
    if (typeof trigger.field !== "string" || trigger.field === "") errors.push("trigger.field: 必須です");
    validateMatcher(trigger.to, "trigger.to", errors);
    validateMatcher(trigger.from, "trigger.from", errors);
    if (catalog && typeof trigger.deviceId === "string" && trigger.deviceId !== "") {
      if (!catalogHasDevice(catalog, trigger.deviceId)) {
        errors.push(`trigger.deviceId: "${trigger.deviceId}" はカタログにありません`);
      } else if (typeof trigger.field === "string" && !catalogHasField(catalog, trigger.deviceId, trigger.field)) {
        errors.push(`trigger.field: "${trigger.deviceId}" に "${trigger.field}" の観測がありません`);
      }
    }
  }

  if (value.condition !== undefined) validateCondition(value.condition, "condition", errors, catalog);

  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    errors.push("actions: 1つ以上必要です");
  } else {
    value.actions.forEach((action, index) => {
      const path = `actions[${index}]`;
      if (!isRecord(action)) {
        errors.push(`${path}: オブジェクトにしてください`);
        return;
      }
      switch (action.type) {
        case "switchbot_command":
          if (typeof action.deviceId !== "string" || action.deviceId === "") errors.push(`${path}.deviceId: 必須です`);
          if (typeof action.command !== "string" || action.command === "") errors.push(`${path}.command: 必須です`);
          if (
            action.commandType !== undefined &&
            action.commandType !== "command" &&
            action.commandType !== "customize"
          ) {
            errors.push(`${path}.commandType: "command" か "customize" にしてください`);
          }
          if (catalog && typeof action.deviceId === "string" && action.deviceId !== "" && !catalogHasDevice(catalog, action.deviceId)) {
            errors.push(`${path}.deviceId: "${action.deviceId}" はカタログにありません`);
          }
          break;
        case "notify":
        case "log":
          if (typeof action.message !== "string" || action.message === "") errors.push(`${path}.message: 必須です`);
          break;
        default:
          errors.push(`${path}.type: 未知のアクション "${String(action.type)}" です`);
      }
    });
  }

  return errors;
}

export function matchValue(matcher: ValueMatcher | undefined, actual: unknown): boolean {
  if (matcher === undefined) return true;
  if (isPrimitive(matcher)) return actual === matcher;
  if (matcher.eq !== undefined && actual !== matcher.eq) return false;
  if (matcher.ne !== undefined && actual === matcher.ne) return false;
  const numeric = typeof actual === "number" ? actual : Number(actual);
  for (const op of ["gt", "gte", "lt", "lte"] as const) {
    if (matcher[op] === undefined) continue;
    if (typeof actual !== "number" && Number.isNaN(numeric)) return false;
    const threshold = matcher[op] as number;
    if (op === "gt" && !(numeric > threshold)) return false;
    if (op === "gte" && !(numeric >= threshold)) return false;
    if (op === "lt" && !(numeric < threshold)) return false;
    if (op === "lte" && !(numeric <= threshold)) return false;
  }
  return true;
}

/** change イベントがトリガーにマッチするか */
export function matchesTrigger(trigger: Trigger, event: TsukumoEvent): boolean {
  if (event.kind !== "change") return false;
  if (event.deviceId !== trigger.deviceId) return false;
  if (event.field !== trigger.field) return false;
  return matchValue(trigger.to, event.to) && matchValue(trigger.from, event.from);
}

export interface ConditionContext {
  /** デバイスの最新状態（未観測なら undefined） */
  latest: (deviceId: string) => Record<string, unknown> | undefined;
  now: Date;
}

export function evalCondition(condition: Condition | undefined, ctx: ConditionContext): boolean {
  if (condition === undefined) return true;
  if (condition.allOf !== undefined) return condition.allOf.every((child) => evalCondition(child, ctx));
  if (condition.anyOf !== undefined) return condition.anyOf.some((child) => evalCondition(child, ctx));
  if (condition.not !== undefined) return !evalCondition(condition.not, ctx);
  if (condition.device !== undefined) {
    const device = condition.device;
    const status = ctx.latest(device.deviceId);
    if (status === undefined) return false;
    const actual = status[device.field];
    if (device.equals !== undefined && actual !== device.equals) return false;
    if (device.ne !== undefined && actual === device.ne) return false;
    const numeric = typeof actual === "number" ? actual : Number(actual);
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      const threshold = device[op];
      if (threshold === undefined) continue;
      if (Number.isNaN(numeric)) return false;
      if (op === "gt" && !(numeric > threshold)) return false;
      if (op === "gte" && !(numeric >= threshold)) return false;
      if (op === "lt" && !(numeric < threshold)) return false;
      if (op === "lte" && !(numeric <= threshold)) return false;
    }
    return true;
  }
  if (condition.time !== undefined) return inTimeWindow(ctx.now, condition.time.after, condition.time.before);
  return true;
}
