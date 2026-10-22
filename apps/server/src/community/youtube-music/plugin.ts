import type { ServerPlugin } from "../../plugins/types.js";
import { callJson, clean, hosts, isoSeconds, safeUrl, UpstreamError, type FetchFn } from "../_streaming/http.js";
import { intParam, StreamingKit, textParam, type ServiceDef } from "../_streaming/kit.js";
import type { StreamTrack } from "../_streaming/types.js";

/**
 * YouTube search for the "YouTube" player plugin. There is no YouTube Music API; this uses the
 * official YouTube Data API v3 with the owner's own API key (which stays on the server) and only
 * lists videos that their owners allow to be embedded. Playback happens in the official IFrame
 * player in the app, in a visible panel (YouTube's policies forbid hiding it or playing audio
 * only). Nothing from YouTube is stored.
 */

const NAME = "YouTube";
const SLUG = "youtube-music";
/** The "Music" video category. */
const MUSIC_CATEGORY = "10";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const url = () => hosts(SLUG, { api: "https://www.googleapis.com/youtube/v3" });

interface SearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> };
}

interface VideoItem {
  id?: string;
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean; privacyStatus?: string };
}

/** Titles come HTML-escaped from the search endpoint. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 16))))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]!);
}

export function toTrack(item: SearchItem, video: VideoItem | undefined): StreamTrack | null {
  const id = item.id?.videoId ?? "";
  const rawTitle = clean(item.snippet?.title);
  if (!VIDEO_ID.test(id) || !rawTitle) return null;
  // Embedding can be turned off after the search index was built.
  if (video && (video.status?.embeddable === false || video.status?.privacyStatus === "private")) return null;
  const thumbs = item.snippet?.thumbnails ?? {};
  const channel = clean(item.snippet?.channelTitle);
  return {
    id,
    title: decodeEntities(rawTitle),
    artists: channel ? [decodeEntities(channel).replace(/ - Topic$/, "")] : [],
    artwork: safeUrl((thumbs.medium ?? thumbs.default ?? thumbs.high)?.url),
    durationSec: isoSeconds(video?.contentDetails?.duration),
    url: `https://www.youtube.com/watch?v=${id}`,
    playback: "iframe",
  };
}

export const youtubeDef: ServiceDef = {
  slug: SLUG,
  id: "cadence.youtube-music",
  name: NAME,
  fields: [{ key: "apiKey", label: "YouTube Data API key", secret: true, hint: "Create your own in Google Cloud Console (YouTube Data API v3)" }],
  isConfigured: (cfg) => !!cfg?.apiKey,
  features: { search: true, library: false, playlists: false, playback: "iframe" },
};

export function createYouTubePlugin(options: { fetchFn?: FetchFn } = {}): ServerPlugin {
  return {
    id: youtubeDef.id,
    name: "YouTube (search and official player)",
    version: "1.0.0",
    register(app, ctx) {
      const kit = new StreamingKit(youtubeDef, app, ctx, options.fetchFn);
      kit.registerCommon();

      async function api<T>(path: string, query: Record<string, string | number>): Promise<T> {
        const u = new URL(`${url().api}${path}`);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
        u.searchParams.set("key", kit.config()!.apiKey!);
        return callJson<T>(NAME, "GET", u.toString(), { fetchFn: options.fetchFn });
      }

      app.get<{ Querystring: Record<string, string> }>(`${kit.base}/search`, { preHandler: ctx.requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const q = textParam(req.query.q);
        if (!q) return reply.code(400).send({ error: "missing_query" });
        if (kit.limited(req, reply)) return reply;
        return kit.guard(req, reply, async () => {
          const found = await api<{ items?: SearchItem[] }>("/search", {
            part: "snippet",
            type: "video",
            videoEmbeddable: "true",
            videoSyndicated: "true",
            videoCategoryId: MUSIC_CATEGORY,
            safeSearch: "moderate",
            maxResults: intParam(req.query.limit, 20, 1, 30),
            q,
          });
          const hits = (found.items ?? []).filter((i) => VIDEO_ID.test(i.id?.videoId ?? ""));
          if (hits.length === 0) return { items: [], total: 0 };
          const details = new Map<string, VideoItem>();
          try {
            const vids = await api<{ items?: VideoItem[] }>("/videos", {
              part: "contentDetails,status",
              id: hits.map((h) => h.id!.videoId!).join(","),
              maxResults: hits.length,
            });
            for (const v of vids.items ?? []) if (v.id) details.set(v.id, v);
          } catch (e) {
            // Durations and the embeddable check are nice to have; the list itself is not lost.
            if (!(e instanceof UpstreamError)) throw e;
          }
          const items = hits.map((h) => toTrack(h, details.get(h.id!.videoId!))).filter((t): t is StreamTrack => t !== null);
          return { items, total: items.length };
        });
      });
    },
  };
}

export default createYouTubePlugin();
