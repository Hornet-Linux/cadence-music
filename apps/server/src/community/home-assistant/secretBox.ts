import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets (a Home Assistant token) before they go into the database, keyed from the server
 * secret. It keeps a database copy or backup from exposing tokens by itself; anyone with the server secret
 * can still read them, as they can everything else the server holds.
 */
function key(secret: string): Buffer {
  return createHash("sha256").update(`cadence.home-assistant:${secret}`).digest();
}

export function seal(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}

export function open(secret: string, sealed: string): string | null {
  if (!sealed.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
