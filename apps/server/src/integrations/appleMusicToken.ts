import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { AppleMusicConfig } from "../config.js";

/** Apple allows up to six months; shorter limits the damage of a leaked token. */
export const APPLE_TOKEN_TTL_SEC = 12 * 60 * 60;

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function loadAppleMusicKey(config: AppleMusicConfig): KeyObject {
  try {
    const key = createPrivateKey(config.privateKey);
    if (key.asymmetricKeyType !== "ec") throw new Error("not an EC key");
    return key;
  } catch (err) {
    throw new Error(`APPLE_MUSIC_PRIVATE_KEY is not a valid MusicKit (.p8) key: ${(err as Error).message}`);
  }
}

/** Mint a MusicKit developer token: an ES256 JWT signed with the team's key. */
export function mintAppleMusicToken(
  config: AppleMusicConfig,
  key: KeyObject,
  nowSec: number,
  ttlSec = APPLE_TOKEN_TTL_SEC,
): { token: string; expiresAt: number } {
  const expiresAt = nowSec + ttlSec;
  const input = `${b64url({ alg: "ES256", kid: config.keyId, typ: "JWT" })}.${b64url({
    iss: config.teamId,
    iat: nowSec,
    exp: expiresAt,
  })}`;
  // JWS needs the raw r||s signature, not DER.
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return { token: `${input}.${signature.toString("base64url")}`, expiresAt };
}
