import type { Db } from "../../db.js";

/** Limits for one person. 0 means no limit. */
export interface Limits {
  maxConcurrentStreams: number;
  maxHoursPerDay: number;
}

export type Denial = { ok: true } | { ok: false; reason: "concurrent" | "daily"; retryAfterSec: number; message: string };

interface Lease {
  trackId: string;
  startedAt: number;
  endsAt: number;
}

export interface UsageRow {
  userId: number;
  today: number;
  last7: number;
  last30: number;
  streams30: number;
  lastStreamAt: number | null;
}

/** Tracks without a known length count as this long. */
export const DEFAULT_TRACK_SEC = 180;
/** A stream with no length at all is assumed to be over after this long without a new request. */
const MIN_LEASE_MS = 60_000;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS quota_usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    seconds REAL NOT NULL DEFAULT 0,
    streams INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS quota_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    track_id TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS quota_events_at ON quota_events (at DESC);
`;

/**
 * Counts what each person streams and decides whether one more stream is allowed.
 *
 * A "stream" is a listening device (address plus browser) with a track in progress. It lasts as long as the track
 * is long (every request for that track renews it), and starting another track on the same device replaces it. So
 * seeking, buffering and skipping never count as extra streams; a second phone or a shared login does.
 * Pausing keeps a stream counted until the track would have ended.
 */
export class QuotaEngine {
  private readonly leases = new Map<number, Map<string, Lease>>();
  denied = { concurrent: 0, daily: 0 };

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  private active(userId: number, now: number): Map<string, Lease> {
    const all = this.leases.get(userId);
    if (!all) return new Map();
    for (const [device, lease] of all) if (lease.endsAt <= now) all.delete(device);
    return all;
  }

  activeStreams(userId: number): number {
    return this.active(userId, this.now()).size;
  }

  secondsToday(userId: number, now = this.now()): number {
    const row = this.db.prepare("SELECT seconds FROM quota_usage WHERE user_id = ? AND day = ?").get(userId, dayOf(now)) as { seconds: number } | undefined;
    return row?.seconds ?? 0;
  }

  /** May this device start (or keep) a stream of `trackId`? Does not record anything. */
  check(userId: number, device: string, trackId: string | null, limits: Limits): Denial {
    const now = this.now();
    const mine = this.active(userId, now).get(device);
    const continuing = mine !== undefined && (trackId === null || mine.trackId === trackId);
    if (limits.maxConcurrentStreams > 0 && !mine) {
      if (this.active(userId, now).size >= limits.maxConcurrentStreams) {
        const soonest = Math.min(...[...this.active(userId, now).values()].map((l) => l.endsAt));
        return {
          ok: false,
          reason: "concurrent",
          retryAfterSec: Math.max(5, Math.ceil((soonest - now) / 1000)),
          message: `You can stream on ${limits.maxConcurrentStreams} device${limits.maxConcurrentStreams === 1 ? "" : "s"} at a time. Stop playback on another device first.`,
        };
      }
    }
    if (limits.maxHoursPerDay > 0 && !continuing && this.secondsToday(userId, now) >= limits.maxHoursPerDay * 3600) {
      const tomorrow = Date.parse(dayOf(now)) + 86_400_000;
      return {
        ok: false,
        reason: "daily",
        retryAfterSec: Math.max(60, Math.ceil((tomorrow - now) / 1000)),
        message: `The daily listening limit of ${limits.maxHoursPerDay} hour${limits.maxHoursPerDay === 1 ? "" : "s"} is used up. It resets at midnight UTC.`,
      };
    }
    return { ok: true };
  }

  /** Record that `device` is streaming `trackId`. Returns true when this started a new stream (counted in the usage). */
  start(userId: number, device: string, trackId: string, durationSec: number | null): boolean {
    const now = this.now();
    const leases = this.leases.get(userId) ?? new Map<string, Lease>();
    this.leases.set(userId, leases);
    const seconds = durationSec && durationSec > 0 ? durationSec : DEFAULT_TRACK_SEC;
    const existing = leases.get(device);
    if (existing && existing.trackId === trackId && existing.endsAt > now) {
      // The same track asked for again (a seek, a re-buffer): same stream.
      existing.endsAt = Math.max(existing.endsAt, now + MIN_LEASE_MS);
      return false;
    }
    leases.set(device, { trackId, startedAt: now, endsAt: now + Math.max(MIN_LEASE_MS, seconds * 1000) });
    this.db
      .prepare(
        `INSERT INTO quota_usage (user_id, day, seconds, streams) VALUES (?, ?, ?, 1)
         ON CONFLICT (user_id, day) DO UPDATE SET seconds = seconds + excluded.seconds, streams = streams + 1`,
      )
      .run(userId, dayOf(now), seconds);
    this.event(userId, "stream", trackId);
    return true;
  }

  deny(userId: number, reason: "concurrent" | "daily", trackId: string | null): void {
    this.denied[reason] += 1;
    this.event(userId, `denied:${reason}`, trackId);
  }

  private event(userId: number, kind: string, trackId: string | null, detail?: string): void {
    const now = this.now();
    this.db.prepare("INSERT INTO quota_events (user_id, at, kind, track_id, detail) VALUES (?, ?, ?, ?, ?)").run(userId, now, kind, trackId, detail ?? null);
    // Keep the audit trail to a few thousand rows.
    this.db.prepare("DELETE FROM quota_events WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM quota_events)").run();
    this.db.prepare("DELETE FROM quota_usage WHERE day < ?").run(dayOf(now - 120 * 86_400_000));
  }

  usage(): UsageRow[] {
    const now = this.now();
    const d7 = dayOf(now - 6 * 86_400_000);
    const d30 = dayOf(now - 29 * 86_400_000);
    const rows = this.db
      .prepare(
        `SELECT u.id AS userId,
                COALESCE(SUM(CASE WHEN q.day = ? THEN q.seconds END), 0) AS today,
                COALESCE(SUM(CASE WHEN q.day >= ? THEN q.seconds END), 0) AS last7,
                COALESCE(SUM(CASE WHEN q.day >= ? THEN q.seconds END), 0) AS last30,
                COALESCE(SUM(CASE WHEN q.day >= ? THEN q.streams END), 0) AS streams30,
                (SELECT MAX(at) FROM quota_events e WHERE e.user_id = u.id AND e.kind = 'stream') AS lastStreamAt
           FROM users u LEFT JOIN quota_usage q ON q.user_id = u.id
          GROUP BY u.id ORDER BY u.id`,
      )
      .all(dayOf(now), d7, d30, d30) as unknown as UsageRow[];
    return rows;
  }

  events(limit = 100): { id: number; userId: number; username: string | null; at: number; kind: string; trackId: string | null }[] {
    return this.db
      .prepare(
        `SELECT e.id, e.user_id AS userId, u.username, e.at, e.kind, e.track_id AS trackId
           FROM quota_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as { id: number; userId: number; username: string | null; at: number; kind: string; trackId: string | null }[];
  }
}