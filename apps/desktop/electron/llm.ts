// LLM access for the AI DJ. Plain fetch, no Node APIs, so the web build can
// use it directly while Electron runs it in the main process (no CORS, and
// future API keys stay out of the renderer).

export type LlmProviderId = "ollama";

export interface LlmConfig {
  provider: LlmProviderId;
  /** e.g. http://localhost:11434 */
  baseUrl: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmJsonRequest {
  messages: LlmMessage[];
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>;
  temperature?: number;
}

export interface LlmStatus {
  /** False when the provider can't be reached (e.g. Ollama isn't running). */
  available: boolean;
  models: string[];
  error?: string;
}

export interface LlmProvider {
  status(): Promise<LlmStatus>;
  /** Run a chat and return the reply parsed as JSON. */
  chatJson<T = unknown>(req: LlmJsonRequest): Promise<T>;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  // Small enough for CPU-only machines with 8 GB of RAM (about a 2 GB download).
  model: "llama3.2:3b",
};

const TIMEOUT_MS = 180_000;
const REASONING_MODEL = /qwen3|deepseek-r1|gpt-oss|magistral/i;

function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("LLM URL must be http(s)");
  return new URL(path, url.href.endsWith("/") ? url.href : url.href + "/").toString();
}

export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async status(): Promise<LlmStatus> {
    try {
      const res = await this.fetchImpl(endpoint(this.config.baseUrl, "api/tags"), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { available: false, models: [], error: `Ollama returned ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      return { available: true, models: (body.models ?? []).map((m) => m.name) };
    } catch (e) {
      return { available: false, models: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatJson<T = unknown>(req: LlmJsonRequest): Promise<T> {
    const res = await this.fetchImpl(endpoint(this.config.baseUrl, "api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.model,
        messages: req.messages,
        format: req.schema,
        stream: false,
        // Reasoning models spend minutes "thinking"; the DJ doesn't need it.
        // Only sent to models that support it, since others reject the field.
        ...(REASONING_MODEL.test(this.config.model) ? { think: false } : {}),
        options: { temperature: req.temperature ?? 0.8 },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404 && /model/i.test(text)) {
        throw new Error(`Model "${this.config.model}" isn't installed. Run: ollama pull ${this.config.model}`);
      }
      throw new Error(`Ollama returned ${res.status}${text ? `: ${text}` : ""}`);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error("Ollama returned an empty reply");
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error("The model's reply wasn't valid JSON");
    }
  }
}

export function createLlmProvider(config: LlmConfig, fetchImpl?: typeof fetch): LlmProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider(config, fetchImpl);
    default:
      throw new Error(`Unknown LLM provider: ${String(config.provider)}`);
  }
}

/** Validate a config that crossed IPC from the renderer. */
export function parseLlmConfig(value: unknown): LlmConfig {
  const v = value as Partial<LlmConfig> | null;
  if (!v || v.provider !== "ollama" || typeof v.baseUrl !== "string" || typeof v.model !== "string") {
    throw new Error("Invalid LLM config");
  }
  endpoint(v.baseUrl, ""); // throws on a bad URL
  return { provider: v.provider, baseUrl: v.baseUrl, model: v.model };
}
