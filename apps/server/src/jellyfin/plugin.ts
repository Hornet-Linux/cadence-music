import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import type {
  AdminJellyfinResponse,
  AdminJellyfinTestResponse,
  JellyfinAlbumsResponse,
  JellyfinConnectRequest,
  JellyfinMatchRequest,
  JellyfinMatchResponse,
  JellyfinPlaybackReport,
  JellyfinPlaylistsResponse,
  JellyfinStatusResponse,
  JellyfinStreamUrlResponse,
  JellyfinTasteResponse,
  JellyfinTrack,
  JellyfinTracksResponse,
} from "@uma/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter } from "../auth/rateLimit.js";
import type { ServerPlugin } from "../plugins/types.js";
import {
  jfJson,
  jfStream,
  JellyfinError,
  secToTicks,
  validId,
  type FetchFn,
  type JellyfinContext,
  type Query,
} from "./client.js";
import { toAlbum, toPlaylist, toTrack, line, type ArtworkFn, type JfItem, type JfItemsResponse } from "./mapping.js";
import { pickBest, searchTitle } from "./match.js";
import { signedPath, verifySigned } from "./signing.js";
import { ConnectionStore, type Connection } from "./store.js";
import { parseJellyfinUrl } from "./url.js";

const STREAM_TTL_SEC = 6 * 60 * 60;
/** Cover art URLs get stored (history, likes), so they live long and are stable within a day for caching. */
const IMAGE_TTL_DAYS = 30;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_PICKS = 30;
const MATCH_CONCURRENCY = 4;
const DEFAULT_IMAGE_WIDTH = 300;
const MAX_IMAGE_WIDTH = 1200;
const STREAM_HEADER_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_PER_USER = 5;
const LOGIN_MAX_PER_ADDRESS = 20;
const TASTE_ARTISTS = 20;
const TASTE_TRACKS = 25;
const TASTE_GENRES = 10;

/**
 * What browsers and WebViews can play directly. Anything else (Ogg, Opus, WMA, ...)
 * is transcoded by Jellyfin to MP3, which every client plays.
 */
const DIRECT_CONTAINERS = "mp3,aac,m4a,m4b,flac,wav";
const DIRECT_CODECS = "mp3,aac,flac";
const TRANSCODE_CONTAINER = "mp3";

const NOT_CONFIGURED = { error: "jellyfin_not_configured", message: "Jellyfin isn't set up on this server" };
const NOT_CONNECTED = { error: "jellyfin_not_connected", message: "Sign in to Jellyfin first" };
const EXPIRED = { error: "jellyfin_session_expired", message: "Your Jellyfin sign-in expired. Sign in again." };

/** What clients may learn about a failed call: fixed phrases, never upstream text or network details. */
function publicFailure(e: JellyfinError): { error: string; message: string } {
  if (e.kind === "timeout") return { error: "jellyfin_failed", message: "Jellyfin took too long to answer" };
  if (e.kind === "unreachable" || e.kind === "redirect") {
    return { error: "jellyfin_failed", message: "Jellyfin couldn't be reached. Ask the server owner to check it." };
  }
  return { error: "jellyfin_failed", message: "Jellyfin returned an unexpected answer" };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const term = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Passes bytes through, and gives up when the source goes quiet while the
 * consumer wants more. (A consumer that is simply paused is not "quiet".)
 */
class IdleGuard extends Transform {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {
    super();
  }
  override _read(size: number): void {
    this.timer ??= setTimeout(this.onIdle, this.ms);
    super._read(size);
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.disarm();
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    this.disarm();
    cb();
  }
  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.disarm();
    cb(err);
  }
  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export interface JellyfinPluginOptions {
  /** Lets tests stand in for the network. */
  fetchFn?: FetchFn;
  /** Tests shorten these. */
  streamIdleMs?: number;
  streamHeaderTimeoutMs?: number;
}

const SINGLE_RANGE = /^bytes=\d*-\d*$/;
const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/ogg)$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif|bmp)$/i;

/**
 * Jellyfin as a music source. The server signs in to the owner's Jellyfin as
 * each person (their own account), calls it for them, and proxies audio and cover
 * art, so apps never talk to Jellyfin and its tokens never leave the server.
 * Only the server owner sets the Jellyfin address.
 */
export function createJellyfinPlugin(options: JellyfinPluginOptions = {}): ServerPlugin {
  return {
    id: "core.jellyfin",
    name: "Jellyfin",
    version: "1.0.0",
    register(app, ctx) {
      const { secret, settings, requireUser, requireAdmin } = ctx;
      const store = new ConnectionStore(ctx.db, secret);
      const idleMs = options.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
      const headerMs = options.streamHeaderTimeoutMs ?? STREAM_HEADER_TIMEOUT_MS;
      const perUser = new RateLimiter({ max: LOGIN_MAX_PER_USER, windowMs: LOGIN_WINDOW_MS });
      const perAddress = new RateLimiter({ max: LOGIN_MAX_PER_ADDRESS, windowMs: LOGIN_WINDOW_MS });

      /** Resolved per request, so an admin's change applies immediately. */
      const baseUrl = (): string | null => settings.jellyfin().serverUrl;
      const nowSec = () => Math.floor(Date.now() / 1000);

      /** Signed, relative cover art path for this person. */
      const artworkFor = (userId: number): ArtworkFn => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return (itemId) => signedPath(secret, "image", userId, itemId, exp);
      };

      /** The person's usable connection: signed in, to the address in effect now. */
      function connectionFor(userId: number, base: string): Connection | null {
        const conn = store.get(userId);
        if (!conn) return null;
        if (conn.serverUrl !== base) {
          // The owner moved Jellyfin: never send this token to a different address.
          store.delete(userId);
          return null;
        }
        return conn;
      }

      const jf = (base: string, conn: Connection): JellyfinContext => ({
        baseUrl: base,
        deviceId: conn.deviceId,
        token: conn.token,
        fetchFn: options.fetchFn,
      });

      interface Authed {
        jf: JellyfinContext;
        conn: Connection;
        userId: number;
        art: ArtworkFn;
      }

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown, conn?: Connection) {
        if (e instanceof JellyfinError) {
          if (e.kind === "unauthorized") {
            if (conn) store.deleteIfToken(conn.userId, conn.tokenEnc);
            return reply.code(401).send(EXPIRED);
          }
          if (e.kind === "not_found") return reply.code(404).send({ error: "not_found" });
          req.log.warn({ kind: e.kind, status: e.status }, "Jellyfin call failed");
          return reply.code(502).send(publicFailure(e));
        }
        req.log.error({ err: e }, "Jellyfin handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      /** Runs `fn` for the signed-in person, turning Jellyfin failures into the right answers. */
      async function authed(req: FastifyRequest, reply: FastifyReply, fn: (a: Authed) => Promise<unknown>) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const userId = req.user!.id;
        const conn = connectionFor(userId, base);
        if (!conn) return reply.code(409).send(NOT_CONNECTED);
        try {
          return await fn({ jf: jf(base, conn), conn, userId, art: artworkFor(userId) });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      }

      const idParam = (reply: FastifyReply, id: string): string | null => {
        if (validId(id)) return id.toLowerCase();
        void reply.code(400).send({ error: "invalid_id" });
        return null;
      };

      function trackQuery(a: Authed, extra: Query, limit: number, offset: number): Query {
        return {
          userId: a.conn.jellyfinUserId,
          IncludeItemTypes: "Audio",
          Recursive: true,
          SortBy: "AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName",
          Limit: limit,
          StartIndex: offset,
          ...extra,
        };
      }

      async function listTracks(a: Authed, query: Query): Promise<JellyfinTracksResponse> {
        const data = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", { query });
        const items = (data?.Items ?? []).map((i) => toTrack(i, a.art)).filter((t): t is JellyfinTrack => t !== null);
        return { items, total: typeof data?.TotalRecordCount === "number" ? data.TotalRecordCount : items.length };
      }

      /**
       * Jellyfin's `SearchTerm` only matches a track's own title, but people search
       * for artists and albums too. So a plain text search also finds the artists
       * and albums that match and adds their tracks: title matches first, then
       * artists, then albums, with no repeats.
       */
      async function searchTracks(a: Authed, text: string, limit: number, offset: number): Promise<JellyfinTracksResponse> {
        const want = Math.min(MAX_LIMIT, offset + limit);
        const matchIds = async (type: "MusicArtist" | "MusicAlbum"): Promise<string[]> => {
          const data = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", {
            query: { userId: a.conn.jellyfinUserId, IncludeItemTypes: type, Recursive: true, SearchTerm: text, Limit: 10, EnableTotalRecordCount: false },
          });
          return (data?.Items ?? []).map((i) => i.Id).filter((id): id is string => typeof id === "string" && validId(id));
        };
        const [byTitle, artistIds, albumIds] = await Promise.all([
          listTracks(a, trackQuery(a, { SearchTerm: text }, want, 0)),
          matchIds("MusicArtist"),
          matchIds("MusicAlbum"),
        ]);
        const [byArtist, byAlbum] = await Promise.all([
          artistIds.length ? listTracks(a, trackQuery(a, { ArtistIds: artistIds.join(",") }, want, 0)) : { items: [], total: 0 },
          albumIds.length ? listTracks(a, trackQuery(a, { AlbumIds: albumIds.join(",") }, want, 0)) : { items: [], total: 0 },
        ]);
        const seen = new Set<string>();
        const merged: JellyfinTrack[] = [];
        for (const t of [...byTitle.items, ...byArtist.items, ...byAlbum.items]) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            merged.push(t);
          }
        }
        return { items: merged.slice(offset, offset + limit), total: merged.length };
      }

      // ---- status and sign-in ---------------------------------------------------

      app.get("/api/jellyfin/status", { preHandler: requireUser }, async (req): Promise<JellyfinStatusResponse> => {
        const base = baseUrl();
        if (!base) return { configured: false, connected: false };
        const conn = connectionFor(req.user!.id, base);
        return conn
          ? { configured: true, connected: true, ...(conn.serverName ? { serverName: conn.serverName } : {}), userName: conn.jellyfinUserName }
          : { configured: true, connected: false };
      });

      app.put<{ Body: JellyfinConnectRequest }>("/api/jellyfin/connection", { preHandler: requireUser }, async (req, reply) => {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const b = req.body;
        const username = typeof b?.username === "string" ? b.username.trim() : "";
        const password = b?.password;
        if (!username || username.length > 256 || typeof password !== "string" || password.length > 1024) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        const userId = req.user!.id;
        // Failed sign-ins are counted per person and per address, so this can't be used to guess Jellyfin passwords.
        const userKey = `user:${userId}`;
        const addressKey = `ip:${req.ip}`;
        if (perUser.isLimited(userKey) || perAddress.isLimited(addressKey)) {
          return reply.code(429).send({ error: "rate_limited", message: "Too many sign-in attempts. Try again later." });
        }

        const deviceId = store.deviceIdFor(userId);
        const anon: JellyfinContext = { baseUrl: base, deviceId, fetchFn: options.fetchFn };
        let auth: { AccessToken?: unknown; User?: { Id?: unknown; Name?: unknown } };
        try {
          auth = await jfJson(anon, "POST", "/Users/AuthenticateByName", { body: { Username: username, Pw: password } });
        } catch (e) {
          if (e instanceof JellyfinError && (e.kind === "unauthorized" || e.status === 400)) {
            perUser.hit(userKey);
            perAddress.hit(addressKey);
            return reply.code(401).send({ error: "jellyfin_invalid_credentials", message: "Jellyfin didn't accept that user name and password" });
          }
          if (e instanceof JellyfinError) {
            req.log.warn({ kind: e.kind, status: e.status }, "Jellyfin sign-in failed");
            return reply.code(502).send(publicFailure(e));
          }
          throw e;
        }
        const token = auth?.AccessToken;
        const jfUserId = auth?.User?.Id;
        if (typeof token !== "string" || !token || !validId(jfUserId)) {
          return reply.code(502).send({ error: "jellyfin_failed", message: "Jellyfin returned an unexpected answer" });
        }
        const jfUserName = typeof auth.User?.Name === "string" && auth.User.Name ? auth.User.Name.slice(0, 200) : username;

        let serverName: string | null = null;
        try {
          const info = await jfJson<{ ServerName?: unknown }>(anon, "GET", "/System/Info/Public");
          if (typeof info?.ServerName === "string") serverName = info.ServerName.slice(0, 200);
        } catch {
          // The name is a nicety.
        }

        // Signing in again replaces the old token; sign the old one out so sessions don't pile up in Jellyfin.
        const previous = store.get(userId);
        if (previous && previous.serverUrl === base) {
          await jfJson(jf(base, previous), "POST", "/Sessions/Logout").catch(() => undefined);
        }
        store.save({
          userId,
          jellyfinUserId: jfUserId.toLowerCase(),
          jellyfinUserName: jfUserName,
          serverName,
          serverUrl: base,
          token,
          deviceId,
        });
        perUser.reset(userKey);
        return { configured: true, connected: true, ...(serverName ? { serverName } : {}), userName: jfUserName } satisfies JellyfinStatusResponse;
      });

      app.delete("/api/jellyfin/connection", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const conn = store.get(userId);
        const base = baseUrl();
        if (conn && base && conn.serverUrl === base) {
          await jfJson(jf(base, conn), "POST", "/Sessions/Logout").catch(() => undefined);
        }
        store.delete(userId);
        return reply.code(204).send();
      });

      // ---- browsing -------------------------------------------------------------

      app.get<{
        Querystring: { q?: string; artist?: string; album?: string; albumId?: string; favourites?: string; limit?: string; offset?: string };
      }>("/api/jellyfin/tracks", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const { q, artist, album, albumId, favourites } = req.query;
          const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
          const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
          // A plain search (no other filter) looks at artists and albums as well as titles.
          const plain = !albumId && !artist && !album && favourites !== "1" && favourites !== "true";
          if (plain && term(q)) return searchTracks(a, term(q)!, limit, offset);
          let parent: string | undefined;
          if (albumId !== undefined && albumId !== "") {
            if (!validId(albumId)) return reply.code(400).send({ error: "invalid_id" });
            parent = albumId.toLowerCase();
          }
          const query = trackQuery(
            a,
            {
              SearchTerm: term(q),
              Artists: term(artist)?.replace(/\|/g, " "),
              Albums: term(album)?.replace(/\|/g, " "),
              ParentId: parent,
              Filters: favourites === "1" || favourites === "true" ? "IsFavorite" : undefined,
            },
            limit,
            offset,
          );
          return listTracks(a, query);
        }),
      );

      app.get<{ Querystring: { q?: string; artist?: string; limit?: string; offset?: string } }>(
        "/api/jellyfin/albums",
        { preHandler: requireUser },
        (req, reply) =>
          authed(req, reply, async (a): Promise<JellyfinAlbumsResponse> => {
            const data = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", {
              query: {
                userId: a.conn.jellyfinUserId,
                IncludeItemTypes: "MusicAlbum",
                Recursive: true,
                SortBy: "AlbumArtist,SortName",
                Fields: "ChildCount",
                SearchTerm: term(req.query.q),
                Artists: term(req.query.artist)?.replace(/\|/g, " "),
                Limit: clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
                StartIndex: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
              },
            });
            const items = (data?.Items ?? []).map((i) => toAlbum(i, a.art)).filter((x) => x !== null);
            return { items, total: typeof data?.TotalRecordCount === "number" ? data.TotalRecordCount : items.length };
          }),
      );

      app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
        "/api/jellyfin/albums/:id/tracks",
        { preHandler: requireUser },
        (req, reply) => {
          const id = idParam(reply, req.params.id);
          if (!id) return reply;
          return authed(req, reply, (a) =>
            listTracks(
              a,
              trackQuery(
                a,
                { ParentId: id, SortBy: "ParentIndexNumber,IndexNumber,SortName" },
                clampInt(req.query.limit, MAX_LIMIT, 1, MAX_LIMIT),
                clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
              ),
            ),
          );
        },
      );

      app.get("/api/jellyfin/playlists", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a): Promise<JellyfinPlaylistsResponse> => {
          const data = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", {
            query: {
              userId: a.conn.jellyfinUserId,
              IncludeItemTypes: "Playlist",
              Recursive: true,
              SortBy: "SortName",
              Fields: "ChildCount",
              Limit: MAX_LIMIT,
            },
          });
          return { items: (data?.Items ?? []).map((i) => toPlaylist(i, a.art)).filter((x) => x !== null) };
        }),
      );

      app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
        "/api/jellyfin/playlists/:id/tracks",
        { preHandler: requireUser },
        (req, reply) => {
          const id = idParam(reply, req.params.id);
          if (!id) return reply;
          return authed(req, reply, async (a): Promise<JellyfinTracksResponse> => {
            const data = await jfJson<JfItemsResponse>(a.jf, "GET", `/Playlists/${id}/Items`, {
              query: {
                userId: a.conn.jellyfinUserId,
                Limit: clampInt(req.query.limit, MAX_LIMIT, 1, MAX_LIMIT),
                StartIndex: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
              },
            });
            const items = (data?.Items ?? []).map((i) => toTrack(i, a.art)).filter((t): t is JellyfinTrack => t !== null);
            return { items, total: typeof data?.TotalRecordCount === "number" ? data.TotalRecordCount : items.length };
          });
        },
      );

      // ---- favourites -----------------------------------------------------------

      async function setFavourite(a: Authed, id: string, on: boolean): Promise<void> {
        const method = on ? "POST" : "DELETE";
        try {
          await jfJson(a.jf, method, `/UserFavoriteItems/${id}`, { query: { userId: a.conn.jellyfinUserId } });
        } catch (e) {
          // Servers older than Jellyfin 10.9 only have the per-user route.
          if (!(e instanceof JellyfinError && e.kind === "not_found")) throw e;
          await jfJson(a.jf, method, `/Users/${a.conn.jellyfinUserId}/FavoriteItems/${id}`);
        }
      }

      for (const [method, on] of [["PUT", true], ["DELETE", false]] as const) {
        app.route<{ Params: { id: string } }>({
          method,
          url: "/api/jellyfin/favourites/:id",
          preHandler: requireUser,
          handler: (req, reply) => {
            const id = idParam(reply, req.params.id);
            if (!id) return reply;
            return authed(req, reply, async (a) => {
              await setFavourite(a, id, on);
              return reply.code(204).send();
            });
          },
        });
      }

      // ---- matching AI picks to library tracks ------------------------------------

      app.post<{ Body: JellyfinMatchRequest }>("/api/jellyfin/match", { preHandler: requireUser }, (req, reply) => {
        const picks = req.body?.picks;
        if (
          !Array.isArray(picks) ||
          picks.length > MAX_PICKS ||
          !picks.every((p) => p && typeof p.artist === "string" && typeof p.title === "string" && p.artist.length <= 300 && p.title.length <= 300)
        ) {
          return reply.code(400).send({ error: "invalid_picks", message: `Send up to ${MAX_PICKS} picks with an artist and a title` });
        }
        return authed(req, reply, async (a): Promise<JellyfinMatchResponse> => {
          const find = async (pick: { artist: string; title: string }): Promise<JellyfinTrack | null> => {
            if (!pick.title.trim() || !pick.artist.trim()) return null;
            const choose = (tracks: JellyfinTrack[]): JellyfinTrack | null => {
              const i = pickBest(pick, tracks);
              return i >= 0 ? tracks[i] : null;
            };
            // First by title. Jellyfin's search is a substring match on the name, so punctuation
            // ("D.A.N.C.E.") can hide a song; then look through the artist's tracks instead.
            const byTitle = await listTracks(a, {
              userId: a.conn.jellyfinUserId,
              IncludeItemTypes: "Audio",
              Recursive: true,
              SearchTerm: searchTitle(pick.title).slice(0, 200),
              Limit: 50,
            });
            const hit = choose(byTitle.items);
            if (hit) return hit;
            const artist = pick.artist.split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)[0]?.trim().replace(/\|/g, " ");
            if (!artist) return null;
            const byArtist = await listTracks(a, {
              userId: a.conn.jellyfinUserId,
              IncludeItemTypes: "Audio",
              Recursive: true,
              Artists: artist.slice(0, 200),
              Limit: 300,
            });
            return choose(byArtist.items);
          };
          return { matches: await mapLimit(picks, MATCH_CONCURRENCY, find) };
        });
      });

      // ---- taste profile for the AI DJ --------------------------------------------

      app.get("/api/jellyfin/taste", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a): Promise<JellyfinTasteResponse> => {
          const uid = a.conn.jellyfinUserId;
          const artists = (query: Query) =>
            jfJson<JfItemsResponse>(a.jf, "GET", "/Artists", {
              query: { userId: uid, Fields: "Genres", EnableTotalRecordCount: false, ...query },
            }).then((d) => d?.Items ?? []);
          const tracks = (query: Query) =>
            listTracks(a, {
              userId: uid,
              IncludeItemTypes: "Audio",
              Recursive: true,
              EnableTotalRecordCount: false,
              ...query,
            }).then((d) => d.items);

          const [playedArtists, favouriteArtists, topTracks, recentTracks, favouriteTracks] = await Promise.all([
            artists({ SortBy: "PlayCount", SortOrder: "Descending", Limit: TASTE_ARTISTS }),
            artists({ Filters: "IsFavorite", Limit: TASTE_ARTISTS }),
            tracks({ Filters: "IsPlayed", SortBy: "PlayCount", SortOrder: "Descending", Limit: TASTE_TRACKS }),
            tracks({ Filters: "IsPlayed", SortBy: "DatePlayed", SortOrder: "Descending", Limit: TASTE_TRACKS }),
            tracks({ Filters: "IsFavorite", Limit: TASTE_TRACKS }),
          ]);

          // Artists the person plays most, then the artists of their most played songs (Jellyfin
          // doesn't always roll plays up to the artist), then their favourite artists.
          const known = new Map<string, JfItem>();
          for (const x of [...playedArtists, ...favouriteArtists]) if (x.Name) known.set(x.Name.toLowerCase(), x);
          let artistNames = [
            ...new Set(
              [
                ...playedArtists.filter((x) => (x.UserData?.PlayCount ?? 0) > 0).map((x) => x.Name),
                ...topTracks.flatMap((t) => t.artists),
                ...favouriteArtists.map((x) => x.Name),
                ...recentTracks.flatMap((t) => t.artists),
              ].filter((n): n is string => !!n),
            ),
          ];
          let topLines = topTracks.map(line);
          const recentLines = recentTracks.map(line);
          if (topLines.length === 0) topLines = favouriteTracks.map(line);

          // A new Jellyfin has no plays or favourites yet: describe the library instead, so the DJ still works.
          if (artistNames.length === 0 || topLines.length === 0) {
            const [sampleArtists, sampleTracks] = await Promise.all([
              artists({ SortBy: "Random", Limit: TASTE_ARTISTS }),
              tracks({ SortBy: "Random", Limit: TASTE_TRACKS }),
            ]);
            for (const x of sampleArtists) if (x.Name) known.set(x.Name.toLowerCase(), x);
            if (artistNames.length === 0) artistNames = sampleArtists.map((x) => x.Name).filter((n): n is string => !!n);
            if (topLines.length === 0) topLines = sampleTracks.map(line);
          }
          artistNames = artistNames.slice(0, TASTE_ARTISTS);

          // Genres of the leading artists. Look up the ones the lists above didn't carry.
          const leading = artistNames.slice(0, 8);
          await Promise.all(
            leading
              .filter((n) => !known.has(n.toLowerCase()))
              .map(async (name) => {
                const found = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", {
                  query: { userId: uid, IncludeItemTypes: "MusicArtist", Recursive: true, SearchTerm: name.slice(0, 200), Fields: "Genres", Limit: 5, EnableTotalRecordCount: false },
                });
                const hit = found?.Items?.find((x) => x.Name?.toLowerCase() === name.toLowerCase());
                if (hit) known.set(name.toLowerCase(), hit);
              }),
          );
          // Most common first; earlier artists weigh a little more.
          const weight = new Map<string, number>();
          leading.forEach((name, i) => {
            for (const g of known.get(name.toLowerCase())?.Genres ?? []) {
              if (typeof g === "string" && g.trim()) weight.set(g.trim(), (weight.get(g.trim()) ?? 0) + 1 + 1 / (i + 2));
            }
          });
          const genres = [...weight.entries()].sort((x, y) => y[1] - x[1]).slice(0, TASTE_GENRES).map(([g]) => g.slice(0, 200));

          return {
            topArtists: artistNames.map((n) => n.slice(0, 200)),
            genres,
            topTracks: topLines,
            recentTracks: recentLines,
          };
        }),
      );

      // ---- streaming and cover art (signed URLs, no bearer token) -------------------

      app.get<{ Params: { id: string } }>("/api/jellyfin/tracks/:id/stream-url", { preHandler: requireUser }, (req, reply) => {
        const id = idParam(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a): Promise<JellyfinStreamUrlResponse | FastifyReply> => {
          // Also proves the track exists for this person and their sign-in still works.
          const data = await jfJson<JfItemsResponse>(a.jf, "GET", "/Items", {
            query: { userId: a.conn.jellyfinUserId, Ids: id, IncludeItemTypes: "Audio", Limit: 1, EnableTotalRecordCount: false },
          });
          if (!data?.Items?.length) return reply.code(404).send({ error: "not_found" });
          const expiresAt = nowSec() + STREAM_TTL_SEC;
          return { path: signedPath(secret, "stream", a.userId, id, expiresAt), expiresAt };
        });
      });

      /** Sends the upstream body to the client without buffering, and cancels upstream when the client leaves. */
      async function proxy(
        req: FastifyRequest,
        reply: FastifyReply,
        userId: number,
        path: string,
        query: Query,
        opts: { accept: RegExp; cache: string; range?: string },
      ) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const conn = connectionFor(userId, base);
        if (!conn) return reply.code(401).send(EXPIRED);
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        let res: Response;
        try {
          res = await jfStream(jf(base, conn), path, {
            query,
            headers: { ...(opts.range ? { Range: opts.range } : {}), Accept: "*/*" },
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
          store.deleteIfToken(userId, conn.tokenEnc);
          return reply.code(401).send(EXPIRED);
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
        if ((status !== 200 && status !== 206) || !res.body || !opts.accept.test(type)) {
          drop();
          req.log.warn({ status, type }, "Jellyfin returned something unplayable");
          return reply.code(502).send({ error: "jellyfin_failed", message: "Jellyfin returned an unexpected answer" });
        }

        reply.code(status).header("Content-Type", type).header("Cache-Control", opts.cache);
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          const value = res.headers.get(name);
          if (value && /^[\w ,*/=-]{1,100}$/.test(value)) reply.header(name, value);
        }
        const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
        const guard = new IdleGuard(idleMs, () => guard.destroy(new Error("Jellyfin stopped sending data")));
        // Closing either end tears the whole chain down, including the request to Jellyfin.
        pipeline(source, guard, () => {
          if (!source.readableEnded) ac.abort();
        });
        return reply.send(guard);
      }

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string } }>(
        "/api/jellyfin/stream/:id",
        async (req, reply) => {
          const id = idParam(reply, req.params.id);
          if (!id) return reply;
          const userId = verifySigned(secret, "stream", id, req.query, nowSec());
          if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
          const base = baseUrl();
          const conn = base ? connectionFor(userId, base) : null;
          if (!conn) return reply.code(401).send(EXPIRED);
          const range = req.headers.range?.trim();
          return proxy(
            req,
            reply,
            userId,
            `/Audio/${id}/universal`,
            {
              userId: conn.jellyfinUserId,
              deviceId: conn.deviceId,
              container: DIRECT_CONTAINERS,
              audioCodec: DIRECT_CODECS,
              transcodingContainer: TRANSCODE_CONTAINER,
              transcodingProtocol: "http",
              enableRedirection: false,
            },
            { accept: AUDIO_TYPE, cache: "private, max-age=3600", range: range && SINGLE_RANGE.test(range) ? range : undefined },
          );
        },
      );

      app.get<{ Params: { id: string }; Querystring: { u?: string; exp?: string; sig?: string; w?: string } }>(
        "/api/jellyfin/image/:id",
        async (req, reply) => {
          const id = idParam(reply, req.params.id);
          if (!id) return reply;
          const userId = verifySigned(secret, "image", id, req.query, nowSec());
          if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
          return proxy(
            req,
            reply,
            userId,
            `/Items/${id}/Images/Primary`,
            { maxWidth: clampInt(req.query.w, DEFAULT_IMAGE_WIDTH, 16, MAX_IMAGE_WIDTH), quality: 90 },
            { accept: IMAGE_TYPE, cache: "private, max-age=604800" },
          );
        },
      );

      // ---- reporting plays back to Jellyfin -------------------------------------------

      const PLAYBACK_PATHS = { start: "/Sessions/Playing", progress: "/Sessions/Playing/Progress", stop: "/Sessions/Playing/Stopped" } as const;

      app.post<{ Body: JellyfinPlaybackReport }>("/api/jellyfin/playback", { preHandler: requireUser }, (req, reply) => {
        const b = req.body;
        if (
          !b ||
          !Object.hasOwn(PLAYBACK_PATHS, b.event) ||
          !validId(b.itemId) ||
          typeof b.positionSec !== "number" ||
          !Number.isFinite(b.positionSec) ||
          b.positionSec < 0
        ) {
          return reply.code(400).send({ error: "invalid_report" });
        }
        const itemId = b.itemId.toLowerCase();
        const ticks = secToTicks(Math.min(b.positionSec, 7 * 24 * 3600));
        return authed(req, reply, async (a) => {
          const body = {
            ItemId: itemId,
            MediaSourceId: itemId,
            PositionTicks: ticks,
            CanSeek: true,
            PlayMethod: "DirectStream",
            ...(b.event === "stop" ? {} : { IsPaused: false }),
          };
          try {
            await jfJson(a.jf, "POST", PLAYBACK_PATHS[b.event], { body });
          } catch (e) {
            // Reporting is best effort, except that a dead sign-in should surface so the app can ask again.
            if (e instanceof JellyfinError && e.kind === "unauthorized") throw e;
            req.log.debug({ event: b.event }, "Jellyfin playback report failed");
          }
          return reply.code(204).send();
        });
      });

      // ---- admin: where Jellyfin is ---------------------------------------------------

      app.get("/api/admin/jellyfin", { preHandler: requireAdmin }, async (): Promise<AdminJellyfinResponse> => settings.jellyfin());

      app.put<{ Body: { serverUrl?: string | null } }>("/api/admin/jellyfin", { preHandler: requireAdmin }, async (req, reply) => {
        if (ctx.config.jellyfinUrl) {
          return reply.code(409).send({ error: "set_by_environment", message: "JELLYFIN_URL is set on the server and takes precedence" });
        }
        const raw = req.body?.serverUrl;
        if (raw !== null && typeof raw !== "string") return reply.code(400).send({ error: "invalid_url" });
        let url: string | null = null;
        if (typeof raw === "string" && raw.trim()) {
          try {
            url = parseJellyfinUrl(raw);
          } catch (e) {
            return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
          }
        }
        settings.setSavedJellyfinUrl(url);
        req.log.info({ admin: req.user!.username, configured: url !== null }, "admin changed the Jellyfin address");
        return settings.jellyfin() satisfies AdminJellyfinResponse;
      });

      // Only an admin supplies the address to check, and nothing is stored.
      app.post<{ Body: { serverUrl?: string } }>("/api/admin/jellyfin/test", { preHandler: requireAdmin }, async (req, reply) => {
        let url: string;
        try {
          url = parseJellyfinUrl(typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "");
        } catch (e) {
          return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
        }
        try {
          const info = await jfJson<{ ServerName?: unknown; Version?: unknown; Id?: unknown }>(
            { baseUrl: url, deviceId: "cadence-test", fetchFn: options.fetchFn },
            "GET",
            "/System/Info/Public",
          );
          if (typeof info?.Version !== "string" || typeof info?.Id !== "string") {
            return { ok: false, error: "That address answered, but it doesn't look like Jellyfin." } satisfies AdminJellyfinTestResponse;
          }
          return {
            ok: true,
            ...(typeof info.ServerName === "string" ? { serverName: info.ServerName.slice(0, 200) } : {}),
            version: info.Version.slice(0, 50),
          } satisfies AdminJellyfinTestResponse;
        } catch (e) {
          const kind = e instanceof JellyfinError ? e.kind : "unreachable";
          const error =
            kind === "redirect"
              ? "That address redirects somewhere else. Use the address it redirects to."
              : kind === "timeout"
                ? "That address took too long to answer."
                : kind === "unreachable"
                  ? "Couldn't reach that address from the server."
                  : "That address answered, but it doesn't look like Jellyfin.";
          return { ok: false, error } satisfies AdminJellyfinTestResponse;
        }
      });
    },
  };
}

export const jellyfinPlugin: ServerPlugin = createJellyfinPlugin();
