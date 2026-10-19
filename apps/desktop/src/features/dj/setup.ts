import type { LlmConfig, LlmStatus } from "../../../electron/llm";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

export type DjSetup =
  | { kind: "ready" }
  | { kind: "no-ollama"; detail?: string }
  | { kind: "no-model"; command: string; installed: string[] };

/** Ollama tags drop ":latest", so "llama3.1" and "llama3.1:latest" are the same model. */
function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return norm(a) === norm(b);
}

/** What the user still has to do before the DJ can run. */
export function djSetup(config: LlmConfig, status: LlmStatus): DjSetup {
  if (!status.available) return { kind: "no-ollama", detail: status.error };
  if (!status.models.some((m) => sameModel(m, config.model))) {
    return { kind: "no-model", command: `ollama pull ${config.model}`, installed: status.models };
  }
  return { kind: "ready" };
}

export function setupMessage(setup: DjSetup): string | null {
  switch (setup.kind) {
    case "ready":
      return null;
    case "no-ollama":
      return "The DJ needs Ollama running on this computer. Install it from ollama.com, then try again.";
    case "no-model":
      return `The DJ's model isn't downloaded yet. Run: ${setup.command}`;
  }
}
