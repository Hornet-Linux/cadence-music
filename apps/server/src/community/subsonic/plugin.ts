import type { FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { parseServiceUrl } from "../sourcesCommon/address.js";
import { pruneOrphanedUserConfig } from "../sourcesCommon/orphans.js";
import {
  MAX_IMAGE_BYTES,
  publicFailure,
  readCapped,
  UpstreamError,
  type FetchFn,
  type Query,
} from "../sourcesCommon/http.js";
import { AUDIO_TYPE, cleanRange, IMAGE_TYPE, pipeUpstream } from "../sourcesCommon/proxy.js";
import { signedPath, verifySigned } from "../sourcesCommon/signing.js";
import { clampInt, mapLimit, playCounts, term, TtlCache } from "../sourcesCommon/util.js";
import { errorCodeFromBody, subCall, subStream, validId, type SubsonicContext } from "./client.js";
import { list, toAlbum, toArtist, toPlaylist, toTrack, type ArtworkFn, type SubChild } from "./mapping.js";
import { ConnectionStore, PLUGIN_ID, type Connection } from "./store.js";
import type {
  AdminAddress,
  AdminTestResult,
  Page,
  SubsonicAlbum,
  SubsonicPlaybackReport,
  SubsonicStatus,
  SubsonicStreamUrl,
  SubsonicTrack,
} from "./types.js";

const SERVICE = "subsonic";
const LABEL = "Subsonic";
const STREAM_TTL_SEC = 6 * 60 * 60;
/** Cover art URLs get stored (history, likes), so they live long and are stable within a day for caching. */
const IMAGE_TTL_DAYS = 30;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const DEFAULT_IMAGE_SIZE = 300;
const MAX_IMAGE_SIZE = 1200;
const STREAM_HEADER_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_PER_USER = 5;
const LOGIN_MAX_PER_ADDRESS = 20;
/** How many matching albums and artists a text search expands into tracks. */
const SEARCH_ALBUMS = 3;
const SEARCH_ARTISTS = 2;
const SEARCH_CONCURRENCY = 4;
const ALBUM_SORTS = new Set(["alphabeticalByName", "alphabeticalByArtist", "newest", "recent", "frequent", "starred", "random"]);

/** What browsers and WebViews play directly. Anything else is transcoded by the server to MP3. */
const RAW_SUFFIXES = new Set(["mp3", "aac", "m4a", "m4b", "flac", "wav"]);
type StreamMode = "raw" | "mp3";

// Cadence's app signs a person out of Cadence on ANY 401 from an /api route it doesn't know,
// so "your Subsonic sign-in is no good" is a 409 (or 422 while signing in), never a 401.
const NOT_CONFIGURED = { error: "subsonic_not_configured", message: "Subsonic isn't set up on this server" };
const NOT_CONNECTED = { error: "subsonic_not_connected", message: "Sign in to Subsonic first" };
const EXPIRED = { error: "subsonic_session_expired", message: "Your Subsonic sign-in stopped working. Sign in again." };
const FORBIDDEN = { error: "subsonic_forbidden", message: "Your Subsonic account isn't allowed to do that" };

export interface SubsonicPluginOptions {
  /** Lets tests stand in for the network. */
  fetchFn?: FetchFn;
  /** The address from the environment (SUBSONIC_URL); wins over the admin setting. */
  envUrl?: string;
  /** Tests shorten these. */
  streamIdleMs?: number;
  streamHeaderTimeoutMs?: number;
}

/**
 * Subsonic-API servers (Navidrome, Airsonic-Advanced, Gonic, ...) as a music
 * source. The server calls the owner's Subsonic server as each person (their own
 * account) and proxies audio and cover art, so apps never talk to it and its
 * credentials never leave the server. Only the server owner sets the address.
 */
export function createSubsonicPlugin(options: SubsonicPluginOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Subsonic",
    version: "1.0.0",
    description:
      "Use a Subsonic-API server (Navidrome, Airsonic-Advanced, Gonic and others) as a music source. You set the server address; each person signs in with their own account there, and browsing, search and audio are proxied through this server.",
    configFields: [
      { key: "serverUrl", label: "Subsonic server address", type: "url", placeholder: "http://navidrome:4533", help: "The SUBSONIC_URL environment variable overrides this when set. The Test button under Settings > Plugins > Subsonic in the player checks an address before you rely on it." },
    ],
    register(app, ctx) {
      const { secret, settings, requireUser, requireAdmin } = ctx;
      const store = new ConnectionStore(settings, secret);
      const idleMs = options.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
      const headerMs = options.streamHeaderTimeoutMs ?? STREAM_HEADER_TIMEOUT_MS;
      const perUser = new RateLimiter({ max: LOGIN_MAX_PER_USER, windowMs: LOGIN_WINDOW_MS });
      const perAddress = new RateLimiter({ max: LOGIN_MAX_PER_ADDRESS, windowMs: LOGIN_WINDOW_MS });
      const modes = new TtlCache<StreamMode>(10 * 60_000);
      // Sign-ins are kept in settings, which are not deleted with a person; sweep up after people who left.
      ctx.jobs.every("subsonic-prune", 24 * 3600_000, () => void pruneOrphanedUserConfig(ctx.db, PLUGIN_ID), { runSoon: true });

      const envUrl = (): string | null => {
        const raw = options.envUrl ?? process.env.SUBSONIC_URL;
        if (!raw?.trim()) return null;
        try {
          return parseServiceUrl(raw, { what: "your Subsonic server", example: "http://navidrome:4533", allowLinkLocal: true });
        } catch {
          ctx.log.warn("SUBSONIC_URL is not a valid address and is ignored");
          return null;
        }
      };
      const address = (): AdminAddress => {
        const fromEnv = envUrl();
        if (fromEnv) return { serverUrl: fromEnv, source: "env" };
        const saved = settings.pluginConfig<{ serverUrl?: string }>(PLUGIN_ID)?.serverUrl;
        return saved ? { serverUrl: saved, source: "admin" } : { serverUrl: null, source: null };
      };
      /** Resolved per request, so an admin's change applies immediately. */
      const baseUrl = (): string | null => address().serverUrl;
      const nowSec = () => Math.floor(Date.now() / 1000);

      const artworkFor = (userId: number): ArtworkFn => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return (coverArtId) => signedPath(secret, SERVICE, "image", userId, coverArtId, exp);
      };

      /** The person's usable connection: signed in, to the address in effect now. */
      function connectionFor(userId: number, base: string): Connection | null {
        const conn = store.get(userId);
        if (!conn) return null;
        if (conn.serverUrl !== base) {
          // The owner moved the server: never send this password to a different address.
          store.delete(userId);
          return null;
        }
        return conn;
      }

      const sub = (base: string, conn: Connection): SubsonicContext => ({
        baseUrl: base,
        username: conn.username,
        password: conn.password,
        legacy: conn.legacy,
        fetchFn: options.fetchFn,
      });

      interface Authed {
        sub: SubsonicContext;
        conn: Connection;
        userId: number;
        art: ArtworkFn;
      }

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown, conn?: Connection) {
        if (e instanceof UpstreamError) {
          if (e.kind === "unauthorized") {
            if (conn) store.deleteIfSame(conn.userId, conn.passwordEnc);
            return reply.code(409).send(EXPIRED);
          }
          if (e.kind === "forbidden") return reply.code(403).send(FORBIDDEN);
          if (e.kind === "not_found") return reply.code(404).send({ error: "not_found" });
          req.log.warn({ kind: e.kind, status: e.status, code: e.code }, "Subsonic call failed");
          return reply.code(502).send(publicFailure(LABEL, e));
        }
        req.log.error({ err: e }, "Subsonic handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      /** Runs `fn` for the signed-in person, turning Subsonic failures into the right answers. */
      async function authed(req: FastifyRequest, reply: FastifyReply, fn: (a: Authed) => Promise<unknown>) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const userId = req.user!.id;
        const conn = connectionFor(userId, base);
        if (!conn) return reply.code(409).send(NOT_CONNECTED);
        try {
          return await fn({ sub: sub(base, conn), conn, userId, art: artworkFor(userId) });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      }

      const idParam = (reply: FastifyReply, id: string): string | null => {
        if (validId(id)) return id;
        void reply.code(400).send({ error: "invalid_id" });
        return null;
      };

      // ---- listing helpers ----------------------------------------------------------

      const tracksOf = (rows: unknown, a: Authed): SubsonicTrack[] =>
        list<SubChild>(rows)
          .map((r) => toTrack(r, a.art))
          .filter((t): t is SubsonicTrack => t !== null);

      const slice = <T>(items: T[], offset: number, limit: number): Page<T> => ({
        items: items.slice(offset, offset + limit),
        total: items.length,
        hasMore: items.length > offset + limit,
      });

      async function albumTracks(a: Authed, albumId: string): Promise<SubsonicTrack[]> {
        const data = await subCall(a.sub, "getAlbum", { id: albumId });
        return tracksOf((data.album as { song?: unknown } | undefined)?.song, a);
      }

      /** Search3 matches song titles; people also search by artist and album, so matching ones are expanded into tracks. */
      async function searchTracks(a: Authed, text: string, limit: number, offset: number): Promise<Page<SubsonicTrack>> {
        const want = Math.min(MAX_LIMIT, offset + limit);
        const data = await subCall(a.sub, "search3", {
          query: text,
          songCount: want,
          albumCount: SEARCH_ALBUMS,
          artistCount: SEARCH_ARTISTS,
        });
        const result = (data.searchResult3 ?? {}) as { song?: unknown; album?: unknown; artist?: unknown };
        const byTitle = tracksOf(result.song, a);
        const albumIds = list<SubChild>(result.album)
          .map((x) => x.id)
          .filter(validId)
          .slice(0, SEARCH_ALBUMS);
        const artistIds = list<SubChild>(result.artist)
          .map((x) => x.id)
          .filter(validId)
          .slice(0, SEARCH_ARTISTS);
        const fromArtists = await mapLimit(artistIds, SEARCH_CONCURRENCY, async (id) => {
          const artist = await subCall(a.sub, "getArtist", { id });
          return list<SubChild>((artist.artist as { album?: unknown } | undefined)?.album)
            .map((x) => x.id)
            .filter(validId)
            .slice(0, 2);
        });
        const expand = [...new Set([...albumIds, ...fromArtists.flat()])];
        const expanded = await mapLimit(expand, SEARCH_CONCURRENCY, (id) => albumTracks(a, id));
        const seen = new Set<string>();
        const merged: SubsonicTrack[] = [];
        for (const t of [...byTitle, ...expanded.flat()]) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            merged.push(t);
          }
        }
        return slice(merged, offset, limit);
      }

      /**
       * Subsonic has no "list every song" call. An empty search3 query returns the
       * whole library on Navidrome, Gonic and Airsonic. If a server answers nothing, the
       * first albums' tracks stand in so the page isn't empty.
       */
      async function browseTracks(a: Authed, limit: number, offset: number): Promise<Page<SubsonicTrack>> {
        const data = await subCall(a.sub, "search3", { query: "", songCount: limit, songOffset: offset, artistCount: 0, albumCount: 0 });
        const items = tracksOf((data.searchResult3 as { song?: unknown } | undefined)?.song, a);
        if (items.length > 0 || offset > 0) {
          return { items, total: offset + items.length + (items.length === limit ? 1 : 0), hasMore: items.length === limit };
        }
        const albums = await subCall(a.sub, "getAlbumList2", { type: "alphabeticalByName", size: 20 });
        const ids = list<SubChild>((albums.albumList2 as { album?: unknown } | undefined)?.album)
          .map((x) => x.id)
          .filter(validId);
        const tracks = (await mapLimit(ids, SEARCH_CONCURRENCY, (id) => albumTracks(a, id))).flat();
        return { items: tracks.slice(0, limit), total: Math.min(tracks.length, limit), hasMore: false };
      }

      const starred = async (a: Authed) => (await subCall(a.sub, "getStarred2")).starred2 as { song?: unknown; album?: unknown } | undefined;
      // ---- status and sign-in ---------------------------------------------------

      app.get("/api/subsonic/status", { preHandler: requireUser }, async (req): Promise<SubsonicStatus> => {
        const base = baseUrl();
        if (!base) return { configured: false, connected: false };
        const conn = connectionFor(req.user!.id, base);
        return conn
          ? { configured: true, connected: true, ...(conn.serverName ? { serverName: conn.serverName } : {}), userName: conn.username }
          : { configured: true, connected: false };
      });

      app.put<{ Body: { username?: unknown; password?: unknown } }>("/api/subsonic/connection", { preHandler: requireUser }, async (req, reply) => {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const b = req.body;
        const username = typeof b?.username === "string" ? b.username.trim() : "";
        const password = b?.password;
        if (!username || username.length > 256 || typeof password !== "string" || !password || password.length > 1024) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        const userId = req.user!.id;
        // Failed sign-ins are counted per person and per address, so this can't be used to guess Subsonic passwords.
        const userKey = `user:${userId}`;
        const addressKey = `ip:${req.ip}`;
        if (perUser.isLimited(userKey) || perAddress.isLimited(addressKey)) {
          return reply.code(429).send({ error: "rate_limited", message: "Too many sign-in attempts. Try again later." });
        }

        let legacy = false;
        let ping: Record<string, unknown>;
        try {
          try {
            ping = await subCall({ baseUrl: base, username, password, fetchFn: options.fetchFn }, "ping");
          } catch (e) {
            // Code 41: the server can't check token auth (LDAP users); fall back to the older password parameter.
            if (!(e instanceof UpstreamError && e.kind === "unauthorized" && e.code === 41)) throw e;
            legacy = true;
            ping = await subCall({ baseUrl: base, username, password, legacy, fetchFn: options.fetchFn }, "ping");
          }
        } catch (e) {
          if (e instanceof UpstreamError && e.kind === "unauthorized") {
            perUser.hit(userKey);
            perAddress.hit(addressKey);
            return reply.code(422).send({ error: "subsonic_invalid_credentials", message: "Subsonic didn't accept that user name and password" });
          }
          if (e instanceof UpstreamError) {
            req.log.warn({ kind: e.kind, status: e.status, code: e.code }, "Subsonic sign-in failed");
            return reply.code(502).send(publicFailure(LABEL, e));
          }
          throw e;
        }
        const type = typeof ping.type === "string" && ping.type ? ping.type.slice(0, 60) : null;
        const version = typeof ping.serverVersion === "string" ? ping.serverVersion.slice(0, 30) : "";
        const serverName = type ? `${type[0].toUpperCase()}${type.slice(1)}${version ? ` ${version}` : ""}` : null;

        store.save({ userId, serverUrl: base, username, password, legacy, serverName });
        perUser.reset(userKey);
        return { configured: true, connected: true, ...(serverName ? { serverName } : {}), userName: username } satisfies SubsonicStatus;
      });

      app.delete("/api/subsonic/connection", { preHandler: requireUser }, async (req, reply) => {
        store.delete(req.user!.id);
        return reply.code(204).send();
      });

      // ---- browsing -------------------------------------------------------------

      app.get<{ Querystring: { q?: string; albumId?: string; favourites?: string; limit?: string; offset?: string } }>(
        "/api/subsonic/tracks",
        { preHandler: requireUser },
        (req, reply) =>
          authed(req, reply, async (a): Promise<Page<SubsonicTrack> | FastifyReply> => {
            const { q, albumId, favourites } = req.query;
            const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
            const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
            if (albumId !== undefined && albumId !== "") {
              if (!validId(albumId)) return reply.code(400).send({ error: "invalid_id" });
              return slice(await albumTracks(a, albumId), offset, limit);
            }
            if (favourites === "1" || favourites === "true") {
              const all = tracksOf((await starred(a))?.song, a);
              const needle = term(q)?.toLowerCase();
              const shown = needle ? all.filter((t) => `${t.title} ${t.artists.join(" ")} ${t.album ?? ""}`.toLowerCase().includes(needle)) : all;
              return slice(shown, offset, limit);
            }
            const text = term(q);
            return text ? searchTracks(a, text, limit, offset) : browseTracks(a, limit, offset);
          }),
      );

      app.get<{ Querystring: { q?: string; artistId?: string; sort?: string; limit?: string; offset?: string } }>(
        "/api/subsonic/albums",
        { preHandler: requireUser },
        (req, reply) =>
          authed(req, reply, async (a): Promise<Page<SubsonicAlbum> | FastifyReply> => {
            const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
            const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
            const mapAlbums = (rows: unknown) =>
              list<SubChild>(rows)
                .map((r) => toAlbum(r, a.art))
                .filter((x): x is SubsonicAlbum => x !== null);
            const open = (items: SubsonicAlbum[]): Page<SubsonicAlbum> => ({
              items,
              total: offset + items.length + (items.length === limit ? 1 : 0),
              hasMore: items.length === limit,
            });
            const { artistId } = req.query;
            if (artistId !== undefined && artistId !== "") {
              if (!validId(artistId)) return reply.code(400).send({ error: "invalid_id" });
              const data = await subCall(a.sub, "getArtist", { id: artistId });
              return slice(mapAlbums((data.artist as { album?: unknown } | undefined)?.album), offset, limit);
            }
            const text = term(req.query.q);
            if (text) {
              const data = await subCall(a.sub, "search3", { query: text, albumCount: limit, albumOffset: offset, songCount: 0, artistCount: 0 });
              return open(mapAlbums((data.searchResult3 as { album?: unknown } | undefined)?.album));
            }
            const sort = req.query.sort && ALBUM_SORTS.has(req.query.sort) ? req.query.sort : "alphabeticalByName";
            const data = await subCall(a.sub, "getAlbumList2", { type: sort, size: limit, offset });
            return open(mapAlbums((data.albumList2 as { album?: unknown } | undefined)?.album));
          }),
      );

      app.get<{ Params: { id: string } }>("/api/subsonic/albums/:id/tracks", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => slice(await albumTracks(a, id), 0, MAX_LIMIT));
      });

      app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>("/api/subsonic/artists", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const data = await subCall(a.sub, "getArtists");
          const indexes = list<{ artist?: unknown }>((data.artists as { index?: unknown } | undefined)?.index);
          const all = indexes
            .flatMap((i) => list<SubChild>(i.artist))
            .map((r) => toArtist(r, a.art))
            .filter((x) => x !== null)
            .sort((x, y) => x.name.localeCompare(y.name));
          const needle = term(req.query.q)?.toLowerCase();
          const filtered = needle ? all.filter((x) => x.name.toLowerCase().includes(needle)) : all;
          return slice(filtered, clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER), clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT));
        }),
      );

      app.get("/api/subsonic/playlists", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const data = await subCall(a.sub, "getPlaylists");
          const items = list<SubChild>((data.playlists as { playlist?: unknown } | undefined)?.playlist)
            .map((r) => toPlaylist(r, a.art))
            .filter((x) => x !== null)
            .slice(0, MAX_LIMIT);
          return { items };
        }),
      );

      app.get<{ Params: { id: string } }>("/api/subsonic/playlists/:id/tracks", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => {
          const data = await subCall(a.sub, "getPlaylist", { id });
          return slice(tracksOf((data.playlist as { entry?: unknown } | undefined)?.entry, a), 0, MAX_LIMIT);
        });
      });

      // ---- favourites (stars) ---------------------------------------------------

      for (const [method, endpoint] of [["PUT", "star"], ["DELETE", "unstar"]] as const) {
        app.route<{ Params: { id: string } }>({
          method,
          url: "/api/subsonic/favourites/:id",
          preHandler: requireUser,
          handler: (req, reply) => {
            const id = idParam(reply, req.params.id);
            if (!id) return reply;
            return authed(req, reply, async (a) => {
              await subCall(a.sub, endpoint, { id });
              return reply.code(204).send();
            });
          },
        });
      }

      // ---- streaming and cover art (signed URLs, no bearer token) -------------------

      /** Whether to pass the original through or ask for MP3, judged from the file type the server reports. */
      async function modeFor(a: Authed, id: string): Promise<StreamMode> {
        const key = `${a.userId}:${id}`;
        const known = modes.get(key);
        if (known) return known;
        const data = await subCall(a.sub, "getSong", { id });
        const song = data.song as { suffix?: unknown } | undefined;
        if (!song || typeof song !== "object") throw new UpstreamError("not_found");
        const suffix = typeof song.suffix === "string" ? song.suffix.toLowerCase() : "";
        const mode: StreamMode = RAW_SUFFIXES.has(suffix) ? "raw" : "mp3";
        modes.set(key, mode);
        return mode;
      }

      app.get<{ Params: { id: string } }>("/api/subsonic/tracks/:id/stream-url", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a): Promise<SubsonicStreamUrl> => {
          // Also proves the track exists for this person and their sign-in still works.
          await modeFor(a, id);
          const expiresAt = nowSec() + STREAM_TTL_SEC;
          return { path: signedPath(secret, SERVICE, "stream", a.userId, id, expiresAt), expiresAt };
        });
      });

      /** Sends the upstream body to the client without buffering, and cancels upstream when the client leaves. */
      async function proxy(
        req: FastifyRequest,
        reply: FastifyReply,
        userId: number,
        endpoint: string,
        query: Query,
        opts: { accept: RegExp; cache: string; range?: string; maxBytes?: number },
        prepare?: (a: Authed) => Promise<Query>,
      ) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const conn = connectionFor(userId, base);
        if (!conn) return reply.code(409).send(EXPIRED);
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        let res: Response;
        try {
          const extra = prepare ? await prepare({ sub: sub(base, conn), conn, userId, art: artworkFor(userId) }) : {};
          res = await subStream(
            sub(base, conn),
            endpoint,
            { ...query, ...extra },
            { headers: opts.range ? { Range: opts.range } : undefined, signal: ac.signal, headerTimeoutMs: headerMs },
          );
        } catch (e) {
          return failure(req, reply, e, conn);
        }
        const status = res.status;
        const drop = () => void res.body?.cancel().catch(() => undefined);
        if (status === 404) {
          drop();
          return reply.code(404).send({ error: "not_found" });
        }
        if (status === 416) {
          drop();
          const range = res.headers.get("content-range");
          return reply.code(416).header("Content-Range", range && /^bytes \*\/\d+$/.test(range) ? range : "bytes */0").send();
        }
        const type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
        if ((status === 200 || status === 206) && res.body && opts.accept.test(type)) {
          return pipeUpstream(reply, res, type, ac, { cache: opts.cache, idleMs, maxBytes: opts.maxBytes }, () =>
            reply.code(502).send({ error: "subsonic_failed", message: "Subsonic sent more than Cadence accepts" }),
          );
        }
        // Subsonic reports errors as a JSON or XML body with a 200 status; look at it to tell a dead sign-in from a missing item.
        let code: number | undefined;
        if (/json|xml|text/i.test(type) && res.body) {
          try {
            code = errorCodeFromBody(await readCapped(res, 16 * 1024));
          } catch {
            code = undefined;
          }
        } else {
          drop();
        }
        if (status === 401 || code === 40 || code === 41 || code === 44) {
          store.deleteIfSame(userId, conn.passwordEnc);
          return reply.code(409).send(EXPIRED);
        }
        if (code === 70) return reply.code(404).send({ error: "not_found" });
        req.log.warn({ status, type, code }, "Subsonic returned something unplayable");
        return reply.code(502).send({ error: "subsonic_failed", message: "Subsonic returned an unexpected answer" });
      }

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string } }>("/api/subsonic/stream/:id", async (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        const userId = verifySigned(secret, SERVICE, "stream", id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        return proxy(
          req,
          reply,
          userId,
          "stream",
          { id },
          { accept: AUDIO_TYPE, cache: "private, max-age=3600", range: cleanRange(req.headers.range) },
          async (a) => ((await modeFor(a, id)) === "raw" ? { format: "raw" } : { format: "mp3", maxBitRate: 320, estimateContentLength: true }),
        );
      });

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string; w?: string } }>(
        "/api/subsonic/image/:id",
        async (req, reply) => {
          const id = idParam(reply, req.params.id);
          if (!id) return reply;
          const userId = verifySigned(secret, SERVICE, "image", id, req.query, nowSec());
          if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
          return proxy(
            req,
            reply,
            userId,
            "getCoverArt",
            { id, size: clampInt(req.query.w, DEFAULT_IMAGE_SIZE, 16, MAX_IMAGE_SIZE) },
            { accept: IMAGE_TYPE, cache: "private, max-age=604800", maxBytes: MAX_IMAGE_BYTES },
          );
        },
      );

      // ---- reporting plays back (scrobbling) -------------------------------------------

      app.post<{ Body: SubsonicPlaybackReport }>("/api/subsonic/playback", { preHandler: requireUser }, (req, reply) => {
        const b = req.body;
        if (
          !b ||
          (b.event !== "start" && b.event !== "stop") ||
          !validId(b.itemId) ||
          typeof b.positionSec !== "number" ||
          !Number.isFinite(b.positionSec) ||
          b.positionSec < 0 ||
          (b.durationSec !== undefined && (typeof b.durationSec !== "number" || !Number.isFinite(b.durationSec) || b.durationSec < 0))
        ) {
          return reply.code(400).send({ error: "invalid_report" });
        }
        const position = Math.min(b.positionSec, 7 * 24 * 3600);
        return authed(req, reply, async (a) => {
          try {
            if (b.event === "start") {
              // "Now playing": the server shows it but doesn't count a play yet.
              await subCall(a.sub, "scrobble", { id: b.itemId, submission: false });
            } else if (playCounts(position, b.durationSec)) {
              await subCall(a.sub, "scrobble", { id: b.itemId, submission: true, time: Date.now() - Math.round(position * 1000) });
            }
          } catch (e) {
            // Reporting is best effort, except that a dead sign-in should surface so the app can ask again.
            if (e instanceof UpstreamError && e.kind === "unauthorized") throw e;
            req.log.debug({ event: b.event }, "Subsonic playback report failed");
          }
          return reply.code(204).send();
        });
      });

      // ---- admin: where the Subsonic server is ----------------------------------------

      const adminParse = (raw: string, allowLinkLocal: boolean) =>
        parseServiceUrl(raw, { what: "your Subsonic server", example: "http://navidrome:4533", allowLinkLocal });

      app.get("/api/admin/subsonic", { preHandler: requireAdmin }, async (): Promise<AdminAddress> => address());

      app.put<{ Body: { serverUrl?: string | null; allowLinkLocal?: boolean } }>("/api/admin/subsonic", { preHandler: requireAdmin }, async (req, reply) => {
        if (envUrl()) {
          return reply.code(409).send({ error: "set_by_environment", message: "SUBSONIC_URL is set on the server and takes precedence" });
        }
        const raw = req.body?.serverUrl;
        if (raw !== null && typeof raw !== "string") return reply.code(400).send({ error: "invalid_url" });
        let url: string | null = null;
        if (typeof raw === "string" && raw.trim()) {
          try {
            url = adminParse(raw, req.body?.allowLinkLocal === true);
          } catch (e) {
            return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
          }
        }
        settings.setPluginConfig(PLUGIN_ID, url ? { serverUrl: url } : null);
        req.log.info({ admin: req.user!.username, configured: url !== null }, "admin changed the Subsonic address");
        return address();
      });

      // Only an admin supplies the address to check; nothing is stored and no credentials are sent.
      app.post<{ Body: { serverUrl?: string; allowLinkLocal?: boolean } }>("/api/admin/subsonic/test", { preHandler: requireAdmin }, async (req, reply) => {
        let url: string;
        try {
          url = adminParse(typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "", req.body?.allowLinkLocal === true);
        } catch (e) {
          return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
        }
        try {
          // Without credentials a Subsonic server answers "failed, code 40", which still proves it is one.
          let info: Record<string, unknown> = {};
          try {
            info = await subCall({ baseUrl: url, fetchFn: options.fetchFn }, "ping");
          } catch (e) {
            if (!(e instanceof UpstreamError && e.code !== undefined)) throw e;
          }
          const type = typeof info.type === "string" ? info.type.slice(0, 60) : undefined;
          const version = typeof info.serverVersion === "string" ? info.serverVersion.slice(0, 50) : undefined;
          return { ok: true, ...(type ? { serverName: type } : {}), ...(version ? { version } : {}) } satisfies AdminTestResult;
        } catch (e) {
          const kind = e instanceof UpstreamError ? e.kind : "unreachable";
          const error =
            kind === "redirect"
              ? "That address redirects somewhere else. Use the address it redirects to."
              : kind === "timeout"
                ? "That address took too long to answer."
                : kind === "unreachable"
                  ? "Couldn't reach that address from the server."
                  : "That address answered, but it doesn't look like a Subsonic server.";
          return { ok: false, error } satisfies AdminTestResult;
        }
      });
    },
  };
}

export default createSubsonicPlugin();