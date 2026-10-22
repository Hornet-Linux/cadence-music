import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { parseFile } from "music-metadata";
import type { Db } from "../../db.js";
import { BatchRunner } from "./batch.js";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * "Track facts": extra tag details the core scanner does not keep (genre, year, artwork, codec)
 * plus read problems. Several community plugins need them (library health, smart playlists), so
 * they share this table and one indexer per database. Nothing here ever touches the audio files.
 */
export function ensureFactsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_facts (
      track_id TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      genre TEXT,
      year INTEGER,
      disc_no INTEGER,
      has_artwork INTEGER NOT NULL DEFAULT 0,
      has_title_tag INTEGER NOT NULL DEFAULT 0,
      probe_duration REAL,
      bitrate INTEGER,
      sample_rate INTEGER,
      codec TEXT,
      lossless INTEGER,
      error TEXT,
      decode_error TEXT,
      deep_checked_at INTEGER,
      indexed_at INTEGER NOT NULL
    );
  `);
}

/** Cached content samples for files that share a size with another file (used to confirm duplicates). */
export function ensureHashTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_hash (
      track_id TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT
    );
  `);
}

const SAMPLE = 64 * 1024;

/** SHA-1 over the whole file when small, otherwise its start, middle and end plus its size: cheap, and equal only for (near) identical files. */
export async function sampleHash(abs: string, size: number): Promise<string> {
  if (size <= SAMPLE * 3)
    return createHash("sha1")
      .update(String(size))
      .update(await fs.promises.readFile(abs))
      .digest("hex");
  const handle = await fs.promises.open(abs, "r");
  try {
    const hash = createHash("sha1").update(String(size));
    const buf = Buffer.alloc(SAMPLE);
    for (const at of [0, Math.floor((size - SAMPLE) / 2), size - SAMPLE]) {
      const { bytesRead } = await handle.read(buf, 0, SAMPLE, at);
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export interface PendingTrack {
  id: string;
  rel_path: string;
  size: number;
  mtime_ms: number;
}

/** Tracks never indexed, or changed on disk since. */
export function pendingFacts(db: Db): PendingTrack[] {
  return db
    .prepare(
      `SELECT t.id, t.rel_path, t.size, t.mtime_ms FROM tracks t
         LEFT JOIN track_facts f ON f.track_id = t.id
        WHERE f.track_id IS NULL OR f.size != t.size OR f.mtime_ms != t.mtime_ms
        ORDER BY t.rel_path`,
    )
    .all() as unknown as PendingTrack[];
}

/** Drop rows for tracks the library no longer has. */
export function cleanupFacts(db: Db): void {
  db.exec("DELETE FROM track_facts WHERE track_id NOT IN (SELECT id FROM tracks)");
}

const ART_NAMES = /^(cover|folder|front|album|albumart|artwork|art)\.(jpe?g|png|webp|gif|bmp)$/i;
const folderArtCache = new Map<string, { mtimeMs: number; found: boolean }>();

/** Does the folder hold a cover.jpg / folder.png style image? Re-read only when the folder changed. */
export async function folderHasArt(dir: string): Promise<boolean> {
  try {
    const mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
    const hit = folderArtCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.found;
    const found = (await fs.promises.readdir(dir)).some((name) => ART_NAMES.test(name));
    if (folderArtCache.size > 5000) folderArtCache.clear();
    folderArtCache.set(dir, { mtimeMs, found });
    return found;
  } catch {
    // Unreadable folder: treat as no artwork.
    return false;
  }
}

/** Resolve a library-relative path inside the music folder, or null if it would escape. */
export function resolveInside(musicRoot: string, rel: string): string | null {
  const abs = path.resolve(musicRoot, rel);
  return abs.startsWith(path.resolve(musicRoot) + path.sep) ? abs : null;
}

/** Read one file, record its tags (and failures, so a bad file is reported once). */
export async function indexTrackFacts(db: Db, musicRoot: string, row: PendingTrack): Promise<void> {
  const abs = resolveInside(musicRoot, row.rel_path);
  const put = db.prepare(
    `INSERT INTO track_facts (track_id, size, mtime_ms, genre, year, disc_no, has_artwork, has_title_tag,
                              probe_duration, bitrate, sample_rate, codec, lossless, error, decode_error,
                              deep_checked_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT (track_id) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms, genre = excluded.genre, year = excluded.year,
       disc_no = excluded.disc_no, has_artwork = excluded.has_artwork, has_title_tag = excluded.has_title_tag,
       probe_duration = excluded.probe_duration, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
       codec = excluded.codec, lossless = excluded.lossless, error = excluded.error,
       decode_error = NULL, deep_checked_at = NULL, indexed_at = excluded.indexed_at`,
  );
  const now = Date.now();
  const fail = (message: string) =>
    put.run(row.id, row.size, row.mtime_ms, null, null, null, 0, 0, null, null, null, null, null, message, now);
  if (!abs) return void fail("path outside the music folder");
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch (err) {
    return void fail("unreadable: " + ((err as NodeJS.ErrnoException).code ?? "cannot open"));
  }
  if (stat.size === 0) return void fail("empty file");
  try {
    const meta = await parseFile(abs, { duration: true, skipCovers: false });
    const c = meta.common;
    const duration =
      typeof meta.format.duration === "number" && Number.isFinite(meta.format.duration) ? meta.format.duration : null;
    const year = c.year ?? (c.date ? Number.parseInt(c.date.slice(0, 4), 10) : null);
    // Embedded art only: cover files next to the music can appear later, so reports look at folders live.
    const hasArt = (c.picture?.length ?? 0) > 0;
    let problem: string | null = null;
    if (duration === null || duration <= 0) problem = "no playable duration (file may be truncated or corrupt)";
    put.run(
      row.id,
      row.size,
      row.mtime_ms,
      c.genre?.[0]?.trim() || null,
      year !== null && Number.isFinite(year) && year > 0 ? year : null,
      c.disk?.no ?? null,
      hasArt ? 1 : 0,
      c.title?.trim() ? 1 : 0,
      duration,
      meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
      meta.format.sampleRate ?? null,
      meta.format.codec ?? null,
      meta.format.lossless === undefined ? null : meta.format.lossless ? 1 : 0,
      problem,
      now,
    );
  } catch (err) {
    fail("unreadable tags: " + (err as Error).message.slice(0, 160));
  }
}

/**
 * Decode the whole file with ffmpeg and record any errors it reports. Slow, so it is a separate,
 * opt-in pass (deep scan). Requires ffmpeg.
 */
export async function deepCheckTrack(db: Db, musicRoot: string, row: PendingTrack, signal?: AbortSignal): Promise<void> {
  const abs = resolveInside(musicRoot, row.rel_path);
  if (!abs) return;
  const res = await runFfmpeg(["-v", "error", "-xerror", "-i", abs, "-f", "null", "-"], { timeoutMs: 10 * 60_000, signal });
  if (signal?.aborted) return;
  const text = res.stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 300);
  const bad = res.code !== 0 || text.length > 0;
  db.prepare("UPDATE track_facts SET decode_error = ?, deep_checked_at = ? WHERE track_id = ?").run(
    bad ? text || "ffmpeg exited with code " + String(res.code) : null,
    Date.now(),
    row.id,
  );
}

const indexers = new WeakMap<Db, BatchRunner<PendingTrack>>();
const deepers = new WeakMap<Db, BatchRunner<PendingTrack>>();

/** The shared tag indexer for this database (one run at a time, however many plugins ask). */
export function factsIndexer(db: Db, musicRoot: string, log?: FastifyBaseLogger): BatchRunner<PendingTrack> {
  let runner = indexers.get(db);
  if (!runner) {
    ensureFactsTable(db);
    runner = new BatchRunner<PendingTrack>({
      name: "track-facts",
      list: () => {
        cleanupFacts(db);
        return pendingFacts(db);
      },
      label: (t) => t.rel_path,
      work: (t) => indexTrackFacts(db, musicRoot, t),
      pauseMs: 5,
      log,
    });
    indexers.set(db, runner);
  }
  return runner;
}

/** The shared ffmpeg decode check (deep scan). */
export function deepIndexer(db: Db, musicRoot: string, log?: FastifyBaseLogger): BatchRunner<PendingTrack> {
  let runner = deepers.get(db);
  if (!runner) {
    ensureFactsTable(db);
    runner = new BatchRunner<PendingTrack>({
      name: "deep-check",
      list: () =>
        db
          .prepare(
            `SELECT t.id, t.rel_path, t.size, t.mtime_ms FROM tracks t
               JOIN track_facts f ON f.track_id = t.id
              WHERE f.deep_checked_at IS NULL AND f.error IS NULL ORDER BY t.rel_path`,
          )
          .all() as unknown as PendingTrack[],
      label: (t) => t.rel_path,
      work: (t, signal) => deepCheckTrack(db, musicRoot, t, signal),
      pauseMs: 250,
      log,
    });
    deepers.set(db, runner);
  }
  return runner;
}
