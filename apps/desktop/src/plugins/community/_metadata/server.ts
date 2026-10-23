import type { PluginContext } from "../../types";
import { useServer } from "../../builtins/server/serverStore";
import { createMetadataClient, MetadataError, type MetadataClient, type ServerRef } from "./client";

/** The Cadence server this device is signed in to, if any. */
export function currentServer(): ServerRef | null {
  const { url, token, user } = useServer.getState();
  return url && user ? { url, token } : null;
}

/** A metadata client that goes through the plugin guarded fetch (needs network.outbound). */
export function clientFor(ctx: Pick<PluginContext, "fetch">): MetadataClient {
  return createMetadataClient({ fetch: (...args) => ctx.fetch(...args), server: currentServer });
}

/** Admin only: save or clear service keys. A null or empty value clears one. */
export async function saveAdminConfig(ctx: Pick<PluginContext, "fetch">, body: Record<string, string | null>): Promise<void> {
  const server = currentServer();
  if (!server) throw new MetadataError("no_server", "Sign in to your Cadence server first.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (server.token) headers.authorization = "Bearer " + server.token;
  const res = await ctx.fetch(new URL("api/metadata/config", server.url.replace(/\/+$/, "") + "/").toString(), {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw new MetadataError("failed", "Only a server admin can change these.");
  if (!res.ok) throw new MetadataError("failed", "The server did not accept that.");
}
