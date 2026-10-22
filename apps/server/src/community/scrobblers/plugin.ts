import type { FastifyReply } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { PLUGIN_ID, ScrobblerError, Scrobbler, type EngineOptions } from "./engine.js";
import { isServiceId, type ServiceId } from "./services.js";

const FLUSH_EVERY_MS = 60_000;

export interface ScrobblersOptions {
  fetchFn?: EngineOptions["fetchFn"];
  now?: EngineOptions["now"];
  sleep?: EngineOptions["sleep"];
  autoFlushDelayMs?: EngineOptions["autoFlushDelayMs"];
}

type Body = Record<string, unknown>;
const asBody = (b: unknown): Body => (b && typeof b === "object" ? (b as Body) : {});

/**
 * Scrobbling for every device. Phones and desktops all report finished plays to the server's history;
 * this plugin forwards each one to the Last.fm, Libre.fm, ListenBrainz and Maloja accounts its owner
 * connected, with a retry queue that survives restarts.
 */
export function createScrobblersPlugin(options: ScrobblersOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Scrobblers",
    version: "1.0.0",
    register(app, ctx) {
      const engine = new Scrobbler({
        db: ctx.db,
        settings: ctx.settings,
        secret: ctx.secret,
        log: ctx.log,
        fetchFn: options.fetchFn,
        now: options.now,
        sleep: options.sleep,
        autoFlushDelayMs: options.autoFlushDelayMs === undefined ? 2000 : options.autoFlushDelayMs,
      });
      // Calls that reach out to other sites are limited per person.
      const limiter = new RateLimiter({ max: 30, windowMs: 5 * 60_000 });

      ctx.events.on("play.recorded", (event) => {
        engine.onPlay(event);
      });
      ctx.jobs.every("scrobblers.flush", FLUSH_EVERY_MS, () => void engine.flush(), { runSoon: true });
      app.addHook("onClose", async () => engine.stop());

      const fail = (reply: FastifyReply, err: unknown) => {
        if (err instanceof ScrobblerError) return reply.code(err.status).send({ error: err.code, message: err.message });
        ctx.log.warn({ err }, "scrobblers route failed");
        return reply.code(500).send({ error: "server_error", message: "Something went wrong." });
      };
      const limited = (userId: number, reply: FastifyReply): boolean => {
        const key = `u${userId}`;
        if (limiter.isLimited(key)) {
          void reply.code(429).send({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." });
          return true;
        }
        limiter.hit(key);
        return false;
      };
      const serviceOf = (raw: string, reply: FastifyReply): ServiceId | null => {
        if (isServiceId(raw)) return raw;
        void reply.code(404).send({ error: "unknown_service", message: "Unknown service." });
        return null;
      };

      app.get("/api/scrobblers/status", { preHandler: ctx.requireUser }, async (req) => ({
        ...engine.status(req.user!.id),
        isAdmin: !!req.user!.is_admin,
      }));

      app.get("/api/scrobblers/queue", { preHandler: ctx.requireUser }, async (req) => {
        const status = engine.status(req.user!.id);
        return { services: status.services.map((s) => ({ id: s.id, label: s.label, ...s.queue })), problems: status.problems, retryDays: status.retryDays };
      });

      app.post("/api/scrobblers/queue/retry", { preHandler: ctx.requireUser }, async (req, reply) => {
        if (limited(req.user!.id, reply)) return;
        const raw = asBody(req.body).service;
        const service = raw === undefined ? undefined : isServiceId(raw) ? raw : null;
        if (service === null) return reply.code(400).send({ error: "invalid_request", message: "Unknown service." });
        return engine.retryNow(req.user!.id, service);
      });

      app.delete<{ Querystring: { service?: string } }>("/api/scrobblers/queue", { preHandler: ctx.requireUser }, async (req, reply) => {
        const raw = req.query.service;
        if (raw !== undefined && !isServiceId(raw)) return reply.code(400).send({ error: "invalid_request", message: "Unknown service." });
        return { cleared: engine.queue.clear(req.user!.id, raw as ServiceId | undefined) };
      });

      app.post<{ Params: { service: string } }>("/api/scrobblers/:service/connect", { preHandler: ctx.requireUser }, async (req, reply) => {
        const service = serviceOf(req.params.service, reply);
        if (!service) return;
        const userId = req.user!.id;
        if (limited(userId, reply)) return;
        const body = asBody(req.body);
        try {
          if (service === "lastfm" || service === "librefm") {
            const cb = typeof body.callbackUrl === "string" && /^https?:\/\/[^\s]{1,480}$/.test(body.callbackUrl) ? body.callbackUrl : undefined;
            return await engine.connectLastfmLike(userId, service, cb);
          }
          if (service === "listenbrainz") return await engine.connectListenBrainz(userId, body.token, body.host);
          return await engine.connectMaloja(userId, body.url, body.apiKey);
        } catch (err) {
          return fail(reply, err);
        }
      });

      app.post<{ Params: { service: string } }>("/api/scrobblers/:service/finish", { preHandler: ctx.requireUser }, async (req, reply) => {
        const service = serviceOf(req.params.service, reply);
        if (!service) return;
        if (service !== "lastfm" && service !== "librefm") {
          return reply.code(400).send({ error: "invalid_request", message: "This service has no approval step." });
        }
        if (limited(req.user!.id, reply)) return;
        try {
          return await engine.finishLastfmLike(req.user!.id, service);
        } catch (err) {
          return fail(reply, err);
        }
      });

      app.post<{ Params: { service: string } }>("/api/scrobblers/:service/test", { preHandler: ctx.requireUser }, async (req, reply) => {
        const service = serviceOf(req.params.service, reply);
        if (!service) return;
        if (limited(req.user!.id, reply)) return;
        try {
          return await engine.test(req.user!.id, service);
        } catch (err) {
          return fail(reply, err);
        }
      });

      app.patch<{ Params: { service: string } }>("/api/scrobblers/:service", { preHandler: ctx.requireUser }, async (req, reply) => {
        const service = serviceOf(req.params.service, reply);
        if (!service) return;
        const enabled = asBody(req.body).enabled;
        if (typeof enabled !== "boolean") return reply.code(400).send({ error: "invalid_request", message: "Send enabled: true or false." });
        try {
          engine.setEnabled(req.user!.id, service, enabled);
          return { enabled };
        } catch (err) {
          return fail(reply, err);
        }
      });

      app.delete<{ Params: { service: string } }>("/api/scrobblers/:service", { preHandler: ctx.requireUser }, async (req, reply) => {
        const service = serviceOf(req.params.service, reply);
        if (!service) return;
        engine.disconnect(req.user!.id, service);
        return reply.code(204).send();
      });

      // Server owner: Last.fm / Libre.fm app keys and policy. Secrets are never sent back.
      app.get("/api/scrobblers/admin/config", { preHandler: ctx.requireAdmin }, async () => {
        const c = engine.adminConfig();
        return {
          lastfm: c.lastfm ? { apiKey: c.lastfm.apiKey, hasSecret: true } : null,
          librefm: c.librefm ? { apiKey: c.librefm.apiKey, hasSecret: true } : null,
          allowCustomHosts: c.allowCustomHosts === true,
          retryDays: engine.retryDays(),
        };
      });

      app.put("/api/scrobblers/admin/config", { preHandler: ctx.requireAdmin }, async (req, reply) => {
        const body = asBody(req.body);
        const keyPair = (v: unknown) => (v === null ? null : v && typeof v === "object" ? (v as { apiKey?: string; apiSecret?: string }) : undefined);
        try {
          engine.saveAdminConfig({
            lastfm: keyPair(body.lastfm),
            librefm: keyPair(body.librefm),
            allowCustomHosts: typeof body.allowCustomHosts === "boolean" ? body.allowCustomHosts : undefined,
            retryDays: body.retryDays === undefined ? undefined : Number(body.retryDays),
          });
          return reply.code(204).send();
        } catch (err) {
          return fail(reply, err);
        }
      });
    },
  };
}

export default createScrobblersPlugin();
