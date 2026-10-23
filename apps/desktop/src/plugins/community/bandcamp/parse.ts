/**
 * Bandcamp has no public API for playing a person's collection, and Cadence does not scrape or work around
 * anything. What it supports is what Bandcamp itself publishes: the embeddable player (artists and labels get
 * an <iframe> snippet from the Share / Embed button of an album or track) and ordinary links.
 *
 *  - A pasted embed snippet (or just its address) becomes an official player, rebuilt here from the numeric
 *    album or track id so nothing else from the snippet is ever used.
 *  - A pasted page link (https://artist.bandcamp.com/album/name) becomes a link that opens Bandcamp. We do not
 *    fetch the page: that is where the numeric id lives, and reading it would be scraping.
 */

export type BandcampItem =
  | { kind: "embed"; type: "album" | "track"; id: string; title: string; pageUrl?: string }
  | { kind: "link"; url: string; title: string; artist: string };

export type ParseResult = { ok: true; item: BandcampItem } | { ok: false; reason: string };

const EMBED_HOST = "bandcamp.com";
const ALLOWED_SEGMENT = /^(album|track)=\d{1,15}$|^size=(large|small)$|^(bgcol|linkcol)=[0-9a-fA-F]{6}$|^tracklist=(true|false)$|^artwork=(small|none)$|^transparent=true$|^minimal=true$|^t=\d{1,3}$|^package=\d{1,15}$/;

/** Shown inside the app's dark surfaces; fixed on purpose so a snippet can't restyle the player. */
const BG = "1b1b22";
const LINK = "a3a3b2";

export function embedSrc(type: "album" | "track", id: string): string {
  return `https://${EMBED_HOST}/EmbeddedPlayer/${type}=${id}/size=large/bgcol=${BG}/linkcol=${LINK}/tracklist=false/artwork=small/transparent=true/`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");
}

/** The ids of an official embedded-player address, or null if it is anything else. */
export function parseEmbedAddress(address: string): { type: "album" | "track"; id: string } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== EMBED_HOST || url.username || url.password || url.search || url.hash || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "EmbeddedPlayer" || parts.length < 2 || parts.length > 12) return null;
  const rest = parts.slice(1);
  if (!rest.every((p) => ALLOWED_SEGMENT.test(p))) return null;
  const main = rest.filter((p) => p.startsWith("album=") || p.startsWith("track="));
  if (main.length !== 1) return null;
  const [type, id] = main[0]!.split("=") as ["album" | "track", string];
  return { type, id };
}

/** "after-dark" becomes "After dark". */
export function titleFromSlug(slug: string): string {
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  text = text.replace(/[-_]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : slug;
}

/** A Bandcamp page address: https://NAME.bandcamp.com/album/SLUG or /track/SLUG. */
export function parsePageLink(address: string): { url: string; artist: string; title: string; type: "album" | "track" } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const m = /^([a-z0-9-]+)\.bandcamp\.com$/.exec(host);
  if (!m) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || (parts[0] !== "album" && parts[0] !== "track")) return null;
  // Drop the query string and fragment (trackers); keep only what identifies the page.
  return { url: `https://${host}/${parts[0]}/${parts[1]}`, artist: m[1]!, title: titleFromSlug(parts[1]!), type: parts[0] };
}

/** Works out what a pasted piece of text is. */
export function parseBandcampInput(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "Paste a Bandcamp link or an embed code." };
  if (text.length > 4000) return { ok: false, reason: "That is too long to be a Bandcamp link or embed code." };

  // An embed snippet, or just the address from its src attribute.
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(text)?.[1] ?? (text.startsWith("https://bandcamp.com/EmbeddedPlayer/") ? text.split(/\s/)[0] : undefined);
  if (src) {
    const embed = parseEmbedAddress(decodeEntities(src));
    if (!embed) return { ok: false, reason: "That isn't an official Bandcamp player address. Use the embed code from the Share / Embed button on Bandcamp." };
    // The snippet usually has a link inside it with the title: "Album name by Artist".
    const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(text);
    const page = anchor ? parsePageLink(decodeEntities(anchor[1]!)) : null;
    const label = anchor ? decodeEntities(anchor[2]!.replace(/<[^>]*>/g, "")).trim().slice(0, 200) : "";
    return {
      ok: true,
      item: { kind: "embed", type: embed.type, id: embed.id, title: label || page?.title || `Bandcamp ${embed.type}`, pageUrl: page?.url },
    };
  }

  const link = parsePageLink(text.split(/\s/)[0]!);
  if (link) return { ok: true, item: { kind: "link", url: link.url, title: link.title, artist: link.artist } };
  return { ok: false, reason: "That doesn't look like a Bandcamp album or track link (https://name.bandcamp.com/album/…) or an embed code." };
}

export function sameItem(a: BandcampItem, b: BandcampItem): boolean {
  if (a.kind === "embed" && b.kind === "embed") return a.type === b.type && a.id === b.id;
  if (a.kind === "link" && b.kind === "link") return a.url === b.url;
  return false;
}

/** Adds an item unless it is already there (an embed replaces a link to the same page). */
export function addItem(list: BandcampItem[], item: BandcampItem): BandcampItem[] {
  if (list.some((x) => sameItem(x, item))) return list;
  if (item.kind === "embed" && item.pageUrl) return [item, ...list.filter((x) => !(x.kind === "link" && x.url === item.pageUrl))];
  return [item, ...list];
}

/** Reads the saved list back, dropping anything that is not a well-formed item. */
export function sanitizeItems(value: unknown): BandcampItem[] {
  if (!Array.isArray(value)) return [];
  const out: BandcampItem[] = [];
  for (const v of value.slice(0, 200)) {
    const o = v as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.title !== "string") continue;
    if (o.kind === "embed" && (o.type === "album" || o.type === "track") && typeof o.id === "string" && /^\d{1,15}$/.test(o.id)) {
      out.push({ kind: "embed", type: o.type, id: o.id, title: o.title.slice(0, 200), pageUrl: typeof o.pageUrl === "string" && parsePageLink(o.pageUrl) ? o.pageUrl : undefined });
    } else if (o.kind === "link" && typeof o.url === "string" && parsePageLink(o.url) && typeof o.artist === "string") {
      out.push({ kind: "link", url: o.url, title: o.title.slice(0, 200), artist: o.artist.slice(0, 100) });
    }
  }
  return out;
}
