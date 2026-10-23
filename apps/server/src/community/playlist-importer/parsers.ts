import { collapseDuplicates, MAX_ITEMS, parseCsv, parseDuration, parseJson, type ImportFormat, type ParsedItem, type ParseResult } from "./tabular.js";
import { wantedKey } from "./matcher.js";

export { MAX_ITEMS } from "./tabular.js";
export type { ImportFormat, ParsedItem, ParseResult } from "./tabular.js";

const decodeEntities = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decodeEntities(m[1]).trim() : undefined;
};

/** "Artist - Title" from a file name: drops the folder, extension and a leading track number. */
export function fromFileName(location: string): { title: string; artists: string[] } {
  const base = decodeURIComponentSafe(location.split(/[\\/]/).pop() ?? location)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, "")
    .trim();
  const dash = /^(.+?)\s+[-\u2013]\s+(.+)$/.exec(base);
  return dash ? { artists: [dash[1].trim()], title: dash[2].trim() } : { artists: [], title: base };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseM3u(text: string): { name?: string; items: ParsedItem[]; warnings: string[] } {
  const items: ParsedItem[] = [];
  let name: string | undefined;
  let pending: { title: string; artists: string[]; durationSec?: number; album?: string } | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const info = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*(?:,(.*))?$/i.exec(line);
      if (info) {
        const label = (info[2] ?? "").trim();
        const dash = /^(.+?)\s+[-\u2013]\s+(.+)$/.exec(label);
        pending = {
          title: dash ? dash[2].trim() : label,
          artists: dash ? [dash[1].trim()] : [],
          durationSec: Number(info[1]) > 0 ? Number(info[1]) : undefined,
        };
      } else if (/^#PLAYLIST:/i.test(line)) name = line.slice(10).trim() || undefined;
      else if (/^#EXTALB:/i.test(line) && pending) pending.album = line.slice(8).trim();
      else if (/^#EXTART:/i.test(line) && pending) pending.artists = [line.slice(8).trim()];
      continue;
    }
    // A location line. Without #EXTINF the title comes from the file name.
    const item = pending && pending.title ? pending : { ...fromFileName(line), durationSec: undefined, album: undefined };
    pending = null;
    if (item.title) items.push({ title: item.title, artists: item.artists, album: item.album, durationSec: item.durationSec });
  }
  return { name, items, warnings: items.length ? [] : ["No tracks were found in the playlist."] };
}

export function parseXspf(text: string): { name?: string; items: ParsedItem[]; warnings: string[] } {
  const head = text.split(/<trackList/i)[0] ?? "";
  const name = tag(head, "title");
  const items: ParsedItem[] = [];
  for (const m of text.matchAll(/<track(?:\s[^>]*)?>([\s\S]*?)<\/track>/gi)) {
    const block = m[1];
    let title = tag(block, "title") ?? "";
    let artists = [tag(block, "creator") ?? ""].filter(Boolean);
    if (!title) {
      const loc = tag(block, "location");
      if (loc) ({ title, artists } = { ...fromFileName(loc) });
    }
    const ms = Number(tag(block, "duration"));
    if (title) items.push({ title, artists, album: tag(block, "album"), durationSec: ms > 0 ? ms / 1000 : undefined });
  }
  return { name, items, warnings: items.length ? [] : ["No tracks were found in the playlist."] };
}

// ---- Apple Music / iTunes library (.xml property list) ---------------------------------------

type Plist = string | number | boolean | Plist[] | { [k: string]: Plist };

export function parsePlist(xml: string): Plist | undefined {
  const re = /<(dict|array)>|<\/(dict|array)>|<key>([\s\S]*?)<\/key>|<(string|integer|real|date|data)>([\s\S]*?)<\/\4>|<(true|false)\/>|<(string|data)\/>/g;
  type Frame = { kind: "dict"; value: { [k: string]: Plist }; key?: string } | { kind: "array"; value: Plist[] };
  const stack: Frame[] = [];
  let root: Plist | undefined;
  const put = (v: Plist) => {
    const top = stack[stack.length - 1];
    if (!top) root = v;
    else if (top.kind === "array") top.value.push(v);
    else if (top.key !== undefined) {
      top.value[top.key] = v;
      top.key = undefined;
    }
  };
  for (const m of xml.matchAll(re)) {
    if (m[1]) {
      const frame: Frame = m[1] === "dict" ? { kind: "dict", value: {} } : { kind: "array", value: [] };
      stack.push(frame);
    } else if (m[2]) {
      const done = stack.pop();
      if (done) put(done.value);
    } else if (m[3] !== undefined) {
      const top = stack[stack.length - 1];
      if (top?.kind === "dict") top.key = decodeEntities(m[3]);
    } else if (m[4]) {
      const text = decodeEntities(m[5]);
      put(m[4] === "integer" || m[4] === "real" ? Number(text) : text);
    } else if (m[6]) put(m[6] === "true");
    else put("");
  }
  return root;
}

export function parseItunesXml(xml: string, playlist?: string): ParseResult {
  const root = parsePlist(xml);
  const warnings: string[] = [];
  if (!root || typeof root !== "object" || Array.isArray(root) || typeof root.Tracks !== "object" || Array.isArray(root.Tracks)) {
    return { format: "itunes-xml", items: [], warnings: ["That does not look like an Apple Music / iTunes library export."] };
  }
  const tracks = root.Tracks as { [id: string]: Plist };
  const toItem = (t: Plist): ParsedItem | null => {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null;
    const title = typeof t.Name === "string" ? t.Name.trim() : "";
    if (!title) return null;
    const artist = typeof t.Artist === "string" ? t.Artist : typeof t["Album Artist"] === "string" ? t["Album Artist"] : "";
    const ms = typeof t["Total Time"] === "number" ? t["Total Time"] : 0;
    return { title, artists: artist ? [artist] : [], album: typeof t.Album === "string" ? t.Album : undefined, durationSec: ms > 0 ? ms / 1000 : undefined };
  };
  const playlists = (Array.isArray(root.Playlists) ? root.Playlists : []).filter(
    (p): p is { [k: string]: Plist } => !!p && typeof p === "object" && !Array.isArray(p),
  );
  const user = playlists.filter((p) => !p.Master && !p["Distinguished Kind"] && Array.isArray(p["Playlist Items"]) && (p["Playlist Items"] as Plist[]).length > 0);
  const idOf = (p: { [k: string]: Plist }) => String(p["Playlist ID"] ?? p.Name ?? "");
  const itemsOf = (p: { [k: string]: Plist }): ParsedItem[] =>
    (p["Playlist Items"] as Plist[])
      .map((ref) => (ref && typeof ref === "object" && !Array.isArray(ref) ? toItem(tracks[String(ref["Track ID"])]) : null))
      .filter((i): i is ParsedItem => i !== null);

  const chosen = playlist ? user.find((p) => idOf(p) === playlist || p.Name === playlist) : user.length === 1 ? user[0] : undefined;
  if (chosen) return { format: "itunes-xml", name: typeof chosen.Name === "string" ? chosen.Name : undefined, items: itemsOf(chosen), warnings };
  if (user.length > 1 && !playlist) {
    return {
      format: "itunes-xml",
      items: [],
      choices: user.map((p) => ({ id: idOf(p), name: String(p.Name ?? "Untitled"), trackCount: (p["Playlist Items"] as Plist[]).length })),
      warnings: ["This library has several playlists. Pick one to import."],
    };
  }
  if (playlist) warnings.push("That playlist was not found, so the whole library is shown.");
  const all = Object.values(tracks).map(toItem).filter((i): i is ParsedItem => i !== null);
  return { format: "itunes-xml", name: "Apple Music library", items: all, warnings };
}

// ---- Entry point -----------------------------------------------------------------------------

export function detectFormat(text: string, filename = ""): ImportFormat {
  const name = filename.toLowerCase();
  const head = text.slice(0, 2000).trimStart();
  if (/\.(m3u8?|pls)$/.test(name) || head.startsWith("#EXTM3U")) return "m3u";
  if (/<playlist[\s>]/i.test(head) && /xspf/i.test(head)) return "xspf";
  if (/<plist[\s>]/i.test(head) || /<!DOCTYPE plist/i.test(head)) return "itunes-xml";
  if (/\.xspf$/.test(name)) return "xspf";
  if (/\.xml$/.test(name)) return /<plist/i.test(head) ? "itunes-xml" : "xspf";
  if (/\.json$/.test(name) || head.startsWith("{") || head.startsWith("[")) return "json";
  if (/\.(csv|tsv|txt)$/.test(name)) return "csv";
  // A bare list of "Artist - Title" lines or file names is treated like an M3U without headers.
  if (!/[,;\t]/.test(head.split(/\r?\n/, 1)[0] ?? "")) return "m3u";
  return "csv";
}

export function parseImport(text: string, options: { format?: ImportFormat; filename?: string; playlist?: string } = {}): ParseResult {
  const format = options.format ?? detectFormat(text, options.filename);
  let result: ParseResult;
  switch (format) {
    case "m3u":
      result = { format, ...parseM3u(text) };
      break;
    case "xspf":
      result = { format, ...parseXspf(text) };
      break;
    case "json":
      result = { format, ...parseJson(text) };
      break;
    case "itunes-xml":
      result = parseItunesXml(text, options.playlist);
      break;
    default:
      result = { format: "csv", ...parseCsv(text) };
  }
  if (result.items.length > MAX_ITEMS) {
    result.warnings.push(`Only the first ${MAX_ITEMS} tracks are used.`);
    result.items = result.items.slice(0, MAX_ITEMS);
  }
  // The same song appearing many times (a scrobble export) becomes one entry with a play count.
  result.items = collapseDuplicates(result.items, wantedKey);
  return result;
}

export { parseDuration };