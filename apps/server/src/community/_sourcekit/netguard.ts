import dns from "node:dns";
import net from "node:net";

/**
 * Which addresses a server-side fetch of a user-influenced URL may never reach: loopback, private
 * ranges, link-local (cloud metadata), carrier-grade NAT, multicast and reserved space, including
 * IPv4 hidden inside IPv6 (mapped, NAT64, 6to4). Names are checked after DNS resolution, at connect time.
 */

type V4 = [number, number, number, number];

function parseV4(ip: string): V4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts as V4;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when it isn't one. */
function parseV6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!net.isIPv6(ip)) return null;
  // A trailing dotted quad (::ffff:1.2.3.4) is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail) {
    const v4 = parseV4(tail[2]);
    if (!v4) return null;
    ip = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function blockedV4([a, b, c]: V4): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True when `ip` (a literal address) is somewhere a server must not fetch from. Anything unparseable counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return blockedV4(v4);
  const g = parseV6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number): V4 => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded(g[6], g[7])); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return blockedV4(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  return false;
}

export class BlockedAddressError extends Error {
  readonly code = "EBLOCKED";
  constructor(readonly host: string) {
    super(`Refusing to connect to ${host}: private or reserved address`);
  }
}

export interface NetPolicy {
  /** Allow private and loopback addresses (an owner-configured server on the LAN, or tests). */
  allowPrivate?: boolean;
  /** Exempt specific `host:port` pairs from the block (tests point the plugin at a fake upstream). */
  allow?: (host: string, port: number) => boolean;
}

/** Throws if a literal-IP host is blocked. Names are checked when they resolve (see `guardedLookup`). */
export function assertHostAllowed(hostname: string, port: number, policy: NetPolicy): void {
  if (policy.allowPrivate || policy.allow?.(hostname.replace(/^\[|\]$/g, ""), port)) return;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare) && isBlockedAddress(bare)) throw new BlockedAddressError(bare);
  if (bare.toLowerCase() === "localhost" || bare.toLowerCase().endsWith(".localhost")) throw new BlockedAddressError(bare);
}

/**
 * A `lookup` for http.request that resolves the name once and refuses to hand back a private address, so a
 * name that points inward (or flips between a public and a private address, "DNS rebinding") can't get through:
 * the address checked is the address connected to.
 */
export function guardedLookup(policy: NetPolicy, port: number) {
  return (hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = addresses as dns.LookupAddress[];
      const exempt = policy.allowPrivate || policy.allow?.(hostname, port);
      if (!exempt && list.some((a) => isBlockedAddress(a.address))) return cb(new BlockedAddressError(hostname));
      if (options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}
