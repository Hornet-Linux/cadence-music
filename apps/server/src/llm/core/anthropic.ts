import { CHAT_TIMEOUT_MS, describeFetchError, endpoint, errorText, STATUS_TIMEOUT_MS } from "./http.js";
import { LlmError, type FetchFn, type LlmJsonRequest, type LlmProvider, type LlmStatus, type ProviderConfig } from "./types.js";

interface MessagesBody {
  content?: { type: string; input?: unknown }[];
}

/** Anthropic's Messages API. Structured output is a forced tool call. */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: FetchFn = (...args) => fetch(...args),
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      // Needed when an app calls the API straight from a page; ignored elsewhere.
      "anthropic-dangerous-direct-browser-access": "true",
      ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
    };
  }

  async status(): Promise<LlmStatus> {
    try {
      const res = await this.fetchImpl(endpoint(this.config.baseUrl, "v1/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return { available: false, models: [], error: "Anthropic rejected the API key" };
      }
      if (!res.ok) return { available: false, models: [], error: `Anthropic returned ${res.status}` };
      const body = (await res.json()) as { data?: { id: string }[] };
      return { available: true, models: (body.data ?? []).map((m) => m.id) };
    } catch (e) {
      return { available: false, models: [], error: describeFetchError(e) };
    }
  }

  async chatJson<T = unknown>(req: LlmJsonRequest): Promise<T> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages.filter((m) => m.role !== "system");
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint(this.config.baseUrl, "v1/messages"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 4096,
          temperature: Math.min(1, req.temperature ?? 0.8),
          ...(system ? { system } : {}),
          messages,
          tools: [{ name: "reply", description: "Send your reply.", input_schema: req.schema }],
          tool_choice: { type: "tool", name: "reply" },
        }),
      });
    } catch (e) {
      throw new LlmError(`Couldn't reach Anthropic: ${describeFetchError(e)}`);
    }
    if (!res.ok) {
      const text = await errorText(res);
      if (res.status === 401 || res.status === 403) throw new LlmError("Anthropic rejected the API key", res.status);
      throw new LlmError(`Anthropic returned ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    const body = (await res.json()) as MessagesBody;
    const block = body.content?.find((c) => c.type === "tool_use");
    if (!block || typeof block.input !== "object" || block.input === null) {
      throw new LlmError("The model returned an empty reply");
    }
    return block.input as T;
  }
}
