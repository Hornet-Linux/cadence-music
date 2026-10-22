import path from "node:path";
import type { Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { ffmpegInfo } from "../_serverlib/ffmpeg.js";
import { deepIndexer, ensureFactsTable, factsIndexer, folderHasArt, resolveInside } from "../_serverlib/facts.js";
import { buildReport, type HealthReport, type HealthTrack } from "./report.js";

interface Row {
  id: string;
  rel_path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  size: number;
  duration_sec: number | null;
  f_id: string | null;
  genre: string | null;
  year: number | null;
  has_artwork: number | null;
  has_title_tag: number | null;
  probe_duration: number | null;
  bitrate: number | null;
  codec: string | null;
  lossless: number | null;
  error: string | null;
  decode_error: string | null;
}

/** Everything the report needs, joined from the core track list and the shared tag facts. */
export async function loadHealthTracks(db: Db, musicRoot: string): Promise<HealthTrack[]> {
  const rows = db
    .prepare(
      `SELECT t.id, t.rel_path, t.title, t.artist, t.album, t.album_artist, t.track_no, t.size, t.duration_sec,
              f.track_id AS f_id, f.genre, f.year, f.has_artwork, f.has_title_tag, f.probe_duration,
              f.bitrate, f.codec, f.lossless, f.error, f.decode_error
         FROM tracks t LEFT JOIN track_facts f ON f.track_id = t.id`,
    )
    .all() as unknown as Row[];
  // Cover files (cover.jpg, folder.png...) count as artwork; look at each folder once.
  const folderArt = new Map<string, boolean>();
  for (const r of rows) {
    if (r.f_id === null || r.has_artwork === 1) continue;
    const abs = resolveInside(musicRoot, r.rel_path);
    if (!abs) continue;
    const dir = path.dirname(abs);
    if (!folderArt.has(dir)) folderArt.set(dir, await folderHasArt(dir));
  }
  const hasArtwork = (r: Row): boolean | null => {
    if (r.f_id === null) return null;
    if (r.has_artwork === 1) return true;
    const abs = resolveInside(musicRoot, r.rel_path);
    return abs ? (folderArt.get(path.dirname(abs)) ?? false) : false;
  };
  return rows.map((r) => ({
    id: r.id,
    relPath: r.rel_path,
    title: r.title,
    artist: r.artist,
    album: r.album,
    albumArtist: r.album_artist,
    trackNo: r.track_no,
    size: r.size,
    durationSec: r.duration_sec ?? r.probe_duration,
    genre: r.genre,
    year: r.year,
    hasArtwork: hasArtwork(r),
    hasTitleTag: r.f_id === null ? null : r.has_title_tag === 1,
    indexed: r.f_id !== null,
    error: r.error,
    decodeError: r.decode_error,
    bitrate: r.bitrate,
    codec: r.codec,
    lossless: r.lossless === null ? null : r.lossless === 1,
  }));
}

/**
 * Library health: duplicates, missing tags and artwork, unreadable or corrupt files.
 * Read-only: it reports, never changes or deletes anything in the music folder.
 */
export const libraryHealthPlugin: ServerPlugin = {
  id: "cadence.library-health",
  name: "Library health",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireAdmin } = ctx;
    ensureFactsTable(db);
    const musicRoot = path.resolve(ctx.config.musicDir);
    const indexer = factsIndexer(db, musicRoot, ctx.log);
    const deep = deepIndexer(db, musicRoot, ctx.log);
    let cached: { report: HealthReport; limit: number; version: string; at: number } | null = null;

    // Pick up new and changed files every half hour; unchanged files are skipped.
    ctx.jobs.every(
      "library-health-index",
      30 * 60_000,
      async () => {
        if (indexer.pending() > 0) await indexer.start();
      },
      { runSoon: true },
    );
    app.addHook("onClose", async () => {
      await indexer.stop();
      await deep.stop();
    });

    const fingerprint = () => {
      const r = db
        .prepare("SELECT (SELECT COUNT(*) FROM tracks) AS t, (SELECT COUNT(*) FROM track_facts) AS f, (SELECT MAX(indexed_at) FROM track_facts) AS i, (SELECT MAX(deep_checked_at) FROM track_facts) AS d, (SELECT MAX(mtime_ms) FROM tracks) AS m")
        .get() as unknown as Record<string, number | null>;
      return JSON.stringify(r);
    };

    app.get<{ Querystring: { limit?: string } }>("/api/library-health/report", { preHandler: requireAdmin }, async (req) => {
      const n = Number(req.query.limit);
      const limit = Number.isInteger(n) ? Math.min(2000, Math.max(1, n)) : 200;
      const version = fingerprint();
      if (!cached || cached.version !== version || cached.limit !== limit || Date.now() - cached.at > 15_000) {
        cached = { report: buildReport(await loadHealthTracks(db, musicRoot), limit), limit, version, at: Date.now() };
      }
      return cached.report;
    });

    app.get("/api/library-health/status", { preHandler: requireAdmin }, async () => {
      const info = await ffmpegInfo();
      return {
        ffmpeg: { available: info.available, version: info.version },
        indexing: { ...indexer.status(), pending: indexer.pending() },
        deepScan: { ...deep.status(), pending: deep.pending() },
      };
    });

    app.post<{ Querystring: { deep?: string; wait?: string } }>(
      "/api/library-health/scan",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const wantDeep = req.query.deep === "1";
        if (wantDeep && !(await ffmpegInfo()).available) {
          return reply.code(409).send({ error: "ffmpeg_missing", message: "The deep scan needs ffmpeg on the server." });
        }
        const run = (async () => {
          await indexer.start();
          if (wantDeep) await deep.start();
        })();
        if (req.query.wait === "1") {
          await run;
          return { done: true };
        }
        run.catch((err) => ctx.log.warn({ err }, "library health scan failed"));
        return reply.code(202).send({ started: true });
      },
    );

    app.post("/api/library-health/stop", { preHandler: requireAdmin }, async () => {
      await Promise.all([indexer.stop(), deep.stop()]);
      return { stopped: true };
    });
  },
};

export default libraryHealthPlugin;