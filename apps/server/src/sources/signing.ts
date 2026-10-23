import { createHmac } from "node:crypto";
import { safeEqual } from "../util/crypto.js";

/**
 * Audio elements can't send an Authorization header, so streams use short-lived signed URLs.
 * The signature binds the source, the Cadence user (whose connection is used), the track and
 * the expiry, so one person's URL can't be turned into another's and a WebDAV link can't
 * stand in for an S3 one.
 */
function sign(secret: string, source: string, userId: number, trackId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`src-stream:${source}:${userId}:${trackId}:${expiresAt}`).digest("base64url");
}

export function signedStreamPath(secret: string, area: string, source: string, userId: number, trackId: string, expiresAt: number): string {
  const sig = sign(secret, source, userId, trackId, expiresAt);
  return `api/${area}/stream/${trackId}?u=${userId}&exp=${expiresAt}&sig=${sig}`;
}

export interface SignedQuery {
  u?: string;
  exp?: string;
  sig?: string;
}

/** The user id the URL was signed for, or null when the signature is missing, wrong or expired. */
export function verifySignedStream(secret: string, source: string, trackId: string, query: SignedQuery, nowSec: number): number | null {
  const { u, exp, sig } = query;
  if (!u || !exp || !sig || !/^\d{1,12}$/.test(u) || !/^\d{1,12}$/.test(exp)) return null;
  const expiresAt = Number(exp);
  if (expiresAt < nowSec) return null;
  const userId = Number(u);
  return safeEqual(sign(secret, source, userId, trackId, expiresAt), sig) ? userId : null;
}
