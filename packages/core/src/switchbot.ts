/**
 * SwitchBot API v1.1 クライアント（cloud 経由）。
 * 一次情報: https://github.com/OpenWonderLabs/SwitchBotAPI
 */
import { createHmac, randomUUID } from "node:crypto";

export interface SwitchBotCredentials {
  token: string;
  secret: string;
}

export interface SwitchBotClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_BASE_URL = "https://api.switch-bot.com/v1.1";

/**
 * v1.1 の認証ヘッダを組み立てる。
 * sign = base64(HMAC-SHA256(secret, token + t + nonce)) を大文字化したもの。
 */
export function buildAuthHeaders(
  credentials: SwitchBotCredentials,
  at: number = Date.now(),
  nonce: string = randomUUID(),
): Record<string, string> {
  const t = String(at);
  const sign = createHmac("sha256", credentials.secret)
    .update(credentials.token + t + nonce)
    .digest("base64")
    .toUpperCase();
  return { Authorization: credentials.token, sign, t, nonce };
}

interface Envelope {
  statusCode: number;
  message: string;
  body: unknown;
}

export interface SwitchBotDevice {
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  hubDeviceId?: string;
  [extra: string]: unknown;
}

export interface DeviceListBody {
  deviceList?: SwitchBotDevice[];
  infraredRemoteList?: SwitchBotDevice[];
}

export class SwitchBotClient {
  private readonly credentials: SwitchBotCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(credentials: SwitchBotCredentials, options: SwitchBotClientOptions = {}) {
    this.credentials = credentials;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 物理デバイス（deviceList）と赤外線リモコン（infraredRemoteList）の一覧 */
  listDevices(): Promise<unknown> {
    return this.request("GET", "/devices");
  }

  /** 物理デバイスの現在状態（温度・湿度・電源など）。IR リモコンには無い */
  getDeviceStatus(deviceId: string): Promise<unknown> {
    return this.request("GET", `/devices/${encodeURIComponent(deviceId)}/status`);
  }

  /** デバイスへコマンド送信（物理世界に作用する） */
  sendCommand(
    deviceId: string,
    command: string,
    parameter: unknown = "default",
    commandType: string = "command",
  ): Promise<unknown> {
    return this.request("POST", `/devices/${encodeURIComponent(deviceId)}/commands`, {
      command,
      parameter,
      commandType,
    });
  }

  listScenes(): Promise<unknown> {
    return this.request("GET", "/scenes");
  }

  executeScene(sceneId: string): Promise<unknown> {
    return this.request("POST", `/scenes/${encodeURIComponent(sceneId)}/execute`);
  }

  /** イベント Webhook の宛先 URL を登録する */
  setupWebhook(url: string): Promise<unknown> {
    return this.request("POST", "/webhook/setupWebhook", {
      action: "setupWebhook",
      url,
      deviceList: "ALL",
    });
  }

  /** 登録済み Webhook URL を照会する */
  queryWebhook(): Promise<unknown> {
    return this.request("POST", "/webhook/queryWebhook", { action: "queryUrl" });
  }

  /** Webhook 登録を削除する */
  deleteWebhook(url: string): Promise<unknown> {
    return this.request("POST", "/webhook/deleteWebhook", { action: "deleteWebhook", url });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      ...buildAuthHeaders(this.credentials),
      "Content-Type": "application/json; charset=utf8",
    };
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`SwitchBot API returned HTTP ${response.status} for ${method} ${path}`);
    }
    const envelope = (await response.json()) as Envelope;
    if (envelope.statusCode !== 100) {
      throw new Error(`SwitchBot API error ${envelope.statusCode}: ${envelope.message}`);
    }
    return envelope.body;
  }
}
