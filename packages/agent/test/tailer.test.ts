import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "../../core/src/store.ts";
import { SwitchBotClient } from "../../core/src/switchbot.ts";
import { queryEvents } from "../../core/src/history.ts";
import { TsukumoAgent } from "../src/agent.ts";
import { StoreTailer } from "../src/tailer.ts";

test("tailer: 起動後に追記された camera イベントだけがルールを発火させる（履歴・他ソースは無視）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsukumo-tailer-"));
  const storeDir = join(dir, "data");
  const rulesDir = join(storeDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(rulesDir, "entrance-motion.json"),
    JSON.stringify({
      id: "entrance-motion",
      source: "玄関で動きがあったらログして",
      enabled: true,
      trigger: { deviceId: "camera:entrance", field: "motion", to: true },
      actions: [{ type: "log", message: "玄関で動きあり" }],
      explanation: "玄関カメラの motion が true になったらログする",
    }),
  );

  // 起動前から存在する camera イベント（読み飛ばされるべき）
  const writerStore = new JsonlEventStore(storeDir);
  const cameraEvent = {
    node: "remote-camera",
    source: "camera",
    deviceId: "camera:entrance",
    kind: "change" as const,
    field: "motion",
    from: false,
    to: true,
  };
  writerStore.append({ ...cameraEvent, ts: new Date(Date.now() - 60_000).toISOString() });

  const logs: string[] = [];
  const agentStore = new JsonlEventStore(storeDir);
  const agent = new TsukumoAgent({
    client: new SwitchBotClient({ token: "t", secret: "s" }, { baseUrl: "http://127.0.0.1:1" }),
    store: agentStore,
    node: "home",
    rulesDir,
    log: (message) => logs.push(message),
  });
  agent.loadRules();

  const tailer = new StoreTailer(
    storeDir,
    new Set(["camera", "mic"]),
    (event) => void agent.ingestExternalChange(event),
    (message) => logs.push(message),
  );
  tailer.start(3_600_000); // インターバルは実質無効化し、pollNow で決定的にテストする

  try {
    // 起動後の追記: camera（発火する）、switchbot（tail 対象外）、camera の snapshot（change でない）
    writerStore.append({ ...cameraEvent, ts: new Date().toISOString() });
    writerStore.append({
      ts: new Date().toISOString(),
      node: "home",
      source: "switchbot",
      deviceId: "meter-1",
      kind: "change",
      field: "humidity",
      from: 50,
      to: 55,
    });
    writerStore.append({
      ts: new Date().toISOString(),
      node: "remote-camera",
      source: "camera",
      deviceId: "camera:entrance",
      kind: "snapshot",
      status: { motion: true },
    });
    await tailer.pollNow();

    const firedLogs = logs.filter((message) => message.includes("玄関で動きあり"));
    assert.equal(firedLogs.length, 1, `発火は1回のはず: ${JSON.stringify(logs)}`);

    // ルール発火イベントもストアに記録され、最新状態にも反映されている
    const ruleEvents = await queryEvents(agentStore, { kind: "rule" });
    assert.equal(ruleEvents.events.length, 1);
    assert.equal(ruleEvents.events[0].deviceId, "entrance-motion");
    assert.equal(agent.lastStatus.get("camera:entrance")?.motion, true);

    // 追加の poll では何も起きない（オフセット管理）
    await tailer.pollNow();
    assert.equal(logs.filter((message) => message.includes("玄関で動きあり")).length, 1);
  } finally {
    tailer.stop();
  }
});
