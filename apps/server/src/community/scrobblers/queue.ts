import type { Db } from "../../db.js";
import type { Scrobble, ServiceId } from "./services.js";

/** A play still waiting for (or already past) delivery to one service. */
export interface QueueRow {
  id: number;
  userId: number;
  service: ServiceId;
  scrobble: Scrobble;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError: string | null;
}

export type QueueState = "pending" | "sent" | "dropped";

export interface QueueCounts {
  pending: number;
  /** Delivered in the last 24 hours. */
  sentToday: number;
  dropped: number;
  /** When the next retry is due, if anything is waiting. */
  nextAttemptAt: number | null;
}

/** Plays within this many seconds of each other with the same artist and title are one play. */
export const DEDUPE_WINDOW_SEC = 20;
/** Finished rows stay this long, so a repeated report of the same play is still recognised. */
export const KEEP_FINISHED_MS = 7 * 24 * 3600_000;

interface DbRow {
  id: number;
  user_id: number;
  service: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  last_error: string | null;
}

/**
 * The retry queue, kept in the server database so a restart loses nothing.
 * Every query is scoped to a person; nobody sees another person's plays.
 */
export class ScrobbleQueue {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scrobbler_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        last_error TEXT,
        UNIQUE (user_id, service, artist, title, played_at)
      );
      CREATE INDEX IF NOT EXISTS scrobbler_queue_due ON scrobbler_queue (state, next_attempt_at);
      CREATE INDEX IF NOT EXISTS scrobbler_queue_user ON scrobbler_queue (user_id, service, state);
    `);
  }

  /** Add a play. Returns false when it is a duplicate (same play, or the same song reported again within seconds). */
  enqueue(userId: number, service: ServiceId, scrobble: Scrobble, now: number): boolean {
    const near = this.db
      .prepare(
        `SELECT 1 FROM scrobbler_queue
          WHERE user_id = ? AND service = ? AND artist = ? AND title = ?
            AND played_at BETWEEN ? AND ? LIMIT 1`,
      )
      .get(userId, service, scrobble.artist, scrobble.title, scrobble.playedAt - DEDUPE_WINDOW_SEC, scrobble.playedAt + DEDUPE_WINDOW_SEC);
    if (near) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO scrobbler_queue
           (user_id, service, artist, title, played_at, payload, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, service, scrobble.artist, scrobble.title, scrobble.playedAt, JSON.stringify(scrobble), now, now);
    return Number(result.changes) > 0;
  }

  /** Pending rows whose time has come, oldest play first. */
  due(now: number, limit = 500): QueueRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scrobbler_queue WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY user_id, service, played_at LIMIT ?`,
      )
      .all(now, limit) as unknown as DbRow[];
    return rows.map(toRow);
  }

  /** Users that have something due right now. */
  dueFor(userId: number, now: number, limit = 500): QueueRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scrobbler_queue WHERE user_id = ? AND state = 'pending' AND next_attempt_at <= ?
          ORDER BY service, played_at LIMIT ?`,
      )
      .all(userId, now, limit) as unknown as DbRow[];
    return rows.map(toRow);
  }

  markSent(ids: number[], now: number): void {
    this.finish(ids, "sent", now, null);
  }

  markDropped(ids: number[], now: number, reason: string): void {
    this.finish(ids, "dropped", now, reason);
  }

  private finish(ids: number[], state: QueueState, now: number, error: string | null): void {
    const stmt = this.db.prepare("UPDATE scrobbler_queue SET state = ?, finished_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?");
    for (const id of ids) stmt.run(state, now, error, id);
  }

  /** A failed try: count it and wait until `nextAttemptAt`. */
  markRetry(ids: number[], nextAttemptAt: number, error: string): void {
    const stmt = this.db.prepare("UPDATE scrobbler_queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?");
    for (const id of ids) stmt.run(nextAttemptAt, error, id);
  }

  /** Give up on pending plays older than `cutoff`. Returns how many. */
  expire(cutoff: number, now: number): number {
    const result = this.db
      .prepare(
        `UPDATE scrobbler_queue SET state = 'dropped', finished_at = ?, last_error = 'Gave up: could not be delivered in time.'
          WHERE state = 'pending' AND created_at < ?`,
      )
      .run(now, cutoff);
    return Number(result.changes);
  }

  /** Forget finished rows older than the keep period. */
  prune(now: number): void {
    this.db.prepare("DELETE FROM scrobbler_queue WHERE state != 'pending' AND finished_at < ?").run(now - KEEP_FINISHED_MS);
  }

  /** Make every waiting play of this person due now (the "retry now" button). */
  retryNow(userId: number, now: number, service?: ServiceId): number {
    const result = service
      ? this.db.prepare("UPDATE scrobbler_queue SET next_attempt_at = ? WHERE user_id = ? AND service = ? AND state = 'pending'").run(now, userId, service)
      : this.db.prepare("UPDATE scrobbler_queue SET next_attempt_at = ? WHERE user_id = ? AND state = 'pending'").run(now, userId);
    return Number(result.changes);
  }

  /** Remove everything waiting for a service (on disconnect, or "clear queue"). */
  clear(userId: number, service?: ServiceId): number {
    const result = service
      ? this.db.prepare("DELETE FROM scrobbler_queue WHERE user_id = ? AND service = ? AND state = 'pending'").run(userId, service)
      : this.db.prepare("DELETE FROM scrobbler_queue WHERE user_id = ? AND state = 'pending'").run(userId);
    return Number(result.changes);
  }

  counts(userId: number, service: ServiceId, now: number): QueueCounts {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n, MIN(CASE WHEN state = 'pending' THEN next_attempt_at END) AS next FROM scrobbler_queue WHERE user_id = ? AND service = ? GROUP BY state")
      .all(userId, service) as unknown as { state: QueueState; n: number; next: number | null }[];
    const out: QueueCounts = { pending: 0, sentToday: 0, dropped: 0, nextAttemptAt: null };
    for (const r of rows) {
      if (r.state === "pending") {
        out.pending = r.n;
        out.nextAttemptAt = r.next;
      } else if (r.state === "dropped") out.dropped = r.n;
    }
    const today = this.db
      .prepare("SELECT COUNT(*) AS n FROM scrobbler_queue WHERE user_id = ? AND service = ? AND state = 'sent' AND finished_at >= ?")
      .get(userId, service, now - 24 * 3600_000) as { n: number };
    out.sentToday = today.n;
    return out;
  }

  /** The most recent plays that could not be delivered, for the status page. */
  recentProblems(userId: number, limit = 5): { service: ServiceId; artist: string; title: string; playedAt: number; state: QueueState; error: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT service, artist, title, played_at, state, last_error FROM scrobbler_queue
          WHERE user_id = ? AND last_error IS NOT NULL AND state != 'sent'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(userId, limit) as unknown as { service: string; artist: string; title: string; played_at: number; state: QueueState; last_error: string | null }[];
    return rows.map((r) => ({
      service: r.service as ServiceId,
      artist: r.artist,
      title: r.title,
      playedAt: r.played_at,
      state: r.state,
      error: r.last_error,
    }));
  }
}

function toRow(r: DbRow): QueueRow {
  return {
    id: r.id,
    userId: r.user_id,
    service: r.service as ServiceId,
    scrobble: JSON.parse(r.payload) as Scrobble,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    lastError: r.last_error,
  };
}
