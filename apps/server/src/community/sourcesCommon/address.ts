import { isIP } from "node:net";

/**
 * Parsing of the address the server owner gives for a music server.
 *
 * Only the owner sets it, never ordinary users: a URL a user could supply is a
 * URL the server would fetch on their behalf. Accepts http(s) addresses with an
 * optional path (a server behind a reverse proxy at /navidrome). Credentials,
 * query strings and fragments are never what an owner means, so they are refused.
 *
 * Cloud metadata endpoints and link-local addresses are refused too, because a
 * mistyped or malicious value there would hand out instance credentials; an owner
 * who really means such an address passes `allowLinkLocal`.
 */
export interface ParseOptions {
  /** Shown in the error for an empty value, for example "your Subsonic server". */
  what: string;
  /** Shown as the example form, for example "http://navidrome:4533". */
  example: string;
  allowLinkLocal?: boolean;
}

const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);
const METADATA_IPS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192", "fd00:ec2::254"]);

/** True for link-local ranges and well-known cloud metadata hosts. */
export function isMetadataOrLinkLocal(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (METADATA_HOSTS.has(host) || METADATA_IPS.has(host)) return true;
  // URL normalises ::ffff:169.254.169.254 to hex groups (::ffff:a9fe:a9fe).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    host = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (v4) host = v4[1];
  const family = isIP(host);
  if (family === 4) return host.startsWith("169.254.") || METADATA_IPS.has(host);
  if (family === 6) return /^fe[89ab][0-9a-f]:/.test(host) || METADATA_IPS.has(host);
  return false;
}

export function parseServiceUrl(raw: string, opts: ParseOptions): string {
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) throw new Error(`Enter the address of ${opts.what}`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`That isn't a valid address. Use a form like ${opts.example}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) {
    throw new Error("The address must not contain a query string or fragment");
  }
  if (!url.hostname) throw new Error("The address needs a host name");
  if (!opts.allowLinkLocal && isMetadataOrLinkLocal(url.hostname)) {
    throw new Error("That address points at a link-local or cloud metadata endpoint, which Cadence won't call");
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}