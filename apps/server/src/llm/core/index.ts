import { AnthropicProvider } from "./anthropic.js";
import { endpoint } from "./http.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiCompatibleProvider } from "./openai.js";
import { LlmError, type FetchFn, type LlmJsonRequest, type LlmMessage, type LlmProvider, type ProviderConfig, type ProviderKind } from "./types.js";

export * from "./types.js";
export * from "./dj.js";
export { parseTextRequest, readLines, sseData } from "./stream.js";
export { PRESETS, presetById, type ProviderPreset } from "./presets.js";
export { extractJson } from "./http.js";

export const PROVIDER_KINDS: readonly ProviderKind[] = ["ollama", "openai-compatible", "anthropic"];

export function createProvider(config: ProviderConfig, fetchImpl?: FetchFn): LlmProvider {
  switch (config.kind) {
    case "ollama":
      return new OllamaProvider(config, fetchImpl);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(config, fetchImpl);
    case "anthropic":
      return new AnthropicProvider(config, fetchImpl);
    default:
      throw new LlmError(`Unknown LLM provider: ${String((config as { kind?: unknown }).kind)}`);
  }
}

const MAX_MESSAGES = 20;
const MAX_REQUEST_CHARS = 100_000;

/** Validate a chat request that crossed a trust boundary (IPC from a page, a relay job). */
export function parseJsonRequest(value: unknown): LlmJsonRequest {
  const v = value as Partial<LlmJsonRequest> | null;
  if (!v || !Array.isArray(v.messages) || v.messages.length === 0 || v.messages.length > MAX_MESSAGES) {
    throw new LlmError("Invalid LLM request");
  }
  let chars = 0;
  const messages = v.messages.map((m) => {
    const role = (m as Partial<LlmMessage> | null)?.role;
    const content = (m as Partial<LlmMessage> | null)?.content;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new LlmError("Invalid LLM request");
    }
    chars += content.length;
    return { role, content };
  });
  if (chars > MAX_REQUEST_CHARS) throw new LlmError("The request is too large");
  if (!v.schema || typeof v.schema !== "object" || Array.isArray(v.schema)) throw new LlmError("Invalid LLM request");
  const temperature = typeof v.temperature === "number" && Number.isFinite(v.temperature) ? Math.min(2, Math.max(0, v.temperature)) : undefined;
  return { messages, schema: v.schema, ...(temperature !== undefined ? { temperature } : {}) };
}

/** Validate a config that crossed a trust boundary (IPC, HTTP body, storage). */
export function parseProviderConfig(value: unknown): ProviderConfig {
  const v = value as Partial<ProviderConfig> | null;
  if (
    !v ||
    !PROVIDER_KINDS.includes(v.kind as ProviderKind) ||
    typeof v.baseUrl !== "string" ||
    typeof v.model !== "string" ||
    (v.apiKey !== undefined && typeof v.apiKey !== "string")
  ) {
    throw new LlmError("Invalid LLM provider");
  }
  endpoint(v.baseUrl, ""); // throws on a bad URL
  return {
    kind: v.kind as ProviderKind,
    baseUrl: v.baseUrl.trim(),
    model: v.model.trim(),
    ...(v.apiKey ? { apiKey: v.apiKey } : {}),
  };
}
