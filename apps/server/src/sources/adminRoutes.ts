import type { FastifyInstance } from "fastify";
import type { ServerPluginContext } from "../plugins/types.js";
import { networkPolicy, networkPolicySource, setAllowPrivateNetwork } from "./policy.js";

/**
 * Owner-only switch shared by every source plugin: may people connect to servers on private networks
 * (a NAS, MinIO at home)? Off by default. Each plugin mounts the same switch under its own area.
 */
export function registerNetworkAdminRoutes(app: FastifyInstance, ctx: ServerPluginContext, area: string, env: NodeJS.ProcessEnv = process.env): void {
  const read = () => ({ allowPrivateNetwork: networkPolicy(ctx.settings, env).allowPrivate, source: networkPolicySource(ctx.settings, env) });
  app.get(`/api/${area}/admin`, { preHandler: ctx.requireAdmin }, async () => read());
  app.put<{ Body: { allowPrivateNetwork?: unknown } }>(`/api/${area}/admin`, { preHandler: ctx.requireAdmin }, async (req, reply) => {
    if (typeof req.body?.allowPrivateNetwork !== "boolean") return reply.code(400).send({ error: "bad_request", message: "allowPrivateNetwork must be true or false" });
    setAllowPrivateNetwork(ctx.settings, req.body.allowPrivateNetwork);
    return read();
  });
}
