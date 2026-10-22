import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerPlugin } from "../../plugins/types.js";
import { b64, clean, clampInt, StreamSlots, term, TtlCache, unb64 } from "../_sourcekit/common.js";
import { fetchJson, NetError, readBody, request, type NetResponse } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { envPolicy, envUrl } from "../_sourcekit/env.js";
import { netFailureMessage, proxyResponse, singleRange } from "../_sourcekit/proxy.js";
import { nowSec, signedQuery, verifySigned, type SignedParams } from "../_sourcekit/signing.js";
import { IcyStripper, metaInterval } from "./icy.js";
import { firstPlaylistEntry, looksLikeHls, MAX_PLAYLIST_BYTES, rewritePlaylist } from "./hls.js";

const ID = "cadence.radio";
const STREAM_TTL_SEC = 6 * 60 * 60;
const HLS_TTL_SEC = 2 * 60 * 60;
const IMAGE_TTL_DAYS = 30;
const DIRECTORY_CACHE_MS = 5 * 60_000;
const MAX_FAVOURITES = 500;
const MAX_LIMIT = 100;
const DEFAULT_BASES = ["https://all.api.radio-browser.info", "https://de1.api.radio-browser.info", "https://fi1.api.radio-browser.info"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/ogg|application\/octet-stream|video\/(mp2t|mp4|ogg))$/i;
const SEGMENT_TYPE = /^(audio\/[\w.+-]+|video\/(mp2t|mp4|iso\.segment)|application\/(octet-stream|mp4|ogg|x-mpegurl|vnd\.apple\.mpegurl))$/i;
const PLAYLIST_TYPE = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|pls\+xml)|audio\/(x-mpegurl|mpegurl|x-scpls)|text\/plain)$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

export interface RadioOptions {
  /** Radio Browser servers to try, in order. Tests point this at a fake. */
  directoryBases?: string[];
  /** Address policy for the directory and stations (tests allow their loopback fakes). */
  policy?: NetPolicy;
  streamIdleMs?: number;
  headerTimeoutMs?: number;
  /** Tell the directory a station was played (it asks clients to). */
  reportClicks?: boolean;
  /** How long a looked-up station is remembered (tests shorten it). */
  stationCacheMs?: number;
  /** How long directory answers are reused (tests shorten it). */
  directoryCacheMs?: number;
}

interface RawStation {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  language?: string;
  votes?: number;
  codec?: string;
  bitrate?: number;
  hls?: number;
  clickcount?: number;
  lastcheckok?: number;
}

/** What the server remembers about a station. `streamUrl` and `faviconUrl` never reach clients as is. */
interface Station {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  language: string;
  tags: string[];
  codec: string;
  bitrate: number;
  hls: boolean;
  votes: number;
  clicks: number;
  homepage?: string;
  faviconUrl?: string;
  streamUrl: string;
}

export interface RadioStationOut {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  language: string;
  tags: string[];
  codec: string;
  bitrate: number;
  hls: boolean;
  votes: number;
  clicks: number;
  homepage?: string;
  /** Relative signed path to the (proxied) logo. */
  favicon?: string;
}

const httpUrl = (value: unknown, max = 2048): string | undefined => {
  if (typeof value !== "string" || !value || value.length > max) return undefined;
  try {
    const u = new URL(value.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

export function toStation(raw: RawStation): Station | null {
  const id = typeof raw.stationuuid === "string" && UUID.test(raw.stationuuid) ? raw.stationuuid.toLowerCase() : null;
  const streamUrl = httpUrl(raw.url_resolved) ?? httpUrl(raw.url);
  const name = clean(raw.name, 200);
  if (!id || !streamUrl || !name) return null;
  const homepage = httpUrl(raw.homepage);
  const faviconUrl = httpUrl(raw.favicon);
  return {
    id,
    name,
    country: clean(raw.country, 100),
    countryCode: clean(raw.countrycode, 2).toUpperCase(),
    language: clean(raw.language, 100),
    tags: (typeof raw.tags === "string" ? raw.tags.split(",") : []).map((t) => clean(t, 40)).filter(Boolean).slice(0, 8),
    codec: clean(raw.codec, 20).toUpperCase(),
    bitrate: Number.isFinite(raw.bitrate) ? Math.max(0, Math.min(5000, Number(raw.bitrate))) : 0,
    hls: raw.hls === 1,
    votes: Number.isFinite(raw.votes) ? Number(raw.votes) : 0,
    clicks: Number.isFinite(raw.clickcount) ? Number(raw.clickcount) : 0,
    ...(homepage ? { homepage } : {}),
    ...(faviconUrl ? { faviconUrl } : {}),
    streamUrl,
  };
}

/**
 * Internet radio from the Radio Browser community directory. The server asks the directory on the client's
 * behalf, proxies the streams (so HTTP-only stations work on an HTTPS page and addresses stay private),
 * strips and reads the in-band ICY "now playing" text, and passes HLS stations through with rewritten
 * playlists. Stream addresses come from a public, user-edited directory, so every fetch is address-checked.
 */
export function createRadioPlugin(options: RadioOptions = {}): ServerPlugin {
  return {
    id: ID,
    name: "Internet radio",
    version: "1.0.0",
    register(app, ctx) {
      const { secret, db, requireUser } = ctx;
      const policy: NetPolicy = options.policy ?? envPolicy();
      const mirror = envUrl("CADENCE_RADIO_DIRECTORY_URL");
      const bases = options.directoryBases ?? (mirror ? [mirror] : DEFAULT_BASES);
      const idleMs = options.streamIdleMs ?? 30_000;
      const headerMs = options.headerTimeoutMs ?? 15_000;
      const slots = new StreamSlots(40, 4);
      const directoryCache = new TtlCache<unknown>(options.directoryCacheMs ?? DIRECTORY_CACHE_MS, 200);
      const stationCache = new TtlCache<Station>(options.stationCacheMs ?? 60 * 60_000, 2000);
      const clickSeen = new TtlCache<true>(10 * 60_000, 2000);
      const nowPlaying = new Map<string, { title: string | null; at: number; listeners: number }>();

      db.exec(`
        CREATE TABLE IF NOT EXISTS radio_favourites (
          user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          station_id TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (user_id, station_id)
        );
      `);

      // ---- the directory ------------------------------------------------------------

      async function directory<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
        const key = `${path}?${qs}`;
        const hit = directoryCache.get(key);
        if (hit !== undefined) return hit as T;
        let last: unknown = new NetError("unreachable");
        for (const base of bases) {
          try {
            const r = await fetchJson<T>(`${base.replace(/\/+$/, "")}${path}${qs.size ? `?${qs}` : ""}`, {
              ...policy,
              headerTimeoutMs: headerMs,
              maxBytes: 4_000_000,
              maxRedirects: 3,
            });
            if (r.status >= 400 || r.json === undefined) {
              last = new NetError("bad_response", `HTTP ${r.status}`);
              continue;
            }
            directoryCache.set(key, r.json);
            return r.json;
          } catch (e) {
            last = e;
          }
        }
        throw last;
      }

      const imagePath = (userId: number, url: string): string => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return `api/radio/image?t=${b64(url)}&${signedQuery(secret, "radio-image", userId, url, exp)}`;
      };
      const publicStation = (s: Station, userId: number): RadioStationOut => ({
        id: s.id,
        name: s.name,
        country: s.country,
        countryCode: s.countryCode,
        language: s.language,
        tags: s.tags,
        codec: s.codec,
        bitrate: s.bitrate,
        hls: s.hls,
        votes: s.votes,
        clicks: s.clicks,
        ...(s.homepage ? { homepage: s.homepage } : {}),
        ...(s.faviconUrl ? { favicon: imagePath(userId, s.faviconUrl) } : {}),
      });

      function remember(list: RawStation[] | undefined): Station[] {
        const out: Station[] = [];
        for (const raw of Array.isArray(list) ? list.slice(0, 500) : []) {
          const s = toStation(raw);
          if (!s) continue;
          stationCache.set(s.id, s);
          out.push(s);
        }
        return out;
      }

      function favouriteRow(userId: number, id: string): Station | null {
        const row = db.prepare("SELECT data FROM radio_favourites WHERE user_id = ? AND station_id = ?").get(userId, id) as { data: string } | undefined;
        if (!row) return null;
        try {
          return JSON.parse(row.data) as Station;
        } catch {
          return null;
        }
      }

      /** A station by id: from memory, the person's favourites (works if the directory is down), or the directory. */
      async function stationFor(id: string, userId: number): Promise<Station | null> {
        const cached = stationCache.get(id);
        if (cached) return cached;
        try {
          const list = remember(await directory<RawStation[]>(`/json/stations/byuuid/${id}`));
          const hit = list.find((s) => s.id === id);
          if (hit) return hit;
        } catch (e) {
          const fav = favouriteRow(userId, id);
          if (fav) return fav;
          throw e;
        }
        return favouriteRow(userId, id);
      }

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown) {
        if (e instanceof NetError) {
          req.log.warn({ kind: e.kind, detail: e.message }, "radio call failed");
          return reply.code(502).send(netFailureMessage(e.kind));
        }
        req.log.error({ err: e }, "radio handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      const idOf = (reply: FastifyReply, id: string): string | null => {
        if (UUID.test(id)) return id.toLowerCase();
        void reply.code(400).send({ error: "invalid_id" });
        return null;
      };

      // ---- browsing -------------------------------------------------------------

      app.get("/api/radio/status", { preHandler: requireUser }, async () => ({ available: true, directory: "Radio Browser" }));

      app.get<{ Querystring: Record<string, string | undefined> }>("/api/radio/stations", { preHandler: requireUser }, async (req, reply) => {
        const q = req.query;
        const limit = clampInt(q.limit, 30, 1, MAX_LIMIT);
        const offset = clampInt(q.offset, 0, 0, 10_000);
        const country = term(q.country, 60);
        const order = q.order === "name" ? "name" : q.order === "votes" ? "votes" : "clickcount";
        try {
          const raw = await directory<RawStation[]>("/json/stations/search", {
            name: term(q.name, 100),
            tag: term(q.tag, 60),
            tagExact: q.tag ? "true" : undefined,
            ...(country && /^[A-Za-z]{2}$/.test(country) ? { countrycode: country.toUpperCase() } : { country }),
            language: term(q.language, 60),
            limit,
            offset,
            order,
            reverse: order === "name" ? "false" : "true",
            hidebroken: "true",
          });
          const stations = remember(raw);
          return { items: stations.map((s) => publicStation(s, req.user!.id)), hasMore: Array.isArray(raw) && raw.length >= limit };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      for (const [route, listing] of [["top", "topvote"], ["trending", "topclick"]] as const) {
        app.get<{ Querystring: { limit?: string } }>(`/api/radio/${route}`, { preHandler: requireUser }, async (req, reply) => {
          try {
            const stations = remember(await directory<RawStation[]>(`/json/stations/${listing}/${clampInt(req.query.limit, 30, 1, MAX_LIMIT)}`, { hidebroken: "true" }));
            return { items: stations.map((s) => publicStation(s, req.user!.id)), hasMore: false };
          } catch (e) {
            return failure(req, reply, e);
          }
        });
      }

      app.get<{ Params: { kind: string } }>("/api/radio/facets/:kind", { preHandler: requireUser }, async (req, reply) => {
        const kind = req.params.kind;
        if (kind !== "tags" && kind !== "countries" && kind !== "languages") return reply.code(404).send({ error: "not_found" });
        try {
          const raw = await directory<{ name?: string; stationcount?: number; iso_3166_1?: string }[]>(`/json/${kind}`, {
            order: "stationcount",
            reverse: "true",
            hidebroken: "true",
            limit: 120,
          });
          const items = (Array.isArray(raw) ? raw : [])
            .map((x) => ({ name: clean(x.name, 80), count: Number(x.stationcount) || 0, ...(x.iso_3166_1 ? { code: clean(x.iso_3166_1, 2).toUpperCase() } : {}) }))
            .filter((x) => x.name && x.count > 0)
            .slice(0, 120);
          return { items };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.get<{ Params: { id: string } }>("/api/radio/stations/:id", { preHandler: requireUser }, async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        try {
          const s = await stationFor(id, req.user!.id);
          return s ? publicStation(s, req.user!.id) : reply.code(404).send({ error: "not_found" });
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.get<{ Params: { id: string } }>("/api/radio/stations/:id/stream-url", { preHandler: requireUser }, async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        try {
          const s = await stationFor(id, req.user!.id);
          if (!s) return reply.code(404).send({ error: "not_found" });
          const exp = nowSec() + STREAM_TTL_SEC;
          return { path: `api/radio/stream/${id}?${signedQuery(secret, "radio-stream", req.user!.id, id, exp)}`, expiresAt: exp, hls: s.hls };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.get<{ Params: { id: string } }>("/api/radio/stations/:id/now-playing", { preHandler: requireUser }, async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        const np = nowPlaying.get(id);
        if (np && np.listeners === 0 && Date.now() - np.at > 120_000) nowPlaying.delete(id);
        const live = nowPlaying.get(id);
        return { title: live?.title ?? null, updatedAt: live ? live.at : null, live: !!live && live.listeners > 0 };
      });

      // ---- favourites (per person) -----------------------------------------------------

      app.get("/api/radio/favourites", { preHandler: requireUser }, async (req) => {
        const rows = db.prepare("SELECT data FROM radio_favourites WHERE user_id = ? ORDER BY added_at DESC").all(req.user!.id) as { data: string }[];
        const items: RadioStationOut[] = [];
        for (const row of rows) {
          try {
            items.push(publicStation(JSON.parse(row.data) as Station, req.user!.id));
          } catch {
            // A damaged row is skipped.
          }
        }
        return { items };
      });

      app.put<{ Params: { id: string } }>("/api/radio/favourites/:id", { preHandler: requireUser }, async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        const userId = req.user!.id;
        const count = (db.prepare("SELECT COUNT(*) AS n FROM radio_favourites WHERE user_id = ?").get(userId) as { n: number }).n;
        const existing = favouriteRow(userId, id);
        if (!existing && count >= MAX_FAVOURITES) return reply.code(409).send({ error: "too_many_favourites", message: "That's a lot of favourites. Remove some first." });
        try {
          const s = existing ?? (await stationFor(id, userId));
          if (!s) return reply.code(404).send({ error: "not_found" });
          db.prepare(
            `INSERT INTO radio_favourites (user_id, station_id, added_at, data) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, station_id) DO UPDATE SET data = excluded.data`,
          ).run(userId, id, Date.now(), JSON.stringify(s));
          return publicStation(s, userId);
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.delete<{ Params: { id: string } }>("/api/radio/favourites/:id", { preHandler: requireUser }, async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        db.prepare("DELETE FROM radio_favourites WHERE user_id = ? AND station_id = ?").run(req.user!.id, id);
        return reply.code(204).send();
      });

      // ---- streaming, HLS and logos (signed URLs) ----------------------------------------

      /** Opens a station's stream, following .pls/.m3u indirection. An HLS playlist is returned as text instead. */
      async function openStation(
        url: string,
        signal: AbortSignal,
        depth = 0,
      ): Promise<{ res: NetResponse } | { playlist: string; base: URL }> {
        const res = await request(url, {
          ...policy,
          headers: { Accept: "*/*", "Icy-MetaData": "1" },
          lenient: true,
          idleTimeoutMs: 0,
          headerTimeoutMs: headerMs,
          maxRedirects: 5,
          signal,
        });
        const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        const looksPlaylist = PLAYLIST_TYPE.test(type) || /\.(m3u8?|pls)(\?|$)/i.test(res.url.pathname + res.url.search);
        if (res.status === 200 && looksPlaylist && !res.headers["icy-metaint"]) {
          const { data } = await readBody(res, MAX_PLAYLIST_BYTES, { totalTimeoutMs: 15_000 });
          const text = data.toString("utf8");
          if (looksLikeHls(text)) return { playlist: text, base: res.url };
          const entry = firstPlaylistEntry(text, res.url);
          if (!entry || depth >= 2) throw new NetError("bad_response", "playlist");
          return openStation(entry.toString(), signal, depth + 1);
        }
        return { res };
      }

      const hlsPath = (userId: number, target: URL): string => {
        const t = target.toString();
        return `/api/radio/hls?t=${b64(t)}&${signedQuery(secret, "radio-hls", userId, t, nowSec() + HLS_TTL_SEC)}`;
      };

      function sendPlaylist(reply: FastifyReply, userId: number, text: string, base: URL) {
        const body = rewritePlaylist(text, base, (abs) => hlsPath(userId, abs));
        return reply.code(200).header("Content-Type", "application/vnd.apple.mpegurl").header("Cache-Control", "no-store").send(body);
      }

      app.get<{ Params: { id: string }; Querystring: SignedParams }>("/api/radio/stream/:id", async (req, reply) => {
        const id = idOf(reply, req.params.id);
        if (!id) return reply;
        const userId = verifySigned(secret, "radio-stream", id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const release = slots.take(userId);
        if (!release) return reply.code(429).send({ error: "too_many_streams", message: "Too many streams are open. Stop one first." });
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        let handed = false;
        try {
          const station = await stationFor(id, userId);
          if (!station) return reply.code(404).send({ error: "not_found" });
          const opened = await openStation(station.streamUrl, ac.signal);
          if ("playlist" in opened) return sendPlaylist(reply, userId, opened.playlist, opened.base);
          const res = opened.res;
          if (res.status !== 200) {
            res.abort();
            return reply.code(res.status === 404 ? 404 : 502).send(res.status === 404 ? { error: "not_found" } : netFailureMessage("bad_response"));
          }
          // Shoutcast v1 may omit the type; its icy-* headers say it is audio.
          if (!res.headers["content-type"] && Object.keys(res.headers).some((h) => h.startsWith("icy-"))) res.headers["content-type"] = "audio/mpeg";
          const interval = metaInterval(res.headers["icy-metaint"]);
          const entry = nowPlaying.get(id) ?? { title: null, at: Date.now(), listeners: 0 };
          nowPlaying.set(id, entry);
          if (nowPlaying.size > 500) {
            for (const [k, v] of nowPlaying) if (v.listeners === 0) nowPlaying.delete(k);
          }
          entry.listeners++;
          let ended = false;
          handed = true;
          if (options.reportClicks !== false && !clickSeen.get(`${userId}:${id}`)) {
            clickSeen.set(`${userId}:${id}`, true);
            for (const base of bases.slice(0, 1)) {
              void fetchJson(`${base.replace(/\/+$/, "")}/json/url/${id}`, { ...policy, headerTimeoutMs: 5000, maxBytes: 20_000 }).catch(() => undefined);
            }
          }
          return proxyResponse(req, reply, res, {
            accept: AUDIO_TYPE,
            cache: "no-store",
            idleMs,
            relayRange: false,
            transform: () =>
              interval
                ? new IcyStripper(interval, (title) => {
                    entry.title = title;
                    entry.at = Date.now();
                  })
                : null,
            onEnd: () => {
              if (ended) return;
              ended = true;
              entry.listeners = Math.max(0, entry.listeners - 1);
              entry.at = Date.now();
              release();
            },
          });
        } catch (e) {
          return failure(req, reply, e);
        } finally {
          if (!handed) release();
        }
      });

      app.get<{ Querystring: SignedParams & { t?: string } }>("/api/radio/hls", async (req, reply) => {
        const t = typeof req.query.t === "string" && req.query.t.length < 3000 ? unb64(req.query.t) : "";
        const userId = t ? verifySigned(secret, "radio-hls", t, req.query, nowSec()) : null;
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        const range = singleRange(req);
        try {
          const res = await request(t, {
            ...policy,
            headers: { Accept: "*/*", ...(range ? { Range: range } : {}) },
            idleTimeoutMs: 0,
            headerTimeoutMs: headerMs,
            maxRedirects: 3,
            signal: ac.signal,
          });
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (res.status === 200 && (PLAYLIST_TYPE.test(type) || /\.m3u8?(\?|$)/i.test(res.url.pathname + res.url.search))) {
            const { data } = await readBody(res, MAX_PLAYLIST_BYTES, { totalTimeoutMs: 15_000 });
            const text = data.toString("utf8");
            if (!looksLikeHls(text)) return reply.code(502).send(netFailureMessage("bad_response"));
            return sendPlaylist(reply, userId, text, res.url);
          }
          return proxyResponse(req, reply, res, { accept: SEGMENT_TYPE, cache: "private, max-age=60", idleMs });
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.get<{ Querystring: SignedParams & { t?: string } }>("/api/radio/image", async (req, reply) => {
        const t = typeof req.query.t === "string" && req.query.t.length < 3000 ? unb64(req.query.t) : "";
        const userId = t ? verifySigned(secret, "radio-image", t, req.query, nowSec()) : null;
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        try {
          const res = await request(t, { ...policy, headers: { Accept: "image/*" }, headerTimeoutMs: 10_000, maxRedirects: 3 });
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (res.status !== 200 || !IMAGE_TYPE.test(type)) {
            res.abort();
            return reply.code(404).send({ error: "not_found" });
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > 1_000_000) {
            res.abort();
            return reply.code(404).send({ error: "not_found" });
          }
          const { data } = await readBody(res, 1_000_000, { totalTimeoutMs: 15_000 });
          return reply
            .code(200)
            .header("Content-Type", type)
            .header("Cache-Control", "private, max-age=86400")
            .header("Content-Security-Policy", "default-src 'none'; sandbox")
            .send(data);
        } catch (e) {
          if (e instanceof NetError) return reply.code(404).send({ error: "not_found" });
          return failure(req, reply, e);
        }
      });
    },
  };
}

export default createRadioPlugin();