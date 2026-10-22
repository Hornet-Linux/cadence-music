import { CHAT_TIMEOUT_MS, describeFetchError, endpoint, errorText, extractJson, STATUS_TIMEOUT_MS } from "./http.js";
import { readLines, withTimeout } from "./stream.js";
import {
  LlmError,
  type FetchFn,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmStatus,
  type LlmTextOptions,
  type LlmTextRequest,
  type ProviderConfig,
} from "./types.js";

/**
 * Models that "think" for minutes unless told not to; the others reject the
 * field. Most take `think: false`, but gpt-oss ignores it (it still reasons at
 * length) and only accepts a level, so give it "low".
 */
export function thinkOption(model: string): { think: boolean | "low" } | Record<string, never> {
  if (/gpt-oss/i.test(model)) return { think: "low" };
  if (/qwen3|deepseek-r1|magistral/i.test(model)) return { think: false };
  return {};
}

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
          ...thinkOption(this.config.model),
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

  /** Plain chat, streamed as it is written (newline-delimited JSON). */
  async chatText(req: LlmTextRequest, options: LlmTextOptions = {}): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint(this.config.baseUrl, "api/chat"), {
        method: "POST",
        headers: this.headers(),
        signal: withTimeout(CHAT_TIMEOUT_MS, options.signal),
        body: JSON.stringify({
          model: this.config.model,
          messages: req.messages,
          stream: true,
          ...thinkOption(this.config.model),
          options: { temperature: req.temperature ?? 0.7 },
        }),
      });
    } catch (e) {
      if (options.signal?.aborted) throw e;
      throw new LlmError(`Couldn't reach Ollama: ${describeFetchError(e)}`);
    }
    if (!res.ok) {
      const text = await errorText(res);
      if (res.status === 404 && /model/i.test(text)) {
        throw new LlmError(`Model "${this.config.model}" isn't installed. Run: ollama pull ${this.config.model}`, 404);
      }
      throw new LlmError(`Ollama returned ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    let text = "";
    for await (const line of readLines(res)) {
      if (!line.trim()) continue;
      let chunk: { message?: { content?: string }; error?: string };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new LlmError(`Ollama: ${chunk.error}`);
      const piece = chunk.message?.content;
      if (piece) {
        text += piece;
        options.onDelta?.(piece);
      }
    }
    if (!text.trim()) throw new LlmError("Ollama returned an empty reply");
    return text;
  }
}
