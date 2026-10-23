import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Encrypts provider API keys at rest with a key derived from the server
// secret (the one in the data folder). It protects a leaked database file or
// backup; anyone who can read the server's data folder can read both.

/** Each kind of secret gets its own derived key, so a value sealed for one can't be opened as another. */
const LLM_PURPOSE = "llm-provider-api-keys";

function keyFor(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "cadence", purpose, 32));
}

/**
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url, or `v2.…` when `bindTo`
 * is given: the value is then bound to it (AES-GCM additional data, e.g. the
 * provider id), so it can't be copied onto another row and still open.
 */
export function seal(plain: string, secret: string, purpose = LLM_PURPOSE, bindTo?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret, purpose), iv);
  if (bindTo !== undefined) cipher.setAAD(Buffer.from(bindTo, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const version = bindTo !== undefined ? "v2" : "v1";
  return [version, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/**
 * Returns null when the value is damaged, was sealed with a different secret,
 * or (v2) was bound to something other than `bindTo`. A v1 value has no
 * binding and opens whatever `bindTo` is; callers re-seal those as v2.
 */
export function open(sealed: string, secret: string, purpose = LLM_PURPOSE, bindTo?: string): string | null {
  const [version, iv, tag, ct] = sealed.split(".");
  if ((version !== "v1" && version !== "v2") || !iv || !tag || !ct) return null;
  if (version === "v2" && bindTo === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret, purpose), Buffer.from(iv, "base64url"));
    if (version === "v2") decipher.setAAD(Buffer.from(bindTo!, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Is this value in the current format (bound, v2)? */
export const isBound = (sealed: string) => sealed.startsWith("v2.");
