import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import { SERVER_VERSION } from "../version.js";

/**
 * Outbound HTTP for sources that read music from somewhere else (WebDAV, S3, Drive...).
 * The addresses come from users, so the server must not become a way to reach things
 * only the server can see:
 *  - the address a name resolves to is checked at connect time (so DNS tricks and
 *    rebinding can't swap in an internal address afterwards);
 *  - loopback, private, link-local (cloud metadata) and similar ranges are refused,
 *    except that the server owner may allow private networks for a NAS on their LAN;
 *  - plain http is only accepted for private addresses (never for the public internet,
 *    where a password would cross the network in the clear);
 *  - redirects are re-checked on every hop and never carry credentials to another origin.
 */

export interface NetPolicy {
  /** The server owner allows addresses on private networks (a NAS or MinIO at home). */
  allowPrivate: boolean;
}

export type NetErrorKind = "invalid_url" | "blocked" | "insecure" | "unreachable" | "timeout" | "redirect" | "too_large";

export class SourceNetError extends Error {
  constructor(
    readonly kind: NetErrorKind,
    detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "SourceNetError";
  }
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION}`;

// ---- address classification ------------------------------------------------------

type Verdict = "public" | "private" | "blocked";

const privateV4 = new net.BlockList();
const blockedV4 = new net.BlockList();
const privateV6 = new net.BlockList();
const blockedV6 = new net.BlockList();

for (const [base, bits] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // carrier-grade NAT, also Tailscale
  ["198.18.0.0", 15], // benchmarking
  ["192.0.0.0", 24],
] as const) {
  privateV4.addSubnet(base, bits, "ipv4");
}
for (const [base, bits] of [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the cloud metadata address
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blockedV4.addSubnet(base, bits, "ipv4");
}
privateV6.addSubnet("::1", 128, "ipv6");
privateV6.addSubnet("fc00::", 7, "ipv6"); // unique local
blockedV6.addSubnet("::", 128, "ipv6");
blockedV6.addSubnet("fe80::", 10, "ipv6"); // link-local
blockedV6.addSubnet("ff00::", 8, "ipv6"); // multicast
blockedV6.addSubnet("2001:db8::", 32, "ipv6"); // documentation

/** Expand an IPv6 address to its eight 16-bit groups, or null when it is not valid. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    if (!net.isIPv4(v4[1]!)) return null;
    const p = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ":" + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** Which kind of address this is. Anything unparseable counts as blocked. */
export function classifyAddress(address: string): Verdict {
  if (net.isIPv4(address)) {
    if (blockedV4.check(address, "ipv4")) return "blocked";
    return privateV4.check(address, "ipv4") ? "private" : "public";
  }
  const groups = net.isIPv6(address.split("%")[0]!) ? ipv6Groups(address) : null;
  if (!groups) return "blocked";
  const zeros5 = groups.slice(0, 5).every((g) => g === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible) and 64:ff9b::a.b.c.d (NAT64) carry an IPv4 address.
  if (zeros5 && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 0) return "blocked"; // ::
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return "private"; // ::1
    return classifyAddress(dotted(groups[6]!, groups[7]!));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return classifyAddress(dotted(groups[6]!, groups[7]!));
  }
  const canonical = groups.map((g) => g.toString(16)).join(":");
  if (blockedV6.check(canonical, "ipv6")) return "blocked";
  return privateV6.check(canonical, "ipv6") ? "private" : "public";
}

/** Throws when a connection to this address is not allowed for this scheme under the policy. */
export function checkAddress(address: string, protocol: string, policy: NetPolicy): void {
  const verdict = classifyAddress(address);
  if (verdict === "blocked") throw new SourceNetError("blocked");
  if (verdict === "private" && !policy.allowPrivate) throw new SourceNetError("blocked", "private network");
  if (verdict === "public" && protocol === "http:") throw new SourceNetError("insecure");
}

// ---- address validation ----------------------------------------------------------

/** Parses and sanity-checks an address a person typed in. */
export function parseSourceUrl(raw: string, what = "address"): URL {
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) throw new SourceNetError("invalid_url", `Enter the ${what}`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SourceNetError("invalid_url", `That isn't a valid ${what}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceNetError("invalid_url", `The ${what} must start with http:// or https://`);
  }
  if (url.username || url.password) throw new SourceNetError("invalid_url", `The ${what} must not contain a user name or password`);
  if (url.search || url.hash) throw new SourceNetError("invalid_url", `The ${what} must not contain a query string or fragment`);
  if (!url.hostname) throw new SourceNetError("invalid_url", `The ${what} needs a host name`);
  return url;
}

/**
 * Checks the address as far as can be done without a network: literal IPs are classified now;
 * names are checked when connecting. Lets the settings screen refuse obvious mistakes early.
 */
export function precheckUrl(url: URL, policy: NetPolicy): void {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) checkAddress(host, url.protocol, policy);
  else if (url.protocol === "http:" && !policy.allowPrivate) throw new SourceNetError("insecure");
}

function guardedLookup(policy: NetPolicy, protocol: string): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      try {
        if (addresses.length === 0) throw new SourceNetError("unreachable");
        // One bad record is enough to refuse the name: a mixed answer is how rebinding hides.
        for (const a of addresses) checkAddress(a.address, protocol, policy);
      } catch (e) {
        return callback(e as Error, "", 4);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

// ---- requests --------------------------------------------------------------------

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  policy: NetPolicy;
  /** Aborting cancels the request and closes the response body. */
  signal?: AbortSignal;
  /** How long to wait for response headers. */
  headerTimeoutMs?: number;
  maxRedirects?: number;
  /** Headers that may follow a redirect to another origin (credentials never do). */
  crossOriginHeaders?: string[];
}

export interface UpstreamResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
  url: URL;
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

function sendOnce(url: URL, opts: RequestOptions, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        headers,
        signal,
        lookup: guardedLookup(opts.policy, url.protocol),
        agent: false,
        servername: net.isIP(host) ? undefined : host,
      },
      resolve,
    );
    req.on("error", (e) => {
      if (e instanceof SourceNetError) return reject(e);
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof SourceNetError) return reject(cause);
      if (signal.aborted) return reject(new SourceNetError("timeout"));
      reject(new SourceNetError("unreachable", (e as NodeJS.ErrnoException).code));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * One HTTP request with redirects handled by hand (see the notes at the top). Resolves when the
 * response headers arrive; the caller owns the body and must read or destroy it.
 */
export async function request(target: string | URL, opts: RequestOptions): Promise<UpstreamResponse> {
  let url = typeof target === "string" ? new URL(target) : new URL(target.href);
  const origin = url.origin;
  const maxRedirects = opts.maxRedirects ?? 4;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.headerTimeoutMs ?? 30_000);
  const onAbort = () => ac.abort();
  if (opts.signal?.aborted) ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceNetError("invalid_url");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host)) checkAddress(host, url.protocol, opts.policy);
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", ...opts.headers };
      if (url.origin !== origin) {
        const keep = new Set((opts.crossOriginHeaders ?? []).map((h) => h.toLowerCase()));
        for (const k of Object.keys(headers)) {
          const lower = k.toLowerCase();
          if (CREDENTIAL_HEADERS.includes(lower) || (!keep.has(lower) && lower !== "user-agent" && lower !== "accept-encoding")) delete headers[k];
        }
      }
      if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
      const res = await sendOnce(url, opts, headers, ac.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && status !== 304 && res.headers.location) {
        res.resume();
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new SourceNetError("redirect");
        }
        if (hop >= maxRedirects) throw new SourceNetError("redirect", "too many redirects");
        url = next;
        continue;
      }
      // The caller owns the body from here; aborting the signal still ends it.
      clearTimeout(timer);
      const closeOnAbort = () => res.destroy();
      if (opts.signal) {
        if (opts.signal.aborted) res.destroy();
        else opts.signal.addEventListener("abort", closeOnAbort, { once: true });
        res.once("close", () => opts.signal?.removeEventListener("abort", closeOnAbort));
      }
      return { status, headers: res.headers, body: res, url };
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof SourceNetError) throw e;
    throw new SourceNetError(ac.signal.aborted ? "timeout" : "unreachable");
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Reads a whole body, giving up past `maxBytes`. */
export async function readBody(res: UpstreamResponse, maxBytes: number, idleMs = 30_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const idle = setTimeout(() => res.body.destroy(new SourceNetError("timeout")), idleMs);
  try {
    for await (const chunk of res.body) {
      idle.refresh();
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        res.body.destroy();
        throw new SourceNetError("too_large");
      }
      chunks.push(buf);
    }
  } catch (e) {
    if (e instanceof SourceNetError) throw e;
    throw new SourceNetError("unreachable");
  } finally {
    clearTimeout(idle);
  }
  return Buffer.concat(chunks);
}

/** Reads up to `bytes` from the start of a body and then closes it. */
export async function readHead(res: UpstreamResponse, bytes: number, idleMs = 30_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const idle = setTimeout(() => res.body.destroy(new SourceNetError("timeout")), idleMs);
  try {
    for await (const chunk of res.body) {
      idle.refresh();
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= bytes) break;
    }
  } catch (e) {
    if (e instanceof SourceNetError) throw e;
    throw new SourceNetError("unreachable");
  } finally {
    clearTimeout(idle);
    res.body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}
