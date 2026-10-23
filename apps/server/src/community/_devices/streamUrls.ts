import type { FastifyRequest } from "fastify";
import { signedPath } from "../../jellyfin/signing.js";
import { streamPath } from "../../library/streamSigning.js";
import { isLoopbackHost, lanAddress } from "./net.js";

/** How long a stream link handed to a speaker stays valid. Long enough for a track and a pause, short enough to expire. */
export const DEVICE_STREAM_TTL_SEC = 45 * 60;

export interface TrackRef {
  /** Where the link points: a track in the server library or a Jellyfin item. */
  kind: "server" | "jellyfin";
  id: string;
}

/** Cadence track ids are "server:<id>" or "jellyfin:<id>"; other sources (Spotify, local files) cannot be fetched by a speaker. */
export function parseTrackId(trackId: string): TrackRef | null {
  const m = /^(server|jellyfin):([\w.~-]{1,200})$/.exec(trackId);
  return m ? { kind: m[1] as TrackRef["kind"], id: m[2]! } : null;
}

/**
 * The address a speaker should use to fetch audio from this server. An explicit override wins; otherwise it is
 * the address the caller used, except that "localhost" means nothing to a speaker, so the machine's LAN address
 * stands in for it.
 */
export function streamBaseUrl(req: FastifyRequest, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const hostHeader = req.headers.host ?? "localhost";
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
  const hostname = m?.[1] ?? hostHeader;
  const port = m?.[2];
  if (isLoopbackHost(hostname)) {
    const lan = lanAddress();
    if (lan) return `http://${lan}${port ? `:${port}` : ""}`;
  }
  return `${req.protocol}://${hostHeader}`;
}

/** A signed, expiring URL for a track, or null if the track's source cannot be fetched by a speaker. */
export function signedTrackUrl(opts: {
  secret: string;
  trackId: string;
  userId: number;
  base: string;
  now?: number;
  ttlSec?: number;
}): string | null {
  const ref = parseTrackId(opts.trackId);
  if (!ref) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? DEVICE_STREAM_TTL_SEC;
  const path =
    ref.kind === "server"
      ? streamPath(opts.secret, ref.id, ttl, now).path
      : signedPath(opts.secret, "stream", opts.userId, ref.id, now + ttl);
  return `${opts.base.replace(/\/+$/, "")}/${path}`;
}
