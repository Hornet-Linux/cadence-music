import { SERVER_VERSION } from "../../version.js";

/**
 * Safe outbound calls for the music-source plugins (Subsonic, Plex).
 *
 * The addresses called here are always chosen by the server owner (or are a
 * fixed public service such as plex.tv), never by an ordinary user. On top of
 * that: redirects never leave the origin (credentials would go with them),
 * every call has a timeout, JSON answers have a size cap, and the errors thrown
 * never carry upstream text, URLs or credentials.
 */

export type FetchFn = typeof fetch;

export type UpstreamKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "bad_response"
  | "too_large"
  | "upstream";

/** A failed call. The message is for our logs and never contains upstream text, URLs or tokens. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamKind,
    readonly status?: number,
    /** A service-specific code (for example Subsonic's error number). */
    readonly code?: number,
  ) {
    super(`Upstream ${kind}${status ? ` (HTTP ${status})` : ""}${code !== undefined ? ` (code ${code})` : ""}`);
    this.name = "UpstreamError";
  }
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION}`;
export const API_TIMEOUT_MS = 15_000;
/** A library page is a few hundred kilobytes; this leaves room for a very large artist list and nothing more. */
export const MAX_JSON_BYTES = 12 * 1024 * 1024;
/** Cover art larger than this is not a thumbnail anyone wants. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type Query = Record<string, string | number | boolean | undefined>;

export interface Target {
  /** The owner-configured address, no trailing slash. */
  baseUrl: string;
  fetchFn?: FetchFn;
}

export interface RequestOptions {
  query?: Query;
  headers?: Record<string, string>;
  /** Form or text body (sent as given). */
  body?: string;
  signal?: AbortSignal;
}

function buildUrl(target: Target, path: string, query?: Query): URL {
  const base = new URL(target.baseUrl);
  const url = new URL(target.baseUrl + path);
  // Paths are constants and validated ids; this is a last line of defence.
  if (url.origin !== base.origin) throw new UpstreamError("bad_response");
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url;
}

/**
 * One request. Same-origin redirects are followed a few times; others are an
 * error. Resolves once the headers arrive; the caller owns the body.
 */
export async function send(target: Target, method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const fetchFn = target.fetchFn ?? fetch;
  let url = buildUrl(target, path, opts.query);
  const origin = new URL(target.baseUrl).origin;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", ...opts.headers },
        body: opts.body,
        redirect: "manual",
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new UpstreamError("timeout");
      throw new UpstreamError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try {
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      const keepsMethod = res.status === 307 || res.status === 308 || method === "GET" || method === "HEAD";
      if (!next || next.origin !== origin || !keepsMethod || hop >= MAX_REDIRECTS) throw new UpstreamError("redirect", res.status);
      url = next;
      continue;
    }
    return res;
  }
}

export function failFor(res: Response): UpstreamError {
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 401) return new UpstreamError("unauthorized", 401);
  if (res.status === 403) return new UpstreamError("forbidden", 403);
  if (res.status === 404) return new UpstreamError("not_found", 404);
  return new UpstreamError("upstream", res.status);
}

/** Reads a body as text, giving up (and cancelling the download) once it passes `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new UpstreamError("too_large", res.status);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new UpstreamError("too_large", res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs `fn` with a signal that aborts after `ms` or when `outer` aborts. */
async function withTimeout<T>(ms: number, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const onAbort = () => ac.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(ac.signal);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(ac.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export interface JsonResult<T> {
  status: number;
  /** Undefined for an empty body. */
  data: T | undefined;
}

/**
 * A call whose answer is JSON (or empty), bounded in time and size.
 * HTTP errors are thrown as UpstreamError unless `acceptStatus` says the status is fine.
 */
export async function jsonCall<T = unknown>(
  target: Target,
  method: string,
  path: string,
  opts: RequestOptions & { timeoutMs?: number; maxBytes?: number; acceptStatus?: (status: number) => boolean } = {},
): Promise<JsonResult<T>> {
  return withTimeout(opts.timeoutMs ?? API_TIMEOUT_MS, opts.signal, async (signal) => {
    const res = await send(target, method, path, { ...opts, signal });
    if (!res.ok && !opts.acceptStatus?.(res.status)) throw failFor(res);
    if (res.status === 204) return { status: res.status, data: undefined };
    const text = await readCapped(res, opts.maxBytes ?? MAX_JSON_BYTES);
    if (!text.trim()) return { status: res.status, data: undefined };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new UpstreamError("bad_response", res.status);
    }
  });
}

/**
 * A call whose body is streamed on to our client (audio, images). The timeout
 * covers the wait for headers; the caller guards the body and aborts `opts.signal`
 * when the client goes away.
 */
export async function streamCall(target: Target, path: string, opts: RequestOptions & { headerTimeoutMs: number }): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.headerTimeoutMs);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // The response stays open after this returns.
    return await send(target, "GET", path, { ...opts, signal: ac.signal });
  } catch (e) {
    opts.signal?.removeEventListener("abort", onAbort);
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(ac.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** What clients may learn about a failed call: fixed phrases, never upstream text or network details. */
export function publicFailure(service: string, e: UpstreamError): { error: string; message: string } {
  const error = `${service.toLowerCase()}_failed`;
  if (e.kind === "timeout") return { error, message: `${service} took too long to answer` };
  if (e.kind === "unreachable" || e.kind === "redirect") {
    return { error, message: `${service} couldn't be reached. Ask the server owner to check it.` };
  }
  if (e.kind === "too_large") return { error, message: `${service} sent more than Cadence accepts` };
  return { error, message: `${service} returned an unexpected answer` };
}