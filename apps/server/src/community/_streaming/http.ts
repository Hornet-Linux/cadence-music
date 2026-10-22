import { SERVER_VERSION } from "../../version.js";

export type FetchFn = typeof fetch;

export type UpstreamKind = "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unreachable" | "timeout" | "bad_response" | "upstream";

/**
 * A failed call to a streaming service. The message is for our logs only and never
 * holds upstream response text; clients only see the fixed phrases from `publicMessage`.
 */
export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly kind: UpstreamKind,
    readonly status?: number,
  ) {
    super(status ? `${service} ${kind} (HTTP ${status})` : `${service} ${kind}`);
  }
}

export function publicMessage(service: string, e: UpstreamError): string {
  switch (e.kind) {
    case "timeout":
      return `${service} took too long to answer`;
    case "unreachable":
      return `${service} couldn't be reached. Ask the server owner to check the connection.`;
    case "rate_limited":
      return `${service} is limiting requests right now. Try again in a minute.`;
    case "forbidden":
      return `${service} refused the request. The server owner may need to check the app's credentials or permissions.`;
    default:
      return `${service} returned an unexpected answer`;
  }
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION}`;
const TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface CallOptions {
  fetchFn?: FetchFn;
  headers?: Record<string, string>;
  /** Form fields, sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Test-only: when BOTH `CADENCE_TESTING=1` and `CADENCE_STREAMING_TEST_UPSTREAM=<origin>` are set, every
 * service endpoint (token exchange included) points at that origin instead of the real service. Either
 * variable alone does nothing. `StreamingKit` logs a loud warning at start-up when this is active.
 */
export function testUpstream(env: NodeJS.ProcessEnv = process.env): string | null {
  const target = env.CADENCE_STREAMING_TEST_UPSTREAM?.trim().replace(/\/+$/, "");
  return env.CADENCE_TESTING === "1" && target ? target : null;
}

/** Where a service's endpoints live. */
export function hosts<K extends string>(slug: string, defaults: Record<K, string>): Record<K, string> {
  const fake = testUpstream();
  if (!fake) return defaults;
  const out = {} as Record<K, string>;
  for (const key of Object.keys(defaults) as K[]) out[key] = `${fake}/${slug}/${key}`;
  return out;
}

function statusKind(status: number): UpstreamKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "upstream";
}

/** One JSON call to a streaming service, with a timeout, a size cap and fixed error kinds. */
export async function callJson<T>(service: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, options: CallOptions = {}): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT, ...options.headers };
  let body: string | undefined;
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, { method, headers, body, signal: ctl.signal, redirect: "error" });
    } catch {
      throw new UpstreamError(service, ctl.signal.aborted ? "timeout" : "unreachable");
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new UpstreamError(service, statusKind(res.status), res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new UpstreamError(service, "bad_response", res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(service, "bad_response", res.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

const isControl = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || c === 0x7f;
};

/** Clamp text taken from an upstream answer before it reaches a client. */
export function clean(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = Array.from(value, (ch) => (isControl(ch) ? " " : ch)).join("").trim();
  return t ? t.slice(0, max) : undefined;
}

/** Only http(s) URLs are passed on (artwork, links), never javascript: or data: ones. */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** ISO 8601 durations such as PT3M20S or PT1H2M3S, in whole seconds (undefined for zero or live). */
export function isoSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!m) return undefined;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return sec > 0 ? Math.round(sec) : undefined;
}
