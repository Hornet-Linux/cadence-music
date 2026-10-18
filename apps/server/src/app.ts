import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { OidcClient, type FetchFn } from "./auth/oidc.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { userForToken } from "./auth/sessions.js";
import { registerWebApp } from "./web/webApp.js";
import { Settings } from "./settings.js";
import { adminPlugin } from "./admin/plugin.js";
import { historyPlugin } from "./history/plugin.js";
import { collectionPlugin } from "./collection/plugin.js";
import { integrationsPlugin } from "./integrations/plugin.js";
import { libraryPlugin } from "./library/plugin.js";
import type { ServerPlugin } from "./plugins/types.js";

export const builtinPlugins: ServerPlugin[] = [
  libraryPlugin,
  integrationsPlugin,
  historyPlugin,
  collectionPlugin,
  adminPlugin,
];

export interface AppDeps {
  config: Config;
  db: Db;
  secret: string;
  /** Pino options or false to disable logging (tests). */
  logger?: boolean | { level: string };
  /** Injectable fetch for OIDC (tests use a fake identity provider). */
  fetchFn?: FetchFn;
  plugins?: ServerPlugin[];
  /** Receives the first-run setup code of a server with no accounts. */
  onSetupCode?: (code: string) => void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, secret } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorateRequest("user", null);

  // The desktop app calls the API from its own origin with bearer tokens (no
  // cookies), so allowing any origin does not expose sessions.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    reply.header("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  async function requireUser(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const user = token ? userForToken(db, token) : null;
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    req.user = user;
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    if (reply.sent) return reply;
    if (!req.user?.is_admin) return reply.code(403).send({ error: "forbidden" });
  }

  const oidc =
    config.oidc && config.publicUrl
      ? new OidcClient(config.oidc, `${config.publicUrl}/api/auth/oidc/callback`, deps.fetchFn)
      : null;

  const settings = new Settings(db, config);
  registerAuthRoutes(app, { db, config, oidc, requireUser, settings, onSetupCode: deps.onSetupCode });
  registerWebApp(app, config.webDir);

  for (const plugin of deps.plugins ?? builtinPlugins) {
    await plugin.register(app, {
      db,
      config,
      secret,
      log: app.log.child({ plugin: plugin.id }),
      requireUser,
      requireAdmin,
      settings,
    });
  }

  return app;
}
