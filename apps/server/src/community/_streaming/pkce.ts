import { createHash, randomBytes } from "node:crypto";

/** A fresh PKCE pair (RFC 7636, method S256). The verifier is 43 characters of base64url. */
export function newPkce(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}
