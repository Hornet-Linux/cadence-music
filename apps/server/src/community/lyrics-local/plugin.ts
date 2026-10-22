import fs from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import type { ServerPlugin } from "../../plugins/types.js";

/** Lyrics files are small; anything bigger is not lyrics. */
const MAX_BYTES = 256 * 1024;

export interface LocalLyrics {
  /** Synced lyrics in LRC format, if the file or tag has timestamps. */
  lrc?: string;
  /** Plain lyrics text. */
  plain?: string;
  from: "lrc-file" | "txt-file" | "embedded";
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Format an embedded synced-lyrics tag (SYLT) as LRC text. */
export function syncTextToLrc(lines: { text: string; timestamp?: number }[]): string | null {
  const stamped = lines.filter((l) => typeof l.timestamp === "number");
  if (!stamped.length) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return stamped
    .map((l) => {
      const ms = Math.max(0, Math.round(l.timestamp!));
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const cs = Math.floor((ms % 1000) / 10);
      return `[${pad(m)}:${pad(s)}.${pad(cs)}]${l.text.replace(/[\r\n]+/g, " ")}`;
    })
    .join("\n");
}

/**
 * Find lyrics that sit next to a track: a .lrc file with the same name, a .txt file with the
 * same name, or lyrics saved in the tags of the audio file. The path must already be inside the library.
 */
export async function findLocalLyrics(abs: string): Promise<LocalLyrics | null> {
  const base = abs.slice(0, abs.length - path.extname(abs).length);
  const candidates: [string, LocalLyrics["from"]][] = [
    [".lrc", "lrc-file"],
    [".LRC", "lrc-file"],
    [".txt", "txt-file"],
    [".TXT", "txt-file"],
  ];
  for (const [ext, from] of candidates) {
    const text = await readSmall(base + ext);
    if (text?.trim()) return from === "lrc-file" ? { lrc: text, from } : { plain: text, from };
  }
  try {
    const meta = await parseFile(abs, { duration: false, skipCovers: true });
    for (const tag of meta.common.lyrics ?? []) {
      const lrc = syncTextToLrc(tag.syncText ?? []);
      if (lrc) return { lrc, from: "embedded" };
    }
    for (const tag of meta.common.lyrics ?? []) {
      if (tag.text?.trim()) return { plain: tag.text.slice(0, MAX_BYTES), from: "embedded" };
    }
  } catch {
    // Unreadable tags: no lyrics.
  }
  return null;
}

/** Lets the app read lyrics saved beside a library track (.lrc or .txt) or inside its tags. */
const plugin: ServerPlugin = {
  id: "cadence.lyrics-local",
  name: "Lyrics from the music library",
  version: "1.0.0",
  register(app, ctx) {
    const root = path.resolve(ctx.config.musicDir);
    app.get<{ Params: { id: string } }>("/api/lyrics/local/:id", { preHandler: ctx.requireUser }, async (req, reply) => {
      const row = ctx.db.prepare("SELECT rel_path FROM tracks WHERE id = ?").get(req.params.id) as { rel_path: string } | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      const abs = path.resolve(root, row.rel_path);
      if (!abs.startsWith(root + path.sep)) return reply.code(404).send({ error: "not_found" });
      const found = await findLocalLyrics(abs);
      if (!found) return reply.code(404).send({ error: "no_lyrics" });
      reply.header("Cache-Control", "private, max-age=300");
      return found;
    });
  },
};

export default plugin;
