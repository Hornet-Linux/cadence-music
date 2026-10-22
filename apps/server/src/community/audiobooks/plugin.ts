import type { FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { clampInt, clean, TtlCache, term } from "../_sourcekit/common.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { proxyResponse, singleRange } from "../_sourcekit/proxy.js";
import { nowSec, signedQuery, verifySigned, type SignedParams } from "../_sourcekit/signing.js";
import { AbsClient, AbsError, ConnectionStore, parseAbsUrl, validId, type AbsCall, type Connection } from "./client.js";

const ID = "cadence.audiobooks";
const STREAM_TTL_SEC = 12 * 60 * 60;
const IMAGE_TTL_DAYS = 30;
const AUDIO_TYPE = /^(audio\/[\w.+-]+|application\/(ogg|octet-stream)|video\/mp4)$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif)$/i;
const LOGIN_WINDOW_MS = 15 * 60_000;

export interface AudiobooksOptions {
  /** Address policy for the (owner-configured) Audiobookshelf server. Defaults to allowing the local network. */
  policy?: NetPolicy;
  streamIdleMs?: number;
  headerTimeoutMs?: number;
}

const NOT_CONFIGURED = { error: "audiobooks_not_configured", message: "Audiobookshelf isn't set up on this server" };
const NOT_CONNECTED = { error: "audiobooks_not_connected", message: "Sign in to Audiobookshelf first" };
const EXPIRED = { error: "audiobooks_session_expired", message: "Your Audiobookshelf sign-in expired. Sign in again." };

function publicFailure(e: AbsError): { error: string; message: string } {
  if (e.kind === "timeout") return { error: "audiobooks_failed", message: "Audiobookshelf took too long to answer" };
  if (e.kind === "unreachable" || e.kind === "redirect") return { error: "audiobooks_failed", message: "Audiobookshelf couldn't be reached. Ask the server owner to check it." };
  return { error: "audiobooks_failed", message: "Audiobookshelf returned an unexpected answer" };
}

interface AbsMeta {
  title?: string;
  subtitle?: string;
  authorName?: string;
  authors?: { name?: string }[];
  narratorName?: string;
  narrators?: string[];
  seriesName?: string;
  series?: { name?: string; sequence?: string }[];
  description?: string;
  publishedYear?: string;
}
interface AbsItem {
  id?: string;
  libraryId?: string;
  media?: { metadata?: AbsMeta; duration?: number; chapters?: { id?: number; start?: number; end?: number; title?: string }[] };
  userMediaProgress?: AbsProgress;
}
interface AbsProgress {
  libraryItemId?: string;
  currentTime?: number;
  duration?: number;
  progress?: number;
  isFinished?: boolean;
  lastUpdate?: number;
}
interface AbsPlay {
  id?: string;
  duration?: number;
  startTime?: number;
  currentTime?: number;
  audioTracks?: { index?: number; startOffset?: number; duration?: number; contentUrl?: string; mimeType?: string; title?: string }[];
  chapters?: { id?: number; start?: number; end?: number; title?: string }[];
}

const num = (v: unknown, max = 1e9): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);

/**
 * Audiobookshelf as an audiobook source. The server signs in to the owner's Audiobookshelf as each person (their own
 * account), calls the official API for them, reports their listening position back, and proxies audio and covers, so
 * apps never talk to Audiobookshelf and its tokens never leave the server. Only the server owner sets the address.
 */
export function createAudiobooksPlugin(options: AudiobooksOptions = {}): ServerPlugin {
  return {
    id: ID,
    name: "Audiobookshelf",
    version: "1.0.0",
    register(app, ctx) {
      const { secret, settings, requireUser, requireAdmin } = ctx;
      const store = new ConnectionStore(ctx.db, secret);
      const abs = new AbsClient(options.policy ?? {});
      const headerMs = options.headerTimeoutMs ?? 20_000;
      const idleMs = options.streamIdleMs ?? 30_000;
      const perUser = new RateLimiter({ max: 5, windowMs: LOGIN_WINDOW_MS });
      const perAddress = new RateLimiter({ max: 20, windowMs: LOGIN_WINDOW_MS });
      /** Open play sessions: we need the track addresses to stream them. They live as long as Audiobookshelf keeps them. */
      const sessions = new TtlCache<{ userId: number; itemId: string; tracks: { contentUrl: string }[] }>(24 * 3600_000, 500);

      const baseUrl = (): string | null => settings.pluginConfig<{ serverUrl?: string }>(ID)?.serverUrl ?? null;

      function connectionFor(userId: number, base: string): Connection | null {
        const c = store.get(userId);
        if (!c) return null;
        if (c.serverUrl !== base) {
          store.delete(userId);
          return null;
        }
        return c;
      }

      const imagePath = (userId: number, itemId: string): string => {
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return `api/audiobooks/cover/${itemId}?${signedQuery(secret, "abs-cover", userId, itemId, exp)}`;
      };

      interface Authed {
        call: (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", path: string, extra?: Partial<AbsCall>) => Promise<unknown>;
        conn: Connection;
        userId: number;
      }

      /** Calls Audiobookshelf as the person; an expired access token is renewed once with their refresh token. */
      function makeAuthed(base: string, conn: Connection): Authed {
        let current = conn;
        const call = async (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", path: string, extra: Partial<AbsCall> = {}): Promise<unknown> => {
          try {
            return await abs.json({ base, token: current.token, ...extra }, method, path);
          } catch (e) {
            if (!(e instanceof AbsError) || e.kind !== "unauthorized" || !current.refreshToken) throw e;
            const fresh = await abs
              .json<{ user?: { accessToken?: string; token?: string; refreshToken?: string } }>({ base, headers: { "x-refresh-token": current.refreshToken } }, "POST", "/auth/refresh")
              .catch(() => null);
            const token = fresh?.user?.accessToken ?? fresh?.user?.token;
            if (!token) throw e;
            current = { ...current, token, refreshToken: fresh?.user?.refreshToken ?? current.refreshToken };
            store.save(current);
            return await abs.json({ base, token: current.token, ...extra }, method, path);
          }
        };
        return { call, conn, userId: conn.userId };
      }

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown, conn?: Connection) {
        if (e instanceof AbsError) {
          if (e.kind === "unauthorized") {
            if (conn) store.deleteIfToken(conn.userId, conn.tokenEnc);
            return reply.code(409).send(EXPIRED);
          }
          if (e.kind === "not_found") return reply.code(404).send({ error: "not_found" });
          req.log.warn({ kind: e.kind, status: e.status }, "Audiobookshelf call failed");
          return reply.code(502).send(publicFailure(e));
        }
        req.log.error({ err: e }, "audiobooks handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      async function authed(req: FastifyRequest, reply: FastifyReply, fn: (a: Authed) => Promise<unknown>) {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const conn = connectionFor(req.user!.id, base);
        if (!conn) return reply.code(409).send(NOT_CONNECTED);
        try {
          return await fn(makeAuthed(base, conn));
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      }

      const idOr400 = (reply: FastifyReply, id: string): string | null => {
        if (validId(id)) return id;
        void reply.code(400).send({ error: "invalid_id" });
        return null;
      };

      // ---- mapping ---------------------------------------------------------------------

      function bookOut(userId: number, it: AbsItem, progress?: AbsProgress) {
        const m = it.media?.metadata ?? {};
        const author = m.authorName ?? (m.authors ?? []).map((a) => a.name).filter(Boolean).join(", ");
        const narrator = m.narratorName ?? (m.narrators ?? []).join(", ");
        const series = m.seriesName ?? (m.series?.[0]?.name ? `${m.series[0].name}${m.series[0].sequence ? ` #${m.series[0].sequence}` : ""}` : "");
        const p = progress ?? it.userMediaProgress;
        const duration = num(it.media?.duration);
        return {
          id: it.id!,
          libraryId: it.libraryId,
          title: clean(m.title, 300) || "Untitled",
          subtitle: clean(m.subtitle, 300) || undefined,
          author: clean(author, 300) || undefined,
          narrator: clean(narrator, 300) || undefined,
          series: clean(series, 200) || undefined,
          durationSec: duration,
          cover: imagePath(userId, it.id!),
          ...(p ? { progress: { currentTime: num(p.currentTime), progress: num(p.progress, 1), isFinished: !!p.isFinished, lastUpdate: num(p.lastUpdate) } } : {}),
        };
      }

      const chaptersOut = (list: { start?: number; end?: number; title?: string }[] | undefined) =>
        (list ?? []).slice(0, 2000).map((c, i) => ({ index: i, start: num(c.start), end: num(c.end), title: clean(c.title, 200) || `Chapter ${i + 1}` }));

      async function meProgress(a: Authed): Promise<{ progress: Map<string, AbsProgress>; bookmarks: { libraryItemId?: string; time?: number; title?: string; createdAt?: number }[] }> {
        const me = (await a.call("GET", "/api/me")) as { mediaProgress?: AbsProgress[]; bookmarks?: { libraryItemId?: string; time?: number; title?: string; createdAt?: number }[] } | undefined;
        return { progress: new Map((me?.mediaProgress ?? []).filter((p) => p.libraryItemId).map((p) => [p.libraryItemId!, p])), bookmarks: me?.bookmarks ?? [] };
      }

      // ---- status and sign-in ---------------------------------------------------------------

      app.get("/api/audiobooks/status", { preHandler: requireUser }, async (req) => {
        const base = baseUrl();
        if (!base) return { configured: false, connected: false };
        const c = connectionFor(req.user!.id, base);
        return c ? { configured: true, connected: true, userName: c.userName } : { configured: true, connected: false };
      });

      app.put<{ Body: { username?: string; password?: string } }>("/api/audiobooks/connection", { preHandler: requireUser }, async (req, reply) => {
        const base = baseUrl();
        if (!base) return reply.code(409).send(NOT_CONFIGURED);
        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const password = req.body?.password;
        if (!username || username.length > 256 || typeof password !== "string" || !password || password.length > 1024) return reply.code(400).send({ error: "invalid_request" });
        const userId = req.user!.id;
        const userKey = `user:${userId}`;
        const addressKey = `ip:${req.ip}`;
        if (perUser.isLimited(userKey) || perAddress.isLimited(addressKey)) return reply.code(429).send({ error: "rate_limited", message: "Too many sign-in attempts. Try again later." });
        let login: { user?: { id?: string; username?: string; token?: string; accessToken?: string; refreshToken?: string } };
        try {
          login = (await abs.json({ base, body: { username, password }, headers: { "x-return-tokens": "true" } }, "POST", "/login")) as typeof login;
        } catch (e) {
          if (e instanceof AbsError && (e.kind === "unauthorized" || e.status === 400)) {
            perUser.hit(userKey);
            perAddress.hit(addressKey);
            return reply.code(401).send({ error: "audiobooks_invalid_credentials", message: "Audiobookshelf didn't accept that user name and password" });
          }
          if (e instanceof AbsError) {
            req.log.warn({ kind: e.kind, status: e.status }, "Audiobookshelf sign-in failed");
            return reply.code(502).send(publicFailure(e));
          }
          throw e;
        }
        const user = login?.user;
        const token = user?.accessToken ?? user?.token;
        if (typeof token !== "string" || !token || typeof user?.id !== "string") return reply.code(502).send({ error: "audiobooks_failed", message: "Audiobookshelf returned an unexpected answer" });
        store.save({
          userId,
          absUserId: user.id.slice(0, 100),
          userName: clean(user.username, 200) || username,
          serverUrl: base,
          token,
          refreshToken: typeof user.refreshToken === "string" ? user.refreshToken : null,
        });
        perUser.reset(userKey);
        return { configured: true, connected: true, userName: clean(user.username, 200) || username };
      });

      app.delete("/api/audiobooks/connection", { preHandler: requireUser }, async (req, reply) => {
        store.delete(req.user!.id);
        return reply.code(204).send();
      });

      // ---- browsing --------------------------------------------------------------------------

      app.get("/api/audiobooks/libraries", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const res = (await a.call("GET", "/api/libraries")) as { libraries?: { id?: string; name?: string; mediaType?: string }[] } | undefined;
          return {
            items: (res?.libraries ?? [])
              .filter((l) => validId(l.id) && l.mediaType === "book")
              .map((l) => ({ id: l.id!, name: clean(l.name, 100) || "Library" })),
          };
        }),
      );

      app.get<{ Params: { id: string }; Querystring: { q?: string; page?: string; limit?: string; sort?: string } }>("/api/audiobooks/libraries/:id/items", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => {
          const limit = clampInt(req.query.limit, 40, 1, 100);
          const page = clampInt(req.query.page, 0, 0, 10_000);
          const q = term(req.query.q, 100);
          const { progress } = await meProgress(a);
          if (q) {
            const res = (await a.call("GET", `/api/libraries/${id}/search`, { query: { q, limit } })) as { book?: { libraryItem?: AbsItem }[] } | undefined;
            const items = (res?.book ?? []).map((b) => b.libraryItem).filter((x): x is AbsItem => !!x && validId(x.id));
            return { items: items.map((x) => bookOut(a.userId, x, progress.get(x.id!))), total: items.length, page: 0 };
          }
          const sort = { title: "media.metadata.title", added: "addedAt", author: "media.metadata.authorName" }[req.query.sort ?? ""] ?? "media.metadata.title";
          const res = (await a.call("GET", `/api/libraries/${id}/items`, { query: { limit, page, sort, desc: sort === "addedAt" ? 1 : 0, minified: 1 } })) as { results?: AbsItem[]; total?: number } | undefined;
          const items = (res?.results ?? []).filter((x) => validId(x.id));
          return { items: items.map((x) => bookOut(a.userId, x, progress.get(x.id!))), total: num(res?.total) || items.length, page };
        });
      });

      app.get("/api/audiobooks/continue", { preHandler: requireUser }, (req, reply) =>
        authed(req, reply, async (a) => {
          const res = (await a.call("GET", "/api/me/items-in-progress")) as { libraryItems?: AbsItem[] } | undefined;
          const { progress } = await meProgress(a);
          const items = (res?.libraryItems ?? []).filter((x) => validId(x.id)).slice(0, 50);
          return { items: items.map((x) => bookOut(a.userId, x, progress.get(x.id!))) };
        }),
      );

      app.get<{ Params: { id: string } }>("/api/audiobooks/items/:id", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => {
          const item = (await a.call("GET", `/api/items/${id}`, { query: { expanded: 1, include: "progress" } })) as AbsItem | undefined;
          if (!item || !validId(item.id)) throw new AbsError("not_found", 404);
          const { progress } = await meProgress(a);
          return {
            ...bookOut(a.userId, item, progress.get(id) ?? item.userMediaProgress),
            description: clean(item.media?.metadata?.description, 4000).replace(/<[^>]*>/g, "") || undefined,
            year: clean(item.media?.metadata?.publishedYear, 10) || undefined,
            chapters: chaptersOut(item.media?.chapters),
          };
        });
      });

      // ---- playing, progress and bookmarks ---------------------------------------------------

      app.post<{ Params: { id: string } }>("/api/audiobooks/items/:id/play", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => {
          const s = (await a.call("POST", `/api/items/${id}/play`, {
            body: { deviceInfo: { clientName: "Cadence", deviceId: `cadence-${a.userId}` }, forceDirectPlay: true, forceTranscode: false, supportedMimeTypes: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/flac", "audio/x-m4b", "audio/webm"], mediaPlayer: "html5" },
          })) as AbsPlay | undefined;
          const tracks = (s?.audioTracks ?? []).filter((t) => typeof t.contentUrl === "string" && t.contentUrl.startsWith("/") && !t.contentUrl.startsWith("//"));
          if (!s || !validId(s.id) || tracks.length === 0) throw new AbsError("bad_response");
          sessions.set(s.id, { userId: a.userId, itemId: id, tracks: tracks.map((t) => ({ contentUrl: t.contentUrl! })) });
          const exp = nowSec() + STREAM_TTL_SEC;
          return {
            sessionId: s.id,
            durationSec: num(s.duration),
            startTime: num(s.currentTime ?? s.startTime),
            chapters: chaptersOut(s.chapters),
            tracks: tracks.map((t, i) => ({
              index: i,
              startOffset: num(t.startOffset),
              durationSec: num(t.duration),
              mimeType: clean(t.mimeType, 60),
              path: `api/audiobooks/stream/${s.id}/${i}?${signedQuery(secret, "abs-stream", a.userId, `${s.id}/${i}`, exp)}`,
            })),
          };
        });
      });

      for (const kind of ["sync", "close"] as const) {
        app.post<{ Params: { sid: string }; Body: { currentTime?: number; timeListened?: number; duration?: number; itemId?: string } }>(
          `/api/audiobooks/sessions/:sid/${kind}`,
          { preHandler: requireUser },
          (req, reply) => {
            const sid = idOr400(reply, req.params.sid);
            if (!sid) return reply;
            const b = req.body ?? {};
            const currentTime = Number(b.currentTime);
            if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > 1e7) return reply.code(400).send({ error: "invalid_position" });
            return authed(req, reply, async (a) => {
              const open = sessions.get(sid);
              if (open && open.userId !== a.userId) return reply.code(404).send({ error: "not_found" });
              const body = { currentTime, timeListened: Math.max(0, Math.min(Number(b.timeListened) || 0, 3600)), duration: num(b.duration) || undefined };
              try {
                await a.call("POST", `/api/session/${sid}/${kind}`, { body });
              } catch (e) {
                // The session is gone on the Audiobookshelf side (it restarted or timed out): save the position directly.
                const itemId = open?.itemId ?? (validId(b.itemId) ? b.itemId : null);
                if (e instanceof AbsError && e.kind === "not_found" && itemId) {
                  await a.call("PATCH", `/api/me/progress/${itemId}`, { body: { currentTime, ...(body.duration ? { duration: body.duration, progress: Math.min(1, currentTime / body.duration) } : {}) } });
                } else throw e;
              }
              if (kind === "close") sessions.delete(sid);
              return reply.code(204).send();
            });
          },
        );
      }

      app.put<{ Params: { id: string }; Body: { currentTime?: number; duration?: number; isFinished?: boolean } }>("/api/audiobooks/items/:id/progress", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        const b = req.body ?? {};
        const currentTime = Number(b.currentTime);
        if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > 1e7) return reply.code(400).send({ error: "invalid_position" });
        return authed(req, reply, async (a) => {
          const duration = num(b.duration);
          await a.call("PATCH", `/api/me/progress/${id}`, {
            body: { currentTime, ...(duration ? { duration, progress: Math.min(1, currentTime / duration) } : {}), ...(typeof b.isFinished === "boolean" ? { isFinished: b.isFinished } : {}) },
          });
          return reply.code(204).send();
        });
      });

      app.get<{ Params: { id: string } }>("/api/audiobooks/items/:id/bookmarks", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        return authed(req, reply, async (a) => {
          const { bookmarks } = await meProgress(a);
          return { items: bookmarks.filter((b) => b.libraryItemId === id && typeof b.time === "number").map((b) => ({ time: num(b.time), title: clean(b.title, 200), createdAt: num(b.createdAt) })).sort((x, y) => x.time - y.time) };
        });
      });

      app.post<{ Params: { id: string }; Body: { time?: number; title?: string } }>("/api/audiobooks/items/:id/bookmarks", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        const time = Number(req.body?.time);
        const title = clean(req.body?.title, 200);
        if (!Number.isFinite(time) || time < 0 || time > 1e7 || !title) return reply.code(400).send({ error: "invalid_request" });
        return authed(req, reply, async (a) => {
          await a.call("POST", `/api/me/item/${id}/bookmark`, { body: { time: Math.floor(time), title } });
          return reply.code(201).send({ time: Math.floor(time), title });
        });
      });

      app.delete<{ Params: { id: string; time: string } }>("/api/audiobooks/items/:id/bookmarks/:time", { preHandler: requireUser }, (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        if (!/^\d{1,9}$/.test(req.params.time)) return reply.code(400).send({ error: "invalid_request" });
        return authed(req, reply, async (a) => {
          await a.call("DELETE", `/api/me/item/${id}/bookmark/${req.params.time}`);
          return reply.code(204).send();
        });
      });

      // ---- audio and covers (signed URLs) -------------------------------------------------------

      app.get<{ Params: { sid: string; index: string }; Querystring: SignedParams }>("/api/audiobooks/stream/:sid/:index", async (req, reply) => {
        const { sid, index } = req.params;
        if (!validId(sid) || !/^\d{1,4}$/.test(index)) return reply.code(400).send({ error: "invalid_id" });
        const userId = verifySigned(secret, "abs-stream", `${sid}/${index}`, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const base = baseUrl();
        const conn = base ? connectionFor(userId, base) : null;
        if (!base || !conn) return reply.code(401).send(EXPIRED);
        const track = sessions.get(sid);
        const url = track && track.userId === userId ? track.tracks[Number(index)]?.contentUrl : undefined;
        if (!url) return reply.code(404).send({ error: "not_found", message: "This play session ended. Start playing again." });
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        const range = singleRange(req);
        try {
          const res = await abs.stream({ base, token: conn.token, signal: ac.signal, headers: range ? { Range: range } : undefined }, url, headerMs);
          if (res.status === 401) {
            res.abort();
            store.deleteIfToken(userId, conn.tokenEnc);
            return reply.code(401).send(EXPIRED);
          }
          return proxyResponse(req, reply, res, { accept: AUDIO_TYPE, cache: "private, max-age=3600", idleMs });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      });

      app.get<{ Params: { id: string }; Querystring: SignedParams }>("/api/audiobooks/cover/:id", async (req, reply) => {
        const id = idOr400(reply, req.params.id);
        if (!id) return reply;
        const userId = verifySigned(secret, "abs-cover", id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const base = baseUrl();
        const conn = base ? connectionFor(userId, base) : null;
        if (!base || !conn) return reply.code(401).send(EXPIRED);
        try {
          const res = await abs.stream({ base, token: conn.token, query: { width: 400, format: "jpeg" } }, `/api/items/${id}/cover`, headerMs);
          if (res.status === 401) {
            res.abort();
            return reply.code(401).send(EXPIRED);
          }
          return proxyResponse(req, reply, res, { accept: IMAGE_TYPE, cache: "private, max-age=86400", idleMs, extraHeaders: { "Content-Security-Policy": "default-src 'none'; sandbox" } });
        } catch (e) {
          return failure(req, reply, e, conn);
        }
      });

      // ---- admin: the server address --------------------------------------------------------------

      app.get("/api/audiobooks/admin", { preHandler: requireAdmin }, async () => ({ serverUrl: baseUrl() }));

      app.put<{ Body: { serverUrl?: string | null } }>("/api/audiobooks/admin", { preHandler: requireAdmin }, async (req, reply) => {
        const raw = req.body?.serverUrl;
        if (raw === null || raw === "") {
          settings.setPluginConfig(ID, null);
          return { serverUrl: null };
        }
        if (typeof raw !== "string") return reply.code(400).send({ error: "invalid_request" });
        try {
          const url = parseAbsUrl(raw);
          settings.setPluginConfig(ID, { serverUrl: url });
          return { serverUrl: url };
        } catch (e) {
          return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
        }
      });

      app.post<{ Body: { serverUrl?: string } }>("/api/audiobooks/admin/test", { preHandler: requireAdmin }, async (req, reply) => {
        let url: string;
        try {
          url = parseAbsUrl(typeof req.body?.serverUrl === "string" ? req.body.serverUrl : (baseUrl() ?? ""));
        } catch (e) {
          return reply.code(400).send({ error: "invalid_url", message: e instanceof Error ? e.message : "Invalid address" });
        }
        try {
          const res = (await abs.json({ base: url }, "GET", "/ping")) as { success?: boolean } | undefined;
          return res?.success ? { ok: true } : { ok: false, message: "That doesn't look like an Audiobookshelf server" };
        } catch (e) {
          return { ok: false, message: e instanceof AbsError ? publicFailure(e).message : "Couldn't reach it" };
        }
      });
    },
  };
}

export default createAudiobooksPlugin();