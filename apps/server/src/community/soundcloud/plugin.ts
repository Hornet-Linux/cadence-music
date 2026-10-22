import type { ServerPlugin } from "../../plugins/types.js";
import { callJson, clean, hosts, safeUrl, UpstreamError, type FetchFn } from "../_streaming/http.js";
import { idParam, intParam, StreamingKit, textParam, type OAuthDef, type ServiceDef } from "../_streaming/kit.js";
import type { StreamPlaylist, StreamTrack } from "../_streaming/types.js";

/**
 * SoundCloud through its official API (OAuth 2.1 with PKCE). Search uses the owner's app
 * (client credentials); a person's likes and playlists need them to connect their account.
 * Audio is NOT fetched here: tracks play in SoundCloud's own HTML5 Widget in the app, which
 * keeps SoundCloud's branding and the uploader's usage restrictions intact. We never use
 * `stream_url`, never download and never store audio.
 */

const NAME = "SoundCloud";
const SLUG = "soundcloud";
const PAGE_MAX = 50;

const url = () => hosts(SLUG, { api: "https://api.soundcloud.com", auth: "https://secure.soundcloud.com" });

export interface ScTrack {
  id?: number | string;
  title?: string;
  duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  access?: "playable" | "preview" | "blocked";
  user?: { username?: string; avatar_url?: string };
}

interface ScPlaylist {
  id?: number | string;
  title?: string;
  track_count?: number;
  permalink_url?: string;
  artwork_url?: string | null;
}

type ScList<T> = T[] | { collection?: T[] };

const items = <T>(list: ScList<T> | undefined): T[] => (Array.isArray(list) ? list : (list?.collection ?? []));

/** SoundCloud's artwork URLs default to a 100px image; the documented -t300x300 size suits lists. */
export const bigger = (u: string | null | undefined): string | undefined => safeUrl(u?.replace("-large.", "-t300x300."));

export function toTrack(t: ScTrack): StreamTrack | null {
  const id = t.id !== undefined ? String(t.id) : "";
  const title = clean(t.title);
  const permalink = safeUrl(t.permalink_url);
  if (!/^\d{1,20}$/.test(id) || !title || !permalink) return null;
  const blocked = t.access === "blocked";
  const creator = clean(t.user?.username);
  return {
    id,
    title,
    artists: creator ? [creator] : [],
    artwork: bigger(t.artwork_url) ?? bigger(t.user?.avatar_url),
    // The API reports milliseconds.
    durationSec: typeof t.duration === "number" && t.duration > 0 ? Math.round(t.duration / 1000) : undefined,
    url: permalink,
    playback: blocked ? "link" : "widget",
    note: blocked ? "Not playable outside SoundCloud" : t.access === "preview" ? "Preview only" : undefined,
  };
}

function toPlaylist(p: ScPlaylist): StreamPlaylist | null {
  const id = p.id !== undefined ? String(p.id) : "";
  const name = clean(p.title);
  if (!/^\d{1,20}$/.test(id) || !name) return null;
  return { id, name, artwork: bigger(p.artwork_url), trackCount: p.track_count, url: safeUrl(p.permalink_url) };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function tokenSet(r: TokenResponse) {
  if (!r?.access_token) throw new UpstreamError(NAME, "bad_response");
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: typeof r.expires_in === "number" ? Math.floor(Date.now() / 1000) + r.expires_in : undefined,
  };
}

const oauth: OAuthDef = {
  pkce: true,
  authorizeUrl(cfg, p) {
    const u = new URL(`${url().auth}/authorize`);
    u.searchParams.set("client_id", cfg.clientId!);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", p.challenge!);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", p.state);
    return u.toString();
  },
  async exchange(cfg, p, fetchFn) {
    return tokenSet(
      await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth/token`, {
        fetchFn,
        form: {
          grant_type: "authorization_code",
          client_id: cfg.clientId!,
          client_secret: cfg.clientSecret!,
          redirect_uri: p.redirectUri,
          code_verifier: p.verifier!,
          code: p.code,
        },
      }),
    );
  },
  // Refresh tokens are single use: the new one replaces the old.
  async refresh(cfg, refreshToken, fetchFn) {
    return tokenSet(
      await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth/token`, {
        fetchFn,
        form: { grant_type: "refresh_token", client_id: cfg.clientId!, client_secret: cfg.clientSecret!, refresh_token: refreshToken },
      }),
    );
  },
};

export const soundcloudDef: ServiceDef = {
  slug: SLUG,
  id: "cadence.soundcloud",
  name: NAME,
  fields: [
    { key: "clientId", label: "Client ID", hint: "From your app on soundcloud.com (Your Apps)" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ],
  isConfigured: (cfg) => !!cfg?.clientId && !!cfg.clientSecret,
  oauth,
  features: { search: true, library: true, playlists: true, playback: "widget" },
};

export function createSoundCloudPlugin(options: { fetchFn?: FetchFn } = {}): ServerPlugin {
  return {
    id: soundcloudDef.id,
    name: "SoundCloud (search, library, widget player)",
    version: "1.0.0",
    register(app, ctx) {
      const kit = new StreamingKit(soundcloudDef, app, ctx, options.fetchFn);
      kit.registerCommon();
      const { requireUser } = ctx;
      const base = kit.base;

      /** Client-credentials token for the owner's app. Only 50 can be minted per 12 hours, so it is cached. */
      const appToken = () =>
        kit.appToken("app", async () => {
          const cfg = kit.config()!;
          const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
          const r = await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth/token`, {
            fetchFn: options.fetchFn,
            headers: { authorization: `Basic ${basic}` },
            form: { grant_type: "client_credentials" },
          });
          if (!r?.access_token) throw new UpstreamError(NAME, "bad_response");
          return { token: r.access_token, expiresInSec: typeof r.expires_in === "number" ? r.expires_in : 3600 };
        });

      async function api<T>(path: string, query: Record<string, string | number>, token: string, retryApp = false): Promise<T> {
        const u = new URL(`${url().api}${path}`);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
        try {
          return await callJson<T>(NAME, "GET", u.toString(), { fetchFn: options.fetchFn, headers: { authorization: `OAuth ${token}` } });
        } catch (e) {
          // A cached app token the service no longer accepts: mint a new one once.
          if (retryApp && e instanceof UpstreamError && e.kind === "unauthorized") {
            kit.dropAppToken("app");
            return api<T>(path, query, await appToken(), false);
          }
          throw e;
        }
      }

      const limit = (q: Record<string, unknown>) => intParam(q.limit, 25, 1, PAGE_MAX);
      const mapTracks = (list: ScList<ScTrack>) => {
        const out = items(list).map(toTrack).filter((t): t is StreamTrack => t !== null);
        return { items: out, total: out.length };
      };

      app.get<{ Querystring: Record<string, string> }>(`${base}/search`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const q = textParam(req.query.q);
        if (!q) return reply.code(400).send({ error: "missing_query" });
        if (kit.limited(req, reply)) return reply;
        return kit.guard(req, reply, async () =>
          mapTracks(await api<ScList<ScTrack>>("/tracks", { q, limit: limit(req.query), access: "playable,preview" }, await appToken(), true)),
        );
      });

      app.get<{ Querystring: Record<string, string> }>(`${base}/library/tracks`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => mapTracks(await api<ScList<ScTrack>>("/me/likes/tracks", { limit: limit(req.query) }, await kit.userToken(req.user!.id))),
          { userCall: true },
        );
      });

      app.get(`${base}/playlists`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => {
            const list = await api<ScList<ScPlaylist>>("/me/playlists", { show_tracks: "false", limit: 50 }, await kit.userToken(req.user!.id));
            const out = items(list).map(toPlaylist).filter((p): p is StreamPlaylist => p !== null);
            return { items: out, total: out.length };
          },
          { userCall: true },
        );
      });

      app.get<{ Params: { id: string } }>(`${base}/playlists/:id/tracks`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const id = idParam(req.params.id);
        if (!id || !/^\d+$/.test(id)) return reply.code(400).send({ error: "invalid_id" });
        return kit.guard(
          req,
          reply,
          async () => mapTracks(await api<ScList<ScTrack>>(`/playlists/${id}/tracks`, { limit: 100 }, await kit.userToken(req.user!.id))),
          { userCall: true },
        );
      });
    },
  };
}

export default createSoundCloudPlugin();
