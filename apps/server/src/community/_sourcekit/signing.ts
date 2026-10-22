import { createHmac } from "node:crypto";
import { safeEqual } from "../../util/crypto.js";

/**
 * Audio and image elements can't send an Authorization header, so streams and images use short-lived signed
 * URLs. The signature binds the Cadence user, what is being fetched, the kind of use (scope) and the expiry,
 * so one URL can't stand in for another and a leaked one stops working.
 */
function sign(secret: string, scope: string, userId: number, resource: string, exp: number): string {
  return createHmac("sha256", secret).update(`${scope}\n${userId}\n${resource}\n${exp}`).digest("base64url");
}

/** The query string (without "?") that authorises one fetch. */
export function signedQuery(secret: string, scope: string, userId: number, resource: string, exp: number): string {
  return `u=${userId}&exp=${exp}&sig=${sign(secret, scope, userId, resource, exp)}`;
}

export interface SignedParams {
  u?: string;
  exp?: string;
  sig?: string;
}

/** The user id the URL was signed for, or null when the signature is missing, wrong or expired. */
export function verifySigned(secret: string, scope: string, resource: string, q: SignedParams, nowSec: number): number | null {
  const { u, exp, sig } = q;
  if (!u || !exp || !sig || !/^\d{1,12}$/.test(u) || !/^\d{1,12}$/.test(exp) || sig.length > 200) return null;
  const expiresAt = Number(exp);
  if (expiresAt < nowSec) return null;
  const userId = Number(u);
  return safeEqual(sign(secret, scope, userId, resource, expiresAt), sig) ? userId : null;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);