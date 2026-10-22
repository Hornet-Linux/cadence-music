import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { FastifyRequest } from "fastify";
import type { FetchFn } from "../auth/oidc.js";
import { deleteUserEverywhere } from "../auth/account.js";
import type { Db } from "../db.js";
import { MAX_PASSWORD, hashPassword } from "../auth/passwords.js";
import { IDLE_LIMIT_MS } from "../auth/sessions.js";
import { createLocalUser, findUserById, isUniqueViolation, findUserByUsername } from "../auth/users.js";
import { listCommunityPlugins } from "../plugins/community.js";
import type { PluginConfigField, ServerPlugin } from "../plugins/types.js";
import { SERVER_VERSION } from "../version.js";
import { listAudit, noteAudit, genericAuditAction, recordAudit, takeAuditNote } from "./audit.js";
import { registerAdminPage } from "./adminPage.js";
import { maskConfig, unmaskConfig, validConfig } from "./pluginConfig.js";
import { UpdateChecker } from "./updates.js";

const USERNAME_RE = /^[\w.@-]{1,48}$/;
const MIN_PASSWORD = 10;
const INVITE_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PLUGIN_ID_RE = /^[\w.-]{1,100}$/;

export interface AdminUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
  disabled: boolean;
  signIn: "password" | "sso" | "both";
  createdAt: number;
  lastSeenAt: number | null;
  sessions: number;
  plays: number;
}

const count = (db: Db, sql: string, ...args: (string | number)[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** Admins who can actually sign in (a switched-off admin does not keep the server managed). */
function activeAdmins(db: Db, exceptId?: number): number {
  return count(db, "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND id != ?", exceptId ?? -1);
}

export function listUsers(db: Db, now = Date.now()): AdminUser[] {
  // Only sessions that can still sign in count; idle ones are as good as gone.
  const live = now - IDLE_LIMIT_MS;
  const rows = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.last_used_at >= ?) AS sessions,
              (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id AND s.last_used_at >= ?) AS last_seen,
              (SELECT COUNT(*) FROM plays p WHERE p.user_id = u.id) AS plays
         FROM users u ORDER BY u.created_at`,
    )
    .all(live, live) as unknown as {
    id: number;
    username: string;
    display_name: string | null;
    email: string | null;
    is_admin: number;
    disabled_at: number | null;
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
    disabled: r.disabled_at !== null,
    signIn: r.password_hash && r.oidc_subject ? "both" : r.oidc_subject ? "sso" : "password",
    createdAt: r.created_at,
    lastSeenAt: r.last_seen,
    sessions: r.sessions,
    plays: r.plays,
  }));
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function dbFile(db: Db): string | null {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    return rows.find((r) => r.name === "main")?.file || null;
  } catch {
    return null;
  }
}

function diskSpace(dir: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

function folderState(dir: string): { exists: boolean; readable: boolean } {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return { exists: false, readable: false };
    fs.accessSync(dir, fs.constants.R_OK);
    return { exists: true, readable: true };
  } catch {
    return { exists: fs.existsSync(dir), readable: false };
  }
}

export interface AdminPluginOptions {
  /** For the update check and the SSO check; tests pass a fake. */
  fetchFn?: FetchFn;
  /** Where community plugins live (defaults to dist/community). */
  communityDir?: string;
}

/** Admin API (and the /admin page): people, sign-up, plugins and server status. */
export function makeAdminPlugin(options: AdminPluginOptions = {}): ServerPlugin {
  return {
    id: "core.admin",
    name: "Admin",
    version: "1.1.0",
    async register(app, ctx) {
      const { db, settings, requireAdmin, config } = ctx;
      const fetchFn = options.fetchFn ?? (fetch as FetchFn);
      const updates = new UpdateChecker(SERVER_VERSION, fetchFn);
      registerAdminPage(app);

      // What was switched on when this server started: the Plugins page compares it with what is saved now.
      const discovered = await listCommunityPlugins(ctx.log, options.communityDir);
      const atBoot = new Map(
        discovered.map((p) => [p.id, { enabled: settings.pluginEnabled(p.id), config: JSON.stringify(settings.pluginConfig(p.id) ?? null) }]),
      );

      // Every successful admin change leaves a line in the audit log.
      app.addHook("onResponse", async (req: FastifyRequest, reply) => {
        if (!req.user?.is_admin) return;
        const note = takeAuditNote(req);
        const action = note?.action ?? genericAuditAction(req.method, req.routeOptions?.url ?? "", reply.statusCode);
        if (!action || (note && reply.statusCode >= 400)) return;
        try {
          recordAudit(db, req.user, action, note?.target, note?.detail);
        } catch (err) {
          req.log.warn({ err }, "could not write the audit log");
        }
      });

      app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
        const signup = settings.signup();
        const file = dbFile(db);
        return {
          version: SERVER_VERSION,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          uptimeSec: Math.round(process.uptime()),
          users: count(db, "SELECT COUNT(*) AS n FROM users"),
          admins: count(db, "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1"),
          disabledUsers: count(db, "SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NOT NULL"),
          tracks: count(db, "SELECT COUNT(*) AS n FROM tracks"),
          plays: count(db, "SELECT COUNT(*) AS n FROM plays"),
          activeSessions: count(db, "SELECT COUNT(*) AS n FROM sessions WHERE last_used_at > ?", Date.now() - 7 * 86_400_000),
          signup: signup ? { mode: signup.mode, inviteCode: signup.mode === "invite" ? signup.inviteCode : null } : { mode: "closed", inviteCode: null },
          oidc: config.oidc ? { name: config.oidc.displayName, issuer: config.oidc.issuer } : null,
          publicUrl: config.publicUrl ?? null,
          storage: {
            dbBytes: file ? fileSize(file) : null,
            dbWalBytes: file ? fileSize(`${file}-wal`) : null,
            data: diskSpace(config.dataDir),
            music: diskSpace(config.musicDir),
          },
          communityPlugins: { available: discovered.length, enabled: discovered.filter((p) => settings.pluginEnabled(p.id)).length },
        };
      });

      // ---- Library -----------------------------------------------------------
      app.get("/api/admin/library", { preHandler: requireAdmin }, async () => {
        const totals = db
          .prepare("SELECT COUNT(*) AS tracks, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(duration_sec), 0) AS seconds FROM tracks")
          .get() as { tracks: number; bytes: number; seconds: number };
        return {
          folder: config.musicDir,
          ...folderState(config.musicDir),
          tracks: totals.tracks,
          artists: count(db, "SELECT COUNT(DISTINCT COALESCE(album_artist, artist)) AS n FROM tracks WHERE COALESCE(album_artist, artist) IS NOT NULL"),
          albums: count(db, "SELECT COUNT(DISTINCT album) AS n FROM tracks WHERE album IS NOT NULL"),
          bytes: totals.bytes,
          durationSec: Math.round(totals.seconds),
          scanIntervalMinutes: config.scanIntervalMinutes,
          freeBytes: diskSpace(config.musicDir)?.freeBytes ?? null,
        };
      });

      // ---- Updates -----------------------------------------------------------
      app.get("/api/admin/update-check", { preHandler: requireAdmin }, async () => ({
        current: SERVER_VERSION,
        status: updates.cached(),
      }));
      // Only when asked: the server never phones home in the background.
      app.post("/api/admin/update-check", { preHandler: requireAdmin }, async () => ({
        current: SERVER_VERSION,
        status: await updates.check(),
      }));

      // ---- Single sign-on (read-only) ---------------------------------------------
      app.get("/api/admin/sso", { preHandler: requireAdmin }, async () => {
        const oidc = config.oidc;
        if (!oidc) return { configured: false };
        let discovery: { ok: boolean; error: string | null } = { ok: false, error: null };
        try {
          const url = `${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
          const res = await fetchFn(url, { signal: AbortSignal.timeout(4000) });
          discovery = res.ok ? { ok: true, error: null } : { ok: false, error: `The provider answered ${res.status}.` };
        } catch (err) {
          discovery = { ok: false, error: err instanceof Error ? err.message : "Couldn't reach the provider." };
        }
        return {
          configured: true,
          name: oidc.displayName,
          issuer: oidc.issuer,
          clientId: oidc.clientId,
          hasClientSecret: !!oidc.clientSecret,
          scopes: oidc.scopes,
          allowedGroups: oidc.allowedGroups,
          adminGroups: oidc.adminGroups,
          callbackUrl: config.publicUrl ? `${config.publicUrl}/api/auth/oidc/callback` : null,
          webCallbackUrl: config.publicUrl ? `${config.publicUrl}/app/auth/callback` : null,
          publicUrlSet: !!config.publicUrl,
          ssoAccounts: count(db, "SELECT COUNT(*) AS n FROM users WHERE oidc_subject IS NOT NULL"),
          discovery,
        };
      });

      // ---- Audit log ---------------------------------------------------------
      app.get<{ Querystring: { limit?: string; before?: string } }>("/api/admin/audit", { preHandler: requireAdmin }, async (req) => {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const before = Number(req.query.before);
        return listAudit(db, limit, Number.isFinite(before) && before > 0 ? before : undefined);
      });

      // ---- Community plugins -------------------------------------------------------
      const pluginView = (p: ServerPlugin) => {
        const enabled = settings.pluginEnabled(p.id);
        const boot = atBoot.get(p.id);
        const saved = settings.pluginConfig<unknown>(p.id);
        const configNow = JSON.stringify(saved ?? null);
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description ?? null,
          enabled,
          running: boot?.enabled ?? false,
          // Turning a plugin on or off, and changing the config of a running one, apply on the next start.
          restartRequired: !!boot && (boot.enabled !== enabled || (enabled && boot.config !== configNow)),
          config: saved === undefined ? null : maskConfig(saved),
          configFields: (p.configFields ?? []) as PluginConfigField[],
          // "form": the declared fields; "none": the plugin has nothing to set here; "json": undeclared, so a plain JSON editor.
          settings: p.configFields === undefined ? "json" : p.configFields.length > 0 ? "form" : "none",
          configNote: p.configNote ?? null,
          adminRoutes: p.adminRoutes ?? [],
          userRoutes: p.userRoutes ?? [],
        };
      };

      app.get("/api/admin/plugins", { preHandler: requireAdmin }, async () => {
        const items = discovered.map(pluginView);
        return { items, restartRequired: items.some((i) => i.restartRequired) };
      });

      app.put<{ Params: { id: string }; Body: { enabled?: unknown; config?: unknown } }>(
        "/api/admin/plugins/:id",
        { preHandler: requireAdmin },
        async (req, reply) => {
          const plugin = PLUGIN_ID_RE.test(req.params.id) ? discovered.find((p) => p.id === req.params.id) : undefined;
          if (!plugin) return reply.code(404).send({ error: "not_found" });
          const { enabled, config: incoming } = req.body ?? {};
          if (enabled !== undefined && typeof enabled !== "boolean") return reply.code(400).send({ error: "invalid_request" });
          let nextConfig: Record<string, unknown> | null | undefined;
          if (incoming !== undefined) {
            if (incoming === null) nextConfig = null;
            else {
              const valid = validConfig(incoming);
              if (!valid) return reply.code(400).send({ error: "invalid_config" });
              nextConfig = unmaskConfig(valid, settings.pluginConfig(plugin.id)) as Record<string, unknown>;
            }
          }
          const changes: string[] = [];
          if (typeof enabled === "boolean" && enabled !== settings.pluginEnabled(plugin.id)) {
            settings.setPluginEnabled(plugin.id, enabled);
            changes.push(enabled ? "turned on" : "turned off");
          }
          if (nextConfig !== undefined) {
            settings.setPluginConfig(plugin.id, nextConfig);
            changes.push("settings changed");
          }
          if (changes.length) noteAudit(req, { action: "plugin.update", target: plugin.id, detail: changes.join(", ") });
          return pluginView(plugin);
        },
      );

      // ---- People ------------------------------------------------------------
      app.get("/api/admin/users", { preHandler: requireAdmin }, async () => ({ items: listUsers(db) }));

      app.post<{ Body: { username?: string; password?: string; displayName?: string; isAdmin?: boolean } }>(
        "/api/admin/users",
        { preHandler: requireAdmin },
        async (req, reply) => {
          const username = (req.body?.username ?? "").trim();
          const password = req.body?.password;
          if (!USERNAME_RE.test(username)) return reply.code(400).send({ error: "invalid_username" });
          if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
            return reply.code(400).send({ error: "weak_password" });
          }
          if (findUserByUsername(db, username)) return reply.code(409).send({ error: "username_taken" });
          const displayName = req.body?.displayName?.trim().slice(0, 80) || undefined;
          let user;
          try {
            user = await createLocalUser(db, { username, password, displayName, isAdmin: req.body?.isAdmin === true });
          } catch (err) {
            if (isUniqueViolation(err)) return reply.code(409).send({ error: "username_taken" });
            throw err;
          }
          noteAudit(req, { action: "user.create", target: user.username, detail: user.is_admin ? "as admin" : null });
          return reply.code(201).send({ id: user.id });
        },
      );

      app.patch<{ Params: { id: string }; Body: { isAdmin?: boolean; disabled?: boolean; password?: string; displayName?: string } }>(
        "/api/admin/users/:id",
        { preHandler: requireAdmin },
        async (req, reply) => {
          const body = req.body ?? {};
          if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD || body.password.length > MAX_PASSWORD)) {
            return reply.code(400).send({ error: "weak_password" });
          }
          // Hash before the guards below so nothing awaits between checking
          // "is this the last admin" and applying the change.
          const newHash = typeof body.password === "string" ? await hashPassword(body.password) : null;

          const target = findUserById(db, Number(req.params.id));
          if (!target) return reply.code(404).send({ error: "not_found" });
          const isActiveAdmin = target.is_admin === 1 && !target.disabled_at;

          if (body.isAdmin === false && target.is_admin === 1) {
            if (isActiveAdmin && activeAdmins(db, target.id) === 0) return reply.code(409).send({ error: "last_admin" });
            if (target.id === req.user!.id) return reply.code(409).send({ error: "cannot_demote_self" });
          }
          if (body.disabled === true && !target.disabled_at) {
            if (target.id === req.user!.id) return reply.code(409).send({ error: "cannot_disable_self" });
            if (isActiveAdmin && activeAdmins(db, target.id) === 0) return reply.code(409).send({ error: "last_admin" });
          }

          const done: string[] = [];
          if (typeof body.isAdmin === "boolean" && body.isAdmin !== (target.is_admin === 1)) {
            db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(body.isAdmin ? 1 : 0, target.id);
            done.push(body.isAdmin ? "promote" : "demote");
          }
          if (typeof body.disabled === "boolean" && body.disabled !== !!target.disabled_at) {
            db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(body.disabled ? Date.now() : null, target.id);
            // Switching someone off ends the sessions they hold right now.
            if (body.disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
            done.push(body.disabled ? "disable" : "enable");
          }
          if (typeof body.displayName === "string") {
            db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(body.displayName.trim().slice(0, 80) || null, target.id);
            done.push("rename");
          }
          if (newHash) {
            db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, target.id);
            // A reset password ends every existing session for that person.
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
            done.push("reset-password");
          }
          if (done.length) noteAudit(req, { action: `user.${done.join("+")}`, target: target.username });
          return { ok: true };
        },
      );

      app.post<{ Params: { id: string } }>("/api/admin/users/:id/sign-out", { preHandler: requireAdmin }, async (req, reply) => {
        const target = findUserById(db, Number(req.params.id));
        if (!target) return reply.code(404).send({ error: "not_found" });
        const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
        noteAudit(req, { action: "user.sign-out", target: target.username, detail: `${Number(result.changes)} session(s)` });
        return { signedOut: Number(result.changes) };
      });

      app.delete<{ Params: { id: string } }>("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
        const target = findUserById(db, Number(req.params.id));
        if (!target) return reply.code(404).send({ error: "not_found" });
        if (target.id === req.user!.id) return reply.code(409).send({ error: "cannot_delete_self" });
        if (target.is_admin === 1 && !target.disabled_at && activeAdmins(db, target.id) === 0) {
          return reply.code(409).send({ error: "last_admin" });
        }
        // Sessions and listening history go with the account (ON DELETE CASCADE).
        deleteUserEverywhere(db, target.id);
        noteAudit(req, { action: "user.delete", target: target.username });
        return reply.code(204).send();
      });

      // ---- Sign-up -----------------------------------------------------------
      app.put<{ Body: { mode?: string; inviteCode?: string; regenerate?: boolean } }>("/api/admin/signup", { preHandler: requireAdmin }, async (req, reply) => {
        const mode = req.body?.mode;
        if (mode === "closed" || mode === "open") {
          settings.setSignup({ mode });
        } else if (mode === "invite") {
          const typed = (req.body?.inviteCode ?? "").trim();
          const code = req.body?.regenerate === true || !typed ? randomBytes(6).toString("base64url") : typed;
          if (!INVITE_RE.test(code)) return reply.code(400).send({ error: "invalid_invite_code" });
          settings.setSignup({ mode, inviteCode: code });
        } else {
          return reply.code(400).send({ error: "invalid_mode" });
        }
        const signup = settings.signup();
        noteAudit(req, {
          action: "signup.update",
          detail: signup?.mode === "invite" && req.body?.regenerate ? "invite: new code" : `mode: ${signup?.mode ?? "closed"}`,
        });
        return { mode: signup?.mode ?? "closed", inviteCode: signup?.mode === "invite" ? signup.inviteCode : null };
      });
    },
  };
}

export const adminPlugin: ServerPlugin = makeAdminPlugin();
