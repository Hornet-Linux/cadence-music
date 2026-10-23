import { existsSync } from "node:fs";
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

let containerCache: boolean | undefined;
/** True when the server runs inside a container, where its own network addresses are private to the container host. */
export function inContainer(): boolean {
  containerCache ??= existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.CADENCE_IN_CONTAINER === "1";
  return containerCache;
}

/**
 * The address a speaker should use to fetch audio from this server. In order: the plugin's own setting, the
 * server's PUBLIC_URL, then the address the person's player used to reach the server. "localhost" means nothing to
 * a speaker, so outside a container the machine's LAN address stands in for it. Inside a container the LAN
 * address is a private bridge address with the wrong port, so the player's address is kept and the picker warns.
 */
export function streamBaseUrl(req: FastifyRequest, override?: string, publicUrl?: string): string {
  if (override) return override.replace(/\/+$/, "");
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const hostHeader = req.headers.host ?? "localhost";
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
  const hostname = m?.[1] ?? hostHeader;
  const port = m?.[2];
  if (isLoopbackHost(hostname) && !inContainer()) {
    const lan = lanAddress();
    if (lan) return `http://${lan}${port ? `:${port}` : ""}`;
  }
  return `${req.protocol}://${hostHeader}`;
}

/** A plain hint when speakers on the network probably can't reach `base`, or null when it looks fine. */
export function streamAddressWarning(base: string, container = inContainer()): string | null {
  let host: string;
  try {
    host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  const fix = "Open Cadence using this computer's network address (for example http://192.168.1.10:8787), or set PUBLIC_URL on the server or the device address in Settings.";
  if (isLoopbackHost(host)) return `Speakers can't reach "${host}". ${fix}`;
  if (container && /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return `${host} is an address inside Docker that speakers can't reach. ${fix}`;
  return null;
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
