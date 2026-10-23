import { crc32 } from "node:zlib";

/** The parts of a track the exports need. */
export interface ExportTrack {
  id: string;
  title: string;
  artists: { name: string }[];
  album?: string;
  durationSec?: number;
  source?: string;
}

export interface ExportPlay {
  playedAt: number;
  track: ExportTrack;
}

const artistLine = (t: ExportTrack) => t.artists.map((a) => a.name).filter(Boolean).join(", ");

/** One line only: playlist formats break on embedded newlines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

/** Remove characters that are illegal in XML 1.0. */
// eslint-disable-next-line no-control-regex
const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

export function xmlEscape(s: string): string {
  return xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Where a player can find the track: a relative file path for library tracks, otherwise the track's own id/URI. */
export type Locate = (track: ExportTrack) => string;

export function toM3U(name: string, tracks: ExportTrack[], locate: Locate): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${oneLine(name)}`];
  for (const t of tracks) {
    const secs = t.durationSec && t.durationSec > 0 ? Math.round(t.durationSec) : -1;
    const who = artistLine(t);
    lines.push(`#EXTINF:${secs},${oneLine(who ? `${who} - ${t.title}` : t.title)}`);
    if (t.album) lines.push(`#EXTALB:${oneLine(t.album)}`);
    lines.push(oneLine(locate(t)));
  }
  return lines.join("\n") + "\n";
}

export function toXSPF(name: string, tracks: ExportTrack[], locate: Locate): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<playlist version="1" xmlns="http://xspf.org/ns/0/">', `  <title>${xmlEscape(name)}</title>`, "  <trackList>"];
  for (const t of tracks) {
    out.push("    <track>");
    const loc = locate(t);
    // XSPF locations are URIs; paths are percent-encoded, other URIs (spotify:...) are kept as they are.
    out.push(`      <location>${xmlEscape(/^[a-z][a-z0-9+.-]*:/i.test(loc) ? loc : encodeURI(loc))}</location>`);
    out.push(`      <identifier>${xmlEscape(t.id)}</identifier>`);
    out.push(`      <title>${xmlEscape(t.title)}</title>`);
    const who = artistLine(t);
    if (who) out.push(`      <creator>${xmlEscape(who)}</creator>`);
    if (t.album) out.push(`      <album>${xmlEscape(t.album)}</album>`);
    if (t.durationSec && t.durationSec > 0) out.push(`      <duration>${Math.round(t.durationSec * 1000)}</duration>`);
    out.push("    </track>");
  }
  out.push("  </trackList>", "</playlist>");
  return out.join("\n") + "\n";
}

/**
 * One CSV cell. Quotes when needed (RFC 4180). A cell that starts with = + - @ is prefixed with a
 * single quote so a spreadsheet does not run it as a formula (CSV injection).
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function historyToCsv(plays: ExportPlay[]): string {
  const rows = ["played_at,title,artists,album,duration_sec,source,track_id"];
  for (const p of plays) {
    rows.push(
      [new Date(p.playedAt).toISOString(), p.track.title, artistLine(p.track), p.track.album, p.track.durationSec, p.track.source, p.track.id]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\r\n") + "\r\n";
}

export function historyToJson(plays: ExportPlay[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: plays.length,
      plays: plays.map((p) => ({
        playedAt: new Date(p.playedAt).toISOString(),
        title: p.track.title,
        artists: p.track.artists.map((a) => a.name),
        album: p.track.album ?? null,
        durationSec: p.track.durationSec ?? null,
        source: p.track.source ?? null,
        trackId: p.track.id,
      })),
    },
    null,
    2,
  );
}

/** A safe file name stem: letters, digits, spaces and a few marks; never empty. */
export function fileStem(name: string, fallback = "playlist"): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w .()-]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem && !/^\.+$/.test(stem) ? stem : fallback;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  modified?: Date;
}

/** A minimal ZIP writer (stored, no compression). Enough for a few text files and needs no dependency. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const when = entry.modified ?? new Date();
    const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    const date = (Math.max(0, when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, entry.data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(entry.data.length, 20);
    head.writeUInt32LE(entry.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}