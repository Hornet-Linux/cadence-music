import { create } from "zustand";
import type { Play } from "@uma/shared";
import { askText, requireProvider } from "@/features/dj/ask";
import { useHistory } from "@/features/history/historyStore";
import type { LlmMessage } from "../../../../electron/llm";
import type { PluginStorage } from "../../types";
import { MIN_PLAYS, buildAggregates, buildTasteMessages, cleanSummary } from "./taste";

const KEY = "summary";

export interface SavedSummary {
  text: string;
  at: number;
  plays: number;
}

export interface TasteDeps {
  plays: () => Play[];
  provider: () => Promise<{ ref: string }>;
  ask: (ref: string, messages: LlmMessage[]) => Promise<string>;
  now: () => number;
}

interface TasteState {
  status: "idle" | "working";
  summary: SavedSummary | null;
  error: unknown;
  /** Write (or rewrite) the summary. Only runs when the listener presses the button. */
  generate: () => Promise<void>;
  /** Make the saved text available (called when the plugin turns on). */
  load: (storage: PluginStorage | null) => void;
  clear: () => void;
}

export function createTasteStore(deps: TasteDeps) {
  let storage: PluginStorage | null = null;
  let run = 0;
  return create<TasteState>((set, get) => ({
    status: "idle",
    summary: null,
    error: null,

    load(next) {
      storage = next;
      let saved: unknown = null;
      try {
        saved = next?.get(KEY);
      } catch {
        saved = null;
      }
      const s = saved as Partial<SavedSummary> | null;
      set({
        summary:
          s && typeof s.text === "string" && s.text.length > 0 && typeof s.at === "number"
            ? { text: s.text.slice(0, 4000), at: s.at, plays: typeof s.plays === "number" ? s.plays : 0 }
            : null,
      });
    },

    async generate() {
      if (get().status === "working") return;
      const id = ++run;
      const plays = deps.plays();
      set({ status: "working", error: null });
      try {
        if (plays.length < MIN_PLAYS) {
          throw new Error(`Play a few more songs first: a summary needs at least ${MIN_PLAYS} plays and you have ${plays.length}.`);
        }
        const { ref } = await deps.provider();
        const reply = await deps.ask(ref, buildTasteMessages(buildAggregates(plays)));
        const summary = { text: cleanSummary(reply), at: deps.now(), plays: plays.length };
        if (id !== run) return;
        set({ summary });
        try {
          storage?.set(KEY, summary);
        } catch {
          // Storage is optional.
        }
      } catch (e) {
        if (id === run) set({ error: e });
      } finally {
        if (id === run) set({ status: "idle" });
      }
    },

    clear() {
      run++;
      set({ summary: null, error: null, status: "idle" });
      try {
        storage?.remove(KEY);
      } catch {
        // Storage is optional.
      }
    },
  }));
}

export const useTaste = createTasteStore({
  plays: () => useHistory.getState().plays,
  provider: requireProvider,
  ask: (ref, messages) => askText(ref, { messages, temperature: 0.7 }),
  now: () => Date.now(),
});
