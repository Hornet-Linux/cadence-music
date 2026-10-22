// LLM access on this device. The adapters live in the server's dependency-free
// core (apps/server/src/llm/core) so the server and the apps speak to
// providers the same way. Electron runs them in the main process (no CORS, and
// keys typed on this device stay out of the page); the web build calls them
// from the page.
import { createProvider, parseProviderConfig, type ProviderConfig } from "../../server/src/llm/core/index";

export * from "../../server/src/llm/core/index";

export type LlmConfig = ProviderConfig;

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  // Small enough for CPU-only machines with 8 GB of RAM (about a 2 GB download).
  model: "llama3.2:3b",
};

export const createLlmProvider = createProvider;

/** Validate a config that crossed IPC from the renderer. */
export const parseLlmConfig = parseProviderConfig;
