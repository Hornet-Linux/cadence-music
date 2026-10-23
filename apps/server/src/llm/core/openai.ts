import { CHAT_TIMEOUT_MS, describeFetchError, endpoint, errorText, extractJson, STATUS_TIMEOUT_MS } from "./http.js";
import { isJsonReply, sseData, withTimeout } from "./stream.js";
import {
  LlmError,
  type FetchFn,
  type LlmJsonRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmStatus,
  type LlmTextOptions,
  type LlmTextRequest,
  type ProviderConfig,
} from "./types.js";

/** OpenAI's reasoning models reject a custom temperature. */
const FIXED_TEMPERATURE = /^(o\d|gpt-5)/i;

type Mode = "json_schema" | "json_object" | "plain";
const MODES: Mode[] = ["json_schema", "json_object", "plain"];

interface ChatBody {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
}

/**
 * The OpenAI chat-completions protocol, spoken by OpenAI, LM Studio,
 * llama.cpp, vLLM, Jan, LocalAI, OpenRouter, Groq, Together, Mistral,
 * DeepSeek, Gemini's compatibility endpoint and many more. Servers differ in
 * how much structured output they support, so we try the strictest mode first
 * and step down when the server says it doesn't understand it.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  /** Remembered per instance so later calls skip modes this server rejected. */
  private mode: Mode = "json_schema";

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
      const res = await this.fetchImpl(endpoint(this.config.baseUrl, "models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return { available: false, models: [], error: "The server rejected the API key" };
      }
      if (!res.ok) return { available: false, models: [], error: `Server returned ${res.status}` };
      const body = (await res.json()) as { data?: { id: string }[] };
      return { available: true, models: (body.data ?? []).map((m) => m.id).sort() };
    } catch (e) {
      return { available: false, models: [], error: describeFetchError(e) };
    }
  }

  private messagesFor(mode: Mode, req: LlmJsonRequest): LlmMessage[] {
    if (mode === "json_schema") return req.messages;
    // Without enforced schemas, spell the shape out so the model follows it.
    const hint = `Reply with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(req.schema)}`;
    const [first, ...rest] = req.messages;
    if (first?.role === "system") return [{ role: "system", content: `${first.content}\n\n${hint}` }, ...rest];
    return [{ role: "system", content: hint }, ...req.messages];
  }

  private async attempt(mode: Mode, req: LlmJsonRequest): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.messagesFor(mode, req),
      stream: false,
    };
    if (!FIXED_TEMPERATURE.test(this.config.model)) body.temperature = req.temperature ?? 0.8;
    if (mode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: "reply", schema: req.schema } };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    try {
      return await this.fetchImpl(endpoint(this.config.baseUrl, "chat/completions"), {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LlmError(`Couldn't reach the LLM server: ${describeFetchError(e)}`);
    }
  }

  async chatJson<T = unknown>(req: LlmJsonRequest): Promise<T> {
    for (let i = MODES.indexOf(this.mode); i < MODES.length; i++) {
      const mode = MODES[i];
      const res = await this.attempt(mode, req);
      if (res.ok) {
        this.mode = mode;
        const body = (await res.json()) as ChatBody;
        const message = body.choices?.[0]?.message;
        if (message?.refusal) throw new LlmError(`The model refused: ${message.refusal}`);
        if (!message?.content) throw new LlmError("The model returned an empty reply");
        return extractJson<T>(message.content);
      }
      const text = await errorText(res);
      if (res.status === 401 || res.status === 403) throw new LlmError("The server rejected the API key", res.status);
      if (res.status === 404 && /model/i.test(text)) {
        throw new LlmError(`Model "${this.config.model}" wasn't found on that server`, 404);
      }
      // 400/422 mean "I don't understand response_format": step down a mode.
      const unsupported = res.status === 400 || res.status === 422 || res.status === 501;
      if (!unsupported || i === MODES.length - 1) {
        throw new LlmError(`The LLM server returned ${res.status}${text ? `: ${text}` : ""}`, res.status);
      }
    }
    throw new LlmError("The LLM server doesn't support JSON replies");
  }

  /** Plain chat. Streams when the server supports it; otherwise the whole reply arrives at once. */
  async chatText(req: LlmTextRequest, options: LlmTextOptions = {}): Promise<string> {
    const body: Record<string, unknown> = { model: this.config.model, messages: req.messages, stream: true };
    if (!FIXED_TEMPERATURE.test(this.config.model)) body.temperature = req.temperature ?? 0.7;
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint(this.config.baseUrl, "chat/completions"), {
        method: "POST",
        headers: this.headers(),
        signal: withTimeout(CHAT_TIMEOUT_MS, options.signal),
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (options.signal?.aborted) throw e;
      throw new LlmError(`Couldn't reach the LLM server: ${describeFetchError(e)}`);
    }
    if (!res.ok) {
      const text = await errorText(res);
      if (res.status === 401 || res.status === 403) throw new LlmError("The server rejected the API key", res.status);
      if (res.status === 404 && /model/i.test(text)) {
        throw new LlmError(`Model "${this.config.model}" wasn't found on that server`, 404);
      }
      throw new LlmError(`The LLM server returned ${res.status}${text ? `: ${text}` : ""}`, res.status);
    }
    if (isJsonReply(res)) {
      const reply = (await res.json()) as ChatBody;
      const message = reply.choices?.[0]?.message;
      if (message?.refusal) throw new LlmError(`The model refused: ${message.refusal}`);
      if (!message?.content) throw new LlmError("The model returned an empty reply");
      options.onDelta?.(message.content);
      return message.content;
    }
    let text = "";
    for await (const data of sseData(res)) {
      if (data === "[DONE]") break;
      let chunk: { choices?: { delta?: { content?: string | null; refusal?: string | null } }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // partial or non-JSON lines
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.refusal) throw new LlmError(`The model refused: ${delta.refusal}`);
      if (delta?.content) {
        text += delta.content;
        options.onDelta?.(delta.content);
      }
    }
    if (!text.trim()) throw new LlmError("The model returned an empty reply");
    return text;
  }
}
