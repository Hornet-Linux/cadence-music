import { createHmac } from "node:crypto";
import { safeEqual } from "../util/crypto.js";

/**
 * Audio elements cannot send an Authorization header, so streams use
 * short-lived signed URLs: HMAC-SHA256 over the track id and expiry.
 */
export function signStream(secret: string, trackId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`stream:${trackId}:${expiresAt}`).digest("base64url");
}

export function verifyStream(
  secret: string,
  trackId: string,
  exp: string | undefined,
  sig: string | undefined,
  nowSec: number,
): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expiresAt = Number(exp);
  if (expiresAt < nowSec) return false;
  return safeEqual(signStream(secret, trackId, expiresAt), sig);
}

/** Signed stream path relative to the server base URL. */
export function streamPath(
  secret: string,
  trackId: string,
  ttlSec: number,
  nowSec: number,
): { path: string; expiresAt: number } {
  const expiresAt = nowSec + ttlSec;
  const sig = signStream(secret, trackId, expiresAt);
  return {
    path: `api/stream/${encodeURIComponent(trackId)}?exp=${expiresAt}&sig=${sig}`,
    expiresAt,
  };
}
