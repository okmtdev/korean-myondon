import { test } from "node:test";
import assert from "node:assert/strict";
import { createCameraTools, parseCameraUrls } from "../src/camera-tools.ts";

test("parseCameraUrls: 正常系・末尾スラッシュ除去・不正入力", () => {
  assert.deepEqual(parseCameraUrls(undefined), {});
  assert.deepEqual(parseCameraUrls("entrance=http://minipc:8180/, garage=http://x:8181"), {
    entrance: "http://minipc:8180",
    garage: "http://x:8181",
  });
  assert.throws(() => parseCameraUrls("nourl"), /形式が不正/);
});

test("tsukumo_camera_snapshot: JPEG を base64 の image content で返す", async () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const requested: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.length),
      headers: { get: (name: string) => (name === "content-type" ? "image/jpeg" : null) },
    };
  }) as unknown as typeof fetch;

  const [tool] = createCameraTools({ entrance: "http://minipc:8180" }, fetchImpl);
  const result = await tool.handler({});
  assert.deepEqual(requested, ["http://minipc:8180/snapshot"]);
  assert.equal(result.content[0].type, "image");
  const image = result.content[0] as { type: "image"; data: string; mimeType: string };
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual([...Buffer.from(image.data, "base64")], [...jpegBytes]);
  assert.equal(result.content[1].type, "text");
});

test("tsukumo_camera_snapshot: 未知カメラと HTTP エラー", async () => {
  const okFetch = (async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } })) as unknown as typeof fetch;
  const [tool] = createCameraTools({ entrance: "http://minipc:8180" }, okFetch);
  await assert.rejects(() => tool.handler({ camera: "nope" }), /unknown camera/);
  await assert.rejects(() => tool.handler({}), /HTTP 503/);
});
