import path from "node:path";
import { parseFile } from "music-metadata";
import { transaction, type Db } from "../../db.js";

/** Genre (and tempo) tags read from the music files, which the library scan does not keep. */
export interface FileTags {
  genres: string[];
  bpm?: number;
}

export type TagReader = (file: string) => Promise<FileTags>;

export const readFileTags: TagReader = async (file) => {
  const meta = await parseFile(file, { duration: false, skipCovers: true });
  return cleanTags({ genres: meta.common.genre ?? [], bpm: meta.common.bpm });
};

/** Trim, drop empties and duplicates, and keep tag lists a sane size. */
export function cleanTags(input: { genres?: unknown; bpm?: unknown }): FileTags {
  const seen = new Set<string>();
  const genres: string[] = [];
  const raw = Array.isArray(input.genres) ? input.genres : [];
  for (const g of raw) {
    if (typeof g !== "string") continue;
    // Some taggers store several genres in one string, separated by / or ;
    for (const part of g.split(/[;/]/)) {
      const name = part.trim().slice(0, 60);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      genres.push(name);
    }
  }
  const bpm = typeof input.bpm === "number" && Number.isFinite(input.bpm) && input.bpm >= 30 && input.bpm <= 300 ? Math.round(input.bpm) : undefined;
  return { genres: genres.slice(0, 8), bpm };
}

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wr_tags (
      track_id TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      genres TEXT NOT NULL,
      bpm INTEGER,
      scanned_at INTEGER NOT NULL
    );
  `);
}

/**
 * Keeps a small table of genre tags for the tracks in the library. It reads a limited number of
 * files each run, so a big library is indexed gradually without hammering the disk.
 */
export class TagIndexer {
  constructor(
    private readonly db: Db,
    private readonly musicDir: string,
    private readonly read: TagReader = readFileTags,
    private readonly now: () => number = Date.now,
  ) {
    ensureSchema(db);
  }

  /** Tracks never indexed, or changed since. */
  private pending(limit: number): { id: string; rel_path: string; mtime_ms: number }[] {
    return this.db
      .prepare(
        `SELECT t.id, t.rel_path, t.mtime_ms FROM tracks t
           LEFT JOIN wr_tags w ON w.track_id = t.id
          WHERE w.track_id IS NULL OR w.mtime_ms != t.mtime_ms
          LIMIT ?`,
      )
      .all(limit) as unknown as { id: string; rel_path: string; mtime_ms: number }[];
  }

  countPending(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tracks t LEFT JOIN wr_tags w ON w.track_id = t.id WHERE w.track_id IS NULL OR w.mtime_ms != t.mtime_ms`)
        .get() as { n: number }
    ).n;
  }

  /** Index up to `batch` tracks. Returns how many were done. */
  async run(batch = 100): Promise<number> {
    // Forget tracks that left the library.
    this.db.prepare("DELETE FROM wr_tags WHERE track_id NOT IN (SELECT id FROM tracks)").run();
    const todo = this.pending(batch);
    let done = 0;
    for (const row of todo) {
      let tags: FileTags = { genres: [] };
      try {
        // rel_path is relative to the music folder; never read outside it.
        const abs = path.resolve(this.musicDir, row.rel_path);
        if (abs.startsWith(path.resolve(this.musicDir) + path.sep)) tags = await this.read(abs);
      } catch {
        // Unreadable tags still count as indexed, so the file is not retried every run.
      }
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO wr_tags (track_id, mtime_ms, genres, bpm, scanned_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (track_id) DO UPDATE SET mtime_ms = excluded.mtime_ms, genres = excluded.genres, bpm = excluded.bpm, scanned_at = excluded.scanned_at`,
          )
          .run(row.id, row.mtime_ms, JSON.stringify(tags.genres), tags.bpm ?? null, this.now());
      });
      done += 1;
    }
    return done;
  }

  /** Tags for every indexed track that has any. */
  list(): { id: string; genres: string[]; bpm?: number }[] {
    const rows = this.db.prepare("SELECT track_id, genres, bpm FROM wr_tags WHERE genres != '[]' OR bpm IS NOT NULL").all() as unknown as {
      track_id: string;
      genres: string;
      bpm: number | null;
    }[];
    return rows.map((r) => {
      let genres: string[] = [];
      try {
        genres = JSON.parse(r.genres) as string[];
      } catch {
        // Damaged row: skip its genres.
      }
      return { id: r.track_id, genres, ...(r.bpm != null ? { bpm: r.bpm } : {}) };
    });
  }
}