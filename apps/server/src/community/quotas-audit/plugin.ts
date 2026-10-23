import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { userForToken } from "../../auth/sessions.js";
import type { UserRow } from "../../auth/users.js";
import type { PluginConfigField, ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { registerCollector } from "../_ops/registry.js";
import { QuotaEngine, type Denial, type Limits } from "./engine.js";

export const PLUGIN_ID = "cadence.quotas-audit";
const STREAM_URL_RE = /^\/api\/tracks\/([^/]+)\/stream-url$/;
const STREAM_RE = /^\/api\/stream\/([^/?]+)/;
const MAX_OWNERS = 50_000;

export interface QuotaConfig extends Limits {
  /** Admins are never limited (their usage is still counted). */
  exemptAdmins: boolean;
  /** Per-person limits by user id; a missing field falls back to the default above. */
  overrides: Record<string, Partial<Limits>>;
}

const DEFAULTS: QuotaConfig = { maxConcurrentStreams: 0, maxHoursPerDay: 0, exemptAdmins: true, overrides: {} };

const configFields: PluginConfigField[] = [
  { key: "maxConcurrentStreams", label: "Devices streaming at once (0 = no limit)", type: "number", help: "Counted per person. A device is an address plus browser; skipping tracks does not count as a new stream." },
  { key: "maxHoursPerDay", label: "Hours of music per person per day (0 = no limit)", type: "number", help: "Counted when a track starts streaming, in UTC days." },
  { key: "exemptAdmins", label: "Do not limit admins", type: "boolean" },
];

const num = (v: unknown, max: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n * 100) / 100) : undefined;
};

export function cleanConfig(input: Partial<QuotaConfig> | undefined, base: QuotaConfig = DEFAULTS): QuotaConfig {
  const overrides: QuotaConfig["overrides"] = {};
  for (const [id, o] of Object.entries(input?.overrides ?? base.overrides)) {
    if (!/^\d+$/.test(id) || !o || typeof o !== "object") continue;
    const c = num(o.maxConcurrentStreams, 100);
    const h = num(o.maxHoursPerDay, 24);
    if (c !== undefined || h !== undefined) overrides[id] = { ...(c !== undefined ? { maxConcurrentStreams: Math.round(c) } : {}), ...(h !== undefined ? { maxHoursPerDay: h } : {}) };
  }
  return {
    maxConcurrentStreams: Math.round(num(input?.maxConcurrentStreams, 100) ?? base.maxConcurrentStreams),
    maxHoursPerDay: num(input?.maxHoursPerDay, 24) ?? base.maxHoursPerDay,
    exemptAdmins: typeof input?.exemptAdmins === "boolean" ? input.exemptAdmins : base.exemptAdmins,
    overrides,
  };
}

/** The limits that apply to one person (null when they are exempt). */
export function limitsFor(config: QuotaConfig, user: Pick<UserRow, "id" | "is_admin">): Limits | null {
  if (user.is_admin && config.exemptAdmins) return null;
  const o = config.overrides[String(user.id)] ?? {};
  return { maxConcurrentStreams: o.maxConcurrentStreams ?? config.maxConcurrentStreams, maxHoursPerDay: o.maxHoursPerDay ?? config.maxHoursPerDay };
}

const unlimited = (l: Limits) => l.maxConcurrentStreams <= 0 && l.maxHoursPerDay <= 0;

export interface QuotaOptions {
  now?: () => number;
}

export function createQuotasPlugin(options: QuotaOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Quotas and usage",
    version: "1.0.0",
    description:
      "Limits how many devices a person can stream on at once and how many hours they stream per day, and shows the admin who streamed what. Enforced by a hook on the streaming routes; the music library code is untouched.",
    configFields,
    adminRoutes: ["GET|PUT /api/quotas/config", "GET /api/quotas/usage", "GET /api/quotas/events"],
    userRoutes: ["GET /api/quotas/me"],
    register(app, ctx) {
      registerQuotas(app, ctx, options);
    },
  };
}

function registerQuotas(app: FastifyInstance, ctx: ServerPluginContext, options: QuotaOptions): void {
  const { db, settings, requireAdmin, requireUser } = ctx;
  const now = options.now ?? Date.now;
  const engine = new QuotaEngine(db, now);
  const readConfig = (): QuotaConfig => cleanConfig(settings.pluginConfig<Partial<QuotaConfig>>(PLUGIN_ID));

  /** Who a signed stream address was issued to (the stream route itself carries no login). */
  const owners = new Map<string, { userId: number; isAdmin: boolean; expiresAt: number }>();
  function remember(sig: string, user: UserRow, expSec: number): void {
    if (owners.size >= MAX_OWNERS) {
      for (const [k, v] of owners) if (v.expiresAt <= now()) owners.delete(k);
      if (owners.size >= MAX_OWNERS) owners.delete(owners.keys().next().value as string);
    }
    owners.set(sig, { userId: user.id, isAdmin: user.is_admin === 1, expiresAt: expSec * 1000 });
  }

  const deviceOf = (req: FastifyRequest) => `${req.ip}|${createHash("sha1").update(req.headers["user-agent"] ?? "").digest("hex").slice(0, 10)}`;
  const durationOf = (trackId: string): number | null =>
    (db.prepare("SELECT duration_sec FROM tracks WHERE id = ?").get(trackId) as { duration_sec: number | null } | undefined)?.duration_sec ?? null;

  function refuse(reply: FastifyReply, userId: number, trackId: string | null, denial: Extract<Denial, { ok: false }>) {
    engine.deny(userId, denial.reason, trackId);
    return reply
      .code(429)
      .header("Retry-After", String(denial.retryAfterSec))
      .send({ error: denial.reason === "concurrent" ? "quota_concurrent_streams" : "quota_daily_hours", message: denial.message, retryAfterSec: denial.retryAfterSec });
  }

  // 1. Asking for a stream address: the person is known (bearer token), so the limits are checked here, with a clear message.
  // 2. The signed stream request itself: attributed through the address it was issued with, then counted.
  // Both are plain Fastify hooks on this plugin's own registration; the library plugin does not know about them.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET") return;
    const path = req.url.split("?")[0];

    const issue = STREAM_URL_RE.exec(path);
    if (issue) {
      const header = req.headers.authorization ?? "";
      const user = header.startsWith("Bearer ") ? userForToken(db, header.slice(7).trim()) : null;
      if (!user) return; // The route answers 401 itself.
      const limits = limitsFor(readConfig(), user);
      if (!limits || unlimited(limits)) return;
      const trackId = decodeURIComponent(issue[1]);
      const verdict = engine.check(user.id, deviceOf(req), trackId, limits);
      if (!verdict.ok) return refuse(reply, user.id, trackId, verdict);
      return;
    }

    const stream = STREAM_RE.exec(path);
    if (stream) {
      const query = new URL(req.url, "http://x").searchParams;
      const owner = owners.get(query.get("sig") ?? "");
      if (!owner || owner.expiresAt <= now()) return; // Not issued by this running server: cannot be attributed.
      const trackId = decodeURIComponent(stream[1]);
      const user = { id: owner.userId, is_admin: owner.isAdmin ? 1 : 0 };
      const limits = limitsFor(readConfig(), user);
      if (limits && !unlimited(limits)) {
        const verdict = engine.check(owner.userId, deviceOf(req), trackId, limits);
        if (!verdict.ok) return refuse(reply, owner.userId, trackId, verdict);
      }
      engine.start(owner.userId, deviceOf(req), trackId, durationOf(trackId));
    }
  });

  // Remember who each signed stream address was issued to.
  // Deliberately a callback hook, not async: an async onSend on every route delays the write by a
  // tick, and a route that calls reply.send() and then resolves undefined gets answered twice
  // (an empty body plus "Reply was already sent"). Seen with /api/lidarr/status once quotas were on.
  app.addHook("onSend", (req, reply, payload, done) => {
    if (req.method !== "GET" || reply.statusCode !== 200 || !req.user) return done(null, payload);
    if (!STREAM_URL_RE.test(req.url.split("?")[0]) || typeof payload !== "string") return done(null, payload);
    try {
      const { path } = JSON.parse(payload) as { path?: string };
      const q = new URL(path ?? "", "http://x/").searchParams;
      const sig = q.get("sig");
      const exp = Number(q.get("exp"));
      if (sig && Number.isFinite(exp)) remember(sig, req.user, exp);
    } catch {
      // Not the expected shape; nothing to remember.
    }
    done(null, payload);
  });
  registerCollector(PLUGIN_ID, () => [
    { name: "cadence_quota_denied_total", help: "Streams refused by a quota.", type: "counter" as const, labels: { reason: "concurrent" }, value: engine.denied.concurrent },
    { name: "cadence_quota_denied_total", help: "Streams refused by a quota.", type: "counter" as const, labels: { reason: "daily" }, value: engine.denied.daily },
  ]);

  const usernames = () => new Map((db.prepare("SELECT id, username, is_admin FROM users").all() as unknown as { id: number; username: string; is_admin: number }[]).map((u) => [u.id, u]));

  app.get("/api/quotas/config", { preHandler: requireAdmin }, async () => ({ config: readConfig() }));

  app.put<{ Body: Partial<QuotaConfig> }>("/api/quotas/config", { preHandler: requireAdmin }, async (req) => {
    const next = cleanConfig(req.body ?? {}, readConfig());
    settings.setPluginConfig(PLUGIN_ID, next);
    req.log.info({ admin: req.user!.username, config: next }, "admin changed the stream quotas");
    return { config: next };
  });

  app.get("/api/quotas/usage", { preHandler: requireAdmin }, async () => {
    const config = readConfig();
    const users = usernames();
    return {
      config,
      items: engine.usage().map((u) => {
        const user = users.get(u.userId);
        const limits = user ? limitsFor(config, { id: u.userId, is_admin: user.is_admin }) : null;
        return {
          userId: u.userId,
          username: user?.username ?? String(u.userId),
          isAdmin: user?.is_admin === 1,
          todaySeconds: Math.round(u.today),
          last7Seconds: Math.round(u.last7),
          last30Seconds: Math.round(u.last30),
          streams30: u.streams30,
          lastStreamAt: u.lastStreamAt,
          activeStreams: engine.activeStreams(u.userId),
          limits,
        };
      }),
      denied: engine.denied,
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/quotas/events", { preHandler: requireAdmin }, async (req) => ({
    items: engine.events(Math.min(500, Math.max(1, Number(req.query.limit) || 100))),
  }));

  app.get("/api/quotas/me", { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    const limits = limitsFor(readConfig(), user);
    return {
      limits,
      todaySeconds: Math.round(engine.secondsToday(user.id)),
      activeStreams: engine.activeStreams(user.id),
    };
  });
}

export default createQuotasPlugin();