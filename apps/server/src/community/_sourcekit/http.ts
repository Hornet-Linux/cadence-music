import http from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough, type Readable } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";
import { SERVER_VERSION } from "../../version.js";
import { assertHostAllowed, BlockedAddressError, guardedLookup, type NetPolicy } from "./netguard.js";

export type NetErrorKind = "blocked" | "timeout" | "unreachable" | "redirect" | "protocol" | "too_large" | "bad_response";

/** A failed outbound call. Messages are for logs; clients only ever see fixed phrases chosen by the route. */
export class NetError extends Error {
  constructor(
    readonly kind: NetErrorKind,
    detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
  }
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION} (+https://github.com/Hornet-Linux/cadence-music)`;

export interface RequestOptions extends NetPolicy {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Waiting for the response headers, including connecting. */
  headerTimeoutMs?: number;
  /** Silence on an open connection. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** Redirect hops to follow (each hop is checked like the first request). 0 refuses redirects. */
  maxRedirects?: number;
  /** Allow a redirect to this URL. Defaults to anywhere the address check allows. */
  allowRedirect?: (from: URL, to: URL) => boolean;
  /** Tolerate non-standard status lines such as Shoutcast ICY 200 OK. */
  lenient?: boolean;
}

export interface NetResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
  /** Where the final response came from, after redirects. */
  url: URL;
  /** Stops the transfer. */
  abort: () => void;
}

const DEFAULT_HEADER_TIMEOUT = 15_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;

interface Opened {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: Readable;
  abort: () => void;
}

/**
 * Shoutcast v1 servers answer "ICY 200 OK", which Node's HTTP parser rejects. This speaks just enough HTTP/1.0
 * over a plain socket to read that answer. Same address checks as every other request.
 */
function rawIcyRequest(url: URL, opts: RequestOptions, headers: Record<string, string>, port: number): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const lookup = guardedLookup(opts, port) as never;
    const socket = url.protocol === "https:" ? tls.connect({ host, port, servername: host, lookup }) : net.connect({ host, port, lookup });
    let head = Buffer.alloc(0);
    let done = false;
    const fail = (e: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const err = e as NodeJS.ErrnoException;
      reject(e instanceof NetError ? e : err?.code === "EBLOCKED" ? new NetError("blocked", host) : new NetError("unreachable", err?.code ?? err?.message));
    };
    const timer = setTimeout(() => fail(new NetError("timeout", "headers")), opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT);
    socket.on("error", fail);
    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
      const lines = [`GET ${url.pathname}${url.search} HTTP/1.0`, `Host: ${url.host}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", function onData(chunk: Buffer) {
      if (done) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 16_384) fail(new NetError("bad_response", "header too large"));
        return;
      }
      socket.off("data", onData);
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const m = /^(?:ICY|HTTP\/1\.[01]) (\d{3})/.exec(lines[0] ?? "");
      if (!m) return fail(new NetError("bad_response", "status line"));
      const parsed: http.IncomingHttpHeaders = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) parsed[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
      }
      done = true;
      clearTimeout(timer);
      const body = new PassThrough();
      const rest = head.subarray(end + 4);
      if (rest.length) body.write(rest);
      socket.pipe(body);
      socket.removeListener("error", fail);
      socket.on("error", (e) => body.destroy(e));
      resolve({ status: Number(m[1]), headers: parsed, stream: body, abort: () => socket.destroy() });
    });
  });
}

function once(url: URL, opts: RequestOptions, headers: Record<string, string>): Promise<Opened> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return reject(new NetError("protocol", url.protocol));
    if (url.username || url.password) return reject(new NetError("protocol", "credentials in address"));
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    try {
      assertHostAllowed(url.hostname, port, opts);
    } catch (e) {
      return reject(e instanceof BlockedAddressError ? new NetError("blocked", e.host) : e);
    }
    const lib = url.protocol === "https:" ? https : http;
    let settled = false;
    const headerTimer = setTimeout(() => {
      req.destroy();
      fail(new NetError("timeout", "headers"));
    }, opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT);
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      if (e instanceof NetError) return reject(e);
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "EBLOCKED") return reject(new NetError("blocked", url.hostname));
      return reject(new NetError("unreachable", err?.code ?? err?.message));
    };
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? "GET",
        headers,
        lookup: guardedLookup(opts, port) as never,
        insecureHTTPParser: opts.lenient === true,
        // No connection reuse: a server that never closes would otherwise keep sockets (and the process) alive.
        agent: false,
      },
      (res) => {
        if (settled) return res.destroy();
        settled = true;
        clearTimeout(headerTimer);
        res.socket?.setTimeout(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT);
        res.socket?.once("timeout", () => res.destroy(new NetError("timeout", "idle")));
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res, abort: () => req.destroy() });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (opts.lenient && !settled && e.code === "HPE_INVALID_CONSTANT" && (opts.method ?? "GET") === "GET") {
        settled = true;
        clearTimeout(headerTimer);
        rawIcyRequest(url, opts, headers, port).then(resolve, reject);
        return;
      }
      fail(e);
    });
    if (opts.signal) {
      const onAbort = () => {
        req.destroy();
        fail(new NetError("timeout", "aborted"));
      };
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end(opts.body);
  });
}

/**
 * One outbound request. Redirects are followed by hand so each hop goes through the same address checks,
 * and the response body is handed back unread for the caller to stream or cap.
 */
export async function request(rawUrl: string | URL, opts: RequestOptions = {}): Promise<NetResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetError("protocol", "invalid address");
  }
  const max = opts.maxRedirects ?? 5;
  const firstOrigin = url.origin;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", ...opts.headers };
    if (url.origin !== firstOrigin) for (const k of Object.keys(headers)) if (/^(authorization|cookie|x-auth-.*)$/i.test(k)) delete headers[k];
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const { status, headers: resHeaders, stream, abort } = await once(url, opts, headers);
    if (status >= 300 && status < 400 && status !== 304 && resHeaders.location) {
      stream.resume();
      let next: URL;
      try {
        next = new URL(resHeaders.location, url);
      } catch {
        throw new NetError("redirect", "bad location");
      }
      if (hop >= max) throw new NetError("redirect", "too many");
      if (opts.allowRedirect && !opts.allowRedirect(url, next)) throw new NetError("redirect", "not allowed");
      url = next;
      continue;
    }
    return { status, headers: resHeaders, body: stream, url, abort };
  }
}

/** Reads a whole body up to maxBytes. Past the cap it throws, or (with truncate) returns what fit and stops the transfer. */
export async function readBody(
  res: NetResponse,
  maxBytes: number,
  opts: { truncate?: boolean; totalTimeoutMs?: number } = {},
): Promise<{ data: Buffer; truncated: boolean }> {
  let stream: Readable = res.body;
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  // The output limit is what stops a small "zip bomb" from filling memory.
  const zopts = { maxOutputLength: maxBytes + 1 } as const;
  const decoder =
    enc === "gzip" || enc === "x-gzip"
      ? zlib.createGunzip(zopts)
      : enc === "deflate"
        ? zlib.createInflate(zopts)
        : enc === "br"
          ? zlib.createBrotliDecompress(zopts)
          : null;
  if (decoder) {
    stream = res.body.pipe(decoder);
    res.body.on("error", (e) => decoder.destroy(e));
  } else if (enc && enc !== "identity") {
    res.abort();
    throw new NetError("bad_response", "unsupported encoding");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const timer = opts.totalTimeoutMs
    ? setTimeout(() => {
        res.abort();
        stream.destroy(new NetError("timeout", "body"));
      }, opts.totalTimeoutMs)
    : undefined;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      if (size + buf.length > maxBytes) {
        if (!opts.truncate) throw new NetError("too_large");
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } catch (e) {
    res.abort();
    if (e instanceof NetError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new NetError("too_large");
    throw new NetError("unreachable", code ?? (e as Error)?.message);
  } finally {
    clearTimeout(timer);
  }
  if (truncated) {
    res.abort();
    stream.destroy();
  }
  return { data: Buffer.concat(chunks), truncated };
}

export interface TextResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  truncated: boolean;
  url: URL;
}

/** A call that returns text, for small API and feed documents. Compressed answers are inflated within the size cap. */
export async function fetchText(
  url: string | URL,
  opts: RequestOptions & { maxBytes?: number; truncate?: boolean; totalTimeoutMs?: number } = {},
): Promise<TextResult> {
  const res = await request(url, { ...opts, headers: { "Accept-Encoding": "gzip, deflate, br", ...opts.headers } });
  const { data, truncated } = await readBody(res, opts.maxBytes ?? 2_000_000, { truncate: opts.truncate, totalTimeoutMs: opts.totalTimeoutMs ?? 30_000 });
  return { status: res.status, headers: res.headers, text: data.toString("utf8"), truncated, url: res.url };
}

export async function fetchJson<T = unknown>(
  url: string | URL,
  opts: RequestOptions & { maxBytes?: number } = {},
): Promise<{ status: number; json: T | undefined; headers: http.IncomingHttpHeaders }> {
  const r = await fetchText(url, { ...opts, headers: { Accept: "application/json", ...opts.headers } });
  if (r.status >= 400) return { status: r.status, json: undefined, headers: r.headers };
  try {
    return { status: r.status, json: JSON.parse(r.text) as T, headers: r.headers };
  } catch {
    throw new NetError("bad_response", "not json");
  }
}