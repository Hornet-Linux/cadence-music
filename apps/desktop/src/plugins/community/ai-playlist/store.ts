import { create } from "zustand";
import { askJson, requireProvider } from "@/features/dj/ask";
import { historyTaste } from "@/features/dj/historyTaste";
import { useHistory } from "@/features/history/historyStore";
import { compactProfile } from "@/features/dj/providers";
import { buildPlaylist, PLAYLIST_SCHEMA, type BuiltPlaylist } from "./playlist";

type Status = "idle" | "working" | "done" | "error";

interface BuilderState {
  prompt: string;
  count: number;
  useHistory: boolean;
  status: Status;
  /** What the builder is doing right now. */
  step: string;
  result: BuiltPlaylist | null;
  error: unknown;
  setPrompt: (prompt: string) => void;
  setCount: (count: number) => void;
  setUseHistory: (on: boolean) => void;
  build: () => Promise<void>;
  reset: () => void;
}

let run = 0;

export const usePlaylistBuilder = create<BuilderState>((set, get) => ({
  prompt: "",
  count: 15,
  useHistory: true,
  status: "idle",
  step: "",
  result: null,
  error: null,
  setPrompt: (prompt) => set({ prompt }),
  setCount: (count) => set({ count }),
  setUseHistory: (useHistory) => set({ useHistory }),
  reset: () => set({ status: "idle", result: null, error: null, step: "" }),

  async build() {
    const id = ++run;
    const { prompt, count, useHistory: withHistory } = get();
    set({ status: "working", step: "Asking the AI for songs…", error: null, result: null });
    try {
      const option = await requireProvider();
      const taste = withHistory && useHistory.getState().plays.length ? compactProfile(historyTaste()) : null;
      const result = await buildPlaylist(
        { prompt, count, taste },
        {
          ask: (messages) => askJson(option.ref, { messages, schema: PLAYLIST_SCHEMA as unknown as Record<string, unknown> }),
          onStep: (step) => {
            if (id === run) set({ step: step === "asking" ? "Asking the AI for songs…" : "Checking each song against your music…" });
          },
        },
      );
      if (id === run) set({ status: "done", result, step: "" });
    } catch (e) {
      if (id === run) set({ status: "error", error: e, step: "" });
    }
  },
}));
