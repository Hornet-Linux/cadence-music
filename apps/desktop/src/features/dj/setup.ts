import type { LlmStatus, ProviderKind } from "../../../electron/llm";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

export type DjSetup =
  | { kind: "ready" }
  /** Ollama isn't reachable. */
  | { kind: "no-ollama"; detail?: string }
  /** Any other provider isn't reachable, or rejected the key. */
  | { kind: "unreachable"; detail?: string }
  | { kind: "no-model"; model: string; command?: string; installed: string[] };

/** Ollama tags drop ":latest", so "llama3.1" and "llama3.1:latest" are the same model. */
function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return norm(a) === norm(b);
}

/** What the user still has to do before the DJ can run. */
export function djSetup(config: { kind: ProviderKind | "native"; model: string }, status: LlmStatus): DjSetup {
  if (!status.available) {
    return config.kind === "ollama" ? { kind: "no-ollama", detail: status.error } : { kind: "unreachable", detail: status.error };
  }
  // A server that doesn't list its models can't tell us the model is missing.
  if (status.models.length && !status.models.some((m) => sameModel(m, config.model))) {
    return {
      kind: "no-model",
      model: config.model,
      command: config.kind === "ollama" ? `ollama pull ${config.model}` : undefined,
      installed: status.models,
    };
  }
  return { kind: "ready" };
}

export function setupMessage(setup: DjSetup): string | null {
  switch (setup.kind) {
    case "ready":
      return null;
    case "no-ollama":
      return "The DJ needs Ollama running on this computer. Install it from ollama.com, then try again.";
    case "unreachable":
      return `The AI provider can't be reached${setup.detail ? ` (${setup.detail})` : ""}. Check it in Settings → AI DJ.`;
    case "no-model":
      return setup.command
        ? `The DJ's model isn't downloaded yet. Run: ${setup.command}`
        : `The provider doesn't have the model "${setup.model}". Pick another in Settings → AI DJ.`;
  }
}
