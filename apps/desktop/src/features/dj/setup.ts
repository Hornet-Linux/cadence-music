import type { LlmStatus, ProviderKind } from "../../../electron/llm";

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

export type DjSetup =
  | { kind: "ready" }
  /** Ollama on this device isn't reachable. */
  | { kind: "no-ollama"; detail?: string }
  /** Any other provider isn't reachable, or rejected the key. */
  | { kind: "unreachable"; detail?: string; onServer?: boolean }
  /** `onServer`: the server's own provider, which only the server owner can fix (or is still downloading it). */
  | { kind: "no-model"; model: string; command?: string; installed: string[]; onServer?: boolean };

/** Ollama tags drop ":latest", so "llama3.1" and "llama3.1:latest" are the same model. */
function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return norm(a) === norm(b);
}

/** What the user still has to do before the DJ can run. */
export function djSetup(
  config: { kind: ProviderKind | "native"; model: string; scope?: "local" | "server" | "device" | "native" },
  status: LlmStatus,
): DjSetup {
  // Only an Ollama on this device is the listener's to install; the server's
  // own one (or another computer's) is not.
  const here = config.scope === undefined || config.scope === "local";
  const onServer = config.scope === "server";
  if (!status.available) {
    return config.kind === "ollama" && here
      ? { kind: "no-ollama", detail: status.error }
      : { kind: "unreachable", detail: status.error, ...(onServer ? { onServer } : {}) };
  }
  // A server that doesn't list its models can't tell us the model is missing.
  if (status.models.length && !status.models.some((m) => sameModel(m, config.model))) {
    return {
      kind: "no-model",
      model: config.model,
      command: config.kind === "ollama" && here ? `ollama pull ${config.model}` : undefined,
      installed: status.models,
      ...(onServer ? { onServer } : {}),
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
      if (setup.onServer) return `The server's AI provider can't be reached${setup.detail ? ` (${setup.detail})` : ""}. Ask the server owner to check it.`;
      return `The AI provider can't be reached${setup.detail ? ` (${setup.detail})` : ""}. Check it in Settings → AI DJ.`;
    case "no-model":
      if (setup.onServer) {
        return `The server doesn't have the DJ's model (${setup.model}) yet. If the AI DJ was just set up it is still downloading: try again in a few minutes.`;
      }
      return setup.command
        ? `The DJ's model isn't downloaded yet. Run: ${setup.command}`
        : `The provider doesn't have the model "${setup.model}". Pick another in Settings → AI DJ.`;
  }
}
