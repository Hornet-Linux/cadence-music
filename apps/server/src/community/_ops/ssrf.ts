import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** True for addresses that are not on the public internet (loopback, LAN, link-local, carrier NAT, reserved). */
export function isPrivateAddress(address: string): boolean {
  let ip = address.trim().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (net.isIPv4(ip)) return isPrivateV4(ip.split(".").map(Number));
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // Not an IP at all: refuse rather than guess.
}

function isPrivateV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 address to eight 16-bit groups. */
function groupsOf(ip: string): number[] {
  let text = ip.toLowerCase();
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const missing = tail !== undefined ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array<string>(Math.max(0, missing)).fill("0"), ...right];
  return all.map((g) => parseInt(g || "0", 16));
}

function isPrivateV6(ip: string): boolean {
  const g = groupsOf(ip);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return true;
  const embeddedV4 = (hi: number, lo: number) => isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true; // :: and ::1
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return embeddedV4(g[6], g[7]); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return embeddedV4(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

export class UrlRejected extends Error {
  constructor(
    readonly code: "invalid_url" | "blocked_address",
    message: string,
  ) {
    super(message);
    this.name = "UrlRejected";
  }
}

/** Parse a destination URL: http(s) only, no embedded credentials. */
export function parseTargetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlRejected("invalid_url", "That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlRejected("invalid_url", "Only http and https URLs are allowed.");
  if (url.username || url.password) throw new UrlRejected("invalid_url", "Put credentials in a header or the secret, not in the URL.");
  if (!url.hostname) throw new UrlRejected("invalid_url", "The URL has no host.");
  return url;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Let the request go to loopback / LAN addresses (the admin must opt in per destination). */
  allowPrivate?: boolean;
  /** Replaceable for tests. */
  lookup?: typeof dns.lookup;
}

export interface SafeResponse {
  status: number;
  /** First part of the response body, for the delivery log. */
  body: string;
}

const MAX_BODY_KEPT = 2048;

/**
 * Send one HTTP request with SSRF protection. The address check runs inside the connection's DNS
 * lookup, so the address that is checked is the address that is used (no DNS-rebinding window).
 * Redirects are not followed.
 */
export async function safeRequest(rawUrl: string, options: SafeRequestOptions = {}): Promise<SafeResponse> {
  const url = parseTargetUrl(rawUrl);
  const { allowPrivate = false, timeoutMs = 10_000 } = options;
  const realLookup = options.lookup ?? dns.lookup;

  // IP literals skip DNS, so check them up front.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && !allowPrivate && isPrivateAddress(literal)) {
    return Promise.reject(new UrlRejected("blocked_address", `Refusing to send to a private address (${literal}).`));
  }

  const guardedLookup = ((hostname: string, lookupOptions: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    realLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      const usable = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (usable.length === 0) {
        return callback(
          new UrlRejected("blocked_address", `Refusing to send to a private address (${hostname} resolves to ${list.map((a) => a.address).join(", ")}).`),
        );
      }
      if (lookupOptions.all) return callback(null, usable);
      callback(null, usable[0].address, usable[0].family);
    });
  }) as unknown as typeof dns.lookup;

  const transport = url.protocol === "https:" ? https : http;
  return new Promise<SafeResponse>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? "POST",
        headers: { ...options.headers, ...(options.body !== undefined ? { "content-length": String(Buffer.byteLength(options.body)) } : {}) },
        lookup: guardedLookup,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY_KEPT) });
        };
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_KEPT) chunks.push(chunk);
          if (size > 64 * 1024) res.destroy();
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
