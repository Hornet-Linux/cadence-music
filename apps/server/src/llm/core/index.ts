import { AnthropicProvider } from "./anthropic.js";
import { endpoint } from "./http.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiCompatibleProvider } from "./openai.js";
import { LlmError, type FetchFn, type LlmProvider, type ProviderConfig, type ProviderKind } from "./types.js";

export * from "./types.js";
export * from "./dj.js";
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
