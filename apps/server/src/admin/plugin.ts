import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { createLocalUser, findUserById, findUserByUsername } from "../auth/users.js";
import type { ServerPlugin } from "../plugins/types.js";
import { SERVER_VERSION } from "../version.js";
import { registerAdminPage } from "./adminPage.js";

const USERNAME_RE = /^[\w.@-]{1,48}$/;
const MIN_PASSWORD = 10;
const INVITE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export interface AdminUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
  signIn: "password" | "sso" | "both";
  createdAt: number;
  lastSeenAt: number | null;
  sessions: number;
  plays: number;
}

const count = (db: Db, sql: string, ...args: (string | number)[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

function adminCount(db: Db): number {
  return count(db, "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1");
}

function listUsers(db: Db): AdminUser[] {
  const rows = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
              (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
              (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays
         FROM users u ORDER BY u.created_at`,
    )
    .all() as unknown as {
    id: number;
    username: string;
    display_name: string | null;
    email: string | null;
    is_admin: number;
    password_hash: string | null;
    oidc_subject: string | null;
    created_at: number;
    sessions: number;
    last_seen: number | null;
    plays: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    isAdmin: r.is_admin === 1,
    signIn: r.password_hash && r.oidc_subject ? "both" : r.oidc_subject ? "sso" : "password",
    createdAt: r.created_at,
    lastSeenAt: r.last_seen,
    sessions: r.sessions,
    plays: r.plays,
  }));
}


/** Admin API (and the /admin page): people, sign-up and server status. */
export const adminPlugin: ServerPlugin = {
  id: "core.admin",
  name: "Admin",
  version: "1.0.0",
  register(app, ctx) {
    const { db, settings, requireAdmin } = ctx;
    registerAdminPage(app);

    app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
      const signup = settings.signup();
      return {
        version: SERVER_VERSION,
        users: count(db, "SELECT COUNT(*) AS n FROM users"),
        admins: adminCount(db),
        tracks: count(db, "SELECT COUNT(*) AS n FROM tracks"),
        plays: count(db, "SELECT COUNT(*) AS n FROM plays"),
        activeSessions: count(db, "SELECT COUNT(*) AS n FROM sessions WHERE last_used_at > ?", Date.now() - 7 * 86_400_000),
        signup: signup ? { mode: signup.mode, inviteCode: signup.mode === "invite" ? signup.inviteCode : null } : { mode: "closed", inviteCode: null },
        oidc: ctx.config.oidc ? { name: ctx.config.oidc.displayName, issuer: ctx.config.oidc.issuer } : null,
        publicUrl: ctx.config.publicUrl ?? null,
      };
    });

    app.get("/api/admin/users", { preHandler: requireAdmin }, async () => ({ items: listUsers(db) }));

    app.post<{ Body: { username?: string; password?: string; displayName?: string; isAdmin?: boolean } }>(
      "/api/admin/users",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const username = (req.body?.username ?? "").trim();
        const password = req.body?.password ?? "";
        if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: "invalid_username" });
        if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: "weak_password" });
        if (findUserByUsername(db, username)) return reply.code(409).send({ error: "username_taken" });
        const displayName = req.body?.displayName?.trim().slice(0, 80) || undefined;
        const user = createLocalUser(db, { username, password, displayName, isAdmin: req.body?.isAdmin === true });
        req.log.info({ admin: req.user!.username, created: user.username }, "admin created a user");
        return reply.code(201).send({ id: user.id });
      },
    );

    app.patch<{ Params: { id: string }; Body: { isAdmin?: boolean; password?: string; displayName?: string } }>(
      "/api/admin/users/:id",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const target = findUserById(db, Number(req.params.id));
        if (!target) return reply.code(404).send({ error: "not_found" });
        const body = req.body ?? {};

        if (body.isAdmin === false && target.is_admin === 1) {
          if (adminCount(db) <= 1) return reply.code(409).send({ error: "last_admin" });
          if (target.id === req.user!.id) return reply.code(409).send({ error: "cannot_demote_self" });
        }
        if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD)) {
          return reply.code(400).send({ error: "weak_password" });
        }

        if (typeof body.isAdmin === "boolean") {
          db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(body.isAdmin ? 1 : 0, target.id);
        }
        if (typeof body.displayName === "string") {
          db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(body.displayName.trim().slice(0, 80) || null, target.id);
        }
        if (typeof body.password === "string") {
          db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(body.password), target.id);
          // A reset password ends every existing session for that person.
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
        }
        req.log.info({ admin: req.user!.username, target: target.username, changes: Object.keys(body) }, "admin updated a user");
        return { ok: true };
      },
    );

    app.post<{ Params: { id: string } }>("/api/admin/users/:id/sign-out", { preHandler: requireAdmin }, async (req, reply) => {
      const target = findUserById(db, Number(req.params.id));
      if (!target) return reply.code(404).send({ error: "not_found" });
      const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
      return { signedOut: Number(result.changes) };
    });

    app.delete<{ Params: { id: string } }>("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
      const target = findUserById(db, Number(req.params.id));
      if (!target) return reply.code(404).send({ error: "not_found" });
      if (target.id === req.user!.id) return reply.code(409).send({ error: "cannot_delete_self" });
      if (target.is_admin === 1 && adminCount(db) <= 1) return reply.code(409).send({ error: "last_admin" });
      // Sessions and listening history go with the account (ON DELETE CASCADE).
      db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
      req.log.info({ admin: req.user!.username, deleted: target.username }, "admin deleted a user");
      return reply.code(204).send();
    });

    app.put<{ Body: { mode?: string; inviteCode?: string } }>("/api/admin/signup", { preHandler: requireAdmin }, async (req, reply) => {
      const mode = req.body?.mode;
      if (mode === "closed" || mode === "open") {
        settings.setSignup({ mode });
      } else if (mode === "invite") {
        const code = (req.body?.inviteCode ?? "").trim() || randomBytes(6).toString("base64url");
        if (!INVITE_RE.test(code)) return reply.code(400).send({ error: "invalid_invite_code" });
        settings.setSignup({ mode, inviteCode: code });
      } else {
        return reply.code(400).send({ error: "invalid_mode" });
      }
      const signup = settings.signup();
      return { mode: signup?.mode ?? "closed", inviteCode: signup?.mode === "invite" ? signup.inviteCode : null };
    });
  },
};
