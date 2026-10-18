import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeJwtPayload,
  groupsFromClaims,
  isLoopbackRedirect,
  validateIdTokenClaims,
} from "./oidc.js";

const expected = {
  issuer: "https://auth.example.com/application/o/music/",
  clientId: "music-app",
  nonce: "n-123",
  nowSec: 1_700_000_000,
};

const good = {
  iss: expected.issuer,
  aud: "music-app",
  sub: "user-1",
  nonce: "n-123",
  exp: expected.nowSec + 300,
  iat: expected.nowSec,
};

test("accepts valid ID token claims", () => {
  assert.equal(validateIdTokenClaims(good, expected), null);
  assert.equal(validateIdTokenClaims({ ...good, aud: ["music-app"] }, expected), null);
});

test("rejects bad ID token claims", () => {
  assert.equal(validateIdTokenClaims({ ...good, iss: "https://evil" }, expected), "issuer mismatch");
  assert.equal(validateIdTokenClaims({ ...good, aud: "other" }, expected), "audience mismatch");
  assert.equal(
    validateIdTokenClaims({ ...good, aud: ["music-app", "other"] }, expected),
    "authorized party mismatch",
  );
  assert.equal(validateIdTokenClaims({ ...good, exp: expected.nowSec - 120 }, expected), "token expired");
  assert.equal(validateIdTokenClaims({ ...good, nonce: "replayed" }, expected), "nonce mismatch");
  assert.equal(validateIdTokenClaims({ ...good, sub: "" }, expected), "missing subject");
});

test("decodes a JWT payload", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "abc" })).toString("base64url");
  assert.deepEqual(decodeJwtPayload(`e30.${payload}.sig`), { sub: "abc" });
  assert.throws(() => decodeJwtPayload("not-a-jwt"));
});

test("reads group claims", () => {
  assert.deepEqual(groupsFromClaims({ groups: ["a", 1, "b"] }), ["a", "b"]);
  assert.equal(groupsFromClaims({}), null);
});

test("only allows loopback redirect URIs", () => {
  assert.equal(isLoopbackRedirect("http://127.0.0.1:53682/callback"), true);
  assert.equal(isLoopbackRedirect("http://localhost:8080/cb"), true);
  assert.equal(isLoopbackRedirect("http://[::1]:9000/cb"), true);
  assert.equal(isLoopbackRedirect("https://127.0.0.1/cb"), false);
  assert.equal(isLoopbackRedirect("http://evil.example.com/cb"), false);
  assert.equal(isLoopbackRedirect("http://127.0.0.1.evil.com/cb"), false);
  assert.equal(isLoopbackRedirect("http://user:pass@127.0.0.1/cb"), false);
  assert.equal(isLoopbackRedirect("not a url"), false);
});
