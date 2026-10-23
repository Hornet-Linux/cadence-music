import { SERVER_VERSION } from "../version.js";

export type FetchFn = typeof fetch;

/** Jellyfin item ids are 32 hex characters. Anything else never goes into a URL. */
const ID_RE = /^[0-9a-f]{32}$/i;

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export type JellyfinErrorKind = "unauthorized" | "not_found" | "unreachable" | "timeout" | "redirect" | "bad_response" | "upstream";

/**
 * A failed call to Jellyfin. The message is for our logs and never contains
 * upstream response text; what clients see is decided by the route (fixed phrases).
 */
export class JellyfinError extends Error {
  constructor(
    readonly kind: JellyfinErrorKind,
    readonly status?: number,
  ) {
    super(status ? `Jellyfin ${kind} (HTTP ${status})` : `Jellyfin ${kind}`);
  }
}

export interface JellyfinContext {
  /** The owner-configured address, no trailing slash. */
  baseUrl: string;
  /** Stable per Cadence user. */
  deviceId: string;
  /** Absent for the sign-in call and the public info call. */
  token?: string;
  fetchFn?: FetchFn;
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION}`;
const API_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Jellyfin 12 only accepts this header form (or `ApiKey=`); the legacy token headers return 401. */
export function authHeader(ctx: JellyfinContext): string {
  const parts = [
    `Client="Cadence"`,
    `Device="Cadence server"`,
    `DeviceId="${ctx.deviceId.replace(/[^\w-]/g, "")}"`,
    `Version="${SERVER_VERSION}"`,
  ];
  if (ctx.token) parts.push(`Token="${ctx.token.replace(/[^\w.-]/g, "")}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  /** JSON body. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function buildUrl(ctx: JellyfinContext, path: string, query?: Query): URL {
  const base = new URL(ctx.baseUrl);
  const url = new URL(ctx.baseUrl + path);
  // Paths are built from constants and validated ids; this is a last line of defence.
  if (url.origin !== base.origin) throw new JellyfinError("bad_response");
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url;
}

/**
 * One request to Jellyfin. Redirects are never followed to another origin (the
 * Authorization header would go with them); same-origin ones are followed a few times.
 * Resolves once the response headers arrive; the caller owns the body.
 */
async function send(ctx: JellyfinContext, method: string, path: string, opts: RequestOptions): Promise<Response> {
  const fetchFn = ctx.fetchFn ?? fetch;
  let url = buildUrl(ctx, path, opts.query);
  const origin = new URL(ctx.baseUrl).origin;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = {
      Authorization: authHeader(ctx),
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Accept-Encoding": "identity",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "manual",
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new JellyfinError("timeout");
      throw new JellyfinError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => undefined);
      let next: URL | null;
      try {
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      const keepsMethod = res.status === 307 || res.status === 308 || method === "GET" || method === "HEAD";
      if (!next || next.origin !== origin || !keepsMethod || hop >= MAX_REDIRECTS) throw new JellyfinError("redirect", res.status);
      url = next;
      continue;
    }
    return res;
  }
}

function failFor(res: Response): JellyfinError {
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 401) return new JellyfinError("unauthorized", 401);
  if (res.status === 404) return new JellyfinError("not_found", 404);
  return new JellyfinError("upstream", res.status);
}

/** A JSON (or empty) call, bounded in total time. */
export async function jfJson<T = unknown>(ctx: JellyfinContext, method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await send(ctx, method, path, { ...opts, signal: ac.signal });
    if (!res.ok) throw failFor(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JellyfinError("bad_response", res.status);
    }
  } catch (e) {
    if (e instanceof JellyfinError) throw e;
    throw new JellyfinError(ac.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * A call whose body is streamed to our client (audio, images). The timeout covers
 * the wait for headers; the caller guards the body with its own idle timer and
 * aborts `opts.signal` when the client goes away.
 */
export async function jfStream(
  ctx: JellyfinContext,
  path: string,
  opts: RequestOptions & { headerTimeoutMs: number },
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.headerTimeoutMs);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Unlike the other calls, the response stays open after this returns.
    return await send(ctx, "GET", path, { ...opts, signal: ac.signal });
  } catch (e) {
    opts.signal?.removeEventListener("abort", onAbort);
    if (e instanceof JellyfinError) throw e;
    throw new JellyfinError(ac.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

export function ticksToSec(ticks: unknown): number | undefined {
  return typeof ticks === "number" && Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 1e4) / 1e3 : undefined;
}

export const secToTicks = (sec: number): number => Math.round(sec * 1e7);
