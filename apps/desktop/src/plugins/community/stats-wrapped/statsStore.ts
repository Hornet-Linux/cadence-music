import { create } from "zustand";
import type { Play } from "@uma/shared";
import { useHistory } from "@/features/history/historyStore";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { fetchServerHistory } from "../_social/historyPaging";

const FRESH_MS = 5 * 60_000;

interface StatsData {
  plays: Play[];
  /** Where the plays came from: the server (all devices) or just this device. */
  source: "server" | "device";
  truncated: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  loadedAt: number;
  load: (force?: boolean) => Promise<void>;
}

export const useStatsData = create<StatsData>((set, get) => ({
  plays: [],
  source: "device",
  truncated: false,
  status: "idle",
  error: null,
  loadedAt: 0,
  async load(force = false) {
    const { status, loadedAt } = get();
    if (status === "loading" || (!force && status === "ready" && Date.now() - loadedAt < FRESH_MS)) return;
    set({ status: "loading", error: null });
    try {
      if (useServer.getState().user) {
        const { plays, truncated } = await fetchServerHistory();
        set({ plays, truncated, source: "server", status: "ready", loadedAt: Date.now() });
      } else {
        set({ plays: useHistory.getState().plays, truncated: false, source: "device", status: "ready", loadedAt: Date.now() });
      }
    } catch (err) {
      // Fall back to what this device remembers so the page is never empty because of a network blip.
      set({
        plays: useHistory.getState().plays,
        source: "device",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        loadedAt: Date.now(),
      });
    }
  },
}));