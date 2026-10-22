import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { tableExists } from "../_serverlib/decorate.js";
import { ensureFactsTable, factsIndexer } from "../_serverlib/facts.js";
import { evaluate, seededRandom, validateDefinition, type Definition, type SmartTrack } from "./rules.js";

/** The ids the desktop app gives server tracks in history and likes. */
const SERVER_PREFIX = "server:";
const MAX_PLAYLISTS = 100;

interface Row {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
  added_at: number;
  genre?: string | null;
  year?: number | null;
  lufs?: number | null;
  bpm?: number | null;
  energy?: number | null;
}

/** Every track with the facts the rules can use, for one person (play counts and favourites are theirs). */
export function loadSmartTracks(db: Db, userId: number): SmartTrack[] {
  const hasFacts = tableExists(db, "track_facts");
  const hasLoud = tableExists(db, "track_loudness");
  const hasAudio = tableExists(db, "track_audio");
  const sql = `SELECT t.id, t.title, t.artist, t.album, t.duration_sec, t.added_at
      ${hasFacts ? ", f.genre, f.year" : ""}
      ${hasLoud ? ", l.lufs" : ""}
      ${hasAudio ? ", a.bpm, a.energy" : ""}
    FROM tracks t
    ${hasFacts ? "LEFT JOIN track_facts f ON f.track_id = t.id" : ""}
    ${hasLoud ? "LEFT JOIN track_loudness l ON l.track_id = t.id AND l.error IS NULL" : ""}
    ${hasAudio ? "LEFT JOIN track_audio a ON a.track_id = t.id AND a.error IS NULL" : ""}`;
  const rows = db.prepare(sql).all() as unknown as Row[];

  const plays = new Map<string, { n: number; last: number }>();
  for (const p of db
    .prepare(
      "SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays WHERE user_id = ? AND track_id LIKE 'server:%' GROUP BY track_id",
    )
    .all(userId) as unknown as { track_id: string; n: number; last: number }[]) {
    plays.set(p.track_id.slice(SERVER_PREFIX.length), { n: p.n, last: p.last });
  }
  const likes = new Set(
    (
      db.prepare("SELECT track_id FROM likes WHERE user_id = ? AND track_id LIKE 'server:%'").all(userId) as unknown as {
        track_id: string;
      }[]
    ).map((l) => l.track_id.slice(SERVER_PREFIX.length)),
  );

  // Accepted tag suggestions show up in the library API, so rules should see them too.
  const overlay = new Map<string, Map<string, string>>();
  if (tableExists(db, "tag_overlay")) {
    for (const o of db.prepare("SELECT track_id, field, value FROM tag_overlay").all() as unknown as {
      track_id: string;
      field: string;
      value: string;
    }[]) {
      const m = overlay.get(o.track_id) ?? new Map();
      m.set(o.field, o.value);
      overlay.set(o.track_id, m);
    }
  }

  return rows.map((r) => {
    const o = overlay.get(r.id);
    const p = plays.get(r.id);
    return {
      id: r.id,
      title: o?.get("title") ?? r.title,
      artist: o?.get("artist") ?? r.artist,
      album: o?.get("album") ?? r.album,
      genre: r.genre ?? null,
      year: r.year ?? null,
      playCount: p?.n ?? 0,
      lastPlayedAt: p?.last ?? null,
      addedAt: r.added_at,
      loudness: r.lufs ?? null,
      bpm: r.bpm ?? null,
      energy: r.energy ?? null,
      duration: r.duration_sec,
      favourite: likes.has(r.id),
    };
  });
}

const toItem = (t: SmartTrack) => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  album: t.album,
  durationSec: t.duration,
  genre: t.genre,
  year: t.year,
  playCount: t.playCount,
  lastPlayedAt: t.lastPlayedAt,
  favourite: t.favourite,
  loudnessLufs: t.loudness,
  bpm: t.bpm,
  energy: t.energy,
});

interface PlaylistRow {
  id: string;
  name: string;
  definition: string;
  created_at: number;
  updated_at: number;
}

const toPlaylist = (r: PlaylistRow) => ({
  id: r.id,
  name: r.name,
  definition: JSON.parse(r.definition) as Definition,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function ensureTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_playlists (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS smart_playlists_user ON smart_playlists (user_id, updated_at DESC);
  `);
}

const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name && name.length <= 80 ? name : null;
};

/**
 * Rule-based playlists that always reflect the library: genre, year, play count, last played, date
 * added, loudness, tempo, energy, artist, favourites. Stored per person and evaluated on the server.
 */
export const smartPlaylistsPlugin: ServerPlugin = {
  id: "cadence.smart-playlists",
  name: "Smart playlists",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireUser } = ctx;
    ensureTables(db);
    ensureFactsTable(db);
    const musicRoot = path.resolve(ctx.config.musicDir);
    const indexer = factsIndexer(db, musicRoot, ctx.log);
    // Genre and year come from a one-off read of each file's tags (shared with library health).
    ctx.jobs.every(
      "smart-playlists-tags",
      30 * 60_000,
      async () => {
        if (indexer.pending() > 0) await indexer.start();
      },
      { runSoon: true },
    );
    app.addHook("onClose", async () => indexer.stop());

    const owned = (id: string, userId: number) =>
      db.prepare("SELECT * FROM smart_playlists WHERE id = ? AND user_id = ?").get(id, userId) as unknown as
        PlaylistRow | undefined;

    function run(userId: number, def: Definition, seed: string | undefined, limitOverride?: number) {
      const n = seed === undefined ? NaN : Number(seed);
      const random = Number.isFinite(n) ? seededRandom(n) : Math.random;
      const effective = limitOverride && (!def.limit || limitOverride < def.limit) ? { ...def, limit: limitOverride } : def;
      const { total, tracks } = evaluate(loadSmartTracks(db, userId), effective, Date.now(), random);
      return { total, items: tracks.map(toItem) };
    }

    app.get("/api/smart-playlists", { preHandler: requireUser }, async (req) => {
      const rows = db
        .prepare("SELECT * FROM smart_playlists WHERE user_id = ? ORDER BY updated_at DESC")
        .all(req.user!.id) as unknown as PlaylistRow[];
      return { items: rows.map(toPlaylist) };
    });

    // What the editor can offer: which fields have data, and the genres in the library.
    app.get("/api/smart-playlists/meta", { preHandler: requireUser }, async () => {
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const hasLoud = tableExists(db, "track_loudness");
      const hasAudio = tableExists(db, "track_audio");
      return {
        coverage: {
          tracks: count("SELECT COUNT(*) AS n FROM tracks"),
          genre: count("SELECT COUNT(*) AS n FROM track_facts WHERE genre IS NOT NULL"),
          year: count("SELECT COUNT(*) AS n FROM track_facts WHERE year IS NOT NULL"),
          loudness: hasLoud ? count("SELECT COUNT(*) AS n FROM track_loudness WHERE lufs IS NOT NULL") : null,
          bpm: hasAudio ? count("SELECT COUNT(*) AS n FROM track_audio WHERE bpm IS NOT NULL") : null,
          energy: hasAudio ? count("SELECT COUNT(*) AS n FROM track_audio WHERE energy IS NOT NULL") : null,
        },
        genres: (
          db
            .prepare(
              "SELECT genre, COUNT(*) AS n FROM track_facts WHERE genre IS NOT NULL GROUP BY genre ORDER BY n DESC, genre LIMIT 200",
            )
            .all() as unknown as { genre: string }[]
        ).map((g) => g.genre),
        indexing: indexer.status().running,
      };
    });

    app.post<{ Body: { name?: unknown; definition?: unknown } | undefined }>(
      "/api/smart-playlists",
      { preHandler: requireUser },
      async (req, reply) => {
        const name = cleanName(req.body?.name);
        if (!name) return reply.code(400).send({ error: "invalid_name" });
        const checked = validateDefinition(req.body?.definition);
        if (!checked.ok) return reply.code(400).send({ error: checked.error });
        const count = (
          db.prepare("SELECT COUNT(*) AS n FROM smart_playlists WHERE user_id = ?").get(req.user!.id) as { n: number }
        ).n;
        if (count >= MAX_PLAYLISTS) return reply.code(409).send({ error: "too_many_playlists" });
        const id = randomUUID();
        const now = Date.now();
        db.prepare(
          "INSERT INTO smart_playlists (id, user_id, name, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, req.user!.id, name, JSON.stringify(checked.definition), now, now);
        return reply.code(201).send(toPlaylist(owned(id, req.user!.id)!));
      },
    );

    app.put<{ Params: { id: string }; Body: { name?: unknown; definition?: unknown } | undefined }>(
      "/api/smart-playlists/:id",
      { preHandler: requireUser },
      async (req, reply) => {
        const existing = owned(req.params.id, req.user!.id);
        if (!existing) return reply.code(404).send({ error: "not_found" });
        let name = existing.name;
        if (req.body?.name !== undefined) {
          const n = cleanName(req.body.name);
          if (!n) return reply.code(400).send({ error: "invalid_name" });
          name = n;
        }
        let definition = existing.definition;
        if (req.body?.definition !== undefined) {
          const checked = validateDefinition(req.body.definition);
          if (!checked.ok) return reply.code(400).send({ error: checked.error });
          definition = JSON.stringify(checked.definition);
        }
        db.prepare("UPDATE smart_playlists SET name = ?, definition = ?, updated_at = ? WHERE id = ?").run(
          name,
          definition,
          Date.now(),
          existing.id,
        );
        return toPlaylist(owned(existing.id, req.user!.id)!);
      },
    );

    app.delete<{ Params: { id: string } }>("/api/smart-playlists/:id", { preHandler: requireUser }, async (req, reply) => {
      const res = db.prepare("DELETE FROM smart_playlists WHERE id = ? AND user_id = ?").run(req.params.id, req.user!.id);
      return Number(res.changes) === 0 ? reply.code(404).send({ error: "not_found" }) : reply.code(204).send();
    });

    app.get<{ Params: { id: string }; Querystring: { seed?: string; limit?: string } }>(
      "/api/smart-playlists/:id/tracks",
      { preHandler: requireUser },
      async (req, reply) => {
        const row = owned(req.params.id, req.user!.id);
        if (!row) return reply.code(404).send({ error: "not_found" });
        const limit = Number(req.query.limit);
        return run(
          req.user!.id,
          JSON.parse(row.definition) as Definition,
          req.query.seed,
          Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : undefined,
        );
      },
    );

    // Try a definition without saving it (the editor shows a live count).
    app.post<{ Body: { definition?: unknown } | undefined }>(
      "/api/smart-playlists/preview",
      { preHandler: requireUser },
      async (req, reply) => {
        const checked = validateDefinition(req.body?.definition);
        if (!checked.ok) return reply.code(400).send({ error: checked.error });
        return run(req.user!.id, checked.definition, undefined, 25);
      },
    );
  },
};

export default smartPlaylistsPlugin;
