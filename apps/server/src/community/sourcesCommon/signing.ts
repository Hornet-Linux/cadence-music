import { createHmac } from "node:crypto";
import { safeEqual } from "../../util/crypto.js";

/**
 * Audio and image elements can't send an Authorization header, so streams and
 * cover art use short-lived signed URLs. The signature binds the service, the
 * kind ("stream" or "image"), the Cadence user (whose sign-in with the music
 * server is used), the item and the expiry, so one URL can't stand in for another.
 */
export type SignedKind = "stream" | "image";

function sign(secret: string, service: string, kind: SignedKind, userId: number, itemId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${service}-${kind}:${userId}:${itemId}:${expiresAt}`).digest("base64url");
}

/** A relative path such as `api/subsonic/stream/<id>?u=1&exp=...&sig=...`. */
export function signedPath(
  secret: string,
  service: string,
  kind: SignedKind,
  userId: number,
  itemId: string,
  expiresAt: number,
): string {
  const sig = sign(secret, service, kind, userId, itemId, expiresAt);
  return `api/${service}/${kind}/${encodeURIComponent(itemId)}?u=${userId}&exp=${expiresAt}&sig=${sig}`;
}

export interface SignedQuery {
  u?: string;
  exp?: string;
  sig?: string;
}

/** The user id the URL was signed for, or null when the signature is missing, wrong or expired. */
export function verifySigned(
  secret: string,
  service: string,
  kind: SignedKind,
  itemId: string,
  query: SignedQuery,
  nowSec: number,
): number | null {
  const { u, exp, sig } = query;
  if (typeof u !== "string" || typeof exp !== "string" || typeof sig !== "string") return null;
  if (!/^\d{1,12}$/.test(u) || !/^\d{1,12}$/.test(exp)) return null;
  const expiresAt = Number(exp);
  if (expiresAt < nowSec) return null;
  const userId = Number(u);
  return safeEqual(sign(secret, service, kind, userId, itemId, expiresAt), sig) ? userId : null;
}