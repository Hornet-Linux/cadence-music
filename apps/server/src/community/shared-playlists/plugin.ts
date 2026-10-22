import { randomBytes } from "node:crypto";
import type { HistoryTrack } from "@uma/shared";
import { findUserByUsername } from "../../auth/users.js";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { Db } from "../../db.js";
import { transaction } from "../../db.js";
import { sanitizeTrack } from "../../history/plugin.js";
import type { ServerPlugin } from "../../plugins/types.js";

export const MAX_PLAYLISTS_PER_USER = 100;
export const MAX_MEMBERS = 50;
export const MAX_ITEMS = 1000;
const MAX_NAME = 100;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Tables for shared playlists. Created here (not in the core migrations) so the plugin stays self-contained. */
export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_playlists (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sp_members (
      playlist_id TEXT NOT NULL REFERENCES sp_playlists (id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS sp_members_user ON sp_members (user_id);
    CREATE TABLE IF NOT EXISTS sp_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES sp_playlists (id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      track TEXT NOT NULL,
      added_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
      added_at INTEGER NOT NULL,
      UNIQUE (playlist_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS sp_votes (
      item_id TEXT NOT NULL REFERENCES sp_items (id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      value INTEGER NOT NULL CHECK (value IN (-1, 1)),
      PRIMARY KEY (item_id, user_id)
    );
  `);
}

const newId = () => randomBytes(9).toString("base64url");
const newCode = () => {
  let out = "";
  for (const b of randomBytes(8)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};

const cleanName = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const name = input.trim().slice(0, MAX_NAME);
  return name.length > 0 ? name : null;
};

export interface SharedItem {
  id: string;
  track: HistoryTrack;
  addedBy: { id: number; name: string } | null;
  addedAt: number;
  /** Sum of everyone's votes. */
  score: number;
  /** The signed-in person's own vote: -1, 0 or 1. */
  myVote: -1 | 0 | 1;
}

export interface SharedPlaylistDetail {
  id: string;
  name: string;
  ownerId: number;
  isOwner: boolean;
  /** Only the owner sees the invite code. */
  joinCode?: string;
  members: { id: number; name: string }[];
  /** Highest score first; ties keep the order tracks were added in. */
  items: SharedItem[];
  createdAt: number;
  updatedAt: number;
}

export interface SharedPlaylistSummary {
  id: string;
  name: string;
  ownerName: string;
  isOwner: boolean;
  memberCount: number;
  trackCount: number;
  updatedAt: number;
  /** Up to four covers for a tile. */
  artwork: string[];
}

interface PlaylistRow {
  id: string;
  owner_id: number;
  name: string;
  join_code: string;
  created_at: number;
  updated_at: number;
}

const displayName = (row: { display_name: string | null; username: string }) => row.display_name || row.username;

/** Order items by score, then by when they were added. Exported for tests. */
export function orderItems<T extends { score: number; addedAt: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.score - a.score || a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

export class PlaylistService {
  private readonly failedJoins = new RateLimiter({ max: 20, windowMs: 10 * 60_000 });

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    ensureSchema(db);
  }

  isMember(playlistId: string, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM sp_members WHERE playlist_id = ? AND user_id = ?").get(playlistId, userId);
  }

  private row(id: string): PlaylistRow | undefined {
    return this.db.prepare("SELECT * FROM sp_playlists WHERE id = ?").get(id) as unknown as PlaylistRow | undefined;
  }

  private touch(id: string): void {
    this.db.prepare("UPDATE sp_playlists SET updated_at = ? WHERE id = ?").run(Math.max(this.now(), (this.row(id)?.updated_at ?? 0) + 1), id);
  }

  list(userId: number): SharedPlaylistSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name,
                (SELECT COUNT(*) FROM sp_members m2 WHERE m2.playlist_id = p.id) AS member_count,
                (SELECT COUNT(*) FROM sp_items i WHERE i.playlist_id = p.id) AS track_count
           FROM sp_playlists p
           JOIN sp_members m ON m.playlist_id = p.id AND m.user_id = ?
           JOIN users u ON u.id = p.owner_id
          ORDER BY p.updated_at DESC`,
      )
      .all(userId) as unknown as (PlaylistRow & {
      owner_username: string;
      owner_display_name: string | null;
      member_count: number;
      track_count: number;
    })[];
    return rows.map((r) => {
      const covers = (
        this.db.prepare("SELECT track FROM sp_items WHERE playlist_id = ? ORDER BY added_at ASC LIMIT 12").all(r.id) as unknown as { track: string }[]
      )
        .map((t) => parseTrack(t.track)?.artwork)
        .filter((a): a is string => !!a)
        .slice(0, 4);
      return {
        id: r.id,
        name: r.name,
        ownerName: displayName({ username: r.owner_username, display_name: r.owner_display_name }),
        isOwner: r.owner_id === userId,
        memberCount: r.member_count,
        trackCount: r.track_count,
        updatedAt: r.updated_at,
        artwork: covers,
      };
    });
  }

  create(ownerId: number, name: string, tracks: HistoryTrack[] = []): SharedPlaylistDetail {
    const owned = (this.db.prepare("SELECT COUNT(*) AS n FROM sp_playlists WHERE owner_id = ?").get(ownerId) as { n: number }).n;
    if (owned >= MAX_PLAYLISTS_PER_USER) throw new PlaylistError("too_many_playlists", 409);
    const id = newId();
    const now = this.now();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO sp_playlists (id, owner_id, name, join_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ownerId, name, newCode(), now, now);
      this.db.prepare("INSERT INTO sp_members (playlist_id, user_id, joined_at) VALUES (?, ?, ?)").run(id, ownerId, now);
      for (const track of tracks.slice(0, MAX_ITEMS)) this.insertItem(id, ownerId, track, now);
    });
    return this.detail(id, ownerId)!;
  }

  private insertItem(playlistId: string, userId: number, track: HistoryTrack, now: number): string | null {
    const itemId = newId();
    const result = this.db
      .prepare("INSERT OR IGNORE INTO sp_items (id, playlist_id, track_id, track, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(itemId, playlistId, track.id, JSON.stringify(track), userId, now);
    if (Number(result.changes) === 0) return null;
    this.db.prepare("INSERT INTO sp_votes (item_id, user_id, value) VALUES (?, ?, 1)").run(itemId, userId);
    return itemId;
  }

  /** The playlist as `userId` sees it, or null if they are not a member (a stranger learns nothing). */
  detail(id: string, userId: number): SharedPlaylistDetail | null {
    const playlist = this.row(id);
    if (!playlist || !this.isMember(id, userId)) return null;
    const members = (
      this.db
        .prepare("SELECT u.id, u.username, u.display_name FROM sp_members m JOIN users u ON u.id = m.user_id WHERE m.playlist_id = ? ORDER BY m.joined_at")
        .all(id) as unknown as { id: number; username: string; display_name: string | null }[]
    ).map((m) => ({ id: m.id, name: displayName(m) }));
    const rows = this.db
      .prepare(
        `SELECT i.id, i.track, i.added_by, i.added_at, u.username, u.display_name,
                COALESCE((SELECT SUM(value) FROM sp_votes v WHERE v.item_id = i.id), 0) AS score,
                COALESCE((SELECT value FROM sp_votes v WHERE v.item_id = i.id AND v.user_id = ?), 0) AS my_vote
           FROM sp_items i LEFT JOIN users u ON u.id = i.added_by
          WHERE i.playlist_id = ?`,
      )
      .all(userId, id) as unknown as {
      id: string;
      track: string;
      added_by: number | null;
      added_at: number;
      username: string | null;
      display_name: string | null;
      score: number;
      my_vote: number;
    }[];
    const items: SharedItem[] = [];
    for (const r of rows) {
      const track = parseTrack(r.track);
      if (!track) continue;
      items.push({
        id: r.id,
        track,
        addedBy: r.added_by != null && r.username ? { id: r.added_by, name: displayName({ username: r.username, display_name: r.display_name }) } : null,
        addedAt: r.added_at,
        score: r.score,
        myVote: r.my_vote === 1 ? 1 : r.my_vote === -1 ? -1 : 0,
      });
    }
    const isOwner = playlist.owner_id === userId;
    return {
      id: playlist.id,
      name: playlist.name,
      ownerId: playlist.owner_id,
      isOwner,
      joinCode: isOwner ? playlist.join_code : undefined,
      members,
      items: orderItems(items),
      createdAt: playlist.created_at,
      updatedAt: playlist.updated_at,
    };
  }

  rename(id: string, userId: number, name: string): void {
    const p = this.requireOwner(id, userId);
    this.db.prepare("UPDATE sp_playlists SET name = ? WHERE id = ?").run(name, p.id);
    this.touch(id);
  }

  remove(id: string, userId: number): void {
    const p = this.requireOwner(id, userId);
    this.db.prepare("DELETE FROM sp_playlists WHERE id = ?").run(p.id);
  }

  private requireMember(id: string, userId: number): PlaylistRow {
    const p = this.row(id);
    if (!p || !this.isMember(id, userId)) throw new PlaylistError("not_found", 404);
    return p;
  }

  private requireOwner(id: string, userId: number): PlaylistRow {
    const p = this.requireMember(id, userId);
    if (p.owner_id !== userId) throw new PlaylistError("forbidden", 403);
    return p;
  }

  regenerateCode(id: string, userId: number): string {
    this.requireOwner(id, userId);
    const code = newCode();
    this.db.prepare("UPDATE sp_playlists SET join_code = ? WHERE id = ?").run(code, id);
    return code;
  }

  private addMember(id: string, userId: number): void {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM sp_members WHERE playlist_id = ?").get(id) as { n: number }).n;
    if (count >= MAX_MEMBERS) throw new PlaylistError("playlist_full", 409);
    this.db.prepare("INSERT OR IGNORE INTO sp_members (playlist_id, user_id, joined_at) VALUES (?, ?, ?)").run(id, userId, this.now());
    this.touch(id);
  }

  join(code: string, userId: number): string {
    const key = String(userId);
    if (this.failedJoins.isLimited(key)) throw new PlaylistError("too_many_attempts", 429);
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const p = clean ? (this.db.prepare("SELECT * FROM sp_playlists WHERE join_code = ?").get(clean) as unknown as PlaylistRow | undefined) : undefined;
    if (!p) {
      this.failedJoins.hit(key);
      throw new PlaylistError("invalid_code", 404);
    }
    this.addMember(p.id, userId);
    return p.id;
  }

  /** The owner invites a person by username. */
  invite(id: string, ownerId: number, username: string): void {
    this.requireOwner(id, ownerId);
    const user = findUserByUsername(this.db, username.trim());
    if (!user) throw new PlaylistError("user_not_found", 404);
    this.addMember(id, user.id);
  }

  /** A member leaves, or the owner removes someone. The owner cannot leave (they delete the playlist). */
  removeMember(id: string, actorId: number, memberId: number): void {
    const p = this.requireMember(id, actorId);
    if (memberId !== actorId && p.owner_id !== actorId) throw new PlaylistError("forbidden", 403);
    if (memberId === p.owner_id) throw new PlaylistError("owner_cannot_leave", 409);
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM sp_members WHERE playlist_id = ? AND user_id = ?").run(id, memberId);
      this.db.prepare("DELETE FROM sp_votes WHERE user_id = ? AND item_id IN (SELECT id FROM sp_items WHERE playlist_id = ?)").run(memberId, id);
    });
    this.touch(id);
  }

  addTrack(id: string, userId: number, track: HistoryTrack): "added" | "exists" {
    this.requireMember(id, userId);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM sp_items WHERE playlist_id = ?").get(id) as { n: number }).n;
    if (count >= MAX_ITEMS) throw new PlaylistError("playlist_full", 409);
    const added = this.insertItem(id, userId, track, this.now());
    if (added) this.touch(id);
    return added ? "added" : "exists";
  }

  /** The adder or the owner can remove a track. */
  removeTrack(id: string, userId: number, itemId: string): void {
    const p = this.requireMember(id, userId);
    const item = this.db.prepare("SELECT added_by FROM sp_items WHERE id = ? AND playlist_id = ?").get(itemId, id) as { added_by: number | null } | undefined;
    if (!item) throw new PlaylistError("not_found", 404);
    if (item.added_by !== userId && p.owner_id !== userId) throw new PlaylistError("forbidden", 403);
    this.db.prepare("DELETE FROM sp_items WHERE id = ?").run(itemId);
    this.touch(id);
  }

  vote(id: string, userId: number, itemId: string, value: -1 | 0 | 1): void {
    this.requireMember(id, userId);
    if (!this.db.prepare("SELECT 1 FROM sp_items WHERE id = ? AND playlist_id = ?").get(itemId, id)) throw new PlaylistError("not_found", 404);
    if (value === 0) this.db.prepare("DELETE FROM sp_votes WHERE item_id = ? AND user_id = ?").run(itemId, userId);
    else
      this.db
        .prepare("INSERT INTO sp_votes (item_id, user_id, value) VALUES (?, ?, ?) ON CONFLICT (item_id, user_id) DO UPDATE SET value = excluded.value")
        .run(itemId, userId, value);
    this.touch(id);
  }
}

export class PlaylistError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function parseTrack(json: string): HistoryTrack | null {
  try {
    return sanitizeTrack(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Playlists several people on this server build together. Everyone in a playlist can add tracks and
 * vote; the list is ordered by votes. Only members can see a playlist, and only the owner can rename,
 * delete or invite.
 */
const plugin: ServerPlugin = {
  id: "cadence.shared-playlists",
  name: "Shared playlists",
  version: "1.0.0",
  description:
    "Playlists several people on this server edit together. Members add songs and vote them up or down, and people join with a share code. Stored in the server database.",
  configFields: [],
  configNote: "Nothing to set here. It works as soon as it is turned on and the server restarts.",
  register(app, ctx) {
    const { requireUser } = ctx;
    const service = new PlaylistService(ctx.db);
    const guard = <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, run: () => T): T | unknown => {
      try {
        return run();
      } catch (err) {
        if (err instanceof PlaylistError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    };
    const opt = { preHandler: requireUser };

    app.get("/api/shared-playlists", opt, async (req) => ({ items: service.list(req.user!.id) }));

    app.post<{ Body: { name?: unknown; tracks?: unknown } }>("/api/shared-playlists", opt, async (req, reply) => {
      const name = cleanName(req.body?.name);
      if (!name) return reply.code(400).send({ error: "invalid_name" });
      const rawTracks = req.body?.tracks;
      if (rawTracks !== undefined && (!Array.isArray(rawTracks) || rawTracks.length > MAX_ITEMS)) return reply.code(400).send({ error: "invalid_tracks" });
      const tracks = ((rawTracks as unknown[] | undefined) ?? []).map((t) => sanitizeTrack(t)).filter((t): t is HistoryTrack => t !== null);
      return guard(reply, () => reply.code(201).send(service.create(req.user!.id, name, tracks)));
    });

    app.post<{ Body: { code?: unknown } }>("/api/shared-playlists/join", opt, async (req, reply) => {
      if (typeof req.body?.code !== "string") return reply.code(400).send({ error: "invalid_code" });
      return guard(reply, () => {
        const id = service.join(req.body.code as string, req.user!.id);
        return service.detail(id, req.user!.id);
      });
    });

    // `since` lets a client that polls skip the payload when nothing changed.
    app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/shared-playlists/:id", opt, async (req, reply) => {
      const detail = service.detail(req.params.id, req.user!.id);
      if (!detail) return reply.code(404).send({ error: "not_found" });
      if (Number(req.query.since) === detail.updatedAt) return { unchanged: true, updatedAt: detail.updatedAt };
      return detail;
    });

    app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/shared-playlists/:id", opt, async (req, reply) => {
      const name = cleanName(req.body?.name);
      if (!name) return reply.code(400).send({ error: "invalid_name" });
      return guard(reply, () => {
        service.rename(req.params.id, req.user!.id, name);
        return service.detail(req.params.id, req.user!.id);
      });
    });

    app.delete<{ Params: { id: string } }>("/api/shared-playlists/:id", opt, async (req, reply) =>
      guard(reply, () => {
        service.remove(req.params.id, req.user!.id);
        return reply.code(204).send();
      }),
    );

    app.post<{ Params: { id: string } }>("/api/shared-playlists/:id/code", opt, async (req, reply) =>
      guard(reply, () => ({ joinCode: service.regenerateCode(req.params.id, req.user!.id) })),
    );

    app.post<{ Params: { id: string }; Body: { username?: unknown } }>("/api/shared-playlists/:id/members", opt, async (req, reply) => {
      if (typeof req.body?.username !== "string" || !req.body.username.trim()) return reply.code(400).send({ error: "invalid_username" });
      return guard(reply, () => {
        service.invite(req.params.id, req.user!.id, req.body.username as string);
        return service.detail(req.params.id, req.user!.id);
      });
    });

    app.delete<{ Params: { id: string; userId: string } }>("/api/shared-playlists/:id/members/:userId", opt, async (req, reply) => {
      const target = req.params.userId === "me" ? req.user!.id : Number(req.params.userId);
      if (!Number.isInteger(target)) return reply.code(400).send({ error: "invalid_user" });
      return guard(reply, () => {
        service.removeMember(req.params.id, req.user!.id, target);
        return reply.code(204).send();
      });
    });

    app.post<{ Params: { id: string }; Body: { track?: unknown } }>("/api/shared-playlists/:id/items", opt, async (req, reply) => {
      const track = sanitizeTrack(req.body?.track);
      if (!track) return reply.code(400).send({ error: "invalid_track" });
      return guard(reply, () => {
        const result = service.addTrack(req.params.id, req.user!.id, track);
        if (result === "exists") return reply.code(409).send({ error: "already_added" });
        return reply.code(201).send(service.detail(req.params.id, req.user!.id));
      });
    });

    app.delete<{ Params: { id: string; itemId: string } }>("/api/shared-playlists/:id/items/:itemId", opt, async (req, reply) =>
      guard(reply, () => {
        service.removeTrack(req.params.id, req.user!.id, req.params.itemId);
        return reply.code(204).send();
      }),
    );

    app.put<{ Params: { id: string; itemId: string }; Body: { value?: unknown } }>(
      "/api/shared-playlists/:id/items/:itemId/vote",
      opt,
      async (req, reply) => {
        const value = req.body?.value;
        if (value !== -1 && value !== 0 && value !== 1) return reply.code(400).send({ error: "invalid_vote" });
        return guard(reply, () => {
          service.vote(req.params.id, req.user!.id, req.params.itemId, value);
          return service.detail(req.params.id, req.user!.id);
        });
      },
    );
  },
};

export default plugin;