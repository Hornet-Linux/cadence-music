import type { ServerPlugin } from "../../plugins/types.js";
import { callJson, clean, hosts, safeUrl, UpstreamError, type FetchFn } from "../_streaming/http.js";
import { idParam, intParam, StreamingKit, streamingMeta, textParam, type OAuthDef, type ServiceDef } from "../_streaming/kit.js";
import type { StreamPlaylist, StreamTrack } from "../_streaming/types.js";

/**
 * Deezer through its official public API. Search and 30-second previews work with the
 * server owner's app id; a person's own favourites and playlists need them to connect their
 * Deezer account (OAuth code flow; Deezer documents no PKCE and no refresh tokens, so we
 * ask for `offline_access`). Full-length audio is not available through the API: Deezer
 * only allows it inside its own widget, which the app shows as-is.
 */

const NAME = "Deezer";
const SLUG = "deezer";
const PERMS = "basic_access,offline_access";
const PAGE_MAX = 50;

const url = () => hosts(SLUG, { api: "https://api.deezer.com", connect: "https://connect.deezer.com" });

export interface DeezerTrack {
  id?: number | string;
  title?: string;
  title_short?: string;
  duration?: number;
  preview?: string;
  link?: string;
  readable?: boolean;
  artist?: { id?: number; name?: string };
  album?: { title?: string; cover_medium?: string; cover_big?: string; cover_xl?: string };
}

interface DeezerList<T> {
  data?: T[];
  total?: number;
}

interface DeezerPlaylist {
  id?: number | string;
  title?: string;
  nb_tracks?: number;
  picture_medium?: string;
  link?: string;
}

export function toTrack(t: DeezerTrack): StreamTrack | null {
  const id = t.id !== undefined ? String(t.id) : "";
  const title = clean(t.title_short ?? t.title);
  if (!/^\d{1,20}$/.test(id) || !title) return null;
  const artist = clean(t.artist?.name);
  return {
    id,
    title,
    artists: artist ? [artist] : [],
    album: clean(t.album?.title),
    artwork: safeUrl(t.album?.cover_big ?? t.album?.cover_medium ?? t.album?.cover_xl),
    durationSec: typeof t.duration === "number" && t.duration > 0 ? t.duration : undefined,
    url: safeUrl(t.link),
    // Only a 30 s preview is allowed through the API; without one we can only link out.
    playback: t.preview ? "preview" : "link",
  };
}

export function toPlaylist(p: DeezerPlaylist): StreamPlaylist | null {
  const id = p.id !== undefined ? String(p.id) : "";
  const name = clean(p.title);
  if (!/^\d{1,20}$/.test(id) || !name) return null;
  return {
    id,
    name,
    artwork: safeUrl(p.picture_medium),
    trackCount: typeof p.nb_tracks === "number" ? p.nb_tracks : undefined,
    url: safeUrl(p.link),
  };
}

/** Deezer reports many failures as HTTP 200 with an `error` object. */
function checked<T>(body: T & { error?: { type?: string; code?: number } }): T {
  if (body && typeof body === "object" && body.error) {
    const code = body.error.code;
    // 300 = invalid/expired token, 200/201 = permission problems.
    if (code === 300 || body.error.type === "OAuthException") throw new UpstreamError(NAME, "unauthorized");
    if (code === 4) throw new UpstreamError(NAME, "rate_limited");
    if (code === 800) throw new UpstreamError(NAME, "not_found");
    throw new UpstreamError(NAME, "upstream");
  }
  return body;
}

const oauth: OAuthDef = {
  pkce: false,
  authorizeUrl(cfg, p) {
    const u = new URL(`${url().connect}/oauth/auth.php`);
    u.searchParams.set("app_id", cfg.appId!);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("perms", PERMS);
    u.searchParams.set("state", p.state);
    return u.toString();
  },
  async exchange(cfg, p, fetchFn) {
    const u = new URL(`${url().connect}/oauth/access_token.php`);
    u.searchParams.set("app_id", cfg.appId!);
    u.searchParams.set("secret", cfg.appSecret!);
    u.searchParams.set("code", p.code);
    u.searchParams.set("output", "json");
    const r = await callJson<{ access_token?: string; expires?: number }>(NAME, "GET", u.toString(), { fetchFn });
    if (!r?.access_token) throw new UpstreamError(NAME, "bad_response");
    // `expires: 0` means the token does not expire (offline_access).
    const expiresAt = r.expires && r.expires > 0 ? Math.floor(Date.now() / 1000) + r.expires : undefined;
    return { accessToken: r.access_token, expiresAt };
  },
};

export const deezerDef: ServiceDef = {
  slug: SLUG,
  id: "cadence.deezer",
  name: NAME,
  fields: [
    { key: "appId", label: "Application ID", hint: "From developers.deezer.com/myapps" },
    { key: "appSecret", label: "Secret key", secret: true },
  ],
  isConfigured: (cfg) => !!cfg?.appId && !!cfg.appSecret,
  oauth,
  features: { search: true, library: true, playlists: true, playback: "preview" },
};

export function createDeezerPlugin(options: { fetchFn?: FetchFn } = {}): ServerPlugin {
  return {
    id: deezerDef.id,
    name: "Deezer (previews and library)",
    version: "1.0.0",
    ...streamingMeta(deezerDef, "Search Deezer, browse each person's favourites and playlists, and play the official 30-second previews. Full tracks are only available through Deezer's own widget. Free and non-commercial use only; needs your own Deezer application id and secret."),
    register(app, ctx) {
      const kit = new StreamingKit(deezerDef, app, ctx, options.fetchFn);
      kit.registerCommon();
      const { requireUser } = ctx;
      const base = kit.base;

      async function api<T>(path: string, query: Record<string, string | number>, token?: string): Promise<T> {
        const u = new URL(`${url().api}${path}`);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
        if (token) u.searchParams.set("access_token", token);
        return checked(await callJson<T & { error?: { type?: string; code?: number } }>(NAME, "GET", u.toString(), { fetchFn: options.fetchFn }));
      }

      const paging = (q: Record<string, unknown>) => ({
        limit: intParam(q.limit, 25, 1, PAGE_MAX),
        index: intParam(q.offset, 0, 0, 10_000),
      });

      const mapTracks = (list: DeezerList<DeezerTrack>) => {
        const items = (list.data ?? []).map(toTrack).filter((t): t is StreamTrack => t !== null);
        return { items, total: typeof list.total === "number" ? list.total : items.length };
      };

      app.get<{ Querystring: Record<string, string> }>(`${base}/search`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const q = textParam(req.query.q);
        if (!q) return reply.code(400).send({ error: "missing_query" });
        if (kit.limited(req, reply)) return reply;
        return kit.guard(req, reply, async () => mapTracks(await api<DeezerList<DeezerTrack>>("/search/track", { q, ...paging(req.query) })));
      });

      // A fresh 30 s preview: Deezer signs these URLs and they expire, so they are looked up at play time.
      app.get<{ Params: { id: string } }>(`${base}/tracks/:id/preview`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const id = idParam(req.params.id);
        if (!id || !/^\d+$/.test(id)) return reply.code(400).send({ error: "invalid_id" });
        return kit.guard(req, reply, async () => {
          const t = await api<DeezerTrack>(`/track/${id}`, {});
          const preview = safeUrl(t.preview);
          if (!preview) return reply.code(404).send({ error: "no_preview", message: "Deezer offers no preview for this track" });
          return { url: preview, durationSec: 30 };
        });
      });

      app.get<{ Querystring: Record<string, string> }>(`${base}/library/tracks`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => mapTracks(await api<DeezerList<DeezerTrack>>("/user/me/tracks", paging(req.query), await kit.userToken(req.user!.id))),
          { userCall: true },
        );
      });

      app.get<{ Querystring: Record<string, string> }>(`${base}/playlists`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => {
            const list = await api<DeezerList<DeezerPlaylist>>("/user/me/playlists", paging(req.query), await kit.userToken(req.user!.id));
            const items = (list.data ?? []).map(toPlaylist).filter((p): p is StreamPlaylist => p !== null);
            return { items, total: typeof list.total === "number" ? list.total : items.length };
          },
          { userCall: true },
        );
      });

      app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
        `${base}/playlists/:id/tracks`,
        { preHandler: requireUser },
        async (req, reply) => {
          if (!kit.configured()) return kit.notConfigured(reply);
          const id = idParam(req.params.id);
          if (!id || !/^\d+$/.test(id)) return reply.code(400).send({ error: "invalid_id" });
          return kit.guard(
            req,
            reply,
            async () => mapTracks(await api<DeezerList<DeezerTrack>>(`/playlist/${id}/tracks`, paging(req.query), await kit.userToken(req.user!.id))),
            { userCall: true },
          );
        },
      );
    },
  };
}

export default createDeezerPlugin();
