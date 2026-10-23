import type { Db } from "../db.js";
import { open, seal } from "../llm/secretBox.js";
import type { ServerPlugin } from "../plugins/types.js";

// The web player's Spotify connection. The server exchanges the sign-in code
// and keeps the refresh token (encrypted, per Cadence account); the page only
// ever gets short-lived access tokens. So a script on the page, or the next
// person on a shared browser, can't take the long-lived token. The desktop app
// keeps its own token in its main process and doesn't use this.

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PURPOSE = "spotify-refresh-tokens";
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const SPOTIFY_CALLBACK_PATH = "/app/spotify/callback";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface Row {
  client_id: string;
  refresh_enc: string;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export class SpotifyError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number,
  ) {
    super(`Spotify: ${reason}`);
  }
}

function ensureSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS spotify_sessions (
    user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    refresh_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

export function createSpotifySessionPlugin(opts: { fetchFn?: FetchFn } = {}): ServerPlugin {
  const fetchImpl: FetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  return {
    id: "core.spotify-session",
    name: "Spotify for the web player",
    version: "1.0.0",
    register(app, ctx) {
      const { db, secret, requireUser } = ctx;
      ensureSchema(db);
      const access = new Map<number, { accessToken: string; expiresAt: number }>();
      const refreshing = new Map<number, Promise<{ accessToken: string; expiresAt: number }>>();

      async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
        let res: Response;
        try {
          res = await fetchImpl(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params).toString(),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          throw new SpotifyError("unreachable", 502);
        }
        const body = (await res.json().catch(() => ({}))) as Partial<Tokens> & { error?: string };
        if (!res.ok || !body.access_token || typeof body.expires_in !== "number") {
          throw new SpotifyError(typeof body.error === "string" ? body.error.slice(0, 60) : `status_${res.status}`, res.status === 400 ? 400 : 502);
        }
        return body as Tokens;
      }

      function save(userId: number, clientId: string, tokens: Tokens, previousRefresh?: string) {
        const refresh = tokens.refresh_token ?? previousRefresh;
        if (!refresh) throw new SpotifyError("no_refresh_token", 502);
        db.prepare(
          `INSERT INTO spotify_sessions (user_id, client_id, refresh_enc, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET client_id = excluded.client_id, refresh_enc = excluded.refresh_enc, updated_at = excluded.updated_at`,
        ).run(userId, clientId, seal(refresh, secret, PURPOSE), Date.now());
        const token = { accessToken: tokens.access_token, expiresAt: Date.now() + Math.max(60, tokens.expires_in) * 1000 };
        access.set(userId, token);
        return token;
      }

      function forget(userId: number) {
        db.prepare("DELETE FROM spotify_sessions WHERE user_id = ?").run(userId);
        access.delete(userId);
      }

      function row(userId: number): Row | undefined {
        return db.prepare("SELECT client_id, refresh_enc FROM spotify_sessions WHERE user_id = ?").get(userId) as Row | undefined;
      }

      async function accessToken(userId: number) {
        const cached = access.get(userId);
        if (cached && cached.expiresAt - Date.now() > 60_000) return cached;
        let pending = refreshing.get(userId);
        if (!pending) {
          pending = (async () => {
            const r = row(userId);
            const refresh = r ? open(r.refresh_enc, secret, PURPOSE) : null;
            if (!r || !refresh) throw new SpotifyError("not_connected", 404);
            try {
              return save(userId, r.client_id, await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, client_id: r.client_id }), refresh);
            } catch (e) {
              // Revoked or expired at Spotify: the connection is gone.
              if (e instanceof SpotifyError && e.reason === "invalid_grant") forget(userId);
              throw e;
            }
          })().finally(() => refreshing.delete(userId));
          refreshing.set(userId, pending);
        }
        return pending;
      }

      const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
        if (e instanceof SpotifyError) return reply.code(e.status).send({ error: "spotify_failed", reason: e.reason });
        throw e;
      };

      app.get("/api/me/spotify", { preHandler: requireUser }, async (req) => {
        const r = row(req.user!.id);
        return { connected: !!r, clientId: r?.client_id ?? null };
      });

      // Finish the sign-in: the page sends the code and its PKCE verifier; the server redeems them.
      app.post<{ Body: { code?: unknown; codeVerifier?: unknown; clientId?: unknown; redirectUri?: unknown } }>(
        "/api/me/spotify/connect",
        { preHandler: requireUser },
        async (req, reply) => {
          const { code, codeVerifier, clientId, redirectUri } = req.body ?? {};
          if (
            typeof code !== "string" || !/^[\w-]{10,1000}$/.test(code) ||
            typeof codeVerifier !== "string" || !/^[\w.~-]{43,128}$/.test(codeVerifier) ||
            typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId) ||
            typeof redirectUri !== "string" || !validRedirect(redirectUri)
          ) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          try {
            const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier });
            return save(req.user!.id, clientId, tokens);
          } catch (e) {
            return fail(reply, e);
          }
        },
      );

      // A refresh token an older web player kept in localStorage moves here once.
      app.post<{ Body: { clientId?: unknown; refreshToken?: unknown } }>("/api/me/spotify/import", { preHandler: requireUser }, async (req, reply) => {
        const { clientId, refreshToken } = req.body ?? {};
        if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId) || typeof refreshToken !== "string" || refreshToken.length > 2000 || !refreshToken) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        try {
          return save(req.user!.id, clientId, await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }), refreshToken);
        } catch (e) {
          return fail(reply, e);
        }
      });

      app.post("/api/me/spotify/token", { preHandler: requireUser }, async (req, reply) => {
        try {
          return await accessToken(req.user!.id);
        } catch (e) {
          return fail(reply, e);
        }
      });

      app.delete("/api/me/spotify", { preHandler: requireUser }, async (req, reply) => {
        forget(req.user!.id);
        return reply.code(204).send();
      });
    },
  };
}

/** The web player's own Spotify callback, on any http(s) origin (the address the listener uses). */
function validRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && u.pathname === SPOTIFY_CALLBACK_PATH && !u.search && !u.hash && !u.username;
  } catch {
    return false;
  }
}

export const spotifySessionPlugin = createSpotifySessionPlugin();
