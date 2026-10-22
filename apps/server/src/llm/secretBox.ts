import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Encrypts provider API keys at rest with a key derived from the server
// secret (the one in the data folder). It protects a leaked database file or
// backup; anyone who can read the server's data folder can read both.

function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "cadence", "llm-provider-api-keys", 32));
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Returns null when the value is damaged or was sealed with a different secret. */
export function open(sealed: string, secret: string): string | null {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !ct) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
