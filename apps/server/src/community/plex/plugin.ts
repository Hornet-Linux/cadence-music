import type { FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { parseServiceUrl } from "../sourcesCommon/address.js";
import { MAX_IMAGE_BYTES, publicFailure, UpstreamError, type FetchFn, type Query } from "../sourcesCommon/http.js";
import { pruneOrphanedUserConfig } from "../sourcesCommon/orphans.js";
import { AUDIO_TYPE, cleanRange, IMAGE_TYPE, pipeUpstream } from "../sourcesCommon/proxy.js";
import { signedPath, verifySigned } from "../sourcesCommon/signing.js";
import { clampInt, mapLimit, playCounts, term, TtlCache } from "../sourcesCommon/util.js";
import { container, list, plexCall, plexFire, plexStream, validId, type PlexContext } from "./client.js";
import { FAVOURITE_RATING, streamInfo, toAlbum, toArtist, toPlaylist, toTrack, type ArtworkFn, type PxItem, type StreamInfo } from "./mapping.js";
import { ConnectionStore, PLUGIN_ID, type Connection } from "./store.js";
import type {
  AdminAddress,
  AdminTestResult,
  Page,
  PlexAlbum,
  PlexLibrary,
  PlexPinPoll,
  PlexPinResponse,
  PlexPlaybackReport,
  PlexStatus,
  PlexStreamUrl,
  PlexTrack,
} from "./types.js";

const SERVICE = "plex";
const LABEL = "Plex";
const PLEX_TV = "https://plex.tv";
/** Where a person types the code. */
const LINK_URL = "https://plex.tv/link";
const IDENTIFIER = "com.plexapp.plugins.library";
const STREAM_TTL_SEC = 6 * 60 * 60;
const IMAGE_TTL_DAYS = 30;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const DEFAULT_IMAGE_SIZE = 300;
const MAX_IMAGE_SIZE = 1200;
const STREAM_HEADER_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const PIN_WINDOW_MS = 15 * 60_000;
const PIN_MAX_PER_USER = 10;
const SEARCH_ALBUMS = 3;
const SEARCH_ARTISTS = 2;
const SEARCH_CONCURRENCY = 4;
/** Same names as the Subsonic source, so one page can drive both. */
const ALBUM_SORTS: Record<string, string> = {
  alphabeticalByName: "titleSort",
  newest: "addedAt:desc",
  recent: "lastViewedAt:desc",
  frequent: "viewCount:desc",
};

// Cadence's app signs a person out of Cadence on ANY 401 from an /api route it doesn't know,
// so "your Plex sign-in is no good" is a 409, never a 401.
const NOT_CONFIGURED = { error: "plex_not_configured", message: "Plex isn't set up on this server" };
const NOT_CONNECTED = { error: "plex_not_connected", message: "Link your Plex account first" };
const NO_LIBRARY = { error: "plex_no_library", message: "Choose a Plex music library first" };
const EXPIRED = { error: "plex_session_expired", message: "Your Plex sign-in stopped working. Link your account again." };
const FORBIDDEN = { error: "plex_forbidden", message: "Your Plex account isn't allowed to do that" };

export interface PlexPluginOptions {
  fetchFn?: FetchFn;
  /** The address from the environment (PLEX_URL); wins over the admin setting. */
  envUrl?: string;
  /** plex.tv address. A fixed public service; only tests (or the PLEX_TV_URL variable, for a test setup) change it. */
  plexTvUrl?: string;
  /** Tests shorten these. */
  streamIdleMs?: number;
  streamHeaderTimeoutMs?: number;
  now?: () => number;
}

interface PendingPin {
  id: number;
  code: string;
  expiresAt: number;
}

/**
 * Plex as a music source. The owner sets the address of their Plex Media Server;
 * each person links their own plex.tv account with a short code (plex.tv/link),
 * Cadence picks a music library, and the server then browses, searches and proxies
 * audio and artwork for them, so apps never talk to Plex and tokens never leave the server.
 */
export function createPlexPlugin(options: PlexPluginOptions = {}): ServerPlugin {
  return {
    id: PLUGIN_ID,
    name: "Plex",
    version: "1.0.0",
    description:
      "Use your Plex Media Server as a music source. You set the server address; each person links their own plex.tv account with a short code and picks a music library. Browsing, search and audio are proxied through this server.",
    configFields: [
      { key: "serverUrl", label: "Plex server address", type: "url", placeholder: "http://plex:32400", help: "The PLEX_URL environment variable overrides this when set. The Test button under Settings > Plugins > Plex in the player checks an address before you rely on it." },
    ],
    register(app, ctx) {
      const { secret, settings, requireUser, requireAdmin } = ctx;
      const store = new ConnectionStore(settings, secret);
      const idleMs = options.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
      const headerMs = options.streamHeaderTimeoutMs ?? STREAM_HEADER_TIMEOUT_MS;
      const now = options.now ?? Date.now;
      const pinStarts = new RateLimiter({ max: PIN_MAX_PER_USER, windowMs: PIN_WINDOW_MS });
      const pins = new Map<number, PendingPin>();
      const infos = new TtlCache<StreamInfo>(10 * 60_000);
      ctx.jobs.every("plex-prune", 24 * 3600_000, () => void pruneOrphanedUserConfig(ctx.db, PLUGIN_ID), { runSoon: true });

      const envUrl = (): string | null => {
        const raw = options.envUrl ?? process.env.PLEX_URL;
        if (!raw?.trim()) return null;
        try {
          return parseServiceUrl(raw, { what: "your Plex server", example: "http://plex:32400", allowLinkLocal: true });
        } catch {
          ctx.log.warn("PLEX_URL is not a valid address and is ignored");
          return null;
        }
      };
      const address = (): AdminAddress => {
        const fromEnv = envUrl();
        if (fromEnv) return { serverUrl: fromEnv, source: "env" };
        const saved = settings.pluginConfig<{ serverUrl?: string }>(PLUGIN_ID)?.serverUrl;
        return saved ? { serverUrl: saved, source: "admin" } : { serverUrl: null, source: null };
      };
      const baseUrl = (): string | null => address().serverUrl;
      const nowSec = () => Math.floor(Date.now() / 1000);
      const tv = (clientId: string, token?: string): PlexContext => ({ baseUrl: options.plexTvUrl ?? process.env.PLEX_TV_URL ?? PLEX_TV, clientId, token, fetchFn: options.fetchFn });

      const artworkFor = (userId: number): ArtworkFn => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return (itemId) => signedPath(secret, SERVICE, "image", userId, itemId, exp);
      };

      function connectionFor(userId: number, base: string): Connection | null {
        const conn = store.get(userId);
        if (!conn) return null;
        if (conn.serverUrl !== base) {
          // The owner moved the server: never send this token to a different address.
          store.forget(userId);
          return null;
        }
        return conn;
      }

      const pms = (base: string, conn: Connection): PlexContext => ({ baseUrl: base, clientId: conn.clientId, token: conn.token, fetchFn: options.fetchFn });

      interface Authed {
        px: PlexContext;
        conn: Connection;
        userId: number;
        art: ArtworkFn;
        /** The chosen music library's key (only set when the route asked for it). */
        section: string;
      }

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown, conn?: Connection) {
        if (e instanceof UpstreamError) {
          if (e.kind === "unauthorized") {
            if (conn) store.forgetIfSame(conn.userId, conn.tokenEnc);
            return reply.code(409).send(EXPIRED);
          }
          if (e.kind === "forbidden") return reply.code(403).send(FORBIDDEN);
          if (e.kind === "not_found") return reply.code(404).send({ error: "not_found" });
          req.log.warn({ kind: e.kind, status: e.status }, "Plex call failed");
          return reply.code(502).send(publicFailure(LABEL, e));
        }
        req.log.error({ err: e }, "Plex handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      async function authed(req: FastifyRequest, reply: FastifyReply, fn: (a: Authed) => Promise<unknown>, needLibrary = true) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const userId = req.user!.id;
        const conn = connectionFor(userId, base);
        if (!conn) return reply.code(409).send(NOT_CONNECTED);
        if (needLibrary && !conn.library) return reply.code(409).send(NO_LIBRARY);
        try {
          return await fn({ px: pms(base, conn), conn, userId, art: artworkFor(userId), section: conn.library?.key ?? "" });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      }

      const idParam = (reply: FastifyReply, id: string): string | null => {
        if (validId(id)) return id;
        void reply.code(400).send({ error: "invalid_id" });
        return null;
      };

      const statusOf = (conn: Connection): PlexStatus => ({
        configured: true,
        connected: true,
        ...(conn.serverName ? { serverName: conn.serverName } : {}),
        userName: conn.userName,
        ...(conn.library ? { library: conn.library } : { needsLibrary: true }),
      });

      /** The server's music libraries (sections of type "artist"). */
      async function musicLibraries(px: PlexContext): Promise<PlexLibrary[]> {
        const c = await container(px, "/library/sections");
        return list<{ key?: unknown; type?: unknown; title?: unknown }>(c.Directory)
          .filter((d) => d.type === "artist" && typeof d.title === "string" && /^\d{1,8}$/.test(String(d.key)))
          .map((d) => ({ key: String(d.key), title: String(d.title).slice(0, 200) }));
      }

      // ---- listing helpers ----------------------------------------------------------

      const tracksOf = (rows: unknown, a: Authed): PlexTrack[] =>
        list<PxItem>(rows)
          .map((r) => toTrack(r, a.art))
          .filter((t): t is PlexTrack => t !== null);

      const slice = <T>(items: T[], offset: number, limit: number): Page<T> => ({
        items: items.slice(offset, offset + limit),
        total: items.length,
        hasMore: items.length > offset + limit,
      });

      /** A page of a section listing; Plex reports the total. */
      async function sectionPage<T>(a: Authed, type: number, extra: Query, limit: number, offset: number, map: (rows: unknown) => T[]): Promise<Page<T>> {
        const c = await container(a.px, `/library/sections/${a.section}/all`, {
          type,
          "X-Plex-Container-Start": offset,
          "X-Plex-Container-Size": limit,
          ...extra,
        });
        const items = map(c.Metadata);
        const total = typeof c.totalSize === "number" ? c.totalSize : offset + items.length;
        return { items, total, hasMore: offset + items.length < total };
      }

      const childrenOf = async (a: Authed, id: string, edge: "children" | "allLeaves"): Promise<unknown> => (await container(a.px, `/library/metadata/${id}/${edge}`)).Metadata;

      /** Plex's search matches titles; people also search by artist and album, so matching ones are expanded into tracks. */
      async function searchTracks(a: Authed, text: string, limit: number, offset: number): Promise<Page<PlexTrack>> {
        const c = await container(a.px, "/hubs/search", { query: text, sectionId: a.section, limit: Math.min(MAX_LIMIT, offset + limit) });
        const hubs = list<{ type?: unknown; Metadata?: unknown }>(c.Hub);
        const of = (type: string) => hubs.filter((h) => h.type === type).flatMap((h) => list<PxItem>(h.Metadata));
        const byTitle = tracksOf(of("track"), a);
        const albumIds = of("album").map((x) => x.ratingKey).filter(validId).slice(0, SEARCH_ALBUMS);
        const artistIds = of("artist").map((x) => x.ratingKey).filter(validId).slice(0, SEARCH_ARTISTS);
        const expanded = await Promise.all([
          mapLimit(albumIds, SEARCH_CONCURRENCY, async (id) => tracksOf(await childrenOf(a, id, "children"), a)),
          mapLimit(artistIds, SEARCH_CONCURRENCY, async (id) => tracksOf(await childrenOf(a, id, "allLeaves"), a)),
        ]);
        const seen = new Set<string>();
        const merged: PlexTrack[] = [];
        for (const t of [...byTitle, ...expanded.flat(2)]) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            merged.push(t);
          }
        }
        return slice(merged, offset, limit);
      }
      // ---- status and linking ---------------------------------------------------

      app.get("/api/plex/status", { preHandler: requireUser }, async (req): Promise<PlexStatus> => {
        const base = baseUrl();
        if (!base) return { configured: false, connected: false };
        const conn = connectionFor(req.user!.id, base);
        return conn ? statusOf(conn) : { configured: true, connected: false };
      });

      // Step 1: ask plex.tv for a short code. The person types it at plex.tv/link while signed in to their own Plex account.
      app.post("/api/plex/pin", { preHandler: requireUser }, async (req, reply) => {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const userId = req.user!.id;
        const key = `user:${userId}`;
        if (pinStarts.isLimited(key)) return reply.code(429).send({ error: "rate_limited", message: "Too many link attempts. Try again later." });
        pinStarts.hit(key);
        try {
          const res = await plexCall<{ id?: unknown; code?: unknown; expiresIn?: unknown }>(tv(store.clientIdFor(userId)), "POST", "/api/v2/pins", {
            body: "strong=false",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });
          const { id, code, expiresIn } = res.data ?? {};
          if (typeof id !== "number" || !Number.isInteger(id) || typeof code !== "string" || !/^[A-Za-z0-9]{2,32}$/.test(code)) {
            return reply.code(502).send({ error: "plex_failed", message: "Plex returned an unexpected answer" });
          }
          const ttl = typeof expiresIn === "number" && expiresIn > 0 ? Math.min(expiresIn, 3600) : 900;
          const pin: PendingPin = { id, code, expiresAt: now() + ttl * 1000 };
          pins.set(userId, pin);
          return { code, linkUrl: LINK_URL, expiresAt: pin.expiresAt } satisfies PlexPinResponse;
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      // Step 2: the app polls until the person has entered the code. The pin id never leaves the server, so nobody can poll another person's link.
      app.get("/api/plex/pin", { preHandler: requireUser }, async (req, reply) => {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const userId = req.user!.id;
        const pin = pins.get(userId);
        if (!pin) return reply.code(404).send({ error: "plex_no_pin", message: "Start linking first" });
        if (pin.expiresAt <= now()) {
          pins.delete(userId);
          return { state: "expired" } satisfies PlexPinPoll;
        }
        const clientId = store.clientIdFor(userId);
        try {
          let token: unknown;
          try {
            const res = await plexCall<{ authToken?: unknown }>(tv(clientId), "GET", `/api/v2/pins/${pin.id}`, { query: { code: pin.code } });
            token = res.data?.authToken;
          } catch (e) {
            if (e instanceof UpstreamError && e.kind === "not_found") {
              pins.delete(userId);
              return { state: "expired" } satisfies PlexPinPoll;
            }
            throw e;
          }
          if (typeof token !== "string" || !token || token.length > 512) return { state: "waiting", expiresAt: pin.expiresAt } satisfies PlexPinPoll;

          // The code was entered. Is this account allowed on the owner's server, and which music is there?
          const probe: PlexContext = { baseUrl: base, clientId, token, fetchFn: options.fetchFn };
          let libraries: PlexLibrary[];
          try {
            libraries = await musicLibraries(probe);
          } catch (e) {
            if (e instanceof UpstreamError && (e.kind === "unauthorized" || e.kind === "forbidden")) {
              // The token is discarded: it belongs to an account without access here.
              pins.delete(userId);
              return { state: "no_access" } satisfies PlexPinPoll;
            }
            throw e;
          }
          let userName = "Plex user";
          try {
            const me = await plexCall<{ username?: unknown; title?: unknown; email?: unknown }>(tv(clientId, token), "GET", "/api/v2/user");
            const name = [me.data?.username, me.data?.title].find((v) => typeof v === "string" && v);
            if (typeof name === "string") userName = name.slice(0, 100);
          } catch {
            // The name is a nicety.
          }
          let serverName: string | null = null;
          try {
            const root = await container(probe, "/");
            if (typeof root.friendlyName === "string") serverName = root.friendlyName.slice(0, 200);
          } catch {
            // So is this.
          }
          const library = libraries.length === 1 ? libraries[0] : null;
          store.save({ userId, clientId, serverUrl: base, token, userName, serverName, library });
          pins.delete(userId);
          return { state: "connected", status: statusOf(store.get(userId)!) } satisfies PlexPinPoll;
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.delete("/api/plex/connection", { preHandler: requireUser }, async (req, reply) => {
        pins.delete(req.user!.id);
        store.forget(req.user!.id);
        return reply.code(204).send();
      });

      app.get("/api/plex/libraries", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => ({ items: await musicLibraries(a.px), selected: a.conn.library?.key ?? null }), false),
      );

      app.put<{ Body: { key?: unknown } }>("/api/plex/library", { preHandler: requireUser }, (req, reply) => {
        const key = req.body?.key;
        if (typeof key !== "string" || !/^\d{1,8}$/.test(key)) return reply.code(400).send({ error: "invalid_request" });
        return authed(
          req,
          reply,
          async (a) => {
            // Only a library the server really lists for this account can be chosen.
            const chosen = (await musicLibraries(a.px)).find((l) => l.key === key);
            if (!chosen) return reply.code(404).send({ error: "not_found" });
            store.setLibrary(a.userId, chosen);
            return statusOf(store.get(a.userId)!);
          },
          false,
        );
      });

      // ---- browsing -------------------------------------------------------------

      app.get<{ Querystring: { q?: string; albumId?: string; favourites?: string; limit?: string; offset?: string } }>(
        "/api/plex/tracks",
        { preHandler: requireUser },
        (req, reply) =>
          authed(req, reply, async (a): Promise<Page<PlexTrack> | FastifyReply> => {
            const { q, albumId, favourites } = req.query;
            const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
            const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
            if (albumId !== undefined && albumId !== "") {
              if (!validId(albumId)) return reply.code(400).send({ error: "invalid_id" });
              return slice(tracksOf(await childrenOf(a, albumId, "children"), a), offset, limit);
            }
            const text = term(q);
            const wantFavourites = favourites === "1" || favourites === "true";
            if (text && !wantFavourites) return searchTracks(a, text, limit, offset);
            return sectionPage(
              a,
              10,
              {
                sort: "artist.titleSort,album.titleSort,album.index,track.index",
                ...(wantFavourites ? { "userRating>>": FAVOURITE_RATING } : {}),
                ...(text ? { title: text } : {}),
              },
              limit,
              offset,
              (rows) => tracksOf(rows, a),
            );
          }),
      );

      app.get<{ Querystring: { q?: string; artistId?: string; sort?: string; limit?: string; offset?: string } }>(
        "/api/plex/albums",
        { preHandler: requireUser },
        (req, reply) =>
          authed(req, reply, async (a): Promise<Page<PlexAlbum> | FastifyReply> => {
            const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
            const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
            const mapAlbums = (rows: unknown) =>
              list<PxItem>(rows)
                .map((r) => toAlbum(r, a.art))
                .filter((x): x is PlexAlbum => x !== null);
            const { artistId } = req.query;
            if (artistId !== undefined && artistId !== "") {
              if (!validId(artistId)) return reply.code(400).send({ error: "invalid_id" });
              return slice(mapAlbums(await childrenOf(a, artistId, "children")), offset, limit);
            }
            const sort = (req.query.sort && Object.hasOwn(ALBUM_SORTS, req.query.sort) ? ALBUM_SORTS[req.query.sort] : undefined) ?? "titleSort";
            const text = term(req.query.q);
            return sectionPage(a, 9, { sort, ...(text ? { title: text } : {}) }, limit, offset, mapAlbums);
          }),
      );

      app.get<{ Params: { id: string } }>("/api/plex/albums/:id/tracks", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => slice(tracksOf(await childrenOf(a, id, "children"), a), 0, MAX_LIMIT));
      });

      app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>("/api/plex/artists", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, (a) => {
          const text = term(req.query.q);
          return sectionPage(
            a,
            8,
            { sort: "titleSort", ...(text ? { title: text } : {}) },
            clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
            clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
            (rows) =>
              list<PxItem>(rows)
                .map((r) => toArtist(r, a.art))
                .filter((x) => x !== null),
          );
        }),
      );

      app.get("/api/plex/playlists", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const c = await container(a.px, "/playlists", { playlistType: "audio" });
          return {
            items: list<PxItem>(c.Metadata)
              .map((r) => toPlaylist(r))
              .filter((x) => x !== null)
              .slice(0, MAX_LIMIT),
          };
        }),
      );

      app.get<{ Params: { id: string } }>("/api/plex/playlists/:id/tracks", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => slice(tracksOf((await container(a.px, `/playlists/${id}/items`)).Metadata, a), 0, MAX_LIMIT));
      });

      // ---- favourites (a rating of 10, or none) ---------------------------------

      for (const [method, rating] of [["PUT", 10], ["DELETE", 0]] as const) {
        app.route<{ Params: { id: string } }>({
          method,
          url: "/api/plex/favourites/:id",
          preHandler: requireUser,
          handler: (req, reply) => {
            const id = idParam(reply, req.params.id);
            if (!id) return reply;
            return authed(req, reply, async (a) => {
              await plexFire(a.px, "PUT", "/:/rate", { key: id, identifier: IDENTIFIER, rating });
              return reply.code(204).send();
            });
          },
        });
      }
      // ---- streaming and cover art (signed URLs, no bearer token) -------------------

      /** The track's file and whether browsers can play it as is (looked up once, then remembered briefly). */
      async function infoFor(a: Authed, id: string): Promise<StreamInfo> {
        const key = `${a.userId}:${id}`;
        const known = infos.get(key);
        if (known) return known;
        const c = await container(a.px, `/library/metadata/${id}`);
        const item = list<PxItem>(c.Metadata)[0];
        const info = item && item.type === "track" ? streamInfo(item) : null;
        if (!info) throw new UpstreamError("not_found");
        infos.set(key, info);
        return info;
      }

      app.get<{ Params: { id: string } }>("/api/plex/tracks/:id/stream-url", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(
          req,
          reply,
          async (a): Promise<PlexStreamUrl> => {
            const info = await infoFor(a, id);
            const expiresAt = nowSec() + STREAM_TTL_SEC;
            return { path: signedPath(secret, SERVICE, "stream", a.userId, id, expiresAt), expiresAt, mode: info.mode };
          },
          false,
        );
      });

      async function proxy(
        req: FastifyRequest,
        reply: FastifyReply,
        userId: number,
        resolve: (a: Authed) => Promise<{ path: string; query: Query }>,
        opts: { accept: RegExp; cache: string; range?: string; maxBytes?: number },
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
          const a: Authed = { px: pms(base, conn), conn, userId, art: artworkFor(userId), section: conn.library?.key ?? "" };
          const target = await resolve(a);
          res = await plexStream(a.px, target.path, target.query, {
            headers: opts.range ? { Range: opts.range } : undefined,
            signal: ac.signal,
            headerTimeoutMs: headerMs,
          });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
        const status = res.status;
        const drop = () => void res.body?.cancel().catch(() => undefined);
        if (status === 401) {
          drop();
          store.forgetIfSame(userId, conn.tokenEnc);
          return reply.code(409).send(EXPIRED);
        }
        if (status === 403) {
          drop();
          return reply.code(403).send(FORBIDDEN);
        }
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
            reply.code(502).send({ error: "plex_failed", message: "Plex sent more than Cadence accepts" }),
          );
        }
        drop();
        req.log.warn({ status, type }, "Plex returned something unplayable");
        return reply.code(502).send({ error: "plex_failed", message: "Plex returned an unexpected answer" });
      }

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string } }>("/api/plex/stream/:id", async (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        const userId = verifySigned(secret, SERVICE, "stream", id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        return proxy(
          req,
          reply,
          userId,
          async (a) => {
            const info = await infoFor(a, id);
            // Direct play passes the original file (with Range) through; anything else is converted to MP3 by Plex.
            if (info.mode === "direct") return { path: info.partKey, query: {} };
            return {
              path: "/music/:/transcode/universal/start.mp3",
              query: { path: `/library/metadata/${id}`, mediaIndex: 0, partIndex: 0, protocol: "http", directPlay: 0, directStream: 0, maxAudioBitrate: 320, "X-Plex-Platform": "Chrome" },
            };
          },
          { accept: AUDIO_TYPE, cache: "private, max-age=3600", range: cleanRange(req.headers.range) },
        );
      });

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string; w?: string } }>("/api/plex/image/:id", async (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        const userId = verifySigned(secret, SERVICE, "image", id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const size = clampInt(req.query.w, DEFAULT_IMAGE_SIZE, 16, MAX_IMAGE_SIZE);
        return proxy(
          req,
          reply,
          userId,
          async () => ({
            path: "/photo/:/transcode",
            query: { width: size, height: size, minSize: 1, upscale: 1, url: `/library/metadata/${id}/thumb` },
          }),
          { accept: IMAGE_TYPE, cache: "private, max-age=604800", maxBytes: MAX_IMAGE_BYTES },
        );
      });

      // ---- reporting plays back --------------------------------------------------------

      app.post<{ Body: PlexPlaybackReport }>("/api/plex/playback", { preHandler: requireUser }, (req, reply) => {
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
        return authed(
          req,
          reply,
          async (a) => {
            try {
              await plexFire(a.px, "GET", "/:/timeline", {
                ratingKey: b.itemId,
                key: `/library/metadata/${b.itemId}`,
                state: b.event === "start" ? "playing" : "stopped",
                time: Math.round(position * 1000),
                duration: b.durationSec ? Math.round(b.durationSec * 1000) : undefined,
                identifier: IDENTIFIER,
              });
              // Plex counts a play (and updates "recently played") only when it is told the track was finished.
              if (b.event === "stop" && playCounts(position, b.durationSec)) {
                await plexFire(a.px, "GET", "/:/scrobble", { key: b.itemId, identifier: IDENTIFIER });
              }
            } catch (e) {
              // Reporting is best effort, except that a dead sign-in should surface so the app can ask again.
              if (e instanceof UpstreamError && e.kind === "unauthorized") throw e;
              req.log.debug({ event: b.event }, "Plex playback report failed");
            }
            return reply.code(204).send();
          },
          false,
        );
      });

      // ---- admin: where the Plex server is --------------------------------------------

      const adminParse = (raw: string, allowLinkLocal: boolean) => parseServiceUrl(raw, { what: "your Plex server", example: "http://plex:32400", allowLinkLocal });

      app.get("/api/admin/plex", { preHandler: requireAdmin }, async (): Promise<AdminAddress> => address());

      app.put<{ Body: { serverUrl?: string | null; allowLinkLocal?: boolean } }>("/api/admin/plex", { preHandler: requireAdmin }, async (req, reply) => {
        if (envUrl()) return reply.code(409).send({ error: "set_by_environment", message: "PLEX_URL is set on the server and takes precedence" });
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
        req.log.info({ admin: req.user!.username, configured: url !== null }, "admin changed the Plex address");
        return address();
      });

      // Only an admin supplies the address to check; nothing is stored and no token is sent (/identity needs none).
      app.post<{ Body: { serverUrl?: string; allowLinkLocal?: boolean } }>("/api/admin/plex/test", { preHandler: requireAdmin }, async (req, reply) => {
        let url: string;
        try {
          url = adminParse(typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "", req.body?.allowLinkLocal === true);
        } catch (e) {
          return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
        }
        try {
          const c = await container({ baseUrl: url, clientId: "cadence-test", fetchFn: options.fetchFn }, "/identity");
          if (typeof c.machineIdentifier !== "string" || typeof c.version !== "string") {
            return { ok: false, error: "That address answered, but it doesn't look like a Plex server." } satisfies AdminTestResult;
          }
          return { ok: true, version: c.version.slice(0, 50) } satisfies AdminTestResult;
        } catch (e) {
          const kind = e instanceof UpstreamError ? e.kind : "unreachable";
          const error =
            kind === "redirect"
              ? "That address redirects somewhere else. Use the address it redirects to."
              : kind === "timeout"
                ? "That address took too long to answer."
                : kind === "unreachable"
                  ? "Couldn't reach that address from the server."
                  : "That address answered, but it doesn't look like a Plex server.";
          return { ok: false, error } satisfies AdminTestResult;
        }
      });
    },
  };
}

export default createPlexPlugin();