import { createHash } from "node:crypto";
import { transaction, type Db } from "../db.js";

/**
 * The cache of what each person's remote music contains (so browsing and search are instant and
 * don't call the remote service). One table serves every source; rows are scoped by source and
 * user. The tables are created here instead of in the shared migrations so each plugin stays
 * a self-contained folder.
 */
export function ensureSourceTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_tracks (
      source TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      location TEXT,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      album_artist TEXT,
      track_no INTEGER,
      duration_sec REAL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      etag TEXT,
      from_tags INTEGER NOT NULL DEFAULT 1,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (source, user_id, id)
    );
    CREATE INDEX IF NOT EXISTS source_tracks_album ON source_tracks (source, user_id, album);
    CREATE TABLE IF NOT EXISTS source_index_runs (
      source TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      found INTEGER NOT NULL DEFAULT 0,
      indexed INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (source, user_id)
    );
  `);
}

/** A stable id for a remote file: the same file always gets the same id, so likes and playlists keep working. */
export function trackIdFor(source: string, userId: number, filePath: string): string {
  return createHash("sha1").update(`${source}\0${userId}\0${filePath}`).digest("hex").slice(0, 24);
}

export interface CachedTrack {
  id: string;
  path: string;
  location: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  durationSec: number | null;
  size: number;
  mtimeMs: number;
  etag: string | null;
  fromTags: boolean;
}

interface Row {
  id: string;
  path: string;
  location: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  duration_sec: number | null;
  size: number;
  mtime_ms: number;
  etag: string | null;
  from_tags: number;
}

const fromRow = (r: Row): CachedTrack => ({
  id: r.id,
  path: r.path,
  location: r.location,
  title: r.title,
  artist: r.artist,
  album: r.album,
  albumArtist: r.album_artist,
  trackNo: r.track_no,
  durationSec: r.duration_sec,
  size: r.size,
  mtimeMs: r.mtime_ms,
  etag: r.etag,
  fromTags: r.from_tags === 1,
});

export interface TrackQuery {
  q?: string;
  album?: string;
  artist?: string;
  limit: number;
  offset: number;
}

const ORDER =
  "ORDER BY COALESCE(album_artist, artist, '') COLLATE NOCASE, album COLLATE NOCASE, track_no, title COLLATE NOCASE, id";

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function where(q: Omit<TrackQuery, "limit" | "offset">): { sql: string; args: string[] } {
  const parts = ["source = ?", "user_id = ?"];
  const args: string[] = [];
  if (q.q) {
    const like = `%${likeEscape(q.q)}%`;
    parts.push("(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (q.album !== undefined) {
    parts.push("album = ?");
    args.push(q.album);
  }
  if (q.artist !== undefined) {
    parts.push("COALESCE(album_artist, artist) = ?");
    args.push(q.artist);
  }
  return { sql: parts.join(" AND "), args };
}

export class SourceStore {
  constructor(
    private readonly db: Db,
    readonly source: string,
  ) {}

  list(userId: number, q: TrackQuery): { items: CachedTrack[]; total: number } {
    const w = where(q);
    const base = [this.source, userId];
    const rows = this.db
      .prepare(`SELECT * FROM source_tracks WHERE ${w.sql} ${ORDER} LIMIT ? OFFSET ?`)
      .all(...base, ...w.args, q.limit, q.offset) as unknown as Row[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM source_tracks WHERE ${w.sql}`).get(...base, ...w.args) as { n: number }).n;
    return { items: rows.map(fromRow), total };
  }

  get(userId: number, id: string): CachedTrack | null {
    const row = this.db.prepare("SELECT * FROM source_tracks WHERE source = ? AND user_id = ? AND id = ?").get(this.source, userId, id) as
      | Row
      | undefined;
    return row ? fromRow(row) : null;
  }

  albums(userId: number, q: { q?: string; limit: number; offset: number }): { items: { name: string; artist: string | null; trackCount: number }[]; total: number } {
    const w = where({ q: q.q });
    const base = [this.source, userId];
    const group = "GROUP BY album, COALESCE(album_artist, artist)";
    const rows = this.db
      .prepare(
        `SELECT album AS name, COALESCE(album_artist, artist) AS artist, COUNT(*) AS n FROM source_tracks
         WHERE ${w.sql} AND album IS NOT NULL ${group} ORDER BY name COLLATE NOCASE, artist COLLATE NOCASE LIMIT ? OFFSET ?`,
      )
      .all(...base, ...w.args, q.limit, q.offset) as unknown as { name: string; artist: string | null; n: number }[];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM source_tracks WHERE ${w.sql} AND album IS NOT NULL ${group})`).get(...base, ...w.args) as {
        n: number;
      }
    ).n;
    return { items: rows.map((r) => ({ name: r.name, artist: r.artist, trackCount: r.n })), total };
  }

  count(userId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM source_tracks WHERE source = ? AND user_id = ?").get(this.source, userId) as { n: number }).n;
  }

  /** What is known about every file, to tell new and changed files from the ones already indexed. */
  known(userId: number): Map<string, { size: number; mtimeMs: number; etag: string | null }> {
    const out = new Map<string, { size: number; mtimeMs: number; etag: string | null }>();
    for (const r of this.db.prepare("SELECT id, size, mtime_ms, etag FROM source_tracks WHERE source = ? AND user_id = ?").all(this.source, userId) as {
      id: string;
      size: number;
      mtime_ms: number;
      etag: string | null;
    }[]) {
      out.set(r.id, { size: r.size, mtimeMs: r.mtime_ms, etag: r.etag });
    }
    return out;
  }

  upsert(userId: number, tracks: CachedTrack[]): void {
    if (tracks.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO source_tracks (source, user_id, id, path, location, title, artist, album, album_artist, track_no, duration_sec,
                                  size, mtime_ms, etag, from_tags, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, user_id, id) DO UPDATE SET
         path = excluded.path, location = excluded.location, title = excluded.title, artist = excluded.artist,
         album = excluded.album, album_artist = excluded.album_artist, track_no = excluded.track_no,
         duration_sec = excluded.duration_sec, size = excluded.size, mtime_ms = excluded.mtime_ms,
         etag = excluded.etag, from_tags = excluded.from_tags, indexed_at = excluded.indexed_at`,
    );
    const now = Date.now();
    transaction(this.db, () => {
      for (const t of tracks) {
        stmt.run(
          this.source,
          userId,
          t.id,
          t.path,
          t.location,
          t.title,
          t.artist,
          t.album,
          t.albumArtist,
          t.trackNo,
          t.durationSec,
          t.size,
          t.mtimeMs,
          t.etag,
          t.fromTags ? 1 : 0,
          now,
        );
      }
    });
  }

  remove(userId: number, ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM source_tracks WHERE source = ? AND user_id = ? AND id = ?");
    transaction(this.db, () => {
      for (const id of ids) stmt.run(this.source, userId, id);
    });
  }

  /** Forget everything cached for a person (they disconnected). */
  clear(userId: number): void {
    this.db.prepare("DELETE FROM source_tracks WHERE source = ? AND user_id = ?").run(this.source, userId);
    this.db.prepare("DELETE FROM source_index_runs WHERE source = ? AND user_id = ?").run(this.source, userId);
  }

  // ---- index runs -------------------------------------------------------------

  run(userId: number): IndexRun | null {
    const r = this.db.prepare("SELECT * FROM source_index_runs WHERE source = ? AND user_id = ?").get(this.source, userId) as
      | {
          status: IndexRun["status"];
          started_at: number;
          finished_at: number | null;
          found: number;
          indexed: number;
          removed: number;
          failed: number;
          error: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      found: r.found,
      indexed: r.indexed,
      removed: r.removed,
      failed: r.failed,
      error: r.error,
    };
  }

  saveRun(userId: number, run: IndexRun): void {
    this.db
      .prepare(
        `INSERT INTO source_index_runs (source, user_id, status, started_at, finished_at, found, indexed, removed, failed, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, user_id) DO UPDATE SET status = excluded.status, started_at = excluded.started_at,
           finished_at = excluded.finished_at, found = excluded.found, indexed = excluded.indexed,
           removed = excluded.removed, failed = excluded.failed, error = excluded.error`,
      )
      .run(this.source, userId, run.status, run.startedAt, run.finishedAt, run.found, run.indexed, run.removed, run.failed, run.error);
  }

  /** Runs still marked "running" when the server starts were cut short; mark them so they are picked up again. */
  markInterrupted(): void {
    this.db.prepare("UPDATE source_index_runs SET status = 'interrupted' WHERE source = ? AND status = 'running'").run(this.source);
  }
}

export interface IndexRun {
  /** "running", "done", "failed" (the listing failed, nothing was removed) or "interrupted" (the server stopped mid-run). */
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: number;
  finishedAt: number | null;
  /** Audio files found in the last listing. */
  found: number;
  /** Files whose tags were read in this run. */
  indexed: number;
  removed: number;
  failed: number;
  error: string | null;
}
