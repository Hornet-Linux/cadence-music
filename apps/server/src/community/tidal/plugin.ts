import type { ServerPlugin } from "../../plugins/types.js";
import { callJson, clean, hosts, isoSeconds, safeUrl, UpstreamError, type FetchFn } from "../_streaming/http.js";
import { idParam, intParam, StreamingKit, streamingMeta, textParam, type OAuthDef, type ServiceDef } from "../_streaming/kit.js";
import type { StreamPlaylist, StreamTrack } from "../_streaming/types.js";

/**
 * TIDAL through its official developer API (OpenAPI v2, JSON:API). Catalogue search uses
 * the owner's app (client credentials); a person's saved tracks and playlists need them
 * to log in (authorization code with PKCE). TIDAL only releases audio through its own Player
 * SDK, which this plugin does not use, so tracks open in TIDAL instead of playing here.
 *
 * Request and response shapes follow TIDAL's public documentation and SDK; they have not been
 * exercised against the live service (no credentials were available when this was written).
 */

const NAME = "TIDAL";
const SLUG = "tidal";
const SCOPES = "user.read collection.read playlists.read";
const JSON_API = "application/vnd.api+json";
const TRACK_INCLUDE = "tracks,tracks.artists,tracks.albums,tracks.albums.coverArt";

const url = () => hosts(SLUG, { api: "https://openapi.tidal.com/v2", login: "https://login.tidal.com", auth: "https://auth.tidal.com/v1" });

interface Resource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } | { id?: string; type?: string }[] } | undefined>;
}

interface Doc {
  data?: Resource | Resource[];
  included?: Resource[];
  links?: { next?: string };
}

class Included {
  private readonly map = new Map<string, Resource>();
  constructor(doc: Doc) {
    // `data` may hold bare references (relationship documents); the full resources in
    // `included` replace them.
    for (const r of Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []) if (r.type && r.id) this.map.set(`${r.type}:${r.id}`, r);
    for (const r of doc.included ?? []) if (r.type && r.id) this.map.set(`${r.type}:${r.id}`, r);
  }
  get(ref: { type?: string; id?: string } | undefined): Resource | undefined {
    return ref?.type && ref.id ? this.map.get(`${ref.type}:${ref.id}`) : undefined;
  }
  related(r: Resource | undefined, rel: string): Resource[] {
    const data = r?.relationships?.[rel]?.data;
    const refs = Array.isArray(data) ? data : data ? [data] : [];
    return refs.map((x) => this.get(x)).filter((x): x is Resource => !!x);
  }
}

/** The largest artwork file TIDAL lists, at most ~640px, for list covers. */
function artworkOf(art: Resource | undefined): string | undefined {
  const files = (art?.attributes?.files as { href?: string; meta?: { width?: number } }[] | undefined) ?? [];
  const sorted = files.filter((f) => f.href).sort((a, b) => (a.meta?.width ?? 0) - (b.meta?.width ?? 0));
  const fit = sorted.filter((f) => (f.meta?.width ?? 0) <= 640);
  return safeUrl((fit.at(-1) ?? sorted[0])?.href);
}

function externalLink(r: Resource): string | undefined {
  const links = r.attributes?.externalLinks as { href?: string }[] | undefined;
  return safeUrl(links?.[0]?.href);
}

export function toTrack(r: Resource, inc: Included): StreamTrack | null {
  const id = r.id ?? "";
  const title = clean(r.attributes?.title);
  if (!/^\d{1,20}$/.test(id) || !title) return null;
  const version = clean(r.attributes?.version);
  const artists = inc.related(r, "artists").map((a) => clean(a.attributes?.name)).filter((n): n is string => !!n);
  const album = inc.related(r, "albums")[0];
  return {
    id,
    title: version ? `${title} (${version})` : title,
    artists,
    album: clean(album?.attributes?.title),
    artwork: artworkOf(inc.related(album, "coverArt")[0]),
    durationSec: isoSeconds(r.attributes?.duration),
    // The canonical public page; TIDAL's own link, when present, wins.
    url: externalLink(r) ?? `https://tidal.com/track/${id}`,
    playback: "link",
    note: "Plays in TIDAL",
  };
}

/** Tracks in a JSON:API document, in the order the document lists them. */
export function tracksOf(doc: Doc): { items: StreamTrack[]; next: boolean } {
  const inc = new Included(doc);
  const order = Array.isArray(doc.data) ? doc.data : [];
  const items = order
    .filter((ref) => ref.type === "tracks")
    .map((ref) => inc.get(ref))
    .filter((r): r is Resource => !!r)
    .map((r) => toTrack(r, inc))
    .filter((t): t is StreamTrack => t !== null);
  return { items, next: !!doc.links?.next };
}

export function toPlaylist(r: Resource, inc: Included): StreamPlaylist | null {
  const id = r.id ?? "";
  const name = clean(r.attributes?.name);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || !name) return null;
  const count = r.attributes?.numberOfItems;
  return {
    id,
    name,
    artwork: artworkOf(inc.related(r, "coverArt")[0]),
    trackCount: typeof count === "number" ? count : undefined,
    url: externalLink(r) ?? `https://tidal.com/playlist/${id}`,
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

const basic = (clientId: string, secret: string) => `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;

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
    const u = new URL(`${url().login}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.clientId!);
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("scope", SCOPES);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("code_challenge", p.challenge!);
    u.searchParams.set("state", p.state);
    return u.toString();
  },
  async exchange(cfg, p, fetchFn) {
    return tokenSet(
      await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth2/token`, {
        fetchFn,
        headers: { authorization: basic(cfg.clientId!, cfg.clientSecret!) },
        form: {
          grant_type: "authorization_code",
          client_id: cfg.clientId!,
          code: p.code,
          redirect_uri: p.redirectUri,
          code_verifier: p.verifier!,
        },
      }),
    );
  },
  async refresh(cfg, refreshToken, fetchFn) {
    return tokenSet(
      await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth2/token`, {
        fetchFn,
        headers: { authorization: basic(cfg.clientId!, cfg.clientSecret!) },
        form: { grant_type: "refresh_token", client_id: cfg.clientId!, refresh_token: refreshToken },
      }),
    );
  },
};

export const tidalDef: ServiceDef = {
  slug: SLUG,
  id: "cadence.tidal",
  name: NAME,
  fields: [
    { key: "clientId", label: "Client ID", hint: "From developer.tidal.com (Dashboard)" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "countryCode", label: "Country code", optional: true, hint: "Two letters, e.g. US or DE. Default US." },
  ],
  isConfigured: (cfg) => !!cfg?.clientId && !!cfg.clientSecret,
  oauth,
  features: { search: true, library: true, playlists: true, playback: "link" },
};

export function createTidalPlugin(options: { fetchFn?: FetchFn } = {}): ServerPlugin {
  return {
    id: tidalDef.id,
    name: "TIDAL (catalogue and library, link-out)",
    version: "1.0.0",
    ...streamingMeta(tidalDef, "Search TIDAL and browse each person's playlists and saved tracks. TIDAL does not allow third-party playback here, so every track opens in TIDAL. Needs your own client id and secret from the TIDAL developer portal."),
    register(app, ctx) {
      const kit = new StreamingKit(tidalDef, app, ctx, options.fetchFn);
      kit.registerCommon();
      const { requireUser } = ctx;
      const base = kit.base;

      const country = () => {
        const c = kit.config()?.countryCode?.toUpperCase();
        return c && /^[A-Z]{2}$/.test(c) ? c : "US";
      };

      const appToken = () =>
        kit.appToken("app", async () => {
          const cfg = kit.config()!;
          const r = await callJson<TokenResponse>(NAME, "POST", `${url().auth}/oauth2/token`, {
            fetchFn: options.fetchFn,
            headers: { authorization: basic(cfg.clientId!, cfg.clientSecret!) },
            form: { grant_type: "client_credentials" },
          });
          if (!r?.access_token) throw new UpstreamError(NAME, "bad_response");
          return { token: r.access_token, expiresInSec: typeof r.expires_in === "number" ? r.expires_in : 3600 };
        });

      async function api<T = Doc>(path: string, query: Record<string, string>, token: string, retryApp = false): Promise<T> {
        const u = new URL(`${url().api}${path}`);
        u.searchParams.set("countryCode", country());
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
        try {
          return await callJson<T>(NAME, "GET", u.toString(), {
            fetchFn: options.fetchFn,
            headers: { authorization: `Bearer ${token}`, accept: JSON_API },
          });
        } catch (e) {
          if (retryApp && e instanceof UpstreamError && e.kind === "unauthorized") {
            kit.dropAppToken("app");
            return api<T>(path, query, await appToken(), false);
          }
          throw e;
        }
      }

      app.get<{ Querystring: Record<string, string> }>(`${base}/search`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const q = textParam(req.query.q);
        if (!q) return reply.code(400).send({ error: "missing_query" });
        if (kit.limited(req, reply)) return reply;
        return kit.guard(req, reply, async () => {
          const doc = await api(`/searchResults/${encodeURIComponent(q)}/relationships/tracks`, { include: TRACK_INCLUDE }, await appToken(), true);
          const { items } = tracksOf(doc);
          return { items, total: items.length };
        });
      });

      app.get<{ Querystring: Record<string, string> }>(`${base}/library/tracks`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => {
            const token = await kit.userToken(req.user!.id);
            const doc = await api(`/userCollections/me/relationships/tracks`, { include: TRACK_INCLUDE }, token);
            const { items } = tracksOf(doc);
            return { items: items.slice(0, intParam(req.query.limit, 50, 1, 100)), total: items.length };
          },
          { userCall: true },
        );
      });

      app.get(`${base}/playlists`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        return kit.guard(
          req,
          reply,
          async () => {
            const token = await kit.userToken(req.user!.id);
            const me = await api<Doc>("/users/me", {}, token);
            const meId = Array.isArray(me.data) ? undefined : me.data?.id;
            if (!meId || !/^\d{1,20}$/.test(meId)) throw new UpstreamError(NAME, "bad_response");
            const doc = await api("/playlists", { "filter[r.owners.id]": meId, include: "coverArt" }, token);
            const inc = new Included(doc);
            const out = (Array.isArray(doc.data) ? doc.data : [])
              .map((r) => toPlaylist(r, inc))
              .filter((p): p is StreamPlaylist => p !== null);
            return { items: out, total: out.length };
          },
          { userCall: true },
        );
      });

      app.get<{ Params: { id: string } }>(`${base}/playlists/:id/tracks`, { preHandler: requireUser }, async (req, reply) => {
        if (!kit.configured()) return kit.notConfigured(reply);
        const id = idParam(req.params.id);
        if (!id) return reply.code(400).send({ error: "invalid_id" });
        return kit.guard(
          req,
          reply,
          async () => {
            const token = await kit.userToken(req.user!.id);
            const doc = await api(`/playlists/${id}/relationships/items`, { include: "items,items.artists,items.albums,items.albums.coverArt" }, token);
            // The relationship lists its entries as "tracks" (and videos); the items are in `included`.
            const inc = new Included(doc);
            const refs = Array.isArray(doc.data) ? doc.data : [];
            const items = refs
              .filter((r) => r.type === "tracks")
              .map((r) => inc.get(r))
              .filter((r): r is Resource => !!r)
              .map((r) => toTrack(r, inc))
              .filter((t): t is StreamTrack => t !== null);
            return { items, total: items.length };
          },
          { userCall: true },
        );
      });
    },
  };
}

export default createTidalPlugin();
