import type {
  HistoryResponse,
  HistoryTrack,
  Play,
  RecordPlaysRequest,
  TopTracksResponse,
} from "@uma/shared";
import { transaction } from "../db.js";
import type { ServerPlugin } from "../plugins/types.js";

const MAX_BATCH = 200;
const MAX_TEXT = 500;
const MAX_URL = 2000;

interface PlayRow {
  track_id: string;
  source: string | null;
  title: string;
  artists: string;
  album: string | null;
  artwork: string | null;
  duration_sec: number | null;
  played_at: number;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

/** Validate an untrusted track (from any source); returns null if it is unusable. */
export function sanitizeTrack(input: unknown): HistoryTrack | null {
  if (!input || typeof input !== "object") return null;
  const track = input as Partial<HistoryTrack>;
  const id = str(track.id, MAX_TEXT);
  const title = str(track.title, MAX_TEXT);
  if (!id || !title) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists
        .slice(0, 20)
        .map((a) => ({ id: str(a?.id, MAX_TEXT) ?? "", name: str(a?.name, MAX_TEXT) ?? "" }))
        .filter((a) => a.name)
    : [];
  const artwork = str(track.artwork, MAX_URL);
  return {
    id,
    title,
    artists,
    album: str(track.album, MAX_TEXT),
    // Only web artwork; never let a client store arbitrary schemes.
    artwork: artwork && /^https:\/\//.test(artwork) ? artwork : undefined,
    durationSec:
      typeof track.durationSec === "number" && Number.isFinite(track.durationSec) && track.durationSec > 0
        ? track.durationSec
        : undefined,
    source: str(track.source, 50),
  };
}

/** Validate an untrusted play; returns null if it is unusable. */
export function sanitizePlay(input: unknown, now = Date.now()): Play | null {
  if (!input || typeof input !== "object") return null;
  const { track: rawTrack, playedAt } = input as { track?: unknown; playedAt?: unknown };
  const track = sanitizeTrack(rawTrack);
  if (!track) return null;
  // Plays may be uploaded late (offline), but not from the future.
  if (typeof playedAt !== "number" || !Number.isFinite(playedAt) || playedAt <= 0 || playedAt > now + 60_000) {
    return null;
  }
  return { playedAt: Math.floor(playedAt), track };
}

function rowToTrack(row: PlayRow): HistoryTrack {
  let artists: HistoryTrack["artists"] = [];
  try {
    artists = JSON.parse(row.artists) as HistoryTrack["artists"];
  } catch {
    // Keep the play visible even if the stored artist list is damaged.
  }
  return {
    id: row.track_id,
    title: row.title,
    artists,
    album: row.album ?? undefined,
    artwork: row.artwork ?? undefined,
    durationSec: row.duration_sec ?? undefined,
    source: row.source ?? undefined,
  };
}

/** Listening history, so Home and "most played" follow you across devices. */
export const historyPlugin: ServerPlugin = {
  id: "core.history",
  name: "Listening history",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireUser } = ctx;

    app.post<{ Body: RecordPlaysRequest }>(
      "/api/me/history",
      { preHandler: requireUser },
      async (req, reply) => {
        const plays = (req.body as Partial<RecordPlaysRequest> | undefined)?.plays;
        if (!Array.isArray(plays) || plays.length > MAX_BATCH) {
          return reply.code(400).send({ error: "invalid_request", message: `Send 1-${MAX_BATCH} plays.` });
        }
        const valid = plays.map((p) => sanitizePlay(p)).filter((p): p is Play => p !== null);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO plays
             (user_id, track_id, source, title, artists, album, artwork, duration_sec, played_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        let stored = 0;
        transaction(db, () => {
          for (const { track, playedAt } of valid) {
            const result = insert.run(
              req.user!.id,
              track.id,
              track.source ?? null,
              track.title,
              JSON.stringify(track.artists),
              track.album ?? null,
              track.artwork ?? null,
              track.durationSec ?? null,
              playedAt,
            );
            stored += Number(result.changes);
          }
        });
        return { stored, rejected: plays.length - valid.length };
      },
    );

    app.get<{ Querystring: { limit?: string; before?: string } }>(
      "/api/me/history",
      { preHandler: requireUser },
      async (req): Promise<HistoryResponse> => {
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
        const rows = db
          .prepare(
            `SELECT * FROM plays WHERE user_id = ? AND played_at < ?
             ORDER BY played_at DESC LIMIT ?`,
          )
          .all(req.user!.id, before, limit) as unknown as PlayRow[];
        return { items: rows.map((row) => ({ track: rowToTrack(row), playedAt: row.played_at })) };
      },
    );

    app.get<{ Querystring: { limit?: string; days?: string } }>(
      "/api/me/top",
      { preHandler: requireUser },
      async (req): Promise<TopTracksResponse> => {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const days = Number(req.query.days);
        const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : 0;
        // Latest metadata for each track, ranked by play count.
        const rows = db
          .prepare(
            `SELECT p.*, t.plays, t.last_played_at
               FROM (SELECT track_id, COUNT(*) AS plays, MAX(played_at) AS last_played_at
                       FROM plays WHERE user_id = ? AND played_at >= ?
                      GROUP BY track_id) t
               JOIN plays p ON p.user_id = ? AND p.track_id = t.track_id AND p.played_at = t.last_played_at
              ORDER BY t.plays DESC, t.last_played_at DESC
              LIMIT ?`,
          )
          .all(req.user!.id, since, req.user!.id, limit) as unknown as (PlayRow & {
          plays: number;
          last_played_at: number;
        })[];
        return {
          items: rows.map((row) => ({
            track: rowToTrack(row),
            plays: row.plays,
            lastPlayedAt: row.last_played_at,
          })),
        };
      },
    );
  },
};
