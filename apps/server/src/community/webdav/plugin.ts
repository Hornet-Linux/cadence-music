import { RateLimiter } from "../../auth/rateLimit.js";
import { open, seal } from "../../llm/secretBox.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { registerNetworkAdminRoutes } from "../../sources/adminRoutes.js";
import { RemoteError } from "../../sources/indexer.js";
import { parseSourceUrl, precheckUrl, SourceNetError } from "../../sources/net.js";
import { networkPolicy } from "../../sources/policy.js";
import { SourceRuntime, type RuntimeOptions } from "../../sources/runtime.js";
import { listFolders, normalizeDavPath, openFile, testConnection, walkAudio, type DavConnection } from "./client.js";
import { readHead } from "../../sources/net.js";

export const WEBDAV_PLUGIN_ID = "cadence.webdav";
const PURPOSE = "cadence-webdav-passwords";
const MAX_FOLDERS = 50;

/** What is saved for a person (settings.pluginUserConfig). The password is sealed with the server secret. */
interface Stored {
  url: string;
  username: string;
  passwordEnc: string;
  folders: string[];
}

interface Conn extends DavConnection {
  folders: string[];
}

export interface WebdavPluginOptions {
  /** Connection attempts per person per 10 minutes. */
  maxConnectAttempts?: number;
  runtime?: RuntimeOptions;
  env?: NodeJS.ProcessEnv;
}

function cleanFolders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return null;
  const out: string[] = [];
  for (const raw of value) {
    const p = typeof raw === "string" ? normalizeDavPath(raw) : null;
    if (p === null) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * WebDAV as a music source: Nextcloud, ownCloud and most NAS boxes. Each person saves the share's
 * address, user name and (app) password; the server lists the chosen folders, caches the tracks and
 * streams the files through itself, so apps never see the share or its password.
 */
export function createWebdavPlugin(options: WebdavPluginOptions = {}): ServerPlugin {
  return {
    id: WEBDAV_PLUGIN_ID,
    name: "WebDAV (Nextcloud, ownCloud, NAS)",
    version: "1.0.0",
    description:
      "Play music from WebDAV folders such as Nextcloud, ownCloud or a NAS. Each person adds their own address and sign-in; passwords are stored encrypted on this server.",
    configFields: [],
    configNote: "Nothing to set here. Each person adds their WebDAV folder in the player under Settings > Plugins.",
    register(app, ctx) {
      const { settings, secret, requireUser } = ctx;
      const policy = () => networkPolicy(settings, options.env);
      const limiter = new RateLimiter({ max: options.maxConnectAttempts ?? 10, windowMs: 10 * 60_000 });

      const read = (userId: number): Conn | null => {
        const stored = settings.pluginUserConfig<Stored>(WEBDAV_PLUGIN_ID, userId);
        if (!stored) return null;
        const password = open(stored.passwordEnc, secret, PURPOSE);
        if (password === null) {
          // Sealed with a different server secret, or damaged: it can't be used, so the person connects again.
          settings.setPluginUserConfig(WEBDAV_PLUGIN_ID, userId, null);
          return null;
        }
        return { baseUrl: stored.url, username: stored.username, password, folders: stored.folders };
      };

      const runtime = new SourceRuntime<Conn>(
        ctx,
        {
          area: "webdav",
          source: "webdav",
          label: "WebDAV",
          pluginId: WEBDAV_PLUGIN_ID,
          connection: read,
          describe: (_userId, c) => {
            const u = new URL(c.baseUrl);
            return { address: u.origin + u.pathname.replace(/\/+$/, ""), username: c.username, folders: c.folders };
          },
          driver: (_userId, c) => ({
            list: (signal) => walkAudio(c, c.folders, policy(), signal),
            readHead: async (file, bytes, signal) => {
              const res = await openFile(c, file.path, `bytes=0-${bytes - 1}`, policy(), signal);
              if (res.status !== 200 && res.status !== 206) {
                res.body.destroy();
                throw res.status === 404 ? new RemoteError("not_found") : new RemoteError("upstream", undefined, res.status);
              }
              return readHead(res, bytes);
            },
          }),
          open: (_userId, c, track, range, signal) => openFile(c, track.path, range, policy(), signal),
          disconnect: (userId) => settings.setPluginUserConfig(WEBDAV_PLUGIN_ID, userId, null),
        },
        options.runtime,
      );
      runtime.register(app);
      registerNetworkAdminRoutes(app, ctx, "webdav", options.env);

      app.put<{ Body: { url?: unknown; username?: unknown; password?: unknown; folders?: unknown } }>(
        "/api/webdav/connection",
        { preHandler: requireUser },
        async (req, reply) => {
          const userId = req.user!.id;
          const key = `u${userId}`;
          if (limiter.isLimited(key)) return reply.code(429).send({ error: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." });
          const b = req.body ?? {};
          if (typeof b.url !== "string" || typeof b.username !== "string" || typeof b.password !== "string") {
            return reply.code(400).send({ error: "bad_request", message: "Enter the address, user name and password" });
          }
          const username = b.username.trim();
          if (!username || username.length > 200 || b.password.length > 500) {
            return reply.code(400).send({ error: "bad_request", message: "Enter the user name and password" });
          }
          const folders = b.folders === undefined ? [] : cleanFolders(b.folders);
          if (folders === null) return reply.code(400).send({ error: "bad_request", message: "Those folders aren't valid" });
          limiter.hit(key);
          try {
            const url = parseSourceUrl(b.url, "WebDAV address");
            precheckUrl(url, policy());
            const baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
            const conn: Conn = { baseUrl, username, password: b.password, folders };
            await testConnection(conn, policy());
            const stored: Stored = { url: baseUrl, username, passwordEnc: seal(b.password, secret, PURPOSE), folders };
            await runtime.stop(userId); // never index with the old login while saving the new one
            const prev = settings.pluginUserConfig<Stored>(WEBDAV_PLUGIN_ID, userId);
            settings.setPluginUserConfig(WEBDAV_PLUGIN_ID, userId, stored);
            if (prev && (prev.url !== baseUrl || prev.username !== username)) runtime.store.clear(userId);
            void runtime.index(userId).catch(() => undefined);
            return { connected: true, address: baseUrl, username, folders };
          } catch (e) {
            if (e instanceof RemoteError && e.code === "auth_failed") {
              return reply.code(400).send({ error: "webdav_bad_credentials", message: "The server refused that user name or password" });
            }
            if (e instanceof RemoteError && e.code === "not_found") {
              return reply.code(400).send({ error: "webdav_not_found", message: "Nothing is at that address. For Nextcloud it ends in /remote.php/dav/files/YOUR-NAME/" });
            }
            if (e instanceof RemoteError && e.code === "bad_response") {
              return reply.code(400).send({ error: "webdav_not_webdav", message: "That address didn't answer like a WebDAV share" });
            }
            if (e instanceof SourceNetError || e instanceof RemoteError) return runtime.failure(reply, e, userId);
            throw e;
          }
        },
      );

      app.get<{ Querystring: { path?: string } }>("/api/webdav/folders", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const conn = read(userId);
        if (!conn) return reply.code(409).send({ error: "webdav_not_connected", message: "Connect WebDAV first" });
        const here = normalizeDavPath(req.query.path ?? "/");
        if (here === null) return reply.code(400).send({ error: "bad_request", message: "That folder isn't valid" });
        try {
          return { path: here, folders: await listFolders(conn, here, policy()) };
        } catch (e) {
          return runtime.failure(reply, e, userId);
        }
      });

      app.put<{ Body: { folders?: unknown } }>("/api/webdav/folders", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const stored = settings.pluginUserConfig<Stored>(WEBDAV_PLUGIN_ID, userId);
        if (!stored) return reply.code(409).send({ error: "webdav_not_connected", message: "Connect WebDAV first" });
        const folders = cleanFolders(req.body?.folders);
        if (folders === null) return reply.code(400).send({ error: "bad_request", message: "Those folders aren't valid" });
        settings.setPluginUserConfig(WEBDAV_PLUGIN_ID, userId, { ...stored, folders });
        void runtime.restart(userId).catch(() => undefined);
        return { folders };
      });
    },
  };
}

export default createWebdavPlugin();
