import os from "node:os";
import { isIP } from "node:net";

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h) || h.endsWith(".localhost");
}

/** First non-loopback IPv4 address of this machine, if any (a hint for the address devices can reach). */
export function lanAddress(): string | undefined {
  return lanAddresses()[0];
}

/** Every non-loopback IPv4 address (used to send discovery on each network). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
  }
  return out;
}

/** True for addresses a cloud metadata service lives at; never a device on a home network. */
export function isMetadataHost(host: string): boolean {
  return isIP(host) === 4 && host.startsWith("169.254.");
}

/**
 * Parse a user-entered device address. Accepts "192.168.1.20", "192.168.1.20:1400", "host.local" or a full
 * http(s) URL. Returns a URL or null when it is not an acceptable address.
 */
export function parseAddress(input: string, defaultPort?: number, defaultPath = ""): URL | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 300) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname || isMetadataHost(url.hostname)) return null;
  if (!url.port && defaultPort) url.port = String(defaultPort);
  if (url.pathname === "/" && defaultPath) url.pathname = defaultPath;
  return url;
}
