import type { ProviderKind } from "./types.js";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Needs an API key (local servers usually don't). */
  needsKey: boolean;
  /** Runs on the same machine as the app, so only that machine can reach it. */
  local: boolean;
  /** A sensible starting model, when there is a stable one. */
  defaultModel?: string;
}

/** One-click starting points. Any other OpenAI-style server works as "custom". */
export const PRESETS: readonly ProviderPreset[] = [
  { id: "ollama", name: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434", needsKey: false, local: true, defaultModel: "llama3.2:3b" },
  { id: "lmstudio", name: "LM Studio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", needsKey: false, local: true },
  { id: "llamacpp", name: "llama.cpp server", kind: "openai-compatible", baseUrl: "http://localhost:8080/v1", needsKey: false, local: true },
  { id: "jan", name: "Jan", kind: "openai-compatible", baseUrl: "http://localhost:1337/v1", needsKey: false, local: true },
  { id: "vllm", name: "vLLM", kind: "openai-compatible", baseUrl: "http://localhost:8000/v1", needsKey: false, local: true },
  { id: "openai", name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsKey: true, local: false, defaultModel: "gpt-4o-mini" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", needsKey: true, local: false, defaultModel: "claude-haiku-4-5" },
  { id: "gemini", name: "Google Gemini", kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, local: false, defaultModel: "gemini-2.0-flash" },
  { id: "openrouter", name: "OpenRouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, local: false },
  { id: "groq", name: "Groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, local: false },
  { id: "together", name: "Together AI", kind: "openai-compatible", baseUrl: "https://api.together.xyz/v1", needsKey: true, local: false },
  { id: "mistral", name: "Mistral", kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", needsKey: true, local: false },
  { id: "deepseek", name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", needsKey: true, local: false },
  { id: "xai", name: "xAI", kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", needsKey: true, local: false },
  { id: "custom", name: "Other (OpenAI-compatible)", kind: "openai-compatible", baseUrl: "", needsKey: false, local: false },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
