/** Helpers for passing an HLS live stream through the server: every playlist line is rewritten to a signed server URL. */

export const MAX_PLAYLIST_BYTES = 1_000_000;
const MAX_LINES = 20_000;

export function looksLikeHls(text: string): boolean {
  return /^\uFEFF?#EXTM3U/.test(text.trimStart()) && /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MEDIA:|VERSION|PLAYLIST-TYPE)/.test(text);
}

/**
 * Rewrites the URIs in a playlist. `mk` turns an absolute http(s) URL into the proxied one; lines with other
 * schemes are dropped so nothing can point the player (or the server) at file:, data: and the like.
 */
export function rewritePlaylist(text: string, base: URL, mk: (absolute: URL) => string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").slice(0, MAX_LINES);
  const resolve = (ref: string): string | null => {
    try {
      const u = new URL(ref, base);
      return u.protocol === "http:" || u.protocol === "https:" ? mk(u) : null;
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      out.push(line.replace(/URI="([^"]*)"/g, (_whole, uri: string) => {
        const mapped = resolve(uri);
        return mapped ? `URI="${mapped}"` : 'URI=""';
      }));
      continue;
    }
    const mapped = resolve(line);
    if (mapped) out.push(mapped);
  }
  return out.join("\n") + "\n";
}

/** The first stream address in a .pls or .m3u playlist, or null. */
export function firstPlaylistEntry(text: string, base: URL): URL | null {
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = raw.trim();
    const m = /^File\d*=(.+)$/i.exec(line);
    const ref = m ? m[1].trim() : line && !line.startsWith("#") && !line.startsWith("[") && !line.includes("=") ? line : null;
    if (!ref) continue;
    try {
      const u = new URL(ref, base);
      if (u.protocol === "http:" || u.protocol === "https:") return u;
    } catch {
      // try the next line
    }
  }
  return null;
}