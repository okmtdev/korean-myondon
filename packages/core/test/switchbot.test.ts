import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeaders, SwitchBotClient, DEFAULT_BASE_URL } from "../src/switchbot.ts";

const CREDENTIALS = { token: "demo-token", secret: "demo-secret" };

interface Capture {
  url?: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(envelope: unknown, capture: Capture): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    capture.url = String(url);
    capture.init = init as Capture["init"];
    return { ok: true, status: 200, json: async () => envelope };
  }) as unknown as typeof fetch;
}

test("buildAuthHeaders: 署名がゴールデンベクタと一致する", () => {
  const headers = buildAuthHeaders(CREDENTIALS, 1700000000000, "demo-nonce");
  assert.equal(headers.Authorization, "demo-token");
  assert.equal(headers.t, "1700000000000");
  assert.equal(headers.nonce, "demo-nonce");
  // base64(HMAC-SHA256("demo-secret", "demo-token" + t + nonce)) の大文字化
  assert.equal(headers.sign, "NOLYRTWLROD6M7LQJB9GL1CVAGNRSQ/13WRHLJREJCQ=");
});

test("buildAuthHeaders: 既定でも sign/t/nonce が埋まる", () => {
  const headers = buildAuthHeaders(CREDENTIALS);
  assert.ok(headers.sign.length > 0);
  assert.ok(/^\d+$/.test(headers.t));
  assert.ok(headers.nonce.length > 0);
});

test("listDevices: 正しい URL と認証ヘッダで GET する", async () => {
  const capture: Capture = {};
  const client = new SwitchBotClient(CREDENTIALS, {
    fetchImpl: fakeFetch({ statusCode: 100, message: "success", body: { deviceList: [] } }, capture),
  });
  const body = await client.listDevices();
  assert.equal(capture.url, `${DEFAULT_BASE_URL}/devices`);
  assert.equal(capture.init?.headers?.Authorization, "demo-token");
  assert.ok((capture.init?.headers?.sign ?? "").length > 0);
  assert.deepEqual(body, { deviceList: [] });
});

test("sendCommand: 既定値で command ボディを POST する", async () => {
  const capture: Capture = {};
  const client = new SwitchBotClient(CREDENTIALS, {
    fetchImpl: fakeFetch({ statusCode: 100, message: "success", body: {} }, capture),
  });
  await client.sendCommand("plug-1", "turnOn");
  assert.equal(capture.url, `${DEFAULT_BASE_URL}/devices/plug-1/commands`);
  assert.equal(capture.init?.method, "POST");
  assert.deepEqual(JSON.parse(capture.init?.body ?? ""), {
    command: "turnOn",
    parameter: "default",
    commandType: "command",
  });
});

test("getDeviceStatus: deviceId を URL エンコードする", async () => {
  const capture: Capture = {};
  const client = new SwitchBotClient(CREDENTIALS, {
    fetchImpl: fakeFetch({ statusCode: 100, message: "success", body: {} }, capture),
  });
  await client.getDeviceStatus("AB/CD");
  assert.equal(capture.url, `${DEFAULT_BASE_URL}/devices/AB%2FCD/status`);
});

test("statusCode が 100 以外なら例外", async () => {
  const client = new SwitchBotClient(CREDENTIALS, {
    fetchImpl: fakeFetch({ statusCode: 190, message: "device offline", body: {} }, {}),
  });
  await assert.rejects(() => client.getDeviceStatus("x"), /190.*device offline/);
});

test("HTTP エラーなら例外", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  const client = new SwitchBotClient(CREDENTIALS, { fetchImpl });
  await assert.rejects(() => client.listDevices(), /HTTP 401/);
});
