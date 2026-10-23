import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerPlugin } from "../../plugins/types.js";
import { open, seal } from "../../llm/secretBox.js";
import { b64, clampInt, clean, term, unb64 } from "../_sourcekit/common.js";
import { fetchJson, NetError, readBody, request } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { netFailureMessage, proxyResponse, singleRange } from "../_sourcekit/proxy.js";
import { nowSec, signedQuery, verifySigned, type SignedParams } from "../_sourcekit/signing.js";
import { envPolicy, envUrl } from "../_sourcekit/env.js";
import { searchDirectory } from "./directory.js";
import { buildOpml, NotAFeedError, parseOpml } from "./feed.js";
import { feedIdFor, ID16, ID20, migrate, normaliseFeedUrl, type EpisodeRow, type FeedRow, type ProgressRow, type SubRow } from "./schema.js";
import { FeedService } from "./service.js";

const ID = "cadence.podcasts";
const PURPOSE = "podcast-index-secret";
const MAX_SUBSCRIPTIONS = 300;
const MAX_OPML_FEEDS = 300;
const AUDIO_TTL_SEC = 6 * 60 * 60;
const IMAGE_TTL_DAYS = 30;
const REFRESH_EVERY_MS = 30 * 60_000;
const STREAM_TYPE = /^(audio\/[\w.+-]+|application\/ogg|application\/octet-stream|video\/(mp4|ogg|webm|x-m4v))$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif|bmp)$/i;

export interface PodcastOptions {
  policy?: NetPolicy;
  itunesBase?: string;
  podcastIndexBase?: string;
  streamIdleMs?: number;
  headerTimeoutMs?: number;
  refreshEveryMs?: number;
  /** Tests shorten the minimum time between fetches of one feed. */
  minRefetchMs?: number;
}

interface Admin {
  podcastIndexKey?: string;
  podcastIndexSecretEnc?: string;
}

export function createPodcastsPlugin(options: PodcastOptions = {}): ServerPlugin {
  return {
    id: ID,
    name: "Podcasts",
    version: "1.0.0",
    description:
      "Subscribe to podcasts by RSS or OPML, with new-episode refresh, chapters and per-person progress. Search uses the Podcast Index when you add its API key; feeds by address work without one.",
    configFields: [
      { key: "podcastIndexKey", label: "Podcast Index API key", type: "secret", help: "Optional. Free from api.podcastindex.org; enables podcast search." },
      { key: "podcastIndexSecretEnc", label: "Podcast Index API secret", type: "secret", sealed: true },
    ],
    configNote: "The API secret is stored encrypted: enter or replace it in the player under Settings > Plugins > Podcasts.",
    register(app, ctx) {
      const { db, secret, requireUser, requireAdmin, settings, jobs } = ctx;
      const policy: NetPolicy = options.policy ?? envPolicy();
      const headerMs = options.headerTimeoutMs ?? 15_000;
      const idleMs = options.streamIdleMs ?? 30_000;
      const itunesBase = (options.itunesBase ?? envUrl("CADENCE_ITUNES_URL") ?? "https://itunes.apple.com").replace(/\/+$/, "");
      const podcastIndexBase = (options.podcastIndexBase ?? "https://api.podcastindex.org").replace(/\/+$/, "");

      migrate(db);
      const feeds = new FeedService(db, policy, ctx.log, { headerTimeoutMs: headerMs, minRefetchMs: options.minRefetchMs });
      const feedOf = (id: string) => feeds.feedOf(id);

      // New episodes: every subscribed feed, a few at a time, backing off when one keeps failing.
      jobs.every("podcasts-refresh", options.refreshEveryMs ?? REFRESH_EVERY_MS, async () => void (await feeds.refreshMany(feeds.subscribedFeeds())), { runSoon: true });

      const imagePath = (userId: number, url: string | null | undefined): string | undefined => {
        if (!url) return undefined;
        const exp = (Math.floor(nowSec() / 86400) + IMAGE_TTL_DAYS + 1) * 86400;
        return `api/podcasts/image?t=${b64(url)}&${signedQuery(secret, "podcast-image", userId, url, exp)}`;
      };

      function failure(req: FastifyRequest, reply: FastifyReply, e: unknown) {
        if (e instanceof NotAFeedError) return reply.code(422).send({ error: "not_a_feed", message: "That address doesn't look like a podcast feed" });
        if (e instanceof NetError) {
          req.log.warn({ kind: e.kind, detail: e.message }, "podcast call failed");
          return reply.code(e.kind === "blocked" ? 400 : 502).send(netFailureMessage(e.kind));
        }
        req.log.error({ err: e }, "podcast handler failed");
        return reply.code(500).send({ error: "internal_error" });
      }

      const subCount = (userId: number): number => (db.prepare("SELECT COUNT(*) AS n FROM podcast_subs WHERE user_id = ?").get(userId) as { n: number }).n;
      const subOf = (userId: number, feedId: string): SubRow | undefined =>
        db.prepare("SELECT subscribed_at, speed, auto_queue FROM podcast_subs WHERE user_id = ? AND feed_id = ?").get(userId, feedId) as SubRow | undefined;
      const episodeRow = (id: string): EpisodeRow | undefined => db.prepare("SELECT * FROM podcast_episodes WHERE id = ?").get(id) as unknown as EpisodeRow | undefined;

      function feedOut(userId: number, f: FeedRow, sub?: SubRow) {
        const unplayed = sub
          ? (db
              .prepare(
                `SELECT COUNT(*) AS n FROM podcast_episodes e LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = ?
                 WHERE e.feed_id = ? AND COALESCE(p.played, 0) = 0`,
              )
              .get(userId, f.id) as { n: number }).n
          : undefined;
        return {
          id: f.id,
          title: f.title,
          author: f.author,
          description: f.description,
          link: f.link ?? undefined,
          image: imagePath(userId, f.image_url),
          language: f.language,
          subscribed: !!sub,
          ...(sub ? { speed: sub.speed, autoQueue: !!sub.auto_queue, unplayed } : {}),
        };
      }

      function episodeOut(userId: number, e: EpisodeRow, f?: Pick<FeedRow, "title" | "author" | "image_url">, p?: ProgressRow) {
        const progress = p ?? (db.prepare("SELECT position, duration, played, updated_at FROM podcast_progress WHERE user_id = ? AND episode_id = ?").get(userId, e.id) as ProgressRow | undefined);
        return {
          id: e.id,
          feedId: e.feed_id,
          title: e.title,
          description: e.description,
          durationSec: e.duration || progress?.duration || 0,
          publishedAt: e.published || null,
          season: e.season ?? undefined,
          episode: e.episode ?? undefined,
          hasChapters: !!e.chapters_url,
          image: imagePath(userId, e.image_url ?? f?.image_url),
          feedTitle: f?.title,
          author: f?.author,
          position: progress?.position ?? 0,
          played: !!progress?.played,
          progressAt: progress?.updated_at || null,
        };
      }

      const badId = (reply: FastifyReply, ok: boolean): boolean => {
        if (!ok) void reply.code(400).send({ error: "invalid_id" });
        return !ok;
      };

      // ---- admin: optional Podcast Index keys ---------------------------------------------

      const adminConfig = (): Admin => settings.pluginConfig<Admin>(ID) ?? {};
      const indexKeys = (): { key: string; secret: string } | null => {
        const c = adminConfig();
        const s = c.podcastIndexSecretEnc ? open(c.podcastIndexSecretEnc, secret, PURPOSE) : null;
        return c.podcastIndexKey && s ? { key: c.podcastIndexKey, secret: s } : null;
      };

      app.get("/api/podcasts/admin", { preHandler: requireAdmin }, async () => ({ podcastIndexConfigured: !!indexKeys(), podcastIndexKey: adminConfig().podcastIndexKey ?? null }));

      app.put<{ Body: { podcastIndexKey?: string | null; podcastIndexSecret?: string | null } }>("/api/podcasts/admin", { preHandler: requireAdmin }, async (req, reply) => {
        const b = req.body ?? {};
        if (b.podcastIndexKey === null || b.podcastIndexKey === "") {
          settings.setPluginConfig(ID, null);
          return { podcastIndexConfigured: false, podcastIndexKey: null };
        }
        const key = typeof b.podcastIndexKey === "string" ? b.podcastIndexKey.trim() : "";
        const sec = typeof b.podcastIndexSecret === "string" ? b.podcastIndexSecret.trim() : "";
        if (!/^[\w-]{4,64}$/.test(key) || sec.length < 8 || sec.length > 128 || /\s/.test(sec)) {
          return reply.code(400).send({ error: "invalid_request", message: "Enter both the Podcast Index API key and secret" });
        }
        settings.setPluginConfig(ID, { podcastIndexKey: key, podcastIndexSecretEnc: seal(sec, secret, PURPOSE) } satisfies Admin);
        return { podcastIndexConfigured: true, podcastIndexKey: key };
      });

      app.get("/api/podcasts/status", { preHandler: requireUser }, async () => ({ directory: indexKeys() ? "podcastindex" : "itunes" }));

      app.get<{ Querystring: { q?: string } }>("/api/podcasts/search", { preHandler: requireUser }, async (req, reply) => {
        const q = term(req.query.q, 100);
        const keys = indexKeys();
        if (!q) return { source: keys ? "podcastindex" : "itunes", items: [] };
        try {
          const { source, items } = await searchDirectory({ policy, itunesBase, podcastIndexBase, headerTimeoutMs: headerMs, keys }, q, 25);
          const userId = req.user!.id;
          const mine = new Set((db.prepare("SELECT f.url FROM podcast_subs s JOIN podcast_feeds f ON f.id = s.feed_id WHERE s.user_id = ?").all(userId) as { url: string }[]).map((r) => r.url));
          return { source, items: items.filter((i) => i.title).map((i) => ({ ...i, image: imagePath(userId, i.image), subscribed: mine.has(i.feedUrl) })) };
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      // ---- subscriptions ---------------------------------------------------------------------

      app.get("/api/podcasts/subscriptions", { preHandler: requireUser }, async (req) => {
        const userId = req.user!.id;
        const rows = db
          .prepare("SELECT f.*, s.subscribed_at, s.speed, s.auto_queue FROM podcast_subs s JOIN podcast_feeds f ON f.id = s.feed_id WHERE s.user_id = ? ORDER BY lower(f.title)")
          .all(userId) as unknown as (FeedRow & SubRow)[];
        return { items: rows.map((r) => feedOut(userId, r, r)) };
      });

      app.post<{ Body: { feedUrl?: string; preview?: boolean } }>("/api/podcasts/subscriptions", { preHandler: requireUser }, async (req, reply) => {
        const raw = typeof req.body?.feedUrl === "string" ? req.body.feedUrl : "";
        const url = normaliseFeedUrl(raw);
        if (!url) return reply.code(400).send({ error: "invalid_request", message: "Enter the address of a podcast feed" });
        const userId = req.user!.id;
        try {
          let row = feedOf(feedIdFor(url));
          if (!row || row.last_fetched === null) {
            const r = await feeds.fetch(url, row);
            if (r.kind === "feed") row = r.row;
          }
          if (!row) throw new NotAFeedError("empty");
          if (req.body.preview === true) return feedOut(userId, row, subOf(userId, row.id));
          const created = !subOf(userId, row.id);
          if (created) {
            if (subCount(userId) >= MAX_SUBSCRIPTIONS) return reply.code(409).send({ error: "too_many_subscriptions", message: "That's a lot of shows. Unsubscribe from some first." });
            db.prepare("INSERT INTO podcast_subs (user_id, feed_id, subscribed_at) VALUES (?, ?, ?)").run(userId, row.id, Date.now());
          }
          return reply.code(created ? 201 : 200).send(feedOut(userId, row, subOf(userId, row.id)));
        } catch (e) {
          return failure(req, reply, e);
        }
      });

      app.patch<{ Params: { id: string }; Body: { speed?: number; autoQueue?: boolean } }>("/api/podcasts/subscriptions/:id", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID16.test(req.params.id))) return reply;
        const userId = req.user!.id;
        if (!subOf(userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
        const { speed, autoQueue } = req.body ?? {};
        if (speed !== undefined) {
          if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 4) return reply.code(400).send({ error: "invalid_speed" });
          db.prepare("UPDATE podcast_subs SET speed = ? WHERE user_id = ? AND feed_id = ?").run(Math.round(speed * 100) / 100, userId, req.params.id);
        }
        if (autoQueue !== undefined) db.prepare("UPDATE podcast_subs SET auto_queue = ? WHERE user_id = ? AND feed_id = ?").run(autoQueue ? 1 : 0, userId, req.params.id);
        return feedOut(userId, feedOf(req.params.id)!, subOf(userId, req.params.id));
      });

      app.delete<{ Params: { id: string } }>("/api/podcasts/subscriptions/:id", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID16.test(req.params.id))) return reply;
        const userId = req.user!.id;
        db.prepare("DELETE FROM podcast_subs WHERE user_id = ? AND feed_id = ?").run(userId, req.params.id);
        db.prepare("DELETE FROM podcast_progress WHERE user_id = ? AND feed_id = ?").run(userId, req.params.id);
        return reply.code(204).send();
      });

      const lastManual = new Map<number, number>();
      app.post("/api/podcasts/refresh", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        if (Date.now() - (lastManual.get(userId) ?? 0) < 30_000) return reply.code(429).send({ error: "rate_limited", message: "Refreshed a moment ago. Try again shortly." });
        lastManual.set(userId, Date.now());
        const rows = db.prepare("SELECT f.* FROM podcast_subs s JOIN podcast_feeds f ON f.id = s.feed_id WHERE s.user_id = ?").all(userId) as unknown as FeedRow[];
        const added = await feeds.refreshMany(rows, true);
        return { feeds: rows.length, newEpisodes: added.reduce((a, b) => a + b, 0) };
      });

      // ---- episodes -------------------------------------------------------------------------

      type Joined = EpisodeRow & { p_position: number | null; p_duration: number | null; p_played: number | null; p_updated: number | null };
      const progressOf = (r: Joined): ProgressRow => ({ position: r.p_position ?? 0, duration: r.p_duration ?? 0, played: r.p_played ?? 0, updated_at: r.p_updated ?? 0 });

      app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; order?: string; unplayed?: string } }>(
        "/api/podcasts/feeds/:id/episodes",
        { preHandler: requireUser },
        async (req, reply) => {
          if (badId(reply, ID16.test(req.params.id))) return reply;
          const userId = req.user!.id;
          const feed = feedOf(req.params.id);
          if (!feed) return reply.code(404).send({ error: "not_found" });
          const limit = clampInt(req.query.limit, 50, 1, 200);
          const offset = clampInt(req.query.offset, 0, 0, 100_000);
          const order = req.query.order === "oldest" ? "ASC" : "DESC";
          const only = req.query.unplayed === "1" ? "AND COALESCE(p.played, 0) = 0" : "";
          const rows = db
            .prepare(
              `SELECT e.*, p.position AS p_position, p.duration AS p_duration, p.played AS p_played, p.updated_at AS p_updated
               FROM podcast_episodes e LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = ?
               WHERE e.feed_id = ? ${only} ORDER BY e.published ${order}, e.first_seen ${order} LIMIT ? OFFSET ?`,
            )
            .all(userId, feed.id, limit, offset) as unknown as Joined[];
          const total = (db.prepare(`SELECT COUNT(*) AS n FROM podcast_episodes e LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = ? WHERE e.feed_id = ? ${only}`).get(userId, feed.id) as { n: number }).n;
          return { feed: feedOut(userId, feed, subOf(userId, feed.id)), items: rows.map((r) => episodeOut(userId, r, feed, progressOf(r))), total };
        },
      );

      app.get<{ Querystring: { limit?: string } }>("/api/podcasts/new", { preHandler: requireUser }, async (req) => {
        const userId = req.user!.id;
        const limit = clampInt(req.query.limit, 30, 1, 100);
        const since = Date.now() - 45 * 86_400_000;
        const rows = db
          .prepare(
            `SELECT e.*, f.title AS f_title, f.author AS f_author, f.image_url AS f_image,
                    p.position AS p_position, p.duration AS p_duration, p.played AS p_played, p.updated_at AS p_updated
             FROM podcast_subs s
             JOIN podcast_episodes e ON e.feed_id = s.feed_id
             JOIN podcast_feeds f ON f.id = s.feed_id
             LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = s.user_id
             WHERE s.user_id = ? AND COALESCE(p.played, 0) = 0 AND (e.published >= ? OR (e.published = 0 AND e.first_seen >= ?))
             ORDER BY (COALESCE(p.position, 0) > 0) DESC, e.published DESC LIMIT ?`,
          )
          .all(userId, since, since, limit) as unknown as (Joined & { f_title: string; f_author: string; f_image: string | null })[];
        return { items: rows.map((r) => episodeOut(userId, r, { title: r.f_title, author: r.f_author, image_url: r.f_image }, progressOf(r))) };
      });

      app.get<{ Params: { id: string } }>("/api/podcasts/episodes/:id", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID20.test(req.params.id))) return reply;
        const e = episodeRow(req.params.id);
        if (!e) return reply.code(404).send({ error: "not_found" });
        const userId = req.user!.id;
        const sub = subOf(userId, e.feed_id);
        return { ...episodeOut(userId, e, feedOf(e.feed_id)), speed: sub?.speed ?? 1, autoQueue: !!sub?.auto_queue };
      });

      app.get<{ Params: { id: string } }>("/api/podcasts/episodes/:id/stream-url", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID20.test(req.params.id))) return reply;
        const e = episodeRow(req.params.id);
        if (!e) return reply.code(404).send({ error: "not_found" });
        const exp = nowSec() + AUDIO_TTL_SEC;
        return { path: `api/podcasts/audio/${e.id}?${signedQuery(secret, "podcast-audio", req.user!.id, e.id, exp)}`, expiresAt: exp };
      });

      /** The episodes that follow `after` (newer, oldest first, played ones skipped), for auto-queue. */
      app.get<{ Params: { id: string }; Querystring: { after?: string; count?: string } }>("/api/podcasts/feeds/:id/next", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID16.test(req.params.id))) return reply;
        const after = req.query.after && ID20.test(req.query.after) ? episodeRow(req.query.after) : undefined;
        if (!after || after.feed_id !== req.params.id) return reply.code(404).send({ error: "not_found" });
        const userId = req.user!.id;
        const feed = feedOf(req.params.id)!;
        const rows = db
          .prepare(
            `SELECT e.*, p.position AS p_position, p.duration AS p_duration, p.played AS p_played, p.updated_at AS p_updated
             FROM podcast_episodes e LEFT JOIN podcast_progress p ON p.episode_id = e.id AND p.user_id = ?
             WHERE e.feed_id = ? AND e.id != ? AND COALESCE(p.played, 0) = 0
               AND (e.published > ? OR (e.published = ? AND e.first_seen > ?))
             ORDER BY e.published ASC, e.first_seen ASC LIMIT ?`,
          )
          .all(userId, feed.id, after.id, after.published, after.published, after.first_seen, clampInt(req.query.count, 3, 1, 10)) as unknown as Joined[];
        return { items: rows.map((r) => episodeOut(userId, r, feed, progressOf(r))) };
      });

      app.put<{ Params: { id: string }; Body: { position?: number; duration?: number; played?: boolean; updatedAt?: number } }>(
        "/api/podcasts/episodes/:id/progress",
        { preHandler: requireUser },
        async (req, reply) => {
          if (badId(reply, ID20.test(req.params.id))) return reply;
          const e = episodeRow(req.params.id);
          if (!e) return reply.code(404).send({ error: "not_found" });
          const b = req.body ?? {};
          const position = Number(b.position);
          if (!Number.isFinite(position) || position < 0 || position > 1e6) return reply.code(400).send({ error: "invalid_position" });
          const userId = req.user!.id;
          const prev = db.prepare("SELECT position, duration, played, updated_at FROM podcast_progress WHERE user_id = ? AND episode_id = ?").get(userId, e.id) as ProgressRow | undefined;
          // A device that was offline can report old news after a newer report from another device: ignore it.
          if (prev && typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) && b.updatedAt < prev.updated_at) {
            return { position: prev.position, played: !!prev.played, progressAt: prev.updated_at, stale: true };
          }
          const duration = Number.isFinite(Number(b.duration)) && Number(b.duration) > 0 ? Math.min(Number(b.duration), 1e6) : (prev?.duration ?? e.duration);
          const finished = duration > 0 && (position >= duration - 15 || position / duration >= 0.97);
          const played = typeof b.played === "boolean" ? b.played : finished || !!prev?.played;
          // Marking an episode as unplayed also rewinds it, so it starts from the top next time.
          const savedPosition = b.played === false ? 0 : position;
          const now = Date.now();
          db.prepare(
            `INSERT INTO podcast_progress (user_id, episode_id, feed_id, position, duration, played, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, episode_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, played = excluded.played, updated_at = excluded.updated_at`,
          ).run(userId, e.id, e.feed_id, savedPosition, duration, played ? 1 : 0, now);
          return { position: savedPosition, played, progressAt: now };
        },
      );

      app.get<{ Params: { id: string } }>("/api/podcasts/episodes/:id/chapters", { preHandler: requireUser }, async (req, reply) => {
        if (badId(reply, ID20.test(req.params.id))) return reply;
        const e = episodeRow(req.params.id);
        if (!e) return reply.code(404).send({ error: "not_found" });
        if (!e.chapters_url) return { items: [] };
        try {
          const r = await fetchJson<{ chapters?: { startTime?: number; title?: string }[] }>(e.chapters_url, { ...policy, headerTimeoutMs: headerMs, maxBytes: 300_000 });
          const items = (r.json?.chapters ?? [])
            .filter((c) => typeof c.startTime === "number" && c.startTime >= 0 && c.title)
            .slice(0, 300)
            .map((c) => ({ start: c.startTime as number, title: clean(c.title, 200) }));
          return { items };
        } catch {
          return { items: [] };
        }
      });

      // ---- OPML -----------------------------------------------------------------------------

      app.get("/api/podcasts/opml", { preHandler: requireUser }, async (req, reply) => {
        const rows = db
          .prepare("SELECT f.title, f.url AS feedUrl, f.link FROM podcast_subs s JOIN podcast_feeds f ON f.id = s.feed_id WHERE s.user_id = ? ORDER BY lower(f.title)")
          .all(req.user!.id) as unknown as { title: string; feedUrl: string; link: string | null }[];
        return reply.header("Content-Type", "text/x-opml; charset=utf-8").header("Content-Disposition", 'attachment; filename="cadence-podcasts.opml"').send(buildOpml(rows));
      });

      app.post<{ Body: { opml?: string } }>("/api/podcasts/opml", { preHandler: requireUser, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
        const xml = typeof req.body?.opml === "string" ? req.body.opml : "";
        if (!xml.trim()) return reply.code(400).send({ error: "invalid_request" });
        const userId = req.user!.id;
        const outlines = parseOpml(xml, MAX_OPML_FEEDS);
        if (outlines.length === 0) return reply.code(422).send({ error: "no_feeds", message: "That file doesn't list any podcasts" });
        let added = 0;
        let alreadySubscribed = 0;
        const pending: FeedRow[] = [];
        for (const o of outlines) {
          const url = normaliseFeedUrl(o.feedUrl);
          if (!url) continue;
          const id = feedIdFor(url);
          if (!feedOf(id)) db.prepare("INSERT INTO podcast_feeds (id, url, title, created_at) VALUES (?, ?, ?, ?)").run(id, url, o.title || url, Date.now());
          if (subOf(userId, id)) {
            alreadySubscribed++;
            continue;
          }
          if (subCount(userId) >= MAX_SUBSCRIPTIONS) break;
          db.prepare("INSERT INTO podcast_subs (user_id, feed_id, subscribed_at) VALUES (?, ?, ?)").run(userId, id, Date.now());
          added++;
          const row = feedOf(id)!;
          if (row.last_fetched === null) pending.push(row);
        }
        // Episodes arrive in the background so a big file doesn't hold the request open.
        if (pending.length) void feeds.refreshMany(pending, true).catch(() => undefined);
        return { found: outlines.length, added, alreadySubscribed };
      });

      // ---- audio and images (signed) -----------------------------------------------------

      app.get<{ Params: { id: string }; Querystring: SignedParams }>("/api/podcasts/audio/:id", async (req, reply) => {
        if (badId(reply, ID20.test(req.params.id))) return reply;
        const userId = verifySigned(secret, "podcast-audio", req.params.id, req.query, nowSec());
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        const e = episodeRow(req.params.id);
        if (!e) return reply.code(404).send({ error: "not_found" });
        const ac = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) ac.abort();
        });
        const range = singleRange(req);
        try {
          const res = await request(e.audio_url, {
            ...policy,
            headers: { Accept: "audio/*, */*;q=0.5", ...(range ? { Range: range } : {}) },
            idleTimeoutMs: 0,
            headerTimeoutMs: headerMs,
            maxRedirects: 8,
            signal: ac.signal,
          });
          return proxyResponse(req, reply, res, { accept: STREAM_TYPE, cache: "private, max-age=3600", idleMs });
        } catch (err) {
          return failure(req, reply, err);
        }
      });

      app.get<{ Querystring: SignedParams & { t?: string } }>("/api/podcasts/image", async (req, reply) => {
        const t = typeof req.query.t === "string" && req.query.t.length < 3000 ? unb64(req.query.t) : "";
        const userId = t ? verifySigned(secret, "podcast-image", t, req.query, nowSec()) : null;
        if (userId === null) return reply.code(403).send({ error: "invalid_signature" });
        try {
          const res = await request(t, { ...policy, headers: { Accept: "image/*" }, headerTimeoutMs: 10_000, maxRedirects: 4 });
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (res.status !== 200 || !IMAGE_TYPE.test(type)) {
            res.abort();
            return reply.code(404).send({ error: "not_found" });
          }
          const { data } = await readBody(res, 3_000_000, { totalTimeoutMs: 20_000 });
          return reply.code(200).header("Content-Type", type).header("Cache-Control", "private, max-age=86400").header("Content-Security-Policy", "default-src 'none'; sandbox").send(data);
        } catch (e) {
          if (e instanceof NetError) return reply.code(404).send({ error: "not_found" });
          return failure(req, reply, e);
        }
      });
    },
  };
}

export default createPodcastsPlugin();