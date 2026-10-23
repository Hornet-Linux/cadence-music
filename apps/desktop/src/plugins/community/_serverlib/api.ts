import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "@uma/shared";
import { ApiError, useServer } from "../../builtins/server/serverStore";

/** Who is signed in to the server, and whether they can see admin pages. */
export function useServerSession(): { signedIn: boolean; isAdmin: boolean; user: PublicUser | null } {
  const user = useServer((s) => s.user);
  return { signedIn: user !== null, isAdmin: user?.isAdmin === true, user };
}

/** Call the server API as the signed-in person. */
export function call<T>(route: string, init?: RequestInit): Promise<T> {
  return useServer.getState().api<T>(route, init);
}

/** A JSON request: `send("PUT", "api/x", {a: 1})`. */
export function send<T>(method: "POST" | "PUT" | "DELETE", route: string, body?: unknown): Promise<T> {
  return call<T>(route, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** The server answered 404 for a feature route: its plugin is not switched on. */
export function isMissingFeature(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function explainError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404)
      return "This feature is not switched on for your server yet. A server admin can enable it on the server's admin page (Plugins).";
    if (err.status === 403) return "Only a server admin can do that.";
    if (err.code === "ffmpeg_missing") return "This needs ffmpeg on the server, and it was not found.";
    if (err.code) return err.code.replace(/_/g, " ");
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data when the dependencies change. `refreshMs` re-polls while it returns a number
 * (use it for jobs that report progress).
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: (data: T | null) => number | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const refresh = useRef(refreshMs);
  refresh.current = refreshMs;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const next = await loader.current();
        if (cancelled) return;
        setData(next);
        setError(null);
        const wait = refresh.current?.(next) ?? null;
        if (wait) timer = setTimeout(() => void run(false), wait);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };
    void run(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
