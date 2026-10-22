import type { ServerPlugin } from "../../plugins/types.js";
import { DeviceError } from "../_devices/rendererRoutes.js";
import { makeRpc, parseSnapAddress } from "./rpc.js";
import { SnapcastClient, validId } from "./snapcast.js";

export const SNAPCAST_PLUGIN_ID = "cadence.snapcast";

type Config = { address?: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Control an existing Snapcast server (multi-room audio) over its JSON-RPC API: see groups and clients,
 * change volume, mute and the stream a group plays. Cadence does not send audio into Snapcast.
 */
export function createSnapcastPlugin(options: { timeoutMs?: number } = {}): ServerPlugin {
  return {
    id: SNAPCAST_PLUGIN_ID,
    name: "Snapcast",
    version: "1.0.0",
    description:
      "Controls an existing Snapcast server (multi-room audio): groups, clients, volume, mute and the stream each group plays. Cadence does not send audio into Snapcast itself.",
    configFields: [
      { key: "address", label: "Snapcast server address", type: "text", placeholder: "snapserver:1705", help: "Host and JSON-RPC port (default 1705) of your snapserver." },
    ],
    register(app, ctx) {
      const address = () => ctx.settings.pluginConfig<Config>(SNAPCAST_PLUGIN_ID)?.address;
      const client = (): SnapcastClient | null => {
        const a = address();
        const ep = a ? parseSnapAddress(a) : null;
        return ep ? new SnapcastClient(makeRpc(ep, options.timeoutMs)) : null;
      };
      const fail = (err: unknown) => ({
        error: "device_error",
        message: err instanceof DeviceError ? err.message : "The Snapcast server did not respond.",
      });

      app.get("/api/snapcast/config", { preHandler: ctx.requireUser }, async () => ({ address: address() ?? null }));
      app.put<{ Body: { address?: string | null } }>("/api/snapcast/config", { preHandler: ctx.requireAdmin }, async (req, reply) => {
        const raw = req.body?.address;
        if (raw === null || raw === "") {
          ctx.settings.setPluginConfig(SNAPCAST_PLUGIN_ID, null);
          return { address: null };
        }
        if (typeof raw !== "string" || !parseSnapAddress(raw)) {
          return reply.code(400).send({ error: "invalid_address", message: "Use a host or IP such as 192.168.1.5 or 192.168.1.5:1705." });
        }
        ctx.settings.setPluginConfig(SNAPCAST_PLUGIN_ID, { address: raw.trim() });
        return { address: raw.trim() };
      });

      app.get("/api/snapcast/status", { preHandler: ctx.requireUser }, async (_req, reply) => {
        const c = client();
        if (!c) return { configured: false, groups: [], streams: [] };
        try {
          return { configured: true, ...(await c.status()) };
        } catch (err) {
          return reply.code(502).send(fail(err));
        }
      });

      type Run = (c: SnapcastClient, id: string, body: Record<string, unknown>) => Promise<void> | null;
      const action = (path: string, run: Run) =>
        app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(path, { preHandler: ctx.requireUser }, async (req, reply) => {
          const c = client();
          if (!c) return reply.code(409).send({ error: "not_configured", message: "No Snapcast server is set up yet." });
          if (!validId(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
          const job = run(c, req.params.id, req.body ?? {});
          if (!job) return reply.code(400).send({ error: "invalid_request" });
          try {
            await job;
            return { ok: true };
          } catch (err) {
            return reply.code(502).send(fail(err));
          }
        });

      action("/api/snapcast/clients/:id/volume", (c, id, b) => {
        const percent = num(b["percent"]);
        return percent === undefined ? null : c.setClientVolume(id, percent, typeof b["muted"] === "boolean" ? b["muted"] : undefined);
      });
      action("/api/snapcast/clients/:id/mute", (c, id, b) => (typeof b["muted"] === "boolean" ? c.setClientMuted(id, b["muted"]) : null));
      action("/api/snapcast/groups/:id/mute", (c, id, b) => (typeof b["muted"] === "boolean" ? c.setGroupMuted(id, b["muted"]) : null));
      action("/api/snapcast/groups/:id/stream", (c, id, b) =>
        typeof b["streamId"] === "string" && validId(b["streamId"]) ? c.setGroupStream(id, b["streamId"]) : null,
      );
      action("/api/snapcast/groups/:id/clients", (c, id, b) => {
        const list = b["clients"];
        return Array.isArray(list) && list.length > 0 && list.length <= 64 && list.every((x) => typeof x === "string" && validId(x))
          ? c.setGroupClients(id, list as string[])
          : null;
      });
    },
  };
}

export default createSnapcastPlugin();
