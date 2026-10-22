import type { FastifyInstance, FastifyReply } from "fastify";
import { open, seal } from "../../llm/secretBox.js";
import type { ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { registerNetworkAdminRoutes } from "../../sources/adminRoutes.js";
import { readHead } from "../../sources/net.js";
import { RemoteError } from "../../sources/indexer.js";
import { networkPolicy } from "../../sources/policy.js";
import { SourceRuntime, type RuntimeOptions } from "../../sources/runtime.js";
import { stripControlChars } from "../../sources/text.js";
import { authorizeUrl, makeState, readState, tokenRequest } from "./oauth.js";
import { providers, type Api, type CloudProvider, type FolderRef, type ProviderEndpoints, type ProviderId } from "./providers.js";

/*
 * UNTESTED AGAINST THE REAL SERVICES. See providers.ts. The OAuth app registration, consent screens and
 * token behaviour of Google and Microsoft are only imitated by the test doubles in fakeCloud.ts.
 */

export const CLOUD_PLUGIN_ID = "cadence.onedrive-gdrive";
const AREA = "onedrive-gdrive";
const SECRET_PURPOSE = "cadence-cloud-oauth-client-secrets";
const TOKEN_PURPOSE = "cadence-cloud-refresh-tokens";
const MAX_FOLDERS = 50;
const EXPIRY_MARGIN_MS = 60_000;

/** The server owner's OAuth app for each provider (settings.pluginConfig). The client secret is sealed. */
interface AppConfig {
  google?: { clientId: string; clientSecretEnc: string };
  microsoft?: { clientId: string; clientSecretEnc: string; tenant?: string };
}

/** What is saved for one person and one provider. The refresh token is sealed. */
interface Stored {
  refreshTokenEnc: string;
  account: string | null;
  /** Folders to index; empty means the whole drive. */
  folders: FolderRef[];
  /** The service refused the refresh token (revoked or expired): the person has to connect again. */
  needsReconnect?: boolean;
}

type UserStored = Partial<Record<ProviderId, Stored>>;

interface Conn {
  provider: CloudProvider;
  api: Api;
  folders: FolderRef[];
  account: string | null;
}

export interface CloudPluginOptions {
  runtime?: RuntimeOptions;
  env?: NodeJS.ProcessEnv;
  /** Tests point the providers at test doubles. */
  endpoints?: Partial<Record<ProviderId, ProviderEndpoints>>;
  now?: () => number;
}

function cleanFolders(provider: CloudProvider, value: unknown): FolderRef[] | null {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return null;
  const out: FolderRef[] = [];
  for (const raw of value) {
    const f = raw as Partial<FolderRef> | null;
    if (!f || typeof f.id !== "string" || typeof f.name !== "string" || f.id === "root" || !provider.validId(f.id)) return null;
    if (!out.some((o) => o.id === f.id)) out.push({ id: f.id, name: stripControlChars(f.name.slice(0, 200)) });
  }
  return out;
}

const page = (title: string, message: string, back: string | null): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f3ef;color:#2b2b2b}main{max-width:420px;padding:24px}h1{font-size:20px}a{color:#3b5b7a}` +
  `@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#e7e5e0}a{color:#9db8d2}}</style></head><body><main><h1>${title}</h1><p>${message}</p>` +
  `${back ? `<p><a href="${back}">Back to Cadence</a></p>` : ""}</main></body></html>`;

/**
 * Google Drive and OneDrive as read-only music sources, through their official OAuth APIs. The server owner
 * registers an OAuth app with each provider and enters its client ID and secret in the plugin's settings;
 * each person then signs in with their own account. Only read access is requested. Refresh tokens are kept
 * sealed with the server secret and access tokens are never stored.
 *
 * UNTESTED AGAINST THE REAL SERVICES (see providers.ts).
 */
export function createCloudDrivePlugin(options: CloudPluginOptions = {}): ServerPlugin {
  return {
    id: CLOUD_PLUGIN_ID,
    name: "Google Drive & OneDrive",
    version: "1.0.0",
    register(app: FastifyInstance, ctx: ServerPluginContext) {
      const { settings, secret, requireUser, requireAdmin, config } = ctx;
      const policy = () => networkPolicy(settings, options.env);
      const now = options.now ?? (() => Date.now());
      const redirectUri = config.publicUrl ? `${config.publicUrl}/api/${AREA}/callback` : null;

      const appConfig = (): AppConfig => settings.pluginConfig<AppConfig>(CLOUD_PLUGIN_ID) ?? {};
      const endpointsFor = (p: CloudProvider): ProviderEndpoints => options.endpoints?.[p.id] ?? p.endpoints(p.id === "microsoft" ? appConfig().microsoft?.tenant : undefined);
      const clientFor = (p: CloudProvider): { clientId: string; clientSecret: string } | null => {
        const c = appConfig()[p.id];
        if (!c) return null;
        const clientSecret = open(c.clientSecretEnc, secret, SECRET_PURPOSE);
        return clientSecret === null ? null : { clientId: c.clientId, clientSecret };
      };
      const userStored = (userId: number): UserStored => settings.pluginUserConfig<UserStored>(CLOUD_PLUGIN_ID, userId) ?? {};
      const saveStored = (userId: number, next: UserStored) =>
        settings.setPluginUserConfig(CLOUD_PLUGIN_ID, userId, Object.keys(next).length ? next : null);

      // ---- access tokens: kept in memory only, refreshed on demand --------------------------------------
      const cache = new Map<string, { token: string; expiresAt: number }>();
      const pending = new Map<string, Promise<string>>();

      async function accessToken(p: CloudProvider, userId: number): Promise<string> {
        const key = `${p.id}:${userId}`;
        const hit = cache.get(key);
        if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.token;
        const inflight = pending.get(key);
        if (inflight) return inflight;
        const job = (async () => {
          const stored = userStored(userId)[p.id];
          const client = clientFor(p);
          if (!stored || stored.needsReconnect) throw new RemoteError("needs_reconnect");
          if (!client) throw new RemoteError("not_configured");
          const refreshToken = open(stored.refreshTokenEnc, secret, TOKEN_PURPOSE);
          if (refreshToken === null) throw new RemoteError("needs_reconnect");
          try {
            const fields: Record<string, string> = {
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: client.clientId,
              client_secret: client.clientSecret,
            };
            if (p.id === "microsoft") fields.scope = p.scopes;
            const t = await tokenRequest(endpointsFor(p).token, fields, policy());
            // Microsoft hands out a new refresh token each time; the old one stops working.
            if (t.refreshToken && t.refreshToken !== refreshToken) {
              const latest = userStored(userId);
              if (latest[p.id]) saveStored(userId, { ...latest, [p.id]: { ...latest[p.id]!, refreshTokenEnc: seal(t.refreshToken, secret, TOKEN_PURPOSE) } });
            }
            cache.set(key, { token: t.accessToken, expiresAt: now() + t.expiresIn * 1000 });
            return t.accessToken;
          } catch (e) {
            if (e instanceof RemoteError && e.code === "needs_reconnect") {
              const latest = userStored(userId);
              if (latest[p.id]) saveStored(userId, { ...latest, [p.id]: { ...latest[p.id]!, needsReconnect: true } });
              cache.delete(key);
            }
            throw e;
          }
        })().finally(() => pending.delete(key));
        pending.set(key, job);
        return job;
      }

      const apiFor = (p: CloudProvider, userId: number): Api => ({
        token: () => accessToken(p, userId),
        invalidate: () => cache.delete(`${p.id}:${userId}`),
        policy: policy(),
        base: endpointsFor(p).api,
      });

      const read =
        (p: CloudProvider) =>
        (userId: number): Conn | null => {
          const stored = userStored(userId)[p.id];
          if (!stored || stored.needsReconnect || !clientFor(p)) return null;
          return { provider: p, api: apiFor(p, userId), folders: stored.folders, account: stored.account };
        };

      const runtimes = {} as Record<ProviderId, SourceRuntime<Conn>>;
      for (const p of Object.values(providers)) {
        runtimes[p.id] = new SourceRuntime<Conn>(
          ctx,
          {
            area: `${AREA}/${p.id}`,
            source: p.source,
            label: p.label,
            pluginId: CLOUD_PLUGIN_ID,
            connection: read(p),
            describe: (_userId, c) => ({ account: c.account, folders: c.folders }),
            driver: (userId, c) => ({
              list: (signal) => p.walkAudio(apiFor(p, userId), c.folders.length ? c.folders : [{ id: "root", name: "" }], signal),
              readHead: async (file, bytes, signal) => {
                const res = await p.open(apiFor(p, userId), file.path, `bytes=0-${bytes - 1}`, signal);
                if (res.status !== 200 && res.status !== 206) {
                  res.body.destroy();
                  throw res.status === 404 ? new RemoteError("not_found") : new RemoteError("upstream", undefined, res.status);
                }
                return readHead(res, bytes);
              },
            }),
            open: (userId, _c, track, range, signal) => p.open(apiFor(p, userId), track.path, range, signal),
            disconnect: (userId) => {
              const latest = userStored(userId);
              delete latest[p.id];
              saveStored(userId, latest);
              cache.delete(`${p.id}:${userId}`);
            },
          },
          options.runtime,
        );
        runtimes[p.id].register(app);
      }
      registerNetworkAdminRoutes(app, ctx, AREA, options.env);

      const providerOf = (id: string): CloudProvider | null => (id === "google" || id === "microsoft" ? providers[id] : null);

      // ---- status for the settings screen ----------------------------------------------------------------
      app.get(`/api/${AREA}/status`, { preHandler: requireUser }, async (req) => {
        const userId = req.user!.id;
        const stored = userStored(userId);
        const out: Record<string, unknown> = { redirectUri, publicUrlSet: !!config.publicUrl };
        for (const p of Object.values(providers)) {
          const rt = runtimes[p.id];
          const conn = read(p)(userId);
          out[p.id] = {
            label: p.label,
            configured: !!clientFor(p),
            connected: !!conn,
            needsReconnect: !!stored[p.id]?.needsReconnect,
            account: conn?.account ?? stored[p.id]?.account ?? null,
            folders: conn?.folders ?? [],
            trackCount: rt.store.count(userId),
            indexing: rt.indexingState(userId),
          };
        }
        return out;
      });

      // ---- the owner's OAuth apps --------------------------------------------------------------------------
      const appsView = () => {
        const c = appConfig();
        return {
          redirectUri,
          google: { configured: !!c.google, clientId: c.google?.clientId ?? null },
          microsoft: { configured: !!c.microsoft, clientId: c.microsoft?.clientId ?? null, tenant: c.microsoft?.tenant ?? null },
        };
      };
      app.get(`/api/${AREA}/apps`, { preHandler: requireAdmin }, async () => appsView());
      app.put<{ Body: { provider?: unknown; clientId?: unknown; clientSecret?: unknown; tenant?: unknown } }>(
        `/api/${AREA}/apps`,
        { preHandler: requireAdmin },
        async (req, reply) => {
          const b = req.body ?? {};
          const p = typeof b.provider === "string" ? providerOf(b.provider) : null;
          const clientId = typeof b.clientId === "string" ? b.clientId.trim() : "";
          const clientSecret = typeof b.clientSecret === "string" ? b.clientSecret.trim() : "";
          if (!p || !/^[\w.\-~:/+@]{8,300}$/.test(clientId)) return reply.code(400).send({ error: "bad_request", message: "Enter the client ID of your OAuth app" });
          const current = appConfig();
          const existing = current[p.id];
          if (!clientSecret && !existing) return reply.code(400).send({ error: "bad_request", message: "Enter the client secret of your OAuth app" });
          if (clientSecret.length > 500) return reply.code(400).send({ error: "bad_request", message: "That client secret is too long" });
          const clientSecretEnc = clientSecret ? seal(clientSecret, secret, SECRET_PURPOSE) : existing!.clientSecretEnc;
          if (p.id === "google") current.google = { clientId, clientSecretEnc };
          else {
            const tenant = typeof b.tenant === "string" && b.tenant.trim() ? b.tenant.trim() : undefined;
            if (tenant && !/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) return reply.code(400).send({ error: "bad_request", message: "That tenant isn't valid. Use common, consumers, organizations or a tenant ID." });
            current.microsoft = { clientId, clientSecretEnc, tenant };
          }
          settings.setPluginConfig(CLOUD_PLUGIN_ID, current);
          return appsView();
        },
      );
      app.delete<{ Params: { provider: string } }>(`/api/${AREA}/apps/:provider`, { preHandler: requireAdmin }, async (req, reply) => {
        const p = providerOf(req.params.provider);
        if (!p) return reply.code(404).send({ error: "not_found" });
        const current = appConfig();
        delete current[p.id];
        settings.setPluginConfig(CLOUD_PLUGIN_ID, Object.keys(current).length ? current : null);
        return reply.code(204).send();
      });

      // ---- signing in -----------------------------------------------------------------------------------
      app.post<{ Params: { provider: string } }>(`/api/${AREA}/:provider/authorize`, { preHandler: requireUser }, async (req, reply) => {
        const p = providerOf(req.params.provider);
        if (!p) return reply.code(404).send({ error: "not_found" });
        const client = clientFor(p);
        if (!client) return reply.code(409).send({ error: `${AREA}_not_configured`, message: `${p.label} isn't set up on this server. Ask the server owner to add an OAuth app.` });
        if (!redirectUri) return reply.code(409).send({ error: `${AREA}_no_public_url`, message: "The server owner needs to set PUBLIC_URL before cloud sign-in can work." });
        const s = makeState(secret, p.id, req.user!.id, Math.floor(now() / 1000));
        return {
          url: authorizeUrl({
            authorizeEndpoint: endpointsFor(p).authorize,
            clientId: client.clientId,
            redirectUri,
            scopes: p.scopes,
            state: s.state,
            challenge: s.challenge,
            extra: p.extraAuthorizeParams,
          }),
        };
      });

      const sendPage = (reply: FastifyReply, status: number, title: string, message: string) =>
        reply
          .code(status)
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .send(page(title, message, config.publicUrl ? `${config.publicUrl}/app/` : null));

      app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`/api/${AREA}/callback`, async (req, reply) => {
        const q = req.query;
        const st = typeof q.state === "string" ? readState(secret, q.state, Math.floor(now() / 1000)) : null;
        if (!st) return sendPage(reply, 400, "That link has expired", "Start the connection again from Cadence's settings.");
        const p = providers[st.p];
        if (typeof q.error === "string") return sendPage(reply, 400, "Not connected", `${p.label} was not connected. You can try again from Cadence's settings.`);
        const client = clientFor(p);
        if (typeof q.code !== "string" || q.code.length > 2048 || !client || !redirectUri) {
          return sendPage(reply, 400, "Not connected", `${p.label} could not be connected. Ask the server owner to check the OAuth app.`);
        }
        try {
          const t = await tokenRequest(
            endpointsFor(p).token,
            {
              grant_type: "authorization_code",
              code: q.code,
              redirect_uri: redirectUri,
              client_id: client.clientId,
              client_secret: client.clientSecret,
              code_verifier: st.verifier,
            },
            policy(),
          );
          if (!t.refreshToken) return sendPage(reply, 400, "Not connected", `${p.label} did not allow lasting access. Remove Cadence from your account's connected apps and try again.`);
          const temp: Api = { token: async () => t.accessToken, invalidate: () => undefined, policy: policy(), base: endpointsFor(p).api };
          const account = await p.account(temp).catch(() => null);
          const userId = st.u;
          const rt = runtimes[p.id];
          await rt.stop(userId);
          const all = userStored(userId);
          const prev = all[p.id];
          const sameAccount = !!prev && prev.account === account;
          saveStored(userId, { ...all, [p.id]: { refreshTokenEnc: seal(t.refreshToken, secret, TOKEN_PURPOSE), account, folders: sameAccount ? prev.folders : [] } });
          if (!sameAccount) rt.store.clear(userId);
          cache.set(`${p.id}:${userId}`, { token: t.accessToken, expiresAt: now() + t.expiresIn * 1000 });
          void rt.index(userId).catch(() => undefined);
          return sendPage(reply, 200, `${p.label} connected`, "You can close this tab and go back to Cadence. Your music is being indexed in the background.");
        } catch (e) {
          ctx.log.warn({ err: e instanceof Error ? e.message : String(e), provider: p.id }, "cloud sign-in failed");
          return sendPage(reply, 502, "Not connected", `${p.label} could not be connected. Ask the server owner to check the OAuth app, then try again.`);
        }
      });

      // ---- choosing folders -----------------------------------------------------------------------------
      app.get<{ Params: { provider: string }; Querystring: { parent?: string } }>(`/api/${AREA}/:provider/folders`, { preHandler: requireUser }, async (req, reply) => {
        const p = providerOf(req.params.provider);
        if (!p) return reply.code(404).send({ error: "not_found" });
        const userId = req.user!.id;
        if (!read(p)(userId)) return reply.code(409).send({ error: `${AREA}_not_connected`, message: `Connect ${p.label} first` });
        const parent = req.query.parent && req.query.parent !== "" ? req.query.parent : "root";
        if (!p.validId(parent)) return reply.code(400).send({ error: "bad_request", message: "That folder isn't valid" });
        try {
          return { parent, folders: await p.listFolders(apiFor(p, userId), parent) };
        } catch (e) {
          return runtimes[p.id].failure(reply, e, userId);
        }
      });

      app.put<{ Params: { provider: string }; Body: { folders?: unknown } }>(`/api/${AREA}/:provider/folders`, { preHandler: requireUser }, async (req, reply) => {
        const p = providerOf(req.params.provider);
        if (!p) return reply.code(404).send({ error: "not_found" });
        const userId = req.user!.id;
        const all = userStored(userId);
        const stored = all[p.id];
        if (!stored) return reply.code(409).send({ error: `${AREA}_not_connected`, message: `Connect ${p.label} first` });
        const folders = cleanFolders(p, req.body?.folders);
        if (folders === null) return reply.code(400).send({ error: "bad_request", message: "Those folders aren't valid" });
        saveStored(userId, { ...all, [p.id]: { ...stored, folders } });
        void runtimes[p.id].restart(userId).catch(() => undefined);
        return { folders };
      });
    },
  };
}

export default createCloudDrivePlugin();
