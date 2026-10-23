import type { FastifyInstance, FastifyReply } from "fastify";
import { UpstreamError, type FetchFn } from "../_ops/http.js";
import type { PluginConfigField, ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { hasSecret, openSecret, sealSecret } from "../_ops/secrets.js";
import { parseTargetUrl } from "../_ops/ssrf.js";
import { LidarrClient } from "./lidarr.js";
import { SlskdClient } from "./slskd.js";

export const PLUGIN_ID = "cadence.lidarr-slskd";
export const NOTICE_VERSION = 1;

export const LEGAL_NOTICE =
  "Lidarr and Soulseek (slskd) are tools for finding and fetching music. You, the server administrator, decide what is requested " +
  "and you alone are responsible for it: make sure you have the right to obtain and store everything you ask for, and follow the law " +
  "and the terms of every service involved. Cadence only passes your requests to your own Lidarr and slskd. It does not host, " +
  "search for or download anything itself, and it never starts a Soulseek download.";

interface StoredService {
  url: string;
  /** Sealed. */
  apiKey: string;
}

interface StoredConfig {
  acknowledged?: { version: number; by: string; at: number };
  lidarr?: StoredService & { rootFolderPath?: string; qualityProfileId?: number; metadataProfileId?: number };
  slskd?: StoredService;
}

const configFields: PluginConfigField[] = [
  { key: "acknowledged", label: "I understand the legal notice", type: "boolean", help: LEGAL_NOTICE },
  { key: "lidarr.url", label: "Lidarr address", type: "url", help: "For example http://lidarr:8686" },
  { key: "lidarr.apiKey", label: "Lidarr API key", type: "secret", sealed: true, help: "Lidarr: Settings > General > Security." },
  { key: "lidarr.rootFolderPath", label: "Root folder (optional)", type: "text", help: "Defaults to Lidarr's first root folder." },
  { key: "slskd.url", label: "slskd address", type: "url", help: "For example http://slskd:5030" },
  { key: "slskd.apiKey", label: "slskd API key", type: "secret", sealed: true, help: "Set under 'web.authentication.api_keys' in slskd's configuration." },
];

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

export interface LidarrSlskdOptions {
  /** For tests: replaces the HTTP client used for both services. */
  fetchFn?: FetchFn;
}

export function createLidarrSlskdPlugin(options: LidarrSlskdOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Lidarr and slskd",
    version: "1.0.0",
    description:
      "Admin-only and opt-in. Request missing albums through your own Lidarr (search, add, monitor, status) and run searches on your own slskd. Needs the administrator to accept a legal notice first.",
    configFields,
    configNote: "API keys are stored encrypted. Set or replace them in the player under Settings > Plugins > Lidarr and slskd, which also tests the connection.",
    adminRoutes: [
      "GET|PUT /api/lidarr/config",
      "POST /api/lidarr/test",
      "GET /api/lidarr/search?q=",
      "POST /api/lidarr/request",
      "GET /api/lidarr/status",
      "GET /api/lidarr/requests",
      "GET /api/slskd/status",
      "POST /api/slskd/search",
      "GET /api/slskd/search/:id",
    ],
    register(app, ctx) {
      registerLidarrSlskd(app, ctx, options);
    },
  };
}

function registerLidarrSlskd(app: FastifyInstance, ctx: ServerPluginContext, options: LidarrSlskdOptions): void {
  const { db, settings, requireAdmin, secret } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lidarr_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_album_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      action TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    );
  `);

  const read = (): StoredConfig => settings.pluginConfig<StoredConfig>(PLUGIN_ID) ?? {};
  const write = (c: StoredConfig) => settings.setPluginConfig(PLUGIN_ID, c);

  const lidarr = (c: StoredConfig): LidarrClient | null => {
    const key = openSecret(c.lidarr?.apiKey, secret, PLUGIN_ID);
    return c.lidarr?.url && key ? new LidarrClient(c.lidarr.url, key, options.fetchFn) : null;
  };
  const slskd = (c: StoredConfig): SlskdClient | null => {
    const key = openSecret(c.slskd?.apiKey, secret, PLUGIN_ID);
    return c.slskd?.url && key ? new SlskdClient(c.slskd.url, key, options.fetchFn) : null;
  };

  /** Nothing talks to Lidarr or slskd until the administrator has accepted the notice. */
  function gate(reply: FastifyReply, c: StoredConfig): boolean {
    if (c.acknowledged?.version === NOTICE_VERSION) return true;
    reply.code(403).send({ error: "notice_not_accepted", message: "Read and accept the legal notice in the settings first.", notice: LEGAL_NOTICE });
    return false;
  }

  function upstream(reply: FastifyReply, err: unknown) {
    if (err instanceof UpstreamError) return reply.code(err.status === 401 ? 401 : 502).send({ error: "upstream_error", message: err.message });
    const message = err instanceof Error ? err.message : "Request failed.";
    return reply.code(502).send({ error: "upstream_error", message });
  }

  const publicConfig = (c: StoredConfig) => ({
    notice: LEGAL_NOTICE,
    noticeVersion: NOTICE_VERSION,
    acknowledged: c.acknowledged?.version === NOTICE_VERSION ? { by: c.acknowledged.by, at: c.acknowledged.at } : null,
    lidarr: c.lidarr
      ? { url: c.lidarr.url, apiKeySet: hasSecret(c.lidarr.apiKey), rootFolderPath: c.lidarr.rootFolderPath ?? null, qualityProfileId: c.lidarr.qualityProfileId ?? null, metadataProfileId: c.lidarr.metadataProfileId ?? null }
      : null,
    slskd: c.slskd ? { url: c.slskd.url, apiKeySet: hasSecret(c.slskd.apiKey) } : null,
  });

  app.get("/api/lidarr/config", { preHandler: requireAdmin }, async () => publicConfig(read()));

  app.put<{ Body: Record<string, unknown> }>("/api/lidarr/config", { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body ?? {};
    const current = read();
    const next: StoredConfig = { ...current };

    if (body.acknowledged === true) {
      if (body.noticeVersion !== NOTICE_VERSION) return reply.code(400).send({ error: "invalid_request", message: "Send the notice version that was shown." });
      if (current.acknowledged?.version !== NOTICE_VERSION) next.acknowledged = { version: NOTICE_VERSION, by: req.user!.username, at: Date.now() };
    } else if (body.acknowledged === false) delete next.acknowledged;

    for (const service of ["lidarr", "slskd"] as const) {
      if (!(service in body)) continue;
      const input = body[service];
      if (input === null) {
        delete next[service];
        continue;
      }
      if (!input || typeof input !== "object") return reply.code(400).send({ error: "invalid_request" });
      const o = input as Record<string, unknown>;
      const url = str(o.url, 500);
      try {
        parseTargetUrl(url);
      } catch {
        return reply.code(400).send({ error: "invalid_url", message: `The ${service} address must be an http or https URL.` });
      }
      const previous = current[service];
      const newKey = str(o.apiKey, 200);
      // A blank key keeps the saved one, unless the address changed (a key must not travel to a new host).
      if (!newKey && (!previous?.apiKey || new URL(previous.url).origin !== new URL(url).origin)) {
        return reply.code(400).send({ error: "invalid_request", message: `Enter the ${service} API key.` });
      }
      const stored: StoredService = { url: url.replace(/\/+$/, ""), apiKey: newKey ? sealSecret(newKey, secret, PLUGIN_ID) : previous!.apiKey };
      if (service === "lidarr") {
        next.lidarr = {
          ...stored,
          rootFolderPath: str(o.rootFolderPath, 500) || undefined,
          qualityProfileId: posInt(o.qualityProfileId),
          metadataProfileId: posInt(o.metadataProfileId),
        };
      } else next.slskd = stored;
    }
    write(next);
    req.log.info({ admin: req.user!.username }, "admin updated the Lidarr/slskd settings");
    return publicConfig(next);
  });

  app.post("/api/lidarr/test", { preHandler: requireAdmin }, async (_req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const out: { lidarr: unknown; slskd: unknown } = { lidarr: null, slskd: null };
    const l = lidarr(c);
    if (l) {
      try {
        const s = await l.status();
        out.lidarr = { ok: true, version: s.version ?? null, name: s.instanceName ?? s.appName ?? "Lidarr", rootFolders: (await l.rootFolders()).map((f) => f.path), qualityProfiles: await l.qualityProfiles(), metadataProfiles: await l.metadataProfiles() };
      } catch (err) {
        out.lidarr = { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    }
    const s = slskd(c);
    if (s) {
      try {
        out.slskd = { ok: true, ...(await s.status()) };
      } catch (err) {
        out.slskd = { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    }
    return out;
  });
  // ---- Lidarr ------------------------------------------------------------------
  app.get<{ Querystring: { q?: string } }>("/api/lidarr/search", { preHandler: requireAdmin }, async (req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = lidarr(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "Lidarr is not set up yet." });
    const q = str(req.query.q, 200);
    if (q.length < 2) return reply.code(400).send({ error: "invalid_request", message: "Type at least two characters." });
    try {
      return { items: (await client.lookupAlbums(q)).map((r) => r.hit) };
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.post<{ Body: { foreignAlbumId?: unknown } }>("/api/lidarr/request", { preHandler: requireAdmin }, async (req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = lidarr(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "Lidarr is not set up yet." });
    const id = str(req.body?.foreignAlbumId, 100);
    if (!/^[0-9a-f-]{16,64}$/i.test(id)) return reply.code(400).send({ error: "invalid_request", message: "Pick an album from the search results." });
    try {
      const outcome = await client.requestAlbum(id, { rootFolderPath: c.lidarr?.rootFolderPath, qualityProfileId: c.lidarr?.qualityProfileId, metadataProfileId: c.lidarr?.metadataProfileId });
      db.prepare("INSERT INTO lidarr_requests (foreign_album_id, title, artist, action, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        outcome.title,
        outcome.artist,
        outcome.action,
        req.user!.username,
        Date.now(),
      );
      req.log.info({ admin: req.user!.username, album: outcome.title, artist: outcome.artist, action: outcome.action }, "admin requested an album through Lidarr");
      return reply.code(201).send(outcome);
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.get("/api/lidarr/status", { preHandler: requireAdmin }, async (_req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = lidarr(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "Lidarr is not set up yet." });
    try {
      const [status, queue, missing] = await Promise.all([client.status(), client.queue(), client.missingCount()]);
      return { connected: true, version: status.version ?? null, queue, missing };
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.get("/api/lidarr/requests", { preHandler: requireAdmin }, async () => ({
    items: db.prepare("SELECT foreign_album_id AS foreignAlbumId, title, artist, action, requested_by AS requestedBy, requested_at AS requestedAt FROM lidarr_requests ORDER BY id DESC LIMIT 50").all(),
  }));

  // ---- slskd: status and search only ----------------------------------------------
  app.get("/api/slskd/status", { preHandler: requireAdmin }, async (_req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = slskd(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "slskd is not set up yet." });
    try {
      return await client.status();
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.post<{ Body: { query?: unknown } }>("/api/slskd/search", { preHandler: requireAdmin }, async (req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = slskd(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "slskd is not set up yet." });
    const query = str(req.body?.query, 200);
    if (query.length < 2) return reply.code(400).send({ error: "invalid_request", message: "Type at least two characters." });
    try {
      req.log.info({ admin: req.user!.username }, "admin started a slskd search");
      // 201, not 202: the player drops the body of a 202 and needs this id to poll for results.
      return reply.code(201).send({ id: await client.startSearch(query) });
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/slskd/search/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = slskd(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "slskd is not set up yet." });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "invalid_request" });
    try {
      const state = await client.searchState(req.params.id);
      const responses = state.responseCount > 0 ? await client.searchResponses(req.params.id) : [];
      return { ...state, responses };
    } catch (err) {
      return upstream(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/slskd/search/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const c = read();
    if (!gate(reply, c)) return reply;
    const client = slskd(c);
    if (!client) return reply.code(409).send({ error: "not_configured", message: "slskd is not set up yet." });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "invalid_request" });
    try {
      await client.deleteSearch(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return upstream(reply, err);
    }
  });
}

export default createLidarrSlskdPlugin();