import { SERVER_VERSION } from "../../version.js";
import { API_TIMEOUT_MS, failFor, jsonCall, send, UpstreamError, type JsonResult, type Query, type RequestOptions, type Target } from "../sourcesCommon/http.js";

/** Plex rating keys are plain integers. Anything else never goes into a request. */
export const ID_RE = /^\d{1,12}$/;

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** Servers send rating keys as strings, but be forgiving about numbers. */
export function idOf(value: unknown): string | undefined {
  const s = typeof value === "number" && Number.isInteger(value) && value >= 0 ? String(value) : value;
  return validId(s) ? s : undefined;
}

export interface PlexContext extends Target {
  /** Stable per Cadence user; Plex shows one device per person. */
  clientId: string;
  /** The person's plex.tv token. Sent only in a header, never in a URL, never logged. */
  token?: string;
}

/** Headers Plex wants on every call; the token travels in X-Plex-Token, not the query string, so URLs are safe to log. */
export function plexHeaders(ctx: PlexContext, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": "Cadence",
    "X-Plex-Version": SERVER_VERSION,
    "X-Plex-Client-Identifier": ctx.clientId,
    "X-Plex-Device": "Cadence server",
    "X-Plex-Device-Name": "Cadence server",
    "X-Plex-Platform": "Cadence",
    ...(ctx.token ? { "X-Plex-Token": ctx.token } : {}),
    ...extra,
  };
}

/** A JSON call to the Plex Media Server or plex.tv. */
export function plexCall<T = unknown>(
  ctx: PlexContext,
  method: string,
  path: string,
  opts: Omit<RequestOptions, "headers"> & { headers?: Record<string, string>; acceptStatus?: (s: number) => boolean } = {},
): Promise<JsonResult<T>> {
  return jsonCall<T>(ctx, method, path, { ...opts, headers: plexHeaders(ctx, opts.headers) });
}

export interface MediaContainer {
  size?: number;
  totalSize?: number;
  offset?: number;
  Metadata?: unknown;
  Directory?: unknown;
  Hub?: unknown;
  friendlyName?: string;
  machineIdentifier?: string;
  version?: string;
}

/** The `MediaContainer` of a Plex answer. */
export async function container(ctx: PlexContext, path: string, query: Query = {}, opts: { signal?: AbortSignal } = {}): Promise<MediaContainer> {
  const res = await plexCall<{ MediaContainer?: MediaContainer }>(ctx, "GET", path, { query, signal: opts.signal });
  const c = res.data?.MediaContainer;
  if (!c || typeof c !== "object") throw new UpstreamError("bad_response", res.status);
  return c;
}

/** A Plex call whose answer is binary (audio, images). The caller owns the body. */
export function plexStream(ctx: PlexContext, path: string, query: Query, opts: { headerTimeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.headerTimeoutMs);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return send(ctx, "GET", path, { query, headers: plexHeaders(ctx, { Accept: "*/*", ...opts.headers }), signal: ac.signal })
    .catch((e: unknown) => {
      opts.signal?.removeEventListener("abort", onAbort);
      throw e instanceof UpstreamError ? e : new UpstreamError(ac.signal.aborted ? "timeout" : "unreachable");
    })
    .finally(() => clearTimeout(timer));
}

export const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : value && typeof value === "object" ? [value as T] : []);
/** A call whose answer does not matter (rating, timeline, scrobble): only success or failure. */
export async function plexFire(ctx: PlexContext, method: string, path: string, query: Query = {}): Promise<void> {
  const res = await send(ctx, method, path, { query, headers: plexHeaders(ctx, { Accept: "*/*" }), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw failFor(res);
  void res.body?.cancel().catch(() => undefined);
}