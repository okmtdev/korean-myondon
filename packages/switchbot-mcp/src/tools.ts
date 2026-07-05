/**
 * SwitchBot クライアントを MCP ツール群に束ねる。
 */
import type { ToolDefinition, ToolResult } from "./mcp.ts";
import type { SwitchBotClient } from "./switchbot.ts";

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`argument "${key}" must be a non-empty string`);
  }
  return value;
}

export function createSwitchBotTools(client: SwitchBotClient): ToolDefinition[] {
  return [
    {
      name: "switchbot_list_devices",
      description:
        "List all SwitchBot devices bound to the account: physical devices (deviceList: meters, plugs, curtains, bots, sensors, hubs...) and infrared remotes (infraredRemoteList: aircon, TV... controlled via hub). Call this first to discover deviceIds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async () => jsonResult(await client.listDevices()),
    },
    {
      name: "switchbot_get_device_status",
      description:
        "Get the current status of a physical SwitchBot device: temperature, humidity, CO2, battery, power state, curtain position, etc. Infrared remote devices have no status endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Device ID from switchbot_list_devices" },
        },
        required: ["deviceId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => jsonResult(await client.getDeviceStatus(requireString(args, "deviceId"))),
    },
    {
      name: "switchbot_send_command",
      description:
        'Send a control command to a device. THIS ACTS ON THE PHYSICAL WORLD (switches plugs, moves curtains, presses buttons) — only use when the user asked for it. Examples: command="turnOn"/"turnOff" (plug, bot), "press" (bot), "setPosition" with parameter "0,ff,50" (curtain to 50%). Infrared aircon: command="setAll", parameter="26,2,1,on" (temperature,mode,fanSpeed,power). For custom IR remote buttons use commandType="customize" and command=<button name>.',
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Device ID from switchbot_list_devices" },
          command: { type: "string", description: 'Command name, e.g. "turnOn"' },
          parameter: {
            description: 'Command parameter. Omit for "default". Some commands take a string like "26,2,1,on".',
          },
          commandType: {
            type: "string",
            enum: ["command", "customize"],
            description: '"command" (default) for standard commands, "customize" for user-defined IR buttons',
          },
        },
        required: ["deviceId", "command"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) =>
        jsonResult(
          await client.sendCommand(
            requireString(args, "deviceId"),
            requireString(args, "command"),
            args.parameter ?? "default",
            typeof args.commandType === "string" ? args.commandType : "command",
          ),
        ),
    },
    {
      name: "switchbot_list_scenes",
      description: "List manual scenes registered in the SwitchBot app.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async () => jsonResult(await client.listScenes()),
    },
    {
      name: "switchbot_execute_scene",
      description:
        "Execute a manual scene (a sequence of device actions configured in the SwitchBot app). THIS ACTS ON THE PHYSICAL WORLD.",
      inputSchema: {
        type: "object",
        properties: {
          sceneId: { type: "string", description: "Scene ID from switchbot_list_scenes" },
        },
        required: ["sceneId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) => jsonResult(await client.executeScene(requireString(args, "sceneId"))),
    },
  ];
}
