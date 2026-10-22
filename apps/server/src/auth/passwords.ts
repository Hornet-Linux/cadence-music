import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt parameters (N=2^14, r=8, p=1) use ~16 MB per hash.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Longest password accepted anywhere; bounds the work one request can ask for. */
export const MAX_PASSWORD = 1024;

// Async, so a slow hash runs on the thread pool instead of blocking every
// other request. The output is identical to scryptSync.
function deriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Hash a password as `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length === 0) return false;
  const actual = await deriveKey(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

/**
 * Check a login password. When there is no stored hash (unknown user, or an
 * SSO-only account) the same scrypt work is done against a throwaway hash, so
 * the response time does not reveal whether the username exists. The result
 * is always false in that case.
 */
export async function checkPassword(
  password: string,
  stored: string | null | undefined,
  verify: (password: string, stored: string) => Promise<boolean> = verifyPassword,
): Promise<boolean> {
  if (stored) return verify(password, stored);
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verify(password, await dummyHash);
  return false;
}
