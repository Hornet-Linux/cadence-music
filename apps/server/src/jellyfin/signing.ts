import { createHmac } from "node:crypto";
import { safeEqual } from "../util/crypto.js";

/**
 * Audio and image elements can't send an Authorization header, so streams and
 * cover art use short-lived signed URLs. The signature binds the Cadence user
 * (whose Jellyfin sign-in is used), the Jellyfin item and the expiry, and the
 * kind ("stream" or "image") so one can't stand in for the other.
 */
export type SignedKind = "stream" | "image";

function sign(secret: string, kind: SignedKind, userId: number, itemId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`jf-${kind}:${userId}:${itemId}:${expiresAt}`).digest("base64url");
}

export function signedPath(
  secret: string,
  kind: SignedKind,
  userId: number,
  itemId: string,
  expiresAt: number,
): string {
  const sig = sign(secret, kind, userId, itemId, expiresAt);
  return `api/jellyfin/${kind}/${itemId}?u=${userId}&exp=${expiresAt}&sig=${sig}`;
}

export interface SignedQuery {
  u?: string;
  exp?: string;
  sig?: string;
}

/** The user id the URL was signed for, or null when the signature is missing, wrong or expired. */
export function verifySigned(
  secret: string,
  kind: SignedKind,
  itemId: string,
  query: SignedQuery,
  nowSec: number,
): number | null {
  const { u, exp, sig } = query;
  if (!u || !exp || !sig || !/^\d{1,12}$/.test(u) || !/^\d{1,12}$/.test(exp)) return null;
  const expiresAt = Number(exp);
  if (expiresAt < nowSec) return null;
  const userId = Number(u);
  return safeEqual(sign(secret, kind, userId, itemId, expiresAt), sig) ? userId : null;
}
