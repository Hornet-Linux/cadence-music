import { useEffect, useState } from "react";
import { ApiError, apiUrl, useServer } from "../../builtins/server/serverStore";

/** Authenticated call to the Cadence server (route relative to its address). */
export function serverApi<T>(route: string, init?: RequestInit): Promise<T> {
  return useServer.getState().api<T>(route, init);
}

export const sendJson = (method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Turns a relative path from the server (signed stream or image) into an absolute address. */
export function serverUrl(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  const base = useServer.getState().url;
  return base ? apiUrl(base, path) : undefined;
}

export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    qs.set(k, v === true ? "1" : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** A person-friendly sentence for a failed call. A server without the plugin answers 404. */
export function describeError(e: unknown, what = "this"): string {
  if (e instanceof ApiError) {
    if (e.status === 404 && !e.code) return `Your server doesn't have ${what} turned on. Ask the server owner to enable it in the admin settings.`;
    if (e.status === 502) return e.message.replace(/^Request failed \(\d+\): ?/, "") || "The service couldn't be reached. Try again in a moment.";
    if (e.status === 429) return "That was too many tries. Wait a moment and try again.";
    return e.message.replace(/^Request failed \(\d+\): ?/, "") || "Something went wrong.";
  }
  return e instanceof Error ? e.message : String(e);
}

/** True when the server answered "no such plugin": the plugin is disabled there. */
export const isMissing = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && !e.code;

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  set: (updater: (old: T | null) => T | null) => void;
}

/** Loads something from the server when `key` changes; a stale answer never overwrites a newer one. */
export function useLoad<T>(load: () => Promise<T>, key: string, what = "this"): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => live && setState({ data, loading: false, error: null }),
      (e: unknown) => live && setState({ data: null, loading: false, error: describeError(e, what) }),
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure every render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  return {
    ...state,
    reload: () => setNonce((n) => n + 1),
    set: (updater) => setState((s) => ({ ...s, data: updater(s.data) })),
  };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Whether the person is signed in to a Cadence server (these sources all live behind it). */
export function useSignedIn(): boolean {
  return useServer((s) => !!s.user);
}

export function useIsAdmin(): boolean {
  return useServer((s) => !!s.user?.isAdmin);
}