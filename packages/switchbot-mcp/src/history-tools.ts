/**
 * イベントストア（agent が溜めた履歴）への問い合わせツール群。
 * TSUKUMO_STORE_DIR が設定されているときだけ有効になる。
 */
import { jsonToolResult, requireStringArg } from "../../core/src/mcp.ts";
import type { ToolDefinition } from "../../core/src/mcp.ts";
import { aggregate, queryEvents, thresholdSpans } from "../../core/src/history.ts";
import type { ThresholdOp } from "../../core/src/history.ts";
import { buildCatalogFromStore } from "../../core/src/catalog.ts";
import { parseWhen } from "../../core/src/time.ts";
import type { JsonlEventStore } from "../../core/src/store.ts";

const TIME_HINT = 'ISO 8601, or relative like "-30m" / "-24h" / "-7d"';

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) throw new Error(`argument "${key}" must be a number`);
  return numeric;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`argument "${key}" must be a string`);
  return value;
}

export function createHistoryTools(store: JsonlEventStore): ToolDefinition[] {
  return [
    {
      name: "tsukumo_list_history_devices",
      description:
        "List devices observed in the tsukumo event store, with the fields recorded for each (e.g. temperature, humidity, power). Use this to discover what history is queryable before calling other tsukumo_* history tools.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: `Only consider events after this time (${TIME_HINT}). Default "-30d".` },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const since = parseWhen(optionalString(args, "since"), new Date(Date.now() - 30 * 86_400_000));
        return jsonToolResult(await buildCatalogFromStore(store, { since }));
      },
    },
    {
      name: "tsukumo_query_events",
      description:
        "Query raw events from the tsukumo store: snapshots (full device status per poll), changes (field transitions like power on->off), and rule firings. Returns newest events when truncated by limit.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: `${TIME_HINT}. Default "-24h".` },
          until: { type: "string", description: `${TIME_HINT}. Default: now.` },
          deviceId: { type: "string", description: "Filter by device ID (rule events use the rule ID here)" },
          field: { type: "string", description: 'Filter by field name, e.g. "humidity", "power"' },
          kind: { type: "string", enum: ["snapshot", "change", "rule"], description: "Filter by event kind" },
          limit: { type: "number", description: "Max events to return (default 200)" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const result = await queryEvents(
          store,
          {
            since: parseWhen(optionalString(args, "since"), new Date(Date.now() - 86_400_000)),
            until: parseWhen(optionalString(args, "until")),
            deviceId: optionalString(args, "deviceId"),
            field: optionalString(args, "field"),
            kind: optionalString(args, "kind"),
          },
          optionalNumber(args, "limit") ?? 200,
        );
        return jsonToolResult(result);
      },
    },
    {
      name: "tsukumo_aggregate_history",
      description:
        "Aggregate a numeric field of one device into time buckets (min/max/avg/last per bucket). Good for questions like 'how did the bedroom temperature move this week?'.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          field: { type: "string", description: 'e.g. "temperature", "humidity", "power"' },
          since: { type: "string", description: `${TIME_HINT}. Default "-7d".` },
          until: { type: "string", description: `${TIME_HINT}. Default: now.` },
          bucketMinutes: { type: "number", description: "Bucket size in minutes (default 60)" },
        },
        required: ["deviceId", "field"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        return jsonToolResult(
          await aggregate(store, {
            deviceId: requireStringArg(args, "deviceId"),
            field: requireStringArg(args, "field"),
            since: parseWhen(optionalString(args, "since"), new Date(Date.now() - 7 * 86_400_000)),
            until: parseWhen(optionalString(args, "until")),
            bucketMinutes: optionalNumber(args, "bucketMinutes"),
          }),
        );
      },
    },
    {
      name: "tsukumo_threshold_spans",
      description:
        "Find time spans where a numeric field continuously satisfied a condition. Answers questions like 'when did humidity exceed 60% last week?' (deviceId, field=humidity, op=gt, value=60, since=-7d).",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          field: { type: "string" },
          op: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq", "ne"] },
          value: { type: "number" },
          since: { type: "string", description: `${TIME_HINT}. Default "-7d".` },
          until: { type: "string", description: `${TIME_HINT}. Default: now.` },
        },
        required: ["deviceId", "field", "op", "value"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const op = requireStringArg(args, "op") as ThresholdOp;
        if (!["gt", "gte", "lt", "lte", "eq", "ne"].includes(op)) {
          throw new Error('argument "op" must be one of gt/gte/lt/lte/eq/ne');
        }
        const value = optionalNumber(args, "value");
        if (value === undefined) throw new Error('argument "value" is required');
        return jsonToolResult(
          await thresholdSpans(store, {
            deviceId: requireStringArg(args, "deviceId"),
            field: requireStringArg(args, "field"),
            op,
            value,
            since: parseWhen(optionalString(args, "since"), new Date(Date.now() - 7 * 86_400_000)),
            until: parseWhen(optionalString(args, "until")),
          }),
        );
      },
    },
  ];
}
