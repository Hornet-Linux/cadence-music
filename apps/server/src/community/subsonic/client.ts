import { createHash, randomBytes } from "node:crypto";
import { jsonCall, send, UpstreamError, type JsonResult, type Query, type RequestOptions, type Target } from "../sourcesCommon/http.js";

/** Subsonic ids are opaque strings. Anything outside this set never goes into a request. */
const ID_RE = /^[\w.:@=+~-]{1,128}$/;

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** Servers differ on whether ids are numbers or strings. */
export function idOf(value: unknown): string | undefined {
  const s = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  return validId(s) ? s : undefined;
}

export interface SubsonicContext extends Target {
  /** Absent for the unauthenticated address check. */
  username?: string;
  /** Never logged or returned to clients. */
  password?: string;
  /** Use the old `p=enc:` password parameter (for servers that can't do token auth, such as LDAP-backed ones). */
  legacy?: boolean;
}

export const API_VERSION = "1.16.1";
const CLIENT_NAME = "Cadence";

/** Subsonic token auth: t = md5(password + salt), with a fresh random salt per call. */
export function authQuery(ctx: SubsonicContext, salt = randomBytes(8).toString("hex")): Query {
  const base: Query = { v: API_VERSION, c: CLIENT_NAME, f: "json" };
  if (!ctx.username || ctx.password === undefined) return base;
  if (ctx.legacy) return { ...base, u: ctx.username, p: `enc:${Buffer.from(ctx.password, "utf8").toString("hex")}` };
  return { ...base, u: ctx.username, t: createHash("md5").update(ctx.password + salt).digest("hex"), s: salt };
}

interface Envelope {
  "subsonic-response"?: { status?: unknown; version?: unknown; type?: unknown; serverVersion?: unknown; error?: { code?: unknown } } & Record<string, unknown>;
}

function codeError(code: unknown): UpstreamError {
  const n = typeof code === "number" ? code : undefined;
  // 40 wrong user or password, 41 token auth unsupported (LDAP), 44 bad API key.
  if (n === 40 || n === 41 || n === 44) return new UpstreamError("unauthorized", undefined, n);
  if (n === 50) return new UpstreamError("forbidden", undefined, n);
  if (n === 70) return new UpstreamError("not_found", undefined, n);
  return new UpstreamError("upstream", undefined, n);
}

/** Unwraps `subsonic-response`, turning a "failed" status into an UpstreamError. */
export function unwrap(result: JsonResult<unknown>): Record<string, unknown> {
  const body = (result.data as Envelope | undefined)?.["subsonic-response"];
  if (!body || typeof body !== "object") throw new UpstreamError("bad_response", result.status);
  if (body.status === "failed") throw codeError(body.error?.code);
  if (body.status !== "ok") throw new UpstreamError("bad_response", result.status);
  return body;
}

/** One Subsonic API call; resolves with the payload of `subsonic-response`. */
export async function subCall(
  ctx: SubsonicContext,
  endpoint: string,
  query: Query = {},
  opts: Pick<RequestOptions, "signal"> = {},
): Promise<Record<string, unknown>> {
  const result = await jsonCall<unknown>(ctx, "GET", `/rest/${endpoint}.view`, {
    query: { ...authQuery(ctx), ...query },
    headers: { Accept: "application/json" },
    signal: opts.signal,
  });
  return unwrap(result);
}

/** A Subsonic call whose answer is binary (audio, cover art). The caller owns the body. */
export function subStream(ctx: SubsonicContext, endpoint: string, query: Query, opts: { headerTimeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.headerTimeoutMs);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return send(ctx, "GET", `/rest/${endpoint}.view`, {
    query: { ...authQuery(ctx), ...query },
    headers: { Accept: "*/*", ...opts.headers },
    signal: ac.signal,
  })
    .catch((e: unknown) => {
      opts.signal?.removeEventListener("abort", onAbort);
      throw e instanceof UpstreamError ? e : new UpstreamError(ac.signal.aborted ? "timeout" : "unreachable");
    })
    .finally(() => clearTimeout(timer));
}

/** The error code a Subsonic server put in a JSON or XML body that was supposed to be audio or an image. */
export function errorCodeFromBody(text: string): number | undefined {
  const json = /"code"\s*:\s*(\d+)/.exec(text);
  if (json) return Number(json[1]);
  const xml = /<error[^>]*\bcode="(\d+)"/.exec(text);
  return xml ? Number(xml[1]) : undefined;
}

export { codeError };