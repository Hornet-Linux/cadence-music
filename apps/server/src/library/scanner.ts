import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import type { ScanResult } from "@uma/shared";
import { transaction, type Db } from "../db.js";

/** Formats Chromium (and so the desktop app) can play. */
export const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export function contentTypeFor(file: string): string {
  return AUDIO_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function trackIdFor(relPath: string): string {
  return createHash("sha1").update(relPath).digest("hex").slice(0, 24);
}

interface FoundFile {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

async function* walk(root: string, dir: string): AsyncGenerator<FoundFile> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, abs);
      continue;
    }
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    if (!(path.extname(entry.name).toLowerCase() in AUDIO_TYPES)) continue;
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      yield { abs, rel, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
    } catch {
      // Vanished or unreadable; skip.
    }
  }
}

interface ParsedTrack {
  id: string;
  rel: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
  size: number;
  mtimeMs: number;
}

async function readTags(file: FoundFile): Promise<ParsedTrack> {
  const fallbackTitle = path.basename(file.rel, path.extname(file.rel));
  const base: ParsedTrack = {
    id: trackIdFor(file.rel),
    rel: file.rel,
    title: fallbackTitle,
    artist: null,
    album: null,
    albumArtist: null,
    trackNo: null,
    durationSec: null,
    size: file.size,
    mtimeMs: file.mtimeMs,
  };
  try {
    const meta = await parseFile(file.abs, { duration: false, skipCovers: true });
    const c = meta.common;
    return {
      ...base,
      title: c.title?.trim() || fallbackTitle,
      artist: c.artist?.trim() || null,
      album: c.album?.trim() || null,
      albumArtist: c.albumartist?.trim() || null,
      trackNo: c.track?.no ?? null,
      durationSec:
        typeof meta.format.duration === "number" && Number.isFinite(meta.format.duration)
          ? meta.format.duration
          : null,
    };
  } catch {
    return base;
  }
}

/** Sync the tracks table with the files under `musicDir`. */
export async function scanLibrary(db: Db, musicDir: string): Promise<ScanResult> {
  const known = new Map<string, { size: number; mtime_ms: number }>();
  for (const row of db.prepare("SELECT id, size, mtime_ms FROM tracks").all() as {
    id: string;
    size: number;
    mtime_ms: number;
  }[]) {
    known.set(row.id, { size: row.size, mtime_ms: row.mtime_ms });
  }

  const seen = new Set<string>();
  const changed: ParsedTrack[] = [];
  let added = 0;
  let updated = 0;

  for await (const file of walk(musicDir, musicDir)) {
    const id = trackIdFor(file.rel);
    seen.add(id);
    const prev = known.get(id);
    if (prev && prev.size === file.size && prev.mtime_ms === file.mtimeMs) continue;
    changed.push(await readTags(file));
    if (prev) updated++;
    else added++;
  }

  const removedIds = [...known.keys()].filter((id) => !seen.has(id));
  const now = Date.now();

  transaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO tracks (id, rel_path, title, artist, album, album_artist, track_no,
                           duration_sec, size, mtime_ms, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         rel_path = excluded.rel_path, title = excluded.title, artist = excluded.artist,
         album = excluded.album, album_artist = excluded.album_artist,
         track_no = excluded.track_no, duration_sec = excluded.duration_sec,
         size = excluded.size, mtime_ms = excluded.mtime_ms`,
    );
    for (const t of changed) {
      upsert.run(
        t.id,
        t.rel,
        t.title,
        t.artist,
        t.album,
        t.albumArtist,
        t.trackNo,
        t.durationSec,
        t.size,
        t.mtimeMs,
        now,
      );
    }
    const remove = db.prepare("DELETE FROM tracks WHERE id = ?");
    for (const id of removedIds) remove.run(id);
  });

  const total = (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
  return { added, updated, removed: removedIds.length, total };
}
