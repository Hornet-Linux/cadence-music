import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerPlugin } from "../../plugins/types.js";
import { SERVER_VERSION } from "../../version.js";
import { MetadataCache } from "./cache.js";
import { describeFailure, UpstreamError } from "./errors.js";
import { MBID_RE } from "./mapping.js";
import { MetadataService, type MetadataConfig } from "./service.js";
import { Upstream, type FetchFn, type ProviderId } from "./upstream.js";

export const METADATA_PLUGIN_ID = "cadence.metadata";
const MAX_TEXT = 200;
const CONTACT = "https://github.com/Hornet-Linux/cadence-music";
const BASE_URL_KEYS: ProviderId[] = ["musicbrainz", "coverart", "wikipedia", "wikidata", "fanart", "discogs", "bandsintown"];

/** The User-Agent every request to a metadata service carries (the services ask for a clear one). */
export const userAgent = () => "Cadence/" + SERVER_VERSION + " (+" + CONTACT + ")";

export interface MetadataPluginOptions {
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: Partial<Record<ProviderId, number>>;
}

type Query = Record<string, string | undefined>;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function mbid(value: unknown): string | undefined {
  const t = text(value, 40);
  return t && MBID_RE.test(t) ? t.toLowerCase() : undefined;
}

function cleanBaseUrl(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString().replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cached, rate-limited proxy for music metadata services. Most of them need a clear User-Agent,
 * limit how fast they may be called (MusicBrainz: one request a second) or refuse browsers (CORS),
 * so the app asks this server instead. Keys for Fanart.tv, Discogs and Bandsintown are set by the admin.
 */
export function createMetadataPlugin(options: MetadataPluginOptions = {}): ServerPlugin {
  return {
    id: METADATA_PLUGIN_ID,
    name: "Metadata and discovery",
    version: "1.0.0",
    description:
      "A cached, rate-limited proxy for MusicBrainz, Cover Art Archive, Fanart.tv, Discogs and Bandsintown so the app can show artist info, covers and concerts. Keys for the last three are optional and set here.",
    configFields: [
      { key: "fanartApiKey", label: "Fanart.tv API key", type: "secret", help: "Optional. Unlocks artist backgrounds and logos." },
      { key: "discogsToken", label: "Discogs personal token", type: "secret", help: "Optional. Unlocks Discogs artist and release details." },
      { key: "bandsintownAppId", label: "Bandsintown app id", type: "text", help: "Optional. The app id Bandsintown issued for this server; needed for concert listings." },
    ],
    register(app, ctx) {
      const { db, settings, requireUser, requireAdmin } = ctx;
      const config = (): MetadataConfig => settings.pluginConfig<MetadataConfig>(METADATA_PLUGIN_ID) ?? {};
      const cache = new MetadataCache(db, options.now);
      const upstream = new Upstream({
        cache,
        userAgent: userAgent(),
        fetchFn: options.fetchFn,
        now: options.now,
        sleep: options.sleep,
        gapMs: options.gapMs,
      });
      const service = new MetadataService(upstream, config, options.now);

      ctx.jobs.every("metadata cache cleanup", 6 * 3_600_000, () => {
        cache.purge();
      });

      const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: "invalid_request", message });

      /** Run a lookup and turn upstream failures into short, safe answers. */
      async function answer<T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>): Promise<unknown> {
        try {
          const data = await run();
          reply.header("cache-control", "private, max-age=300");
          return data;
        } catch (err) {
          if (err instanceof UpstreamError) {
            const d = describeFailure(err);
            for (const [k, v] of Object.entries(d.headers ?? {})) reply.header(k, v);
            if (err.kind !== "not_found") req.log.warn({ kind: err.kind, provider: err.provider }, "metadata lookup failed");
            return reply.code(d.status).send(d.body);
          }
          throw err;
        }
      }

      app.get("/api/metadata/status", { preHandler: requireUser }, async () => ({ providers: service.status(), userAgent: userAgent() }));

      app.get<{ Querystring: Query }>("/api/metadata/musicbrainz/artist", { preHandler: requireUser }, async (req, reply) => {
        const id = mbid(req.query.mbid);
        const name = text(req.query.name);
        if (!id && !name) return bad(reply, "Give a name or an mbid.");
        return answer(req, reply, () => service.artist({ mbid: id, name }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/musicbrainz/recording", { preHandler: requireUser }, async (req, reply) => {
        const id = mbid(req.query.mbid);
        const title = text(req.query.title);
        if (!id && !title) return bad(reply, "Give a title or an mbid.");
        return answer(req, reply, () => service.recording({ mbid: id, title, artist: text(req.query.artist) }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/musicbrainz/release", { preHandler: requireUser }, async (req, reply) => {
        const id = mbid(req.query.mbid);
        const album = text(req.query.album);
        if (!id && !album) return bad(reply, "Give an album or an mbid.");
        return answer(req, reply, () => service.release({ mbid: id, album, artist: text(req.query.artist) }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/coverart", { preHandler: requireUser }, async (req, reply) => {
        const release = mbid(req.query.release);
        const releaseGroup = mbid(req.query.releaseGroup);
        const album = text(req.query.album);
        if (!release && !releaseGroup && !album) return bad(reply, "Give a release, a releaseGroup or an album.");
        return answer(req, reply, () => service.cover({ release, releaseGroup, album, artist: text(req.query.artist) }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/wikipedia/artist", { preHandler: requireUser }, async (req, reply) => {
        const id = mbid(req.query.mbid);
        const name = text(req.query.name);
        if (!id && !name) return bad(reply, "Give a name or an mbid.");
        const lang = /^[a-z]{2,3}$/.test(req.query.lang ?? "") ? (req.query.lang as string) : "en";
        return answer(req, reply, () => service.wikipedia({ mbid: id, name, lang }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/fanart/artist", { preHandler: requireUser }, async (req, reply) => {
        const id = mbid(req.query.mbid);
        const name = text(req.query.name);
        if (!id && !name) return bad(reply, "Give a name or an mbid.");
        return answer(req, reply, () => service.fanart({ mbid: id, name }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/discogs/artist", { preHandler: requireUser }, async (req, reply) => {
        const name = text(req.query.name);
        if (!name) return bad(reply, "Give a name.");
        return answer(req, reply, () => service.discogsArtist(name));
      });

      app.get<{ Querystring: Query }>("/api/metadata/discogs/release", { preHandler: requireUser }, async (req, reply) => {
        const artist = text(req.query.artist);
        const title = text(req.query.title);
        if (!artist || !title) return bad(reply, "Give an artist and a title.");
        return answer(req, reply, async () => ({ items: await service.discogsReleases(artist, title) }));
      });

      app.get<{ Querystring: Query }>("/api/metadata/events/artist", { preHandler: requireUser }, async (req, reply) => {
        const name = text(req.query.name);
        if (!name) return bad(reply, "Give a name.");
        const city = text(req.query.city)?.toLowerCase();
        const country = text(req.query.country, 60)?.toLowerCase();
        return answer(req, reply, async () => {
          let items = await service.events(name);
          if (city) items = items.filter((e) => e.city.toLowerCase().includes(city));
          if (country) items = items.filter((e) => e.country.toLowerCase() === country);
          return { items };
        });
      });

      app.get<{ Querystring: Query }>("/api/metadata/releases/new", { preHandler: requireUser }, async (req, reply) => {
        const artist = text(req.query.artist);
        if (!artist) return bad(reply, "Give an artist.");
        const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days)) || 90));
        return answer(req, reply, async () => ({ items: await service.newReleases(artist, days) }));
      });

      // Admin: which keys are set (never their values) and the optional service address overrides.
      app.get("/api/metadata/config", { preHandler: requireAdmin }, async () => {
        const c = config();
        return {
          fanartApiKey: !!c.fanartApiKey,
          discogsToken: !!c.discogsToken,
          bandsintownAppId: c.bandsintownAppId ?? "",
          baseUrls: c.baseUrls ?? {},
        };
      });

      app.put<{ Body: Record<string, unknown> }>("/api/metadata/config", { preHandler: requireAdmin }, async (req, reply) => {
        const body = req.body ?? {};
        const next: MetadataConfig = { ...config() };
        const secret = (key: "fanartApiKey" | "discogsToken" | "bandsintownAppId") => {
          if (!(key in body)) return true;
          const v = body[key];
          if (v === null || v === "") delete next[key];
          else if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 200 && !/\s/.test(v.trim())) next[key] = v.trim();
          else return false;
          return true;
        };
        if (!secret("fanartApiKey") || !secret("discogsToken") || !secret("bandsintownAppId")) {
          return bad(reply, "A key must be a single word of up to 200 characters.");
        }
        if ("baseUrls" in body) {
          const given = body.baseUrls;
          if (given === null) delete next.baseUrls;
          else if (given && typeof given === "object") {
            const urls: Partial<Record<ProviderId, string>> = { ...next.baseUrls };
            for (const key of BASE_URL_KEYS) {
              if (!(key in given)) continue;
              const cleaned = cleanBaseUrl((given as Record<string, unknown>)[key]);
              if (cleaned === undefined) return bad(reply, "Service addresses must be http(s) URLs.");
              if (cleaned === null) delete urls[key];
              else urls[key] = cleaned;
            }
            if (Object.keys(urls).length > 0) next.baseUrls = urls;
            else delete next.baseUrls;
          } else return bad(reply, "baseUrls must be an object.");
        }
        settings.setPluginConfig(METADATA_PLUGIN_ID, Object.keys(next).length > 0 ? next : null);
        req.log.info({ admin: req.user!.username }, "admin updated metadata plugin settings");
        return { ok: true };
      });
    },
  };
}

export default createMetadataPlugin();
