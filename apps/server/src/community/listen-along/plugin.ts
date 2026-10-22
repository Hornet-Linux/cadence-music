import type { HistoryTrack } from "@uma/shared";
import { RateLimiter } from "../../auth/rateLimit.js";
import { sanitizeTrack } from "../../history/plugin.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { cleanRoomCode, HubFailure, RoomHub, type RoomSink } from "./rooms.js";

const STATUS: Record<string, number> = { not_found: 404, not_host: 403, room_full: 409, too_many_rooms: 503 };

/** Format one server-sent event. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Listening rooms. A host starts a room and pushes its playback state; the server relays it to
 * every guest over server-sent events. Guests need an account on this server and the room code;
 * nothing is stored on disk and a person can only change the room they host.
 */
export function createListenAlongPlugin(hub = new RoomHub()): ServerPlugin {
  return {
    id: "cadence.listen-along",
    name: "Listen along",
    version: "1.0.0",
    description:
      "Listening rooms: one person hosts and their playback is relayed to everyone who joins with the room code, over server-sent events. Guests need an account here; rooms live in memory only and nothing is written to disk.",
    configFields: [],
    configNote: "Nothing to set here. It works as soon as it is turned on and the server restarts.",
    register(app, ctx) {
      const { requireUser } = ctx;
      const misses = new RateLimiter({ max: 30, windowMs: 5 * 60_000 });
      const nameOf = (u: { display_name: string | null; username: string }) => u.display_name || u.username;

      ctx.jobs.every("listen-along-ping", 20_000, () => hub.ping());
      ctx.jobs.every("listen-along-sweep", 60_000, () => void hub.sweep());

      const fail = (reply: Parameters<typeof requireUser>[1], err: unknown) => {
        if (err instanceof HubFailure) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code });
        throw err;
      };

      app.get("/api/listen-along/time", { preHandler: requireUser }, async () => ({ now: Date.now() }));

      app.get("/api/listen-along/mine", { preHandler: requireUser }, async (req) => ({
        room: hub.hostedBy(req.user!.id),
      }));

      app.post<{ Body: { name?: unknown } }>("/api/listen-along/rooms", { preHandler: requireUser }, async (req, reply) => {
        try {
          const name = typeof req.body?.name === "string" ? req.body.name : "";
          const room = hub.create({ id: req.user!.id, name: nameOf(req.user!) }, name);
          return reply.code(201).send({ room });
        } catch (err) {
          return fail(reply, err);
        }
      });

      const lookup = (code: unknown, userId: number) => {
        const id = cleanRoomCode(code);
        if (misses.isLimited(String(userId))) throw new HubFailure("not_found");
        const room = id ? hub.find(id) : null;
        if (!room) {
          misses.hit(String(userId));
          throw new HubFailure("not_found");
        }
        return room;
      };

      app.get<{ Params: { code: string } }>("/api/listen-along/rooms/:code", { preHandler: requireUser }, async (req, reply) => {
        try {
          const room = lookup(req.params.code, req.user!.id);
          return { room: { id: room.id, name: room.name, hostName: room.hostName, createdAt: room.createdAt }, state: room.state, listeners: room.listeners, serverNow: Date.now() };
        } catch (err) {
          return fail(reply, err);
        }
      });

      app.post<{ Params: { code: string }; Body: { track?: unknown; playing?: unknown; position?: unknown } }>(
        "/api/listen-along/rooms/:code/state",
        { preHandler: requireUser },
        async (req, reply) => {
          const body = req.body ?? {};
          const track: HistoryTrack | null = body.track == null ? null : sanitizeTrack(body.track);
          if (body.track != null && !track) return reply.code(400).send({ error: "invalid_track" });
          const position = typeof body.position === "number" && Number.isFinite(body.position) ? body.position : 0;
          try {
            const state = hub.setState(cleanRoomCode(req.params.code), req.user!.id, {
              track,
              playing: body.playing === true,
              position,
            });
            return { state, serverNow: Date.now() };
          } catch (err) {
            return fail(reply, err);
          }
        },
      );

      app.delete<{ Params: { code: string } }>("/api/listen-along/rooms/:code", { preHandler: requireUser }, async (req, reply) => {
        try {
          hub.end(cleanRoomCode(req.params.code), req.user!.id);
          return reply.code(204).send();
        } catch (err) {
          return fail(reply, err);
        }
      });

      // The event stream. EventSource cannot send an Authorization header, so clients read this with fetch().
      app.get<{ Params: { code: string } }>(
        "/api/listen-along/rooms/:code/events",
        { preHandler: requireUser },
        async (req, reply) => {
          let leave: (() => void) | null = null;
          const raw = reply.raw;
          const sink: RoomSink = {
            send: (event, data) => void raw.write(sseFrame(event, data)),
            close: () => raw.end(),
          };
          try {
            const id = lookup(req.params.code, req.user!.id).id;
            // subscribe() sends the first event, so the headers must already be out.
            reply.hijack();
            raw.writeHead(200, {
              ...reply.getHeaders(),
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            } as Record<string, string>);
            raw.write(": connected\n\n");
            try {
              leave = hub.subscribe(id, { id: req.user!.id, name: nameOf(req.user!) }, sink);
            } catch (err) {
              const code = err instanceof HubFailure ? err.code : "error";
              raw.write(sseFrame("error", { error: code }));
              raw.end();
              return;
            }
            const done = () => {
              leave?.();
              leave = null;
            };
            req.raw.on("close", done);
            raw.on("close", done);
          } catch (err) {
            if (!reply.sent && !reply.raw.headersSent) return fail(reply, err);
          }
        },
      );
    },
  };
}

export default createListenAlongPlugin();
