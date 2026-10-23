import { createHash } from "node:crypto";
import type { Db } from "../../db.js";

export const feedIdFor = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 16);
export const episodeIdFor = (feedId: string, guid: string): string => createHash("sha256").update(`${feedId}\n${guid}`).digest("hex").slice(0, 20);
export const ID16 = /^[0-9a-f]{16}$/;
export const ID20 = /^[0-9a-f]{20}$/;

/** feed:// and itpc:// are how podcast apps hand out links; they mean http(s). */
export function normaliseFeedUrl(input: string): string | null {
  let text = input.trim();
  if (!text || text.length > 2048) return null;
  text = text.replace(/^(feed|itpc|pcast|podcast):(\/\/)?/i, (_m, _s, slashes: string | undefined) => (slashes ? "http://" : ""));
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[\w-]+(\.[\w-]+)+/.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export interface FeedRow {
  id: string;
  url: string;
  title: string;
  author: string;
  description: string;
  link: string | null;
  image_url: string | null;
  language: string;
  etag: string | null;
  last_modified: string | null;
  last_fetched: number | null;
  last_attempt: number | null;
  failures: number;
}

export interface EpisodeRow {
  id: string;
  feed_id: string;
  guid: string;
  title: string;
  description: string;
  audio_url: string;
  audio_type: string;
  size: number;
  duration: number;
  published: number;
  image_url: string | null;
  season: number | null;
  episode: number | null;
  chapters_url: string | null;
  first_seen: number;
}

export interface ProgressRow {
  position: number;
  duration: number;
  played: number;
  updated_at: number;
}

export interface SubRow {
  subscribed_at: number;
  speed: number;
  auto_queue: number;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcast_feeds (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', link TEXT, image_url TEXT, language TEXT NOT NULL DEFAULT '',
      etag TEXT, last_modified TEXT, last_fetched INTEGER, last_attempt INTEGER,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES podcast_feeds (id) ON DELETE CASCADE,
      guid TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      audio_url TEXT NOT NULL, audio_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
      duration INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, image_url TEXT,
      season INTEGER, episode INTEGER, chapters_url TEXT, first_seen INTEGER NOT NULL,
      UNIQUE (feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS podcast_episodes_feed ON podcast_episodes (feed_id, published DESC);
    CREATE TABLE IF NOT EXISTS podcast_subs (
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      feed_id TEXT NOT NULL REFERENCES podcast_feeds (id) ON DELETE CASCADE,
      subscribed_at INTEGER NOT NULL, speed REAL NOT NULL DEFAULT 1, auto_queue INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, feed_id)
    );
    CREATE TABLE IF NOT EXISTS podcast_progress (
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES podcast_episodes (id) ON DELETE CASCADE,
      feed_id TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      played INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS podcast_progress_feed ON podcast_progress (user_id, feed_id);
  `);
}