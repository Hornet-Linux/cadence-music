import { create } from "zustand";
import type { Track } from "@/shared/types";
import { serverApi } from "../_social/serverApi";
import { nextVote, withVote, type SharedDetail, type SharedSummary } from "./model";

const FRIENDLY: Record<string, string> = {
  already_added: "That song is already in the playlist.",
  invalid_code: "That code doesn't match a playlist.",
  user_not_found: "No one on this server has that username.",
  playlist_full: "This playlist is full.",
  too_many_playlists: "You have reached the playlist limit.",
  too_many_attempts: "Too many tries. Wait a few minutes.",
  forbidden: "Only the owner can do that.",
  not_found: "That playlist isn't available any more.",
  owner_cannot_leave: "The owner can't leave. Delete the playlist instead.",
};

function message(err: unknown): string {
  const code = (err as { code?: string }).code;
  return (code && FRIENDLY[code]) || (err instanceof Error ? err.message : String(err));
}

interface State {
  list: SharedSummary[] | null;
  detail: SharedDetail | null;
  busy: boolean;
  error: string | null;

  loadList: () => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
  refresh: () => Promise<void>;
  create: (name: string, tracks?: Track[]) => Promise<void>;
  join: (code: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  remove: () => Promise<void>;
  leave: () => Promise<void>;
  invite: (username: string) => Promise<void>;
  newCode: () => Promise<void>;
  removeMember: (userId: number) => Promise<void>;
  addTrack: (track: Track) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  vote: (itemId: string, pressed: -1 | 1) => Promise<void>;
  clearError: () => void;
}

const base = "api/shared-playlists";
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const useSharedPlaylists = create<State>((set, get) => {
  /** Run an action that returns the new playlist detail. */
  async function act(run: () => Promise<SharedDetail | void>, after?: () => Promise<void>) {
    set({ busy: true, error: null });
    try {
      const detail = await run();
      if (detail) set({ detail });
      if (after) await after();
    } catch (err) {
      set({ error: message(err) });
    } finally {
      set({ busy: false });
    }
  }
  const reloadList = async () => {
    try {
      set({ list: (await serverApi<{ items: SharedSummary[] }>(base)).items });
    } catch (err) {
      set({ error: message(err), list: get().list ?? [] });
    }
  };
  const id = () => get().detail?.id ?? "";

  return {
    list: null,
    detail: null,
    busy: false,
    error: null,

    loadList: reloadList,

    async open(playlistId) {
      await act(async () => serverApi<SharedDetail>(`${base}/${playlistId}`));
    },
    close() {
      set({ detail: null, error: null });
      void reloadList();
    },
    async refresh() {
      const d = get().detail;
      if (!d || get().busy) return;
      try {
        const next = await serverApi<SharedDetail | { unchanged: true }>(`${base}/${d.id}?since=${d.updatedAt}`);
        if (!("unchanged" in next) && get().detail?.id === d.id && !get().busy) set({ detail: next });
      } catch (err) {
        if ((err as { status?: number }).status === 404) set({ detail: null, error: FRIENDLY.not_found });
      }
    },
    create: (name, tracks) => act(() => serverApi<SharedDetail>(base, json({ name, tracks }))),
    join: (code) => act(() => serverApi<SharedDetail>(`${base}/join`, json({ code }))),
    rename: (name) => act(() => serverApi<SharedDetail>(`${base}/${id()}`, { method: "PATCH", body: JSON.stringify({ name }) })),
    remove: () =>
      act(
        async () => {
          await serverApi(`${base}/${id()}`, { method: "DELETE" });
          set({ detail: null });
        },
        reloadList,
      ),
    leave: () =>
      act(
        async () => {
          await serverApi(`${base}/${id()}/members/me`, { method: "DELETE" });
          set({ detail: null });
        },
        reloadList,
      ),
    invite: (username) => act(() => serverApi<SharedDetail>(`${base}/${id()}/members`, json({ username }))),
    newCode: () =>
      act(async () => {
        const { joinCode } = await serverApi<{ joinCode: string }>(`${base}/${id()}/code`, { method: "POST" });
        const d = get().detail;
        if (d) set({ detail: { ...d, joinCode } });
      }),
    removeMember: (userId) =>
      act(async () => {
        await serverApi(`${base}/${id()}/members/${userId}`, { method: "DELETE" });
        return serverApi<SharedDetail>(`${base}/${id()}`);
      }),
    addTrack: (track) => act(() => serverApi<SharedDetail>(`${base}/${id()}/items`, json({ track }))),
    removeItem: (itemId) =>
      act(async () => {
        await serverApi(`${base}/${id()}/items/${itemId}`, { method: "DELETE" });
        return serverApi<SharedDetail>(`${base}/${id()}`);
      }),
    async vote(itemId, pressed) {
      const d = get().detail;
      const item = d?.items.find((i) => i.id === itemId);
      if (!d || !item) return;
      const value = nextVote(item.myVote, pressed);
      set({ detail: withVote(d, itemId, value), error: null }); // optimistic
      try {
        const fresh = await serverApi<SharedDetail>(`${base}/${d.id}/items/${itemId}/vote`, { method: "PUT", body: JSON.stringify({ value }) });
        set({ detail: fresh });
      } catch (err) {
        set({ detail: d, error: message(err) });
      }
    },
    clearError: () => set({ error: null }),
  };
});