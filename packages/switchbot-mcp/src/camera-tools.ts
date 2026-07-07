/**
 * 遠隔カメラノードのスナップショットを取る MCP ツール。
 * TSUKUMO_CAMERA_URLS が設定されているときだけ有効になる。
 *
 * プライバシー原則: 映像はノードに留まり、このツールで「明示的に要求された瞬間」
 * だけ1枚が取得される（camera デーモン側にもその旨ログが残る）。
 */
import type { ToolDefinition, ToolResult } from "../../core/src/mcp.ts";

/** "entrance=http://minipc:8180,garage=http://x:8181" 形式を読む */
export function parseCameraUrls(raw: string | undefined): Record<string, string> {
  const cameras: Record<string, string> = {};
  if (!raw) return cameras;
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`TSUKUMO_CAMERA_URLS の形式が不正です: "${entry}"（例: entrance=http://minipc:8180）`);
    }
    cameras[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim().replace(/\/$/, "");
  }
  return cameras;
}

export function createCameraTools(
  cameras: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): ToolDefinition[] {
  const names = Object.keys(cameras);
  return [
    {
      name: "tsukumo_camera_snapshot",
      description:
        `Fetch one live snapshot image from a tsukumo camera node. Available cameras: ${names.join(", ")}. ` +
        "Privacy: video never leaves the camera node continuously — this returns a single frame captured only on this explicit request. Only use when the user asks to see the camera.",
      inputSchema: {
        type: "object",
        properties: {
          camera: {
            type: "string",
            description: `Camera name (default: "${names[0]}"). One of: ${names.join(", ")}`,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args): Promise<ToolResult> => {
        const name = typeof args.camera === "string" && args.camera !== "" ? args.camera : names[0];
        const base = cameras[name];
        if (base === undefined) {
          throw new Error(`unknown camera "${name}" — available: ${names.join(", ")}`);
        }
        const response = await fetchImpl(`${base}/snapshot`);
        if (!response.ok) {
          throw new Error(`camera "${name}" returned HTTP ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers?.get?.("content-type") ?? "image/jpeg";
        return {
          content: [
            { type: "image", data: bytes.toString("base64"), mimeType },
            { type: "text", text: `camera=${name} capturedAt=${new Date().toISOString()} bytes=${bytes.length}` },
          ],
        };
      },
    },
  ];
}
