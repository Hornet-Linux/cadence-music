import { randomBytes } from "node:crypto";
import type {
  HistoryTrack,
  LikesResponse,
  PlaylistResponse,
  PlaylistsResponse,
} from "@uma/shared";
import { sanitizeTrack } from "../history/plugin.js";
import type { ServerPlugin } from "../plugins/types.js";

const MAX_LIKES = 20_000;
const MAX_PLAYLISTS = 500;
const MAX_PLAYLIST_TRACKS = 5_000;
const MAX_NAME = 100;

interface PlaylistRow {
  id: string;
  name: string;
  tracks: string;
  created_at: number;
  updated_at: number;
}

function parseTracks(json: string): HistoryTrack[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as HistoryTrack[]) : [];
  } catch {
    return [];
  }
}

function toPlaylist(row: PlaylistRow): PlaylistResponse {
  return {
    id: row.id,
    name: row.name,
    tracks: parseTracks(row.tracks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Validate a client track list; null if it isn't a list or is too long. */
function sanitizeTracks(input: unknown): HistoryTrack[] | null {
  if (!Array.isArray(input) || input.length > MAX_PLAYLIST_TRACKS) return null;
  return input.map((t) => sanitizeTrack(t)).filter((t): t is HistoryTrack => t !== null);
}

function cleanName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim().slice(0, MAX_NAME);
  return name.length > 0 ? name : null;
}

/**
 * Liked songs and playlists. Tracks come from any source, so each one is
 * stored with the metadata the apps need to show it again.
 */
export const collectionPlugin: ServerPlugin = {
  id: "core.collection",
  name: "Liked songs and playlists",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireUser } = ctx;

    // ---- Likes -------------------------------------------------------------
    app.get("/api/me/likes", { preHandler: requireUser }, async (req): Promise<LikesResponse> => {
      const rows = db
        .prepare("SELECT track, liked_at FROM likes WHERE user_id = ? ORDER BY liked_at DESC")
        .all(req.user!.id) as unknown as { track: string; liked_at: number }[];
      const items: LikesResponse["items"] = [];
      for (const row of rows) {
        try {
          items.push({ track: JSON.parse(row.track) as HistoryTrack, likedAt: row.liked_at });
        } catch {
          // Skip a damaged row rather than failing the whole list.
        }
      }
      return { items };
    });

    app.post<{ Body: { track?: unknown; likedAt?: unknown } }>(
      "/api/me/likes",
      { preHandler: requireUser },
      async (req, reply) => {
        const track = sanitizeTrack(req.body?.track);
        if (!track) return reply.code(400).send({ error: "invalid_track" });
        const count = (db.prepare("SELECT COUNT(*) AS n FROM likes WHERE user_id = ?").get(req.user!.id) as { n: number })
          .n;
        if (count >= MAX_LIKES) return reply.code(409).send({ error: "too_many_likes" });
        const likedAt =
          typeof req.body?.likedAt === "number" && req.body.likedAt > 0 && req.body.likedAt <= Date.now() + 60_000
            ? Math.floor(req.body.likedAt)
            : Date.now();
        db.prepare(
          `INSERT INTO likes (user_id, track_id, track, liked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, track_id) DO UPDATE SET track = excluded.track`,
        ).run(req.user!.id, track.id, JSON.stringify(track), likedAt);
        return reply.code(204).send();
      },
    );

    // Track ids contain characters like ":" and "/", so they go in the query.
    app.delete<{ Querystring: { trackId?: string } }>(
      "/api/me/likes",
      { preHandler: requireUser },
      async (req, reply) => {
        const trackId = req.query.trackId;
        if (!trackId) return reply.code(400).send({ error: "invalid_track" });
        db.prepare("DELETE FROM likes WHERE user_id = ? AND track_id = ?").run(req.user!.id, trackId);
        return reply.code(204).send();
      },
    );

    // ---- Playlists ---------------------------------------------------------
    const findOwned = (id: string, userId: number) =>
      db.prepare("SELECT * FROM playlists WHERE id = ? AND user_id = ?").get(id, userId) as unknown as
        | PlaylistRow
        | undefined;

    app.get("/api/me/playlists", { preHandler: requireUser }, async (req): Promise<PlaylistsResponse> => {
      const rows = db
        .prepare("SELECT * FROM playlists WHERE user_id = ? ORDER BY updated_at DESC")
        .all(req.user!.id) as unknown as PlaylistRow[];
      return { items: rows.map(toPlaylist) };
    });

    app.post<{ Body: { name?: unknown; tracks?: unknown } }>(
      "/api/me/playlists",
      { preHandler: requireUser },
      async (req, reply) => {
        const name = cleanName(req.body?.name);
        if (!name) return reply.code(400).send({ error: "invalid_name" });
        const tracks = req.body?.tracks === undefined ? [] : sanitizeTracks(req.body.tracks);
        if (!tracks) return reply.code(400).send({ error: "invalid_tracks" });
        const count = (
          db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?").get(req.user!.id) as { n: number }
        ).n;
        if (count >= MAX_PLAYLISTS) return reply.code(409).send({ error: "too_many_playlists" });
        const now = Date.now();
        const id = randomBytes(9).toString("base64url");
        db.prepare(
          "INSERT INTO playlists (id, user_id, name, tracks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, req.user!.id, name, JSON.stringify(tracks), now, now);
        return reply.code(201).send(toPlaylist(findOwned(id, req.user!.id)!));
      },
    );

    app.patch<{ Params: { id: string }; Body: { name?: unknown; tracks?: unknown } }>(
      "/api/me/playlists/:id",
      { preHandler: requireUser },
      async (req, reply) => {
        const playlist = findOwned(req.params.id, req.user!.id);
        if (!playlist) return reply.code(404).send({ error: "not_found" });
        const body = req.body ?? {};
        const name = body.name === undefined ? playlist.name : cleanName(body.name);
        if (!name) return reply.code(400).send({ error: "invalid_name" });
        const tracks = body.tracks === undefined ? parseTracks(playlist.tracks) : sanitizeTracks(body.tracks);
        if (!tracks) return reply.code(400).send({ error: "invalid_tracks" });
        db.prepare("UPDATE playlists SET name = ?, tracks = ?, updated_at = ? WHERE id = ?").run(
          name,
          JSON.stringify(tracks),
          Date.now(),
          playlist.id,
        );
        return toPlaylist(findOwned(playlist.id, req.user!.id)!);
      },
    );

    app.delete<{ Params: { id: string } }>("/api/me/playlists/:id", { preHandler: requireUser }, async (req, reply) => {
      const result = db
        .prepare("DELETE FROM playlists WHERE id = ? AND user_id = ?")
        .run(req.params.id, req.user!.id);
      if (Number(result.changes) === 0) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    });
  },
};
