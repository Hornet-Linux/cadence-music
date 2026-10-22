import type { ServerPlugin } from "../../plugins/types.js";
import { cleanCommand, cleanState } from "../_devices/hub.js";
import { DeviceHub, deviceHub } from "../_devices/deviceHub.js";

export const REMOTE_CONTROL_PLUGIN_ID = "cadence.remote-control";

const DEVICE_ID = /^[\w-]{8,64}$/;
const KINDS = new Set(["desktop", "web", "phone"]);

export interface RemoteControlOptions {
  hub?: DeviceHub;
  /** Milliseconds between keep-alive comments on each stream (proxies close idle connections). */
  keepAliveMs?: number;
}

/**
 * Control another Cadence player: each open player holds a server-sent-events stream here, and anything
 * the signed-in user sends to a device is relayed down that stream. Players report their state back with
 * POST /state, which is passed on to the user's other devices.
 */
export function createRemoteControlPlugin(options: RemoteControlOptions = {}): ServerPlugin {
  const hub = options.hub ?? deviceHub;
  return {
    id: REMOTE_CONTROL_PLUGIN_ID,
    name: "Remote control",
    version: "1.0.0",
    description:
      "Control one Cadence player from another: each open player keeps an event stream to the server and commands you send to a device are relayed to it. Only your own devices are listed.",
    configFields: [],
    register(app, ctx) {
      hub.active = true;
      app.addHook("onClose", async () => {
        hub.active = false;
        hub.closeAll();
      });
      ctx.jobs.every("remote-control-prune", 30_000, () => hub.prune());

      app.get<{ Querystring: { deviceId?: string; name?: string; kind?: string } }>(
        "/api/remote-control/stream",
        { preHandler: ctx.requireUser },
        async (req, reply) => {
          const { deviceId, name, kind } = req.query;
          if (!deviceId || !DEVICE_ID.test(deviceId)) return reply.code(400).send({ error: "invalid_device_id" });
          const userId = req.user!.id;
          const deviceName = (name ?? "").trim().slice(0, 60) || "Cadence player";

          reply.hijack();
          const raw = reply.raw;
          raw.writeHead(200, {
            ...(reply.getHeaders() as Record<string, string>),
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          const write = (chunk: string) => {
            if (!raw.destroyed && !raw.writableEnded) raw.write(chunk);
          };
          const conn = {
            send: (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            close: () => {
              if (!raw.writableEnded) raw.end();
            },
          };
          write("retry: 3000\n\n");
          const disconnect = hub.connect(userId, { id: deviceId, name: deviceName, kind: KINDS.has(kind ?? "") ? kind! : "web" }, conn);
          conn.send("hello", { deviceId, devices: hub.list(userId) });
          const keepAlive = setInterval(() => write(": keep-alive\n\n"), options.keepAliveMs ?? 20_000);
          keepAlive.unref();
          const end = () => {
            clearInterval(keepAlive);
            disconnect();
          };
          raw.on("close", end);
          return reply;
        },
      );

      app.get("/api/remote-control/devices", { preHandler: ctx.requireUser }, async (req) => ({ devices: hub.list(req.user!.id) }));

      app.post<{ Body: { deviceId?: string; state?: unknown } }>("/api/remote-control/state", { preHandler: ctx.requireUser }, async (req, reply) => {
        const { deviceId } = req.body ?? {};
        const state = cleanState(req.body?.state);
        if (!deviceId || !DEVICE_ID.test(deviceId) || !state) return reply.code(400).send({ error: "invalid_state" });
        if (!hub.updateState(req.user!.id, deviceId, state)) return reply.code(404).send({ error: "device_not_found" });
        return { ok: true };
      });

      app.post<{ Params: { id: string }; Body: { command?: unknown; from?: string } }>(
        "/api/remote-control/devices/:id/command",
        { preHandler: ctx.requireUser },
        async (req, reply) => {
          const command = cleanCommand(req.body?.command);
          if (!command) return reply.code(400).send({ error: "invalid_command" });
          const from = typeof req.body?.from === "string" && DEVICE_ID.test(req.body.from) ? req.body.from : null;
          const result = hub.deliver(req.user!.id, req.params.id, command, from);
          if (result === "unknown") return reply.code(404).send({ error: "device_not_found" });
          if (result === "offline") return reply.code(409).send({ error: "device_offline" });
          return reply.code(202).send({ delivered: true });
        },
      );
    },
  };
}

export default createRemoteControlPlugin();
