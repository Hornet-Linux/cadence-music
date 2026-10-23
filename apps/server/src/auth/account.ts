import type { FastifyInstance, FastifyRequest } from "fastify";
import { sessionCredential } from "./webSession.js";
import type { PublicUser } from "@uma/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { PreHandler } from "../plugins/types.js";
import { SERVER_VERSION } from "../version.js";
import { MAX_PASSWORD, hashPassword, verifyPassword } from "./passwords.js";
import { RateLimiter } from "./rateLimit.js";
import { deleteOtherSessions, deleteSessionById, listSessions } from "./sessions.js";
import { registerAccountPage } from "../web/accountPage.js";
import { findUserById, toPublicUser } from "./users.js";

const MIN_PASSWORD = 10;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_MAX_FAILURES = 8;

const count = (db: Db, sql: string, ...args: (string | number)[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** This request's own session token (bearer, or the web player's cookie). */
function bearer(req: FastifyRequest): string | null {
  return sessionCredential(req)?.token ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Everything the server keeps about one person, for "export my data". Never includes passwords or tokens. */
export function exportUserData(db: Db, userId: number, config: Pick<Config, "oidc">): Record<string, unknown> | null {
  const user = findUserById(db, userId);
  if (!user) return null;
  const plays = (
    db
      .prepare(
        "SELECT track_id, source, title, artists, album, artwork, duration_sec, played_at FROM plays WHERE user_id = ? ORDER BY played_at DESC",
      )
      .all(userId) as {
      track_id: string;
      source: string | null;
      title: string;
      artists: string;
      album: string | null;
      artwork: string | null;
      duration_sec: number | null;
      played_at: number;
    }[]
  ).map((p) => ({
    playedAt: new Date(p.played_at).toISOString(),
    trackId: p.track_id,
    source: p.source,
    title: p.title,
    artists: parseJson(p.artists),
    album: p.album,
    artwork: p.artwork,
    durationSec: p.duration_sec,
  }));
  const likes = (
    db.prepare("SELECT track, liked_at FROM likes WHERE user_id = ? ORDER BY liked_at DESC").all(userId) as {
      track: string;
      liked_at: number;
    }[]
  ).map((l) => ({ likedAt: new Date(l.liked_at).toISOString(), track: parseJson(l.track) }));
  const playlists = (
    db.prepare("SELECT id, name, tracks, created_at, updated_at FROM playlists WHERE user_id = ? ORDER BY created_at").all(userId) as {
      id: string;
      name: string;
      tracks: string;
      created_at: number;
      updated_at: number;
    }[]
  ).map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: new Date(p.created_at).toISOString(),
    updatedAt: new Date(p.updated_at).toISOString(),
    tracks: parseJson(p.tracks),
  }));
  const jellyfin = db
    .prepare("SELECT jellyfin_user_name, server_name, server_url, created_at FROM jellyfin_connections WHERE user_id = ?")
    .get(userId) as { jellyfin_user_name: string; server_name: string | null; server_url: string; created_at: number } | undefined;
  // Settings plugins saved for this person: which ones, not their values (they can hold keys).
  const savedFor = (
    db.prepare("SELECT key FROM settings WHERE key LIKE ? OR key LIKE ?").all(`plugin:%:user:${userId}`, `user:${userId}:%`) as {
      key: string;
    }[]
  ).map((r) => r.key.replace(/^plugin:(.*):user:\d+$/, "$1").replace(/^user:\d+:/, ""));
  return {
    exportedAt: new Date().toISOString(),
    server: { version: SERVER_VERSION },
    account: {
      username: user.username,
      displayName: user.display_name,
      email: user.email,
      admin: user.is_admin === 1,
      createdAt: new Date(user.created_at).toISOString(),
      signIn: { password: !!user.password_hash, sso: config.oidc && user.oidc_subject ? config.oidc.displayName : null },
    },
    history: plays,
    likes,
    playlists,
    connections: {
      jellyfin: jellyfin
        ? {
            user: jellyfin.jellyfin_user_name,
            server: jellyfin.server_name,
            address: jellyfin.server_url,
            connectedAt: new Date(jellyfin.created_at).toISOString(),
          }
        : null,
    },
    savedSettingsFor: savedFor,
  };
}

/** The signed-in person's own account: password, devices, their data. */
export function registerAccountRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config; requireUser: PreHandler },
): void {
  const { db, config, requireUser } = deps;
  registerAccountPage(app);
  // Wrong "current password" guesses per person, so a stolen session cannot grind the password.
  const failures = new RateLimiter({ max: PASSWORD_MAX_FAILURES, windowMs: PASSWORD_WINDOW_MS });

  app.get("/api/me/account", { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    const jf = db
      .prepare("SELECT jellyfin_user_name, server_name FROM jellyfin_connections WHERE user_id = ?")
      .get(user.id) as { jellyfin_user_name: string; server_name: string | null } | undefined;
    return {
      user: toPublicUser(user) as PublicUser,
      createdAt: user.created_at,
      signIn: { password: !!user.password_hash, sso: user.oidc_subject && config.oidc ? config.oidc.displayName : null },
      counts: {
        plays: count(db, "SELECT COUNT(*) AS n FROM plays WHERE user_id = ?", user.id),
        likes: count(db, "SELECT COUNT(*) AS n FROM likes WHERE user_id = ?", user.id),
        playlists: count(db, "SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?", user.id),
      },
      connections: { jellyfin: jf ? { userName: jf.jellyfin_user_name, serverName: jf.server_name } : null },
    };
  });

  app.patch<{ Body: { displayName?: unknown } }>("/api/me", { preHandler: requireUser }, async (req, reply) => {
    const name = req.body?.displayName;
    if (typeof name !== "string") return reply.code(400).send({ error: "invalid_request" });
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name.trim().slice(0, 80) || null, req.user!.id);
    return toPublicUser(findUserById(db, req.user!.id)!);
  });

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
    "/api/me/password",
    { preHandler: requireUser },
    async (req, reply) => {
      const user = req.user!;
      const key = String(user.id);
      if (failures.isLimited(key)) return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
      if (!user.password_hash) return reply.code(409).send({ error: "no_password" });
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > MAX_PASSWORD) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
        return reply.code(400).send({ error: "weak_password" });
      }
      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        failures.hit(key);
        return reply.code(403).send({ error: "wrong_password" });
      }
      if (newPassword === currentPassword) return reply.code(400).send({ error: "same_password" });
      const hash = await hashPassword(newPassword);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
      failures.reset(key);
      // Anyone else who had a session (maybe the reason for the change) is signed out; this device stays in.
      const signedOut = deleteOtherSessions(db, user.id, bearer(req));
      return { ok: true, signedOut };
    },
  );

  app.get("/api/me/sessions", { preHandler: requireUser }, async (req) => ({
    items: listSessions(db, req.user!.id, bearer(req)),
  }));

  app.post("/api/me/sessions/sign-out-others", { preHandler: requireUser }, async (req) => ({
    signedOut: deleteOtherSessions(db, req.user!.id, bearer(req)),
  }));

  app.delete<{ Params: { id: string } }>("/api/me/sessions/:id", { preHandler: requireUser }, async (req, reply) => {
    if (!deleteSessionById(db, req.user!.id, req.params.id)) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  app.get("/api/me/export", { preHandler: requireUser }, async (req, reply) => {
    const data = exportUserData(db, req.user!.id, config);
    const day = new Date().toISOString().slice(0, 10);
    const name = req.user!.username.replace(/[^\w.-]/g, "_");
    return reply
      .type("application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="cadence-${name}-${day}.json"`)
      .header("Cache-Control", "no-store")
      .send(JSON.stringify(data, null, 2));
  });

  app.delete("/api/me/history", { preHandler: requireUser }, async (req) => {
    const result = db.prepare("DELETE FROM plays WHERE user_id = ?").run(req.user!.id);
    return { deleted: Number(result.changes) };
  });

  // Deleting your own account takes your password (or your username, for single sign-on accounts).
  app.post<{ Body: { password?: unknown; confirm?: unknown } }>(
    "/api/me/delete-account",
    { preHandler: requireUser },
    async (req, reply) => {
      const user = req.user!;
      const key = `del:${user.id}`;
      if (failures.isLimited(key)) return reply.code(429).send({ error: "too_many_attempts", message: "Try again later." });
      const { password, confirm } = req.body ?? {};
      if (user.password_hash) {
        if (typeof password !== "string" || !password || password.length > MAX_PASSWORD) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        if (!(await verifyPassword(password, user.password_hash))) {
          failures.hit(key);
          return reply.code(403).send({ error: "wrong_password" });
        }
      } else if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== user.username.toLowerCase()) {
        return reply.code(403).send({ error: "confirm_mismatch" });
      }
      // The only admin cannot leave: nobody could manage the server afterwards.
      if (user.is_admin === 1 && count(db, "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL") <= 1) {
        return reply.code(409).send({ error: "last_admin" });
      }
      deleteUserEverywhere(db, user.id);
      req.log.info({ user: user.username }, "a person deleted their own account");
      return reply.code(204).send();
    },
  );
}

/** Remove an account with everything tied to it (history, likes, sessions cascade; per-person settings do not). */
export function deleteUserEverywhere(db: Db, userId: number): void {
  db.prepare("DELETE FROM settings WHERE key LIKE ? OR key LIKE ?").run(`plugin:%:user:${userId}`, `user:${userId}:%`);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}
