/**
 * コンパイル時 LLM のプロバイダ抽象。
 *
 * kotodama 本体（compile.ts）はプロバイダの中身を知らない。
 * どちらも SDK なし・素の fetch で叩く（依存ゼロ維持）。
 * LLM が呼ばれるのはコンパイル時だけ、という原則はプロバイダによらず不変。
 */

export interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  /** 表示・記録用。例: "gemini:gemini-2.5-flash" */
  readonly label: string;
  complete(system: string, messages: ApiMessage[]): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export interface ProviderOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

async function httpErrorDetail(response: { text(): Promise<string> }): Promise<string> {
  const detail = await response.text().catch(() => "");
  return detail ? `: ${detail.slice(0, 300)}` : "";
}

export class AnthropicProvider implements LlmProvider {
  readonly label: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.label = `anthropic:${this.model}`;
  }

  async complete(system: string, messages: ApiMessage[]): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        temperature: 0,
        system,
        messages,
      }),
    });
    if (!response.ok) {
      throw new Error(`Claude API returned HTTP ${response.status}${await httpErrorDetail(response)}`);
    }
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    if (!Array.isArray(data.content)) throw new Error("Claude API のレスポンスに content がありません");
    return data.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
}

export class GeminiProvider implements LlmProvider {
  readonly label: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.label = `gemini:${this.model}`;
  }

  async complete(system: string, messages: ApiMessage[]): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
          generationConfig: {
            temperature: 0,
            // gemini-2.5 系は思考トークンも出力枠を食うので余裕を持たせる
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini API returned HTTP ${response.status}${await httpErrorDetail(response)}`);
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "unknown";
      throw new Error(`Gemini API がテキストを返しませんでした (reason: ${reason})`);
    }
    return parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
}

/**
 * 環境変数からプロバイダを選ぶ。
 * - TSUKUMO_COMPILE_PROVIDER=anthropic|gemini で明示指定
 * - 未指定なら ANTHROPIC_API_KEY → GEMINI_API_KEY（/ GOOGLE_API_KEY）の順で自動選択
 * - TSUKUMO_COMPILE_MODEL でモデル上書き
 */
export function createProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): LlmProvider {
  const preference = env.TSUKUMO_COMPILE_PROVIDER;
  const model = env.TSUKUMO_COMPILE_MODEL;
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;

  const wantsAnthropic = preference === "anthropic" || preference === "claude";
  const wantsGemini = preference === "gemini" || preference === "google";
  if (preference !== undefined && !wantsAnthropic && !wantsGemini) {
    throw new Error(`TSUKUMO_COMPILE_PROVIDER が不明です: "${preference}"（anthropic か gemini を指定）`);
  }
  if (wantsAnthropic) {
    if (!anthropicKey) throw new Error("TSUKUMO_COMPILE_PROVIDER=anthropic ですが ANTHROPIC_API_KEY がありません");
    return new AnthropicProvider({ apiKey: anthropicKey, model, fetchImpl });
  }
  if (wantsGemini) {
    if (!geminiKey) throw new Error("TSUKUMO_COMPILE_PROVIDER=gemini ですが GEMINI_API_KEY / GOOGLE_API_KEY がありません");
    return new GeminiProvider({ apiKey: geminiKey, model, fetchImpl });
  }
  if (anthropicKey) return new AnthropicProvider({ apiKey: anthropicKey, model, fetchImpl });
  if (geminiKey) return new GeminiProvider({ apiKey: geminiKey, model, fetchImpl });
  throw new Error(
    "コンパイル時 LLM の API キーがありません。ANTHROPIC_API_KEY か GEMINI_API_KEY（または GOOGLE_API_KEY）を設定してください。",
  );
}
