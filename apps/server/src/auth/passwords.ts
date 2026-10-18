import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt parameters (N=2^14, r=8, p=1) use ~16 MB per hash.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Hash a password as `scrypt$N$r$p$salt$hash` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
