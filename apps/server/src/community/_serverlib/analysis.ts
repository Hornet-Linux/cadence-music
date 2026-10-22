import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db.js";
import { BatchRunner } from "./batch.js";
import { resolveInside } from "./facts.js";

export interface PendingAnalysis {
  id: string;
  rel_path: string;
  size: number;
  mtime_ms: number;
}

/**
 * Tracks with no result yet, or whose file changed since. `table` must have track_id, size and
 * mtime_ms columns. A failed file keeps its row (with an error), so it is not retried until it changes.
 */
export function pendingAnalysis(db: Db, table: "track_loudness" | "track_audio"): PendingAnalysis[] {
  return db
    .prepare(
      `SELECT t.id, t.rel_path, t.size, t.mtime_ms FROM tracks t
         LEFT JOIN ${table} a ON a.track_id = t.id
        WHERE a.track_id IS NULL OR a.size != t.size OR a.mtime_ms != t.mtime_ms
        ORDER BY t.added_at DESC, t.rel_path`,
    )
    .all() as unknown as PendingAnalysis[];
}

/** Tracks analysed and tracks the analysis failed on, for progress displays. */
export function analysisCounts(
  db: Db,
  table: "track_loudness" | "track_audio",
  pending: number,
): { total: number; analysed: number; failed: number; pending: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
  const failed = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE error IS NOT NULL`).get() as { n: number }).n;
  return { total, analysed: Math.max(0, total - pending - failed), failed, pending };
}

export interface AnalysisRunnerOptions<R> {
  db: Db;
  table: "track_loudness" | "track_audio";
  musicRoot: string;
  log?: FastifyBaseLogger;
  name: string;
  /** Rest between tracks (read fresh each time, so settings changes apply at once). */
  pauseMs: () => number;
  analyze: (absPath: string, signal: AbortSignal) => Promise<R>;
  store: (track: PendingAnalysis, result: R | null, error: string | null) => void;
}

/** A resumable, throttled, one-at-a-time analysis job over every track that still needs it. */
export function analysisRunner<R>(opts: AnalysisRunnerOptions<R>): BatchRunner<PendingAnalysis> {
  return new BatchRunner<PendingAnalysis>({
    name: opts.name,
    list: () => {
      // Results for tracks that left the library are of no use.
      opts.db.exec(`DELETE FROM ${opts.table} WHERE track_id NOT IN (SELECT id FROM tracks)`);
      return pendingAnalysis(opts.db, opts.table);
    },
    label: (t) => t.rel_path,
    pauseMs: opts.pauseMs,
    log: opts.log,
    work: async (t, signal) => {
      try {
        const abs = resolveInside(opts.musicRoot, t.rel_path);
        if (!abs) throw new Error("path outside the music folder");
        opts.store(t, await opts.analyze(abs, signal), null);
      } catch (err) {
        if (signal.aborted) throw err;
        opts.store(t, null, (err as Error).message.slice(0, 200));
      }
    },
  });
}
