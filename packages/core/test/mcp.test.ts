import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import type { ToolDefinition } from "../src/mcp.ts";

function makeServer(): McpServer {
  const echo: ToolDefinition = {
    name: "echo",
    description: "echo back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => ({ content: [{ type: "text", text: `echo:${args.text}` }] }),
  };
  const boom: ToolDefinition = {
    name: "boom",
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("kaboom");
    },
  };
  return new McpServer({ name: "test-server", version: "0.0.1" }, [echo, boom]);
}

function resultOf(response: unknown): Record<string, any> {
  assert.ok(response && typeof response === "object" && "result" in (response as object));
  return (response as { result: Record<string, any> }).result;
}

test("initialize: 対応バージョンはそのまま返す", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  const result = resultOf(response);
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.equal(result.serverInfo.name, "test-server");
  assert.deepEqual(result.capabilities, { tools: {} });
});

test("initialize: 未知バージョンは最新対応版にフォールバック", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "9999-01-01" },
  });
  assert.equal(resultOf(response).protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test("通知（id なし）には応答しない", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(response, null);
});

test("tools/list: handler を漏らさずスキーマと annotations を返す", async () => {
  const response = await makeServer().handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = resultOf(response).tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "echo");
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.ok(!("handler" in tools[0]));
  assert.ok(!("annotations" in tools[1]));
});

test("tools/call: 正常系", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hi" } },
  });
  assert.deepEqual(resultOf(response).content, [{ type: "text", text: "echo:hi" }]);
});

test("tools/call: ハンドラ例外は isError 付き結果になる", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "boom", arguments: {} },
  });
  const result = resultOf(response);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /kaboom/);
});

test("tools/call: 未知ツールは -32602", async () => {
  const response = await makeServer().handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "nope" },
  });
  assert.equal((response as any).error.code, -32602);
});

test("未知メソッドは -32601", async () => {
  const response = await makeServer().handleMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal((response as any).error.code, -32601);
});

test("ping は空の result を返す", async () => {
  const response = await makeServer().handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(resultOf(response), {});
});

test("attach: LF 区切り JSON-RPC の往復（壊れた行にも耐える）", async () => {
  const server = makeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  server.attach(input, output);

  const lines: string[] = [];
  const gotThree = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for responses")), 2000);
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += String(chunk);
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (part.trim() !== "") lines.push(part);
      if (lines.length >= 3) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  input.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
  );
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write("this-is-not-json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await gotThree;

  const [first, second, third] = lines.map((line) => JSON.parse(line));
  assert.equal(first.id, 1);
  assert.equal(first.result.protocolVersion, "2025-06-18");
  assert.equal(second.id, null);
  assert.equal(second.error.code, -32700);
  assert.equal(third.id, 2);
  assert.equal(third.result.tools.length, 2);
});
