import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../../core/src/store.ts";
import { SwitchBotClient } from "../../core/src/switchbot.ts";
import { queryEvents, thresholdSpans } from "../../core/src/history.ts";
import { TsukumoAgent } from "../src/agent.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
}

test("e2e: 偽SwitchBot相手に ポーリング→変化検知→ルール発火→履歴クエリ が通る", async () => {
  // --- 偽 SwitchBot API ---
  let humidity = 55;
  const commands: unknown[] = [];
  const fakeApi = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const ok = (payload: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ statusCode: 100, message: "success", body: payload }));
      };
      if (request.method === "GET" && request.url === "/devices") {
        ok({
          deviceList: [{ deviceId: "meter-1", deviceName: "寝室温湿度計", deviceType: "MeterPlus" }],
          infraredRemoteList: [],
        });
      } else if (request.method === "GET" && request.url === "/devices/meter-1/status") {
        ok({ deviceId: "meter-1", deviceType: "MeterPlus", humidity, temperature: 25, battery: 90 });
      } else if (request.method === "POST" && request.url === "/devices/plug-fan/commands") {
        commands.push(JSON.parse(body));
        ok({});
      } else {
        response.writeHead(404).end();
      }
    });
  });
  const apiPort = await listen(fakeApi);

  // --- 偽 通知 Webhook ---
  const notifications: Array<{ text?: string }> = [];
  const fakeNotify = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      notifications.push(JSON.parse(body));
      response.writeHead(200).end("ok");
    });
  });
  const notifyPort = await listen(fakeNotify);

  try {
    const dir = mkdtempSync(join(tmpdir(), "tsukumo-e2e-"));
    const rulesDir = join(dir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(rulesDir, "humid-fan.json"),
      JSON.stringify({
        id: "humid-fan",
        source: "湿度が60を超えたらサーキュレーターをつけて通知して",
        enabled: true,
        trigger: { deviceId: "meter-1", field: "humidity", to: { gt: 60 }, from: { lte: 60 } },
        actions: [
          { type: "switchbot_command", deviceId: "plug-fan", command: "turnOn" },
          { type: "notify", message: "湿度が60%を超えたよ" },
        ],
        explanation: "湿度が60を上回った瞬間にファンをつけて通知する",
      }),
    );

    const store = new JsonlEventStore(join(dir, "data"));
    const client = new SwitchBotClient({ token: "t", secret: "s" }, { baseUrl: `http://127.0.0.1:${apiPort}` });
    const agent = new TsukumoAgent({
      client,
      store,
      node: "e2e",
      rulesDir,
      notifyWebhook: `http://127.0.0.1:${notifyPort}/notify`,
      log: () => {},
    });

    const rules = agent.loadRules();
    assert.deepEqual({ loaded: rules.loaded, errors: rules.errors }, { loaded: 1, errors: [] });
    assert.equal(await agent.refreshDevices(), 1);

    // 1周目: 初回観測（snapshot のみ・発火なし）
    const first = await agent.pollOnce();
    assert.deepEqual(
      { snapshots: first.snapshots, changes: first.changes, fired: first.fired },
      { snapshots: 1, changes: 0, fired: 0 },
    );

    // 湿度が跳ねる → 2周目で change + ルール発火
    humidity = 65;
    const second = await agent.pollOnce();
    assert.equal(second.changes, 1);
    assert.equal(second.fired, 1);

    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], { command: "turnOn", parameter: "default", commandType: "command" });
    assert.deepEqual(notifications, [{ text: "湿度が60%を超えたよ" }]);

    // 履歴にも残っている
    const changes = await queryEvents(store, { kind: "change" });
    assert.equal(changes.events.length, 1);
    assert.deepEqual({ from: changes.events[0].from, to: changes.events[0].to }, { from: 55, to: 65 });

    const fired = await queryEvents(store, { kind: "rule" });
    assert.equal(fired.events.length, 1);
    assert.equal(fired.events[0].deviceId, "humid-fan");

    // 「湿度が60を超えた時間帯は？」にも答えられる
    const spans = await thresholdSpans(store, { deviceId: "meter-1", field: "humidity", op: "gt", value: 60 });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].open, true);
  } finally {
    fakeApi.close();
    fakeNotify.close();
  }
});

test("e2e: SwitchBot Webhook ボディが change として流れ、ルールが発火する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsukumo-webhook-"));
  const rulesDir = join(dir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(rulesDir, "door-log.json"),
    JSON.stringify({
      id: "door-log",
      source: "ドアが開いたらログして",
      enabled: true,
      trigger: { deviceId: "AA:BB:CC", field: "detectionState", to: "DETECTED" },
      actions: [{ type: "log", message: "ドアが開いた" }],
      explanation: "開閉センサーが DETECTED になったらログする",
    }),
  );

  const logs: string[] = [];
  const store = new JsonlEventStore(join(dir, "data"));
  const client = new SwitchBotClient({ token: "t", secret: "s" }, { baseUrl: "http://127.0.0.1:1" });
  const agent = new TsukumoAgent({ client, store, node: "e2e", rulesDir, log: (message) => logs.push(message) });
  agent.loadRules();

  // 他ノード担当のルールは読み込み時にスキップされる（同期で配られても多重発火しない）
  writeFileSync(
    join(rulesDir, "remote-only.json"),
    JSON.stringify({
      id: "remote-only",
      source: "リモートノード専用",
      enabled: true,
      node: "remote-camera",
      trigger: { deviceId: "AA:BB:CC", field: "detectionState", to: "DETECTED" },
      actions: [{ type: "log", message: "リモート側でだけ動くはず" }],
      explanation: "node が違うので e2e ノードでは動かない",
    }),
  );
  const reloaded = agent.loadRules();
  assert.deepEqual({ loaded: reloaded.loaded, skipped: reloaded.skipped }, { loaded: 1, skipped: 1 });

  const result = await agent.handleWebhookBody({
    eventType: "changeReport",
    eventVersion: "1",
    context: {
      deviceType: "WoContact",
      deviceMac: "AA:BB:CC",
      detectionState: "DETECTED",
      timeOfSample: 1234567890,
    },
  });

  assert.equal(result.changes, 1); // deviceMac / deviceType / timeOfSample は無視される
  assert.equal(result.fired, 1);
  assert.ok(logs.some((message) => message.includes("ドアが開いた")));

  const events = await queryEvents(store, { kind: "change" });
  assert.equal(events.events[0].source, "switchbot-webhook");
  assert.equal(events.events[0].to, "DETECTED");

  await assert.rejects(() => agent.handleWebhookBody({ nope: true }), /context/);
});
