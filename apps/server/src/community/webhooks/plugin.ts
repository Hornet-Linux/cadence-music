import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import type { ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { instrumentJobs, registerCollector } from "../_ops/registry.js";
import { hasSecret, openSecret, sealSecret } from "../_ops/secrets.js";
import { UrlRejected, isPrivateAddress, parseTargetUrl } from "../_ops/ssrf.js";
import { WebhookEngine, type RequestFn, type ResolvedEndpoint } from "./engine.js";
import { TEMPLATES, TEMPLATE_LABELS, type TemplateId } from "./templates.js";

export const PLUGIN_ID = "cadence.webhooks";
export const EVENTS = ["play.recorded", "library.changed"] as const;

interface StoredEndpoint {
  id: string;
  name: string;
  url: string;
  /** Sealed with the server secret. */
  secret: string;
  events: string[];
  template: TemplateId;
  enabled: boolean;
  allowPrivate: boolean;
  createdAt: number;
}

interface StoredConfig {
  endpoints: StoredEndpoint[];
}


function clean(input: unknown, max: number): string {
  return typeof input === "string" ? input.trim().slice(0, max) : "";
}

/** Public form of an endpoint: never includes the secret. */
function publicEndpoint(e: StoredEndpoint) {
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    events: e.events,
    template: e.template,
    enabled: e.enabled,
    allowPrivate: e.allowPrivate,
    secretSet: hasSecret(e.secret),
    createdAt: e.createdAt,
  };
}

/** Throws UrlRejected for an address the admin has not explicitly allowed. Names are checked again at send time. */
export function validateDestination(url: string, allowPrivate: boolean): URL {
  const parsed = parseTargetUrl(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const privateName = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host);
  if (!allowPrivate && (net.isIP(host) ? isPrivateAddress(host) : privateName)) {
    throw new UrlRejected("blocked_address", "That address is on a private network. Turn on 'Allow private network addresses' if you really mean to send there.");
  }
  return parsed;
}

export interface WebhooksOptions {
  /** For tests: replace the HTTP sender. */
  request?: RequestFn;
  backoffMs?: number[];
  now?: () => number;
}

export function createWebhooksPlugin(options: WebhooksOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Webhooks",
    version: "1.0.0",
    description:
      "Sends signed webhooks (HMAC-SHA256) when plays are recorded or the library changes, with retries, a delivery log, SSRF protection and templates for n8n, Home Assistant and Discord.",
    configFields: [],
    configNote: "Destinations, signing secrets and templates are managed in the player under Settings > Plugins > Webhooks (secrets are stored encrypted and shown once). Nothing here needs filling in.",
    adminRoutes: [
      "GET /api/webhooks",
      "POST /api/webhooks/endpoints",
      "PATCH /api/webhooks/endpoints/:id",
      "DELETE /api/webhooks/endpoints/:id",
      "POST /api/webhooks/endpoints/:id/test",
      "GET /api/webhooks/deliveries",
      "POST /api/webhooks/deliveries/:id/retry",
    ],
    register(app, ctx) {
      registerWebhooks(app, ctx, options);
    },
  };
}

function registerWebhooks(app: FastifyInstance, ctx: ServerPluginContext, options: WebhooksOptions): void {
  const { db, settings, requireAdmin, secret } = ctx;
  instrumentJobs(ctx.jobs, ctx.log);

  const read = (): StoredConfig => settings.pluginConfig<StoredConfig>(PLUGIN_ID) ?? { endpoints: [] };
  const write = (config: StoredConfig) => settings.setPluginConfig(PLUGIN_ID, config);

  const resolved = (): ResolvedEndpoint[] =>
    read().endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url,
      secret: openSecret(e.secret, secret, PLUGIN_ID) ?? "",
      events: e.events,
      template: e.template,
      enabled: e.enabled,
      allowPrivate: e.allowPrivate,
    }));

  const engine = new WebhookEngine({
    db,
    endpoints: resolved,
    request: options.request,
    backoffMs: options.backoffMs,
    now: options.now,
    onError: (err) => ctx.log.warn({ err }, "webhook delivery problem"),
  });

  // Deliveries that were mid-flight when the server stopped are retried on the next tick.
  ctx.jobs.every("webhooks-deliver", 5_000, async () => void (await engine.tick()), { runSoon: true });

  ctx.events.on("play.recorded", (play) => {
    const user = db.prepare("SELECT username FROM users WHERE id = ?").get(play.userId) as { username: string } | undefined;
    engine.emit("play.recorded", {
      user: { id: play.userId, username: user?.username ?? null },
      track: {
        id: play.track.id,
        title: play.track.title,
        artists: play.track.artists.map((a) => a.name),
        album: play.track.album ?? null,
        durationSec: play.track.durationSec ?? null,
        source: play.track.source ?? null,
      },
      playedAt: new Date(play.playedAt).toISOString(),
    });
  });

  // The library plugin does not publish an event when a scan ends, so a scan is noticed by its result:
  // the number of tracks or the newest addition changed.
  const librarySnapshot = () =>
    db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(added_at), 0) AS newest FROM tracks").get() as { n: number; newest: number };
  let last = librarySnapshot();
  ctx.jobs.every("webhooks-library-watch", 60_000, () => {
    const now = librarySnapshot();
    if (now.n !== last.n || now.newest !== last.newest) {
      engine.emit("library.changed", { tracks: now.n, delta: now.n - last.n });
      last = now;
    }
  });

  registerCollector(PLUGIN_ID, () => {
    const c = engine.counts();
    const help = "Webhook deliveries by status.";
    return (["pending", "failed", "success"] as const).map((status) => ({
      name: "cadence_webhook_deliveries",
      help,
      type: "gauge" as const,
      labels: { status },
      value: c[status],
    }));
  });

  function parseEndpointBody(body: Record<string, unknown>, existing?: StoredEndpoint) {
    const name = body.name === undefined && existing ? existing.name : clean(body.name, 80);
    if (!name) return { error: "invalid_name" as const };
    const url = body.url === undefined && existing ? existing.url : clean(body.url, 2000);
    const allowPrivate = typeof body.allowPrivate === "boolean" ? body.allowPrivate : (existing?.allowPrivate ?? false);
    try {
      validateDestination(url, allowPrivate);
    } catch (err) {
      if (err instanceof UrlRejected) return { error: err.code, message: err.message };
      throw err;
    }
    const events = Array.isArray(body.events)
      ? body.events.filter((e): e is string => typeof e === "string" && (EVENTS as readonly string[]).includes(e))
      : (existing?.events ?? [...EVENTS]);
    const template = (TEMPLATES as readonly string[]).includes(body.template as string) ? (body.template as TemplateId) : (existing?.template ?? "generic");
    const enabled = typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? true);
    return { value: { name, url, allowPrivate, events, template, enabled } };
  }

  app.get("/api/webhooks", { preHandler: requireAdmin }, async () => ({
    endpoints: read().endpoints.map(publicEndpoint),
    events: EVENTS,
    templates: TEMPLATES.map((id) => ({ id, label: TEMPLATE_LABELS[id] })),
    counts: engine.counts(),
    signing: {
      headers: ["X-Cadence-Event", "X-Cadence-Delivery", "X-Cadence-Timestamp", "X-Cadence-Signature"],
      scheme: "X-Cadence-Signature is sha256= followed by hex(HMAC-SHA256(secret, timestamp + '.' + rawBody)). Reject timestamps older than 5 minutes.",
    },
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/webhooks/endpoints", { preHandler: requireAdmin }, async (req, reply) => {
    const config = read();
    if (config.endpoints.length >= 20) return reply.code(409).send({ error: "too_many_endpoints" });
    const parsed = parseEndpointBody(req.body ?? {});
    if ("error" in parsed) return reply.code(400).send(parsed);
    const plainSecret = clean((req.body ?? {}).secret, 200) || randomBytes(24).toString("base64url");
    const endpoint: StoredEndpoint = {
      id: randomUUID(),
      ...parsed.value,
      secret: sealSecret(plainSecret, secret, PLUGIN_ID),
      createdAt: Date.now(),
    };
    write({ endpoints: [...config.endpoints, endpoint] });
    req.log.info({ admin: req.user!.username, endpoint: endpoint.name }, "admin added a webhook endpoint");
    // The secret is shown once; after this only whether one exists.
    return reply.code(201).send({ endpoint: publicEndpoint(endpoint), secret: plainSecret });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/webhooks/endpoints/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const config = read();
    const existing = config.endpoints.find((e) => e.id === req.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const parsed = parseEndpointBody(req.body ?? {}, existing);
    if ("error" in parsed) return reply.code(400).send(parsed);
    let newSecret: string | undefined;
    let sealed = existing.secret;
    if ((req.body ?? {}).rotateSecret === true) {
      newSecret = randomBytes(24).toString("base64url");
      sealed = sealSecret(newSecret, secret, PLUGIN_ID);
    }
    const updated: StoredEndpoint = { ...existing, ...parsed.value, secret: sealed };
    write({ endpoints: config.endpoints.map((e) => (e.id === existing.id ? updated : e)) });
    return { endpoint: publicEndpoint(updated), ...(newSecret ? { secret: newSecret } : {}) };
  });

  app.delete<{ Params: { id: string } }>("/api/webhooks/endpoints/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const config = read();
    if (!config.endpoints.some((e) => e.id === req.params.id)) return reply.code(404).send({ error: "not_found" });
    write({ endpoints: config.endpoints.filter((e) => e.id !== req.params.id) });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/webhooks/endpoints/:id/test", { preHandler: requireAdmin }, async (req, reply) => {
    if (!read().endpoints.some((e) => e.id === req.params.id)) return reply.code(404).send({ error: "not_found" });
    const [id] = engine.emit("webhook.test", { message: "Hello from Cadence", requestedBy: req.user!.username }, req.params.id);
    // Wait for the first attempt so the admin sees the outcome right away.
    const delivery = id ? await engine.attemptById(id) : null;
    return { delivery };
  });

  app.get<{ Querystring: { limit?: string; endpoint?: string } }>("/api/webhooks/deliveries", { preHandler: requireAdmin }, async (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return { items: engine.list(limit, req.query.endpoint) };
  });

  app.post<{ Params: { id: string } }>("/api/webhooks/deliveries/:id/retry", { preHandler: requireAdmin }, async (req, reply) => {
    if (!engine.retry(req.params.id)) return reply.code(409).send({ error: "not_retryable" });
    return reply.code(202).send({ queued: true });
  });
}

export default createWebhooksPlugin();