import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerPluginContext } from "../../plugins/types.js";
import { contentTypeFor } from "../../library/scanner.js";
import { parseAddress } from "./net.js";
import { signedTrackUrl, streamBaseUrl, parseTrackId } from "./streamUrls.js";

/** A speaker or TV the server can send audio to (UPnP renderer, Chromecast...). */
export interface RendererDevice {
  id: string;
  name: string;
  /** What kind of device it is, so the UI can label it: "sonos", "upnp", "chromecast"... */
  kind: string;
  model?: string;
  manufacturer?: string;
  address: string;
  manual?: boolean;
}

export interface LoadRequest {
  url: string;
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
  durationSec?: number;
  /** MIME type of the stream, when known. */
  mime?: string;
  startSec: number;
  autoplay: boolean;
}

export type RendererState = "playing" | "paused" | "stopped" | "buffering" | "unknown";

export interface RendererStatus {
  state: RendererState;
  positionSec?: number;
  durationSec?: number;
  /** 0..1 */
  volume?: number;
  muted?: boolean;
}

/** A connection to one device. Implementations throw `DeviceError` for failures worth showing the person. */
export interface RendererSession {
  load(req: LoadRequest): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  seek(positionSec: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  status(): Promise<RendererStatus>;
}

export interface RendererBackend {
  list(): RendererDevice[];
  /** Look for devices again (waits for replies). */
  refresh(): Promise<void>;
  addManual(address: string): Promise<RendererDevice>;
  removeManual(id: string): boolean;
  session(id: string): RendererSession | null;
  /** Free-text status shown in the UI, e.g. when discovery found nothing. */
  info(): { discovering: boolean; lastScanAt: number | null; hint?: string };
}

/** A failure the person should see, with a short message that is safe to show (no stack traces or addresses). */
export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceError";
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 300): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export interface RendererRoutesOptions {
  /** URL prefix such as "dlna" -> /api/dlna/... */
  prefix: string;
  /** The plugin id whose saved config holds `streamBaseUrl`. */
  pluginId: string;
  backend: RendererBackend;
}

interface TrackRow {
  rel_path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
}

type PlayBody = {
  trackId?: string;
  positionSec?: number;
  autoplay?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  durationSec?: number;
  volume?: number;
};

/** Shared HTTP surface for "send the audio to a device on the network" plugins. */
export function registerRendererRoutes(app: FastifyInstance, ctx: ServerPluginContext, opts: RendererRoutesOptions): void {
  const { backend, prefix, pluginId } = opts;
  const base = `/api/${prefix}`;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DeviceError) return reply.code(502).send({ error: "device_error", message: err.message });
    ctx.log.warn({ err }, "device call failed");
    return reply.code(502).send({ error: "device_error", message: "The device did not respond." });
  };
  const config = () => ctx.settings.pluginConfig<{ streamBaseUrl?: string }>(pluginId) ?? {};

  app.get<{ Querystring: { refresh?: string } }>(`${base}/devices`, { preHandler: ctx.requireUser }, async (req) => {
    if (req.query.refresh === "1") await backend.refresh().catch((err) => ctx.log.warn({ err }, "device scan failed"));
    return { devices: backend.list(), ...backend.info() };
  });

  app.post<{ Body: { address?: string } }>(`${base}/devices/manual`, { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const address = str(req.body?.address);
    if (!address) return reply.code(400).send({ error: "invalid_address" });
    try {
      return await backend.addManual(address);
    } catch (err) {
      if (err instanceof DeviceError) return reply.code(422).send({ error: "device_error", message: err.message });
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>(`${base}/devices/manual/:id`, { preHandler: ctx.requireAdmin }, async (req, reply) => {
    if (!backend.removeManual(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { removed: true };
  });

  app.get(`${base}/config`, { preHandler: ctx.requireUser }, async () => ({ streamBaseUrl: config().streamBaseUrl ?? null }));
  app.put<{ Body: { streamBaseUrl?: string | null } }>(`${base}/config`, { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const raw = req.body?.streamBaseUrl;
    let value: string | null = null;
    if (typeof raw === "string" && raw.trim()) {
      const url = parseAddress(raw);
      if (!url) return reply.code(400).send({ error: "invalid_url" });
      value = url.origin;
    }
    ctx.settings.setPluginConfig(pluginId, { ...config(), streamBaseUrl: value ?? undefined });
    return { streamBaseUrl: value };
  });

  function sessionFor(id: string, reply: FastifyReply): RendererSession | null {
    const session = backend.session(id);
    if (!session) {
      void reply.code(404).send({ error: "device_not_found" });
      return null;
    }
    return session;
  }

  app.post<{ Params: { id: string }; Body: PlayBody }>(`${base}/devices/:id/play`, { preHandler: ctx.requireUser }, async (req, reply) => {
    const session = sessionFor(req.params.id, reply);
    if (!session) return reply;
    const body = req.body ?? {};
    const trackId = str(body.trackId, 400);
    const ref = trackId ? parseTrackId(trackId) : null;
    if (!trackId || !ref) {
      return reply.code(422).send({
        error: "unsupported_track",
        message: "Only tracks from your Cadence server or Jellyfin can be played on a device.",
      });
    }
    const url = signedTrackUrl({
      secret: ctx.secret,
      trackId,
      userId: req.user!.id,
      base: streamBaseUrl(req, config().streamBaseUrl),
    });
    if (!url) return reply.code(422).send({ error: "unsupported_track" });

    let title = str(body.title) ?? "Cadence";
    let artist = str(body.artist);
    let album = str(body.album);
    let durationSec = num(body.durationSec);
    let mime: string | undefined;
    if (ref.kind === "server") {
      const row = ctx.db
        .prepare("SELECT rel_path, title, artist, album, duration_sec FROM tracks WHERE id = ?")
        .get(ref.id) as TrackRow | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      title = row.title;
      artist = row.artist ?? artist;
      album = row.album ?? album;
      durationSec = row.duration_sec ?? durationSec;
      mime = contentTypeFor(row.rel_path);
    }
    const artwork = str(body.artwork, 500);
    try {
      await session.load({
        url,
        title,
        artist,
        album,
        artwork: artwork && /^https?:\/\//i.test(artwork) ? artwork : undefined,
        durationSec,
        mime,
        startSec: Math.max(0, num(body.positionSec) ?? 0),
        autoplay: body.autoplay !== false,
      });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  for (const action of ["pause", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`${base}/devices/:id/${action}`, { preHandler: ctx.requireUser }, async (req, reply) => {
      const session = sessionFor(req.params.id, reply);
      if (!session) return reply;
      try {
        await session[action]();
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    });
  }

  app.post<{ Params: { id: string }; Body: PlayBody }>(`${base}/devices/:id/seek`, { preHandler: ctx.requireUser }, async (req, reply) => {
    const session = sessionFor(req.params.id, reply);
    if (!session) return reply;
    const pos = num(req.body?.positionSec);
    if (pos === undefined || pos < 0) return reply.code(400).send({ error: "invalid_position" });
    try {
      await session.seek(pos);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: PlayBody }>(`${base}/devices/:id/volume`, { preHandler: ctx.requireUser }, async (req, reply) => {
    const session = sessionFor(req.params.id, reply);
    if (!session) return reply;
    const volume = num(req.body?.volume);
    if (volume === undefined) return reply.code(400).send({ error: "invalid_volume" });
    try {
      await session.setVolume(Math.min(1, Math.max(0, volume)));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(`${base}/devices/:id/status`, { preHandler: ctx.requireUser }, async (req, reply) => {
    const session = sessionFor(req.params.id, reply);
    if (!session) return reply;
    try {
      return await session.status();
    } catch (err) {
      return fail(reply, err);
    }
  });
}
