import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./passwords.js";

test("hashes and verifies a password", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("salts every hash", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("rejects malformed stored hashes", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", "bcrypt$whatever"), false);
  assert.equal(verifyPassword("x", "scrypt$16384$8$1$c2FsdA$"), false);
});
