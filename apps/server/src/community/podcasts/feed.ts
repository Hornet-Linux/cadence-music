import { child, childrenNamed, childText, decodeEntities, escapeXml, parseXml, type XmlNode } from "../_sourcekit/xml.js";
import { clean } from "../_sourcekit/common.js";

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  audioUrl: string;
  audioType: string;
  size: number;
  durationSec: number;
  publishedAt: number;
  imageUrl?: string;
  season?: number;
  episode?: number;
  chaptersUrl?: string;
}

export interface ParsedFeed {
  title: string;
  author: string;
  description: string;
  link?: string;
  imageUrl?: string;
  language: string;
  episodes: ParsedEpisode[];
  /** The document was cut off (too big or too many elements) or had more items than kept; what was readable is used. */
  truncated: boolean;
}

export class NotAFeedError extends Error {}

export function httpUrl(value: string | undefined, base?: URL, max = 2048): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text || text.length > max) return undefined;
  try {
    const u = new URL(text, base);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** "1:02:03", "42:10", "3600" or "3600.5" to seconds; 0 when it is not a duration. */
export function parseDuration(text: string | undefined): number {
  if (!text) return 0;
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.min(Math.round(Number(t)), 7 * 86400);
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:\.\d+)?$/.exec(t);
  if (!m) return 0;
  return Math.min(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), 7 * 86400);
}

/** Descriptions are HTML in the wild; the app shows plain text. */
export function htmlToText(html: string, max = 4000): string {
  const stripped = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "");
  return clean(
    decodeEntities(stripped)
      .replace(/[\u00a0 \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
    max,
  );
}

function enclosure(item: XmlNode, base: URL): { url: string; type: string; size: number } | null {
  for (const enc of findItems(item, "enclosure")) {
    const url = httpUrl(enc.attrs.url, base);
    if (url) return { url, type: clean(enc.attrs.type, 80).toLowerCase(), size: Math.max(0, Number(enc.attrs.length) || 0) };
  }
  for (const media of childrenNamed(item, "media:content")) {
    const url = httpUrl(media.attrs.url, base);
    if (url && (!media.attrs.medium || media.attrs.medium === "audio" || /^(audio|video)\//.test(media.attrs.type ?? ""))) {
      return { url, type: clean(media.attrs.type, 80).toLowerCase(), size: Math.max(0, Number(media.attrs.filesize) || 0) };
    }
  }
  // Atom: a link with rel="enclosure".
  for (const link of childrenNamed(item, "link")) {
    if (link.attrs.rel === "enclosure") {
      const url = httpUrl(link.attrs.href, base);
      if (url) return { url, type: clean(link.attrs.type, 80).toLowerCase(), size: Math.max(0, Number(link.attrs.length) || 0) };
    }
  }
  return null;
}

function image(node: XmlNode, base: URL): string | undefined {
  const it = child(node, "itunes:image")?.attrs.href;
  const rss = childText(child(node, "image"), "url");
  const atom = childText(node, "logo") || childText(node, "icon");
  return httpUrl(it, base) ?? httpUrl(rss, base) ?? httpUrl(atom, base) ?? httpUrl(child(node, "media:thumbnail")?.attrs.url, base);
}

function atomLink(node: XmlNode, base: URL): string | undefined {
  const links = childrenNamed(node, "link");
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links.find((l) => l.attrs.rel !== "self" && l.attrs.rel !== "enclosure");
  return httpUrl(alt?.attrs.href ?? alt?.text, base);
}

/** Parses an RSS 2.0 (with iTunes and Podcasting 2.0 tags) or Atom podcast feed. Malformed markup is tolerated; only a document with no feed in it throws. */
/** Items or entries wherever they sit (a feed with an unclosed tag nests them oddly), without descending into one. */
function findItems(top: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const stack: XmlNode[] = [...top.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === name) out.push(n);
    else for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

export function parseFeed(xml: string, feedUrl: string, opts: { maxItems?: number; sourceTruncated?: boolean } = {}): ParsedFeed {
  const base = new URL(feedUrl);
  const { root, truncated: capped } = parseXml(xml);
  const rss = child(root, "rss");
  const rdf = child(root, "rdf:rdf");
  const channel = child(rss, "channel") ?? child(rdf, "channel") ?? child(root, "channel");
  const atom = child(root, "feed");
  const top = channel ?? atom;
  if (!top) throw new NotAFeedError("not a feed");
  const max = opts.maxItems ?? 1000;
  const itemNodes = channel ? [...findItems(channel, "item"), ...childrenNamed(rdf, "item")] : findItems(atom!, "entry");
  const episodes: ParsedEpisode[] = [];
  for (const item of itemNodes) {
    if (episodes.length >= max) break;
    const enc = enclosure(item, base);
    if (!enc) continue;
    if (enc.type && !/^(audio|video)\//.test(enc.type) && enc.type !== "application/octet-stream" && enc.type !== "application/ogg") continue;
    const title = clean(childText(item, "title") || childText(item, "itunes:title"), 300) || "Untitled episode";
    const guid = clean(childText(item, "guid") || childText(item, "id"), 500) || enc.url;
    const dateText = childText(item, "pubdate") || childText(item, "dc:date") || childText(item, "published") || childText(item, "updated");
    const published = Date.parse(dateText);
    const season = Number(childText(item, "itunes:season"));
    const episode = Number(childText(item, "itunes:episode"));
    const description =
      childText(item, "content:encoded") || childText(item, "description") || childText(item, "itunes:summary") || childText(item, "summary") || childText(item, "content");
    episodes.push({
      guid,
      title,
      description: htmlToText(description),
      audioUrl: enc.url,
      audioType: enc.type,
      size: enc.size,
      durationSec: parseDuration(childText(item, "itunes:duration")) || parseDuration(item.children.find((c) => c.name === "media:content")?.attrs.duration),
      publishedAt: Number.isFinite(published) ? Math.min(published, Date.now() + 86_400_000) : 0,
      imageUrl: image(item, base),
      ...(Number.isInteger(season) && season > 0 ? { season } : {}),
      ...(Number.isInteger(episode) && episode > 0 ? { episode } : {}),
      chaptersUrl: httpUrl(child(item, "podcast:chapters")?.attrs.url, base),
    });
  }
  const description = childText(top, "description") || childText(top, "itunes:summary") || childText(top, "subtitle");
  return {
    title: clean(childText(top, "title") || childText(top, "itunes:title"), 300) || "Untitled podcast",
    author: clean(childText(top, "itunes:author") || childText(child(top, "author"), "name") || childText(top, "managingeditor"), 200),
    description: htmlToText(description),
    link: channel ? httpUrl(childText(channel, "link"), base) : atomLink(top, base),
    imageUrl: image(top, base),
    language: clean(childText(top, "language"), 20),
    episodes,
    truncated: capped || opts.sourceTruncated === true || itemNodes.length > max,
  };
}

export interface OpmlOutline {
  title: string;
  feedUrl: string;
}

/** The feed outlines in an OPML file (nested folders are flattened). */
export function parseOpml(xml: string, max = 500): OpmlOutline[] {
  const { root } = parseXml(xml);
  const out: OpmlOutline[] = [];
  const seen = new Set<string>();
  const walk = (node: XmlNode) => {
    for (const c of node.children) {
      if (out.length >= max) return;
      if (c.name === "outline") {
        const url = httpUrl(c.attrs.xmlurl);
        if (url && !seen.has(url)) {
          seen.add(url);
          out.push({ title: clean(c.attrs.title || c.attrs.text, 300), feedUrl: url });
        }
      }
      walk(c);
    }
  };
  walk(child(child(root, "opml"), "body") ?? root);
  return out;
}

export function buildOpml(feeds: { title: string; feedUrl: string; link?: string | null }[]): string {
  const lines = feeds.map(
    (f) => `    <outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.feedUrl)}"${f.link ? ` htmlUrl="${escapeXml(f.link)}"` : ""}/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Cadence podcast subscriptions</title></head>\n  <body>\n${lines.join("\n")}\n  </body>\n</opml>\n`;
}