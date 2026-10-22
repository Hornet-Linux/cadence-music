import { create } from "zustand";
import { setSpeechEngine } from "@/features/dj/hooks";
import type { PluginStorage } from "../../types";
import { createNeuralEngine, DEFAULT_TTS, isConfigured, parseTtsConfig, type TtsConfig } from "./speech";

const CONFIG_KEY = "config";
const SECRET = "tts.key";

export type LastResult = { ok: true; at: number } | { ok: false; at: number; message: string } | null;

interface TtsState {
  config: TtsConfig;
  hasKey: boolean;
  last: LastResult;
  setConfig: (patch: Partial<TtsConfig>) => void;
  setKey: (key: string | null) => Promise<void>;
  report: (r: { ok: true } | { ok: false; message: string }) => void;
}

let storage: PluginStorage | null = null;
let netFetch: typeof fetch | undefined;

async function readKey(): Promise<string | undefined> {
  try {
    return (await window.host?.secrets?.get(SECRET)) ?? undefined;
  } catch {
    return undefined;
  }
}

export const useTts = create<TtsState>((set, get) => ({
  config: DEFAULT_TTS,
  hasKey: false,
  last: null,

  setConfig(patch) {
    // Keep exactly what is being typed (text is trimmed when it is used, not while editing).
    const speed = patch.speed === undefined ? get().config.speed : Math.min(4, Math.max(0.25, patch.speed));
    set({ config: { ...get().config, ...patch, speed } });
    try {
      storage?.set(CONFIG_KEY, get().config);
    } catch {
      // Storage is optional.
    }
  },

  async setKey(key) {
    const secrets = window.host?.secrets;
    if (!secrets) return;
    try {
      if (key) await secrets.set(SECRET, key);
      else await secrets.delete(SECRET);
      set({ hasKey: !!key });
    } catch (e) {
      console.warn("Could not save the speech API key", e);
    }
  },

  report: (r) => set({ last: r.ok ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), message: r.message } }),
}));

/** Turn the neural voice on: load the saved settings and offer the voice to the DJ. */
export async function activateTts(pluginStorage: PluginStorage, fetchImpl: typeof fetch): Promise<void> {
  storage = pluginStorage;
  netFetch = fetchImpl;
  let saved: unknown = null;
  try {
    saved = pluginStorage.get(CONFIG_KEY);
  } catch {
    saved = null;
  }
  useTts.setState({ config: parseTtsConfig(saved ?? DEFAULT_TTS), hasKey: !!(await readKey()) });
  setSpeechEngine(
    createNeuralEngine({
      config: () => useTts.getState().config,
      apiKey: readKey,
      fetchImpl: (...args) => (netFetch ?? fetch)(...args),
      report: (r) => useTts.getState().report(r),
    }),
  );
}

/** Back to system voices. */
export function deactivateTts(): void {
  storage = null;
  netFetch = undefined;
  setSpeechEngine(null);
}

export { isConfigured };
