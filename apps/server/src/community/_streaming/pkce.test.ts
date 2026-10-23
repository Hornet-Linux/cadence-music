import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeFor, newPkce, newState } from "./pkce.js";

test("S256 challenge matches the RFC 7636 appendix B example", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("verifiers are 43+ url-safe characters and never repeat", () => {
  const a = newPkce();
  const b = newPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(challengeFor(a.verifier), a.challenge);
  assert.notEqual(newState(), newState());
});
