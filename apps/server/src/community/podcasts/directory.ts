import { createHash } from "node:crypto";
import { clean } from "../_sourcekit/common.js";
import { fetchJson, NetError } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";
import { nowSec } from "../_sourcekit/signing.js";
import { httpUrl } from "./feed.js";

export interface DirectoryHit {
  feedUrl: string;
  title: string;
  author: string;
  image?: string;
  description?: string;
}

export interface DirectoryConfig {
  policy: NetPolicy;
  itunesBase: string;
  podcastIndexBase: string;
  headerTimeoutMs: number;
  keys: { key: string; secret: string } | null;
}

/**
 * Finds shows. With the admin's Podcast Index key and secret it asks Podcast Index (signed as its API requires);
 * otherwise it uses the iTunes Search API, which needs no key. Either way only the feed address is used from the answer.
 */
export async function searchDirectory(cfg: DirectoryConfig, q: string, limit: number): Promise<{ source: "podcastindex" | "itunes"; items: DirectoryHit[] }> {
  if (cfg.keys) {
    const date = String(nowSec());
    const auth = createHash("sha1").update(cfg.keys.key + cfg.keys.secret + date).digest("hex");
    const r = await fetchJson<{ feeds?: { url?: string; title?: string; author?: string; image?: string; artwork?: string; description?: string }[] }>(
      `${cfg.podcastIndexBase}/api/1.0/search/byterm?q=${encodeURIComponent(q)}&max=${limit}`,
      { ...cfg.policy, headers: { "X-Auth-Date": date, "X-Auth-Key": cfg.keys.key, Authorization: auth }, headerTimeoutMs: cfg.headerTimeoutMs, maxBytes: 2_000_000 },
    );
    if (r.status >= 400 || !r.json) throw new NetError("bad_response", `HTTP ${r.status}`);
    return {
      source: "podcastindex",
      items: (r.json.feeds ?? []).flatMap((f) => {
        const feedUrl = httpUrl(f.url);
        return feedUrl ? [{ feedUrl, title: clean(f.title, 300), author: clean(f.author, 200), image: httpUrl(f.image) ?? httpUrl(f.artwork), description: clean(f.description, 400) }] : [];
      }),
    };
  }
  const r = await fetchJson<{ results?: { feedUrl?: string; collectionName?: string; trackName?: string; artistName?: string; artworkUrl600?: string; artworkUrl100?: string }[] }>(
    `${cfg.itunesBase}/search?media=podcast&entity=podcast&limit=${limit}&term=${encodeURIComponent(q)}`,
    { ...cfg.policy, headerTimeoutMs: cfg.headerTimeoutMs, maxBytes: 2_000_000 },
  );
  if (r.status >= 400 || !r.json) throw new NetError("bad_response", `HTTP ${r.status}`);
  return {
    source: "itunes",
    items: (r.json.results ?? []).flatMap((f) => {
      const feedUrl = httpUrl(f.feedUrl);
      return feedUrl ? [{ feedUrl, title: clean(f.collectionName ?? f.trackName, 300), author: clean(f.artistName, 200), image: httpUrl(f.artworkUrl600) ?? httpUrl(f.artworkUrl100) }] : [];
    }),
  };
}