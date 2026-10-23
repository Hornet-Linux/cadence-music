import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db.js";
import { mapLimit } from "../_sourcekit/common.js";
import { fetchText, NetError } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { parseFeed, type ParsedFeed } from "./feed.js";
import { episodeIdFor, feedIdFor, type FeedRow } from "./schema.js";

export const FEED_MAX_BYTES = 8_000_000;
export const MAX_EPISODES_PER_FEED = 1000;
const MIN_REFETCH_MS = 20 * 60_000;

export type Fetched = { kind: "feed"; row: FeedRow; added: number } | { kind: "unchanged" };

/** Fetches, parses and stores podcast feeds, and keeps them fresh. Shared by every person who subscribes. */
export class FeedService {
  constructor(
    private readonly db: Db,
    private readonly policy: NetPolicy,
    private readonly log: FastifyBaseLogger,
    private readonly opts: { headerTimeoutMs: number; minRefetchMs?: number },
  ) {}

  feedOf(id: string): FeedRow | undefined {
    return this.db.prepare("SELECT * FROM podcast_feeds WHERE id = ?").get(id) as unknown as FeedRow | undefined;
  }

  private count(feedId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM podcast_episodes WHERE feed_id = ?").get(feedId) as { n: number }).n;
  }

  store(feedUrl: string, feed: ParsedFeed, headers: { etag?: string; lastModified?: string }): FeedRow {
    const db = this.db;
    const id = feedIdFor(feedUrl);
    const now = Date.now();
    db.prepare(
      `INSERT INTO podcast_feeds (id, url, title, author, description, link, image_url, language, etag, last_modified, last_fetched, last_attempt, failures, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, author = excluded.author, description = excluded.description,
         link = excluded.link, image_url = excluded.image_url, language = excluded.language, etag = excluded.etag,
         last_modified = excluded.last_modified, last_fetched = excluded.last_fetched, last_attempt = excluded.last_attempt, failures = 0`,
    ).run(id, feedUrl, feed.title, feed.author, feed.description, feed.link ?? null, feed.imageUrl ?? null, feed.language, headers.etag ?? null, headers.lastModified ?? null, now, now, now);
    const upsert = db.prepare(
      `INSERT INTO podcast_episodes (id, feed_id, guid, title, description, audio_url, audio_type, size, duration, published, image_url, season, episode, chapters_url, first_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id, guid) DO UPDATE SET title = excluded.title, description = excluded.description, audio_url = excluded.audio_url,
         audio_type = excluded.audio_type, size = excluded.size, duration = excluded.duration, published = excluded.published,
         image_url = excluded.image_url, season = excluded.season, episode = excluded.episode, chapters_url = excluded.chapters_url`,
    );
    db.exec("BEGIN");
    try {
      for (const e of feed.episodes) {
        upsert.run(episodeIdFor(id, e.guid), id, e.guid, e.title, e.description, e.audioUrl, e.audioType, e.size, e.durationSec, e.publishedAt, e.imageUrl ?? null, e.season ?? null, e.episode ?? null, e.chaptersUrl ?? null, now);
      }
      db.prepare(
        `DELETE FROM podcast_episodes WHERE feed_id = ? AND id NOT IN (SELECT id FROM podcast_episodes WHERE feed_id = ? ORDER BY published DESC, first_seen DESC LIMIT ?)`,
      ).run(id, id, MAX_EPISODES_PER_FEED);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return this.feedOf(id)!;
  }

  /** Downloads and stores a feed. With `existing`, asks the server whether it changed (ETag / Last-Modified). */
  async fetch(feedUrl: string, existing?: FeedRow): Promise<Fetched> {
    const before = existing ? this.count(existing.id) : 0;
    const r = await fetchText(feedUrl, {
      ...this.policy,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        ...(existing?.etag ? { "If-None-Match": existing.etag } : {}),
        ...(existing?.last_modified ? { "If-Modified-Since": existing.last_modified } : {}),
      },
      headerTimeoutMs: this.opts.headerTimeoutMs,
      maxBytes: FEED_MAX_BYTES,
      truncate: true,
      totalTimeoutMs: 40_000,
      maxRedirects: 5,
    });
    if (r.status === 304 && existing) {
      this.db.prepare("UPDATE podcast_feeds SET last_fetched = ?, last_attempt = ?, failures = 0 WHERE id = ?").run(Date.now(), Date.now(), existing.id);
      return { kind: "unchanged" };
    }
    if (r.status !== 200) throw new NetError("bad_response", `HTTP ${r.status}`);
    const parsed = parseFeed(r.text, r.url.toString(), { maxItems: MAX_EPISODES_PER_FEED, sourceTruncated: r.truncated });
    const etag = typeof r.headers.etag === "string" ? r.headers.etag.slice(0, 200) : undefined;
    const lastModified = typeof r.headers["last-modified"] === "string" ? r.headers["last-modified"].slice(0, 100) : undefined;
    const row = this.store(feedUrl, parsed, { etag, lastModified });
    return { kind: "feed", row, added: Math.max(0, this.count(row.id) - before) };
  }

  /** Refreshes one feed. Recent attempts are skipped, and a feed that keeps failing is tried less and less often. */
  async refresh(row: FeedRow, force = false): Promise<number> {
    const wait = (this.opts.minRefetchMs ?? MIN_REFETCH_MS) * (1 + Math.min(row.failures, 6) ** 2);
    if (!force && row.last_attempt && Date.now() - row.last_attempt < wait) return 0;
    try {
      const r = await this.fetch(row.url, row);
      return r.kind === "feed" ? r.added : 0;
    } catch (e) {
      this.db.prepare("UPDATE podcast_feeds SET failures = failures + 1, last_attempt = ? WHERE id = ?").run(Date.now(), row.id);
      this.log.warn({ feed: row.id, detail: e instanceof Error ? e.message : String(e) }, "podcast refresh failed");
      return 0;
    }
  }

  refreshMany(rows: FeedRow[], force = false): Promise<number[]> {
    return mapLimit(rows, 4, (row) => this.refresh(row, force));
  }

  /** Every feed someone subscribes to. */
  subscribedFeeds(): FeedRow[] {
    return this.db.prepare("SELECT f.* FROM podcast_feeds f WHERE EXISTS (SELECT 1 FROM podcast_subs s WHERE s.feed_id = f.id)").all() as unknown as FeedRow[];
  }
}