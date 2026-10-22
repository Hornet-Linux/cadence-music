import { CHAT_TIMEOUT_MS, describeFetchError, endpoint, errorText, extractJson, STATUS_TIMEOUT_MS } from "./http.js";
import { LlmError, type FetchFn, type LlmJsonRequest, type LlmProvider, type LlmStatus, type ProviderConfig } from "./types.js";

/** Models that "think" for minutes unless told not to; the others reject the field. */
const REASONING_MODEL = /qwen3|deepseek-r1|gpt-oss|magistral/i;

/** Ollama's native API (/api/chat) with JSON-schema structured output. */
export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: FetchFn = (...args) => fetch(...args),
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  async status(): Promise<LlmStatus> {
    try {
      const res = await this.fetchImpl(endpoint(this.config.baseUrl, "api/tags"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!res.ok) return { available: false, models: [], error: `Ollama returned ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      return { available: true, models: (body.models ?? []).map((m) => m.name) };
    } catch (e) {
      return { available: false, models: [], error: describeFetchError(e) };
    }
  }

  async chatJson<T = unknown>(req: LlmJsonRequest): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint(this.config.baseUrl, "api/chat"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.config.model,
          messages: req.messages,
          format: req.schema,
          stream: false,
          ...(REASONING_MODEL.test(this.config.model) ? { think: false } : {}),
          options: { temperature: req.temperature ?? 0.8 },
        }),
      });
    } catch (e) {
      throw new LlmError(`Couldn't reach Ollama: ${describeFetchError(e)}`);
    }
    if (!res.ok) {
      const text = await errorText(res);
      if (res.status === 404 && /model/i.test(text)) {
        throw new LlmError(`Model "${this.config.model}" isn't installed. Run: ollama pull ${this.config.model}`, 404);
      }
      throw new LlmError(`Ollama returned ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new LlmError("Ollama returned an empty reply");
    return extractJson<T>(content);
  }
}
