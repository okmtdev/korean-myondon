/**
 * 最小の MCP (Model Context Protocol) サーバー実装。
 *
 * 依存ゼロでツール提供（tools/list・tools/call）だけをやる。
 * トランスポートは MCP の stdio 仕様どおり、LF 区切りの JSON-RPC 2.0。
 * 仕様: https://modelcontextprotocol.io/specification
 */
import { createInterface } from "node:readline";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema をそのまま持つ */
  inputSchema: Record<string, unknown>;
  /** readOnlyHint / destructiveHint などのヒント */
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

type RequestId = number | string | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: RequestId;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: RequestId; result: unknown }
  | { jsonrpc: "2.0"; id: RequestId; error: { code: number; message: string } };

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class McpServer {
  readonly serverInfo: ServerInfo;
  readonly tools: ToolDefinition[];

  constructor(serverInfo: ServerInfo, tools: ToolDefinition[]) {
    this.serverInfo = serverInfo;
    this.tools = tools;
  }

  /** 1 つの JSON-RPC メッセージを処理する。通知（id なし）には null を返す。 */
  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!("id" in message) || message.id === undefined) {
      // notifications/initialized, notifications/cancelled などは黙って受ける
      return null;
    }
    const id = message.id as RequestId;
    const method = message.method ?? "";

    try {
      switch (method) {
        case "initialize":
          return this.result(id, this.initialize(message.params));
        case "ping":
          return this.result(id, {});
        case "tools/list":
          return this.result(id, {
            tools: this.tools.map(({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema,
              ...(annotations ? { annotations } : {}),
            })),
          });
        case "tools/call":
          return await this.callTool(id, message.params);
        default:
          return this.error(id, -32601, `Method not found: ${method}`);
      }
    } catch (cause) {
      return this.error(id, -32603, `Internal error: ${describeError(cause)}`);
    }
  }

  /** stdin/stdout（など）に接続する。メッセージは到着順に直列処理。 */
  attach(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let queue: Promise<void> = Promise.resolve();
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      queue = queue.then(async () => {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(trimmed) as JsonRpcMessage;
        } catch {
          this.send(output, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        const response = await this.handleMessage(message);
        if (response) this.send(output, response);
      });
    });
  }

  private initialize(params: Record<string, unknown> | undefined) {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: this.serverInfo,
    };
  }

  private async callTool(
    id: RequestId,
    params: Record<string, unknown> | undefined,
  ): Promise<JsonRpcResponse> {
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return this.error(id, -32602, `Unknown tool: ${name}`);
    }
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      return this.result(id, await tool.handler(args));
    } catch (cause) {
      // ツール実行の失敗はプロトコルエラーではなく isError 付きの結果として返す
      const failure: ToolResult = {
        content: [{ type: "text", text: `Error: ${describeError(cause)}` }],
        isError: true,
      };
      return this.result(id, failure);
    }
  }

  private send(output: NodeJS.WritableStream, response: JsonRpcResponse): void {
    output.write(JSON.stringify(response) + "\n");
  }

  private result(id: RequestId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: RequestId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

/** ツール実装用ヘルパ: 値を整形 JSON のテキスト結果にする */
export function jsonToolResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** ツール実装用ヘルパ: 必須の文字列引数を取り出す */
export function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`argument "${key}" must be a non-empty string`);
  }
  return value;
}
