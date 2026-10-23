import { create } from "zustand";
import { ApiError, useServer } from "../../builtins/server/serverStore";
import {
  cleanError,
  type AdminConfig,
  type ServiceId,
  type StatusResponse,
} from "./logic";

export interface Message {
  kind: "ok" | "error";
  text: string;
}

interface ScrobblersState {
  /** Null until the first check. */
  status: StatusResponse | null;
  /** "missing": the server is reachable but its Scrobblers plugin is not turned on. */
  support: "unknown" | "ok" | "missing";
  loading: boolean;
  /** A per-service action in flight, for disabling its buttons. */
  busy: Partial<Record<ServiceId, string>>;
  messages: Partial<Record<ServiceId, Message>>;
  /** Pages where the person approves Last.fm / Libre.fm, by service. */
  approvals: Partial<Record<ServiceId, string>>;
  error: string | null;
  admin: AdminConfig | null;

  refresh: () => Promise<void>;
  /** Last.fm / Libre.fm step 1. */
  startApproval: (id: ServiceId) => Promise<void>;
  /** Last.fm / Libre.fm step 2. */
  finishApproval: (id: ServiceId) => Promise<boolean>;
  connectListenBrainz: (token: string, host: string) => Promise<boolean>;
  connectMaloja: (url: string, apiKey: string) => Promise<boolean>;
  disconnect: (id: ServiceId) => Promise<void>;
  setEnabled: (id: ServiceId, enabled: boolean) => Promise<void>;
  test: (id: ServiceId) => Promise<void>;
  retryNow: (id: ServiceId) => Promise<void>;
  clearQueue: (id: ServiceId) => Promise<void>;
  loadAdmin: () => Promise<void>;
  saveAdmin: (patch: {
    lastfm?: { apiKey: string; apiSecret?: string } | null;
    librefm?: { apiKey: string; apiSecret?: string } | null;
    allowCustomHosts?: boolean;
    retryDays?: number;
  }) => Promise<boolean>;
  reset: () => void;
}

const BASE = "api/scrobblers";
const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export const useScrobblers = create<ScrobblersState>((set, get) => {
  const api = <T>(route: string, init?: RequestInit) =>
    useServer.getState().api<T>(`${BASE}/${route}`, init);
  const note = (id: ServiceId, message: Message | undefined) =>
    set((s) => ({ messages: { ...s.messages, [id]: message } }));

  /** Run one action for a service: mark it busy, report failures on its card, then reload the status. */
  async function act<T>(
    id: ServiceId,
    name: string,
    run: () => Promise<T>,
    onOk?: (result: T) => Message | undefined,
  ): Promise<T | undefined> {
    set((s) => ({
      busy: { ...s.busy, [id]: name },
      messages: { ...s.messages, [id]: undefined },
    }));
    try {
      const result = await run();
      note(id, onOk?.(result));
      return result;
    } catch (err) {
      note(id, { kind: "error", text: cleanError(err) });
      return undefined;
    } finally {
      set((s) => ({ busy: { ...s.busy, [id]: undefined } }));
      await get().refresh();
    }
  }

  return {
    status: null,
    support: "unknown",
    loading: false,
    busy: {},
    messages: {},
    approvals: {},
    error: null,
    admin: null,

    async refresh() {
      if (!useServer.getState().token) return get().reset();
      set({ loading: true });
      try {
        const status = await api<StatusResponse>("status");
        set({ status, support: "ok", error: null });
      } catch (err) {
        // A server without the plugin (or an older one) has no such route.
        if (err instanceof ApiError && err.status === 404)
          set({ status: null, support: "missing", error: null });
        else set({ error: cleanError(err) });
      } finally {
        set({ loading: false });
      }
    },

    async startApproval(id) {
      const out = await act(id, "connect", () =>
        api<{ approveUrl: string }>(`${id}/connect`, json({})),
      );
      if (out)
        set((s) => ({ approvals: { ...s.approvals, [id]: out.approveUrl } }));
    },

    async finishApproval(id) {
      const out = await act(
        id,
        "finish",
        () => api<{ username: string }>(`${id}/finish`, json({})),
        (r) => ({
          kind: "ok",
          text: r.username ? `Connected as ${r.username}.` : "Connected.",
        }),
      );
      if (out) set((s) => ({ approvals: { ...s.approvals, [id]: undefined } }));
      return !!out;
    },

    async connectListenBrainz(token, host) {
      const out = await act(
        "listenbrainz",
        "connect",
        () =>
          api<{ username: string }>(
            "listenbrainz/connect",
            json({
              token: token.trim(),
              ...(host.trim() ? { host: host.trim() } : {}),
            }),
          ),
        (r) => ({
          kind: "ok",
          text: r.username ? `Connected as ${r.username}.` : "Connected.",
        }),
      );
      return !!out;
    },

    async connectMaloja(url, apiKey) {
      const out = await act(
        "maloja",
        "connect",
        () =>
          api<{ keyChecked: boolean }>(
            "maloja/connect",
            json({ url: url.trim(), apiKey: apiKey.trim() }),
          ),
        (r) => ({
          kind: "ok",
          text: r.keyChecked
            ? "Connected."
            : "Connected. This Maloja version can't confirm the key until the first play.",
        }),
      );
      return !!out;
    },

    async disconnect(id) {
      await act(id, "disconnect", () => api<void>(id, { method: "DELETE" }));
      set((s) => ({ approvals: { ...s.approvals, [id]: undefined } }));
    },

    async setEnabled(id, enabled) {
      await act(id, "toggle", () =>
        api<{ enabled: boolean }>(id, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        }),
      );
    },

    async test(id) {
      await act(
        id,
        "test",
        () => api<{ message: string }>(`${id}/test`, json({})),
        (r) => ({ kind: "ok", text: r.message }),
      );
    },

    async retryNow(id) {
      await act(id, "retry", () =>
        api<unknown>("queue/retry", json({ service: id })),
      );
    },

    async clearQueue(id) {
      await act(
        id,
        "clear",
        () =>
          api<{ cleared: number }>(`queue?service=${id}`, { method: "DELETE" }),
        (r) => ({
          kind: "ok",
          text: `Cleared ${r.cleared} waiting ${r.cleared === 1 ? "play" : "plays"}.`,
        }),
      );
    },

    async loadAdmin() {
      try {
        set({ admin: await api<AdminConfig>("admin/config") });
      } catch {
        set({ admin: null });
      }
    },

    async saveAdmin(patch) {
      try {
        await api<void>("admin/config", {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        set({ error: null });
        await Promise.all([get().loadAdmin(), get().refresh()]);
        return true;
      } catch (err) {
        set({ error: cleanError(err) });
        return false;
      }
    },

    reset() {
      set({
        status: null,
        support: "unknown",
        loading: false,
        busy: {},
        messages: {},
        approvals: {},
        error: null,
        admin: null,
      });
    },
  };
});
