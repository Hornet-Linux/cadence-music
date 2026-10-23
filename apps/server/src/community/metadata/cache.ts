import type { Db } from "../../db.js";

export interface CacheRow {
  /** Parsed JSON body, or null for a remembered "not found". */
  value: unknown;
  /** True when this entry remembers a 404. */
  missing: boolean;
  expiresAt: number;
}

/** How long past its expiry an entry is kept, so it can still be served if the service is down. */
export const STALE_KEEP_MS = 14 * 86_400_000;

/** Answers from upstream services, kept in SQLite so repeat lookups cost nothing and survive restarts. */
export class MetadataCache {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS metadata_cache (
      key TEXT PRIMARY KEY,
      value TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
  }

  get(key: string): CacheRow | undefined {
    const row = this.db.prepare("SELECT value, missing, expires_at FROM metadata_cache WHERE key = ?").get(key) as
      | { value: string | null; missing: number; expires_at: number }
      | undefined;
    if (!row) return undefined;
    try {
      return {
        value: row.value == null ? null : JSON.parse(row.value),
        missing: row.missing === 1,
        expiresAt: row.expires_at,
      };
    } catch {
      return undefined;
    }
  }

  isFresh(row: CacheRow): boolean {
    return row.expiresAt > this.now();
  }

  set(key: string, value: unknown, ttlMs: number): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO metadata_cache (key, value, missing, fetched_at, expires_at) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, missing = 0, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), now, now + ttlMs);
  }

  setMissing(key: string, ttlMs: number): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO metadata_cache (key, value, missing, fetched_at, expires_at) VALUES (?, NULL, 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = NULL, missing = 1, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      )
      .run(key, now, now + ttlMs);
  }

  /** Remove entries that expired long enough ago that they are no longer useful as a fallback. */
  purge(): number {
    const result = this.db.prepare("DELETE FROM metadata_cache WHERE expires_at < ?").run(this.now() - STALE_KEEP_MS);
    return Number(result.changes);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM metadata_cache").get() as { n: number }).n;
  }
}
