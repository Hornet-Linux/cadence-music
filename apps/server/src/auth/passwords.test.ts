import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { checkPassword, hashPassword, verifyPassword } from "./passwords.js";

test("hashes and verifies a password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("salts every hash", async () => {
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("rejects malformed stored hashes", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "bcrypt$whatever"), false);
  assert.equal(await verifyPassword("x", "scrypt$16384$8$1$c2FsdA$"), false);
});

test("the stored format is unchanged: hashes made with scryptSync still verify", async () => {
  const salt = Buffer.from("0123456789abcdef");
  const key = scryptSync("legacy-password", salt, 64, { N: 16384, r: 8, p: 1 });
  const stored = ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
  assert.equal(await verifyPassword("legacy-password", stored), true);
  assert.equal(await verifyPassword("other", stored), false);
});

test("checkPassword verifies for known and unknown users alike", async () => {
  const calls: string[] = [];
  const verify = async (_password: string, stored: string) => {
    calls.push(stored);
    return true; // even a "match" must not log an unknown user in
  };
  const real = await hashPassword("pw");
  assert.equal(await checkPassword("pw", real, verify), true);
  assert.equal(await checkPassword("pw", undefined, verify), false);
  assert.equal(await checkPassword("pw", null, verify), false);
  assert.equal(await checkPassword("pw", "", verify), false);
  assert.equal(calls.length, 4, "verify ran for every case");
  assert.equal(calls[0], real);
  assert.match(calls[1], /^scrypt\$16384\$8\$1\$/, "unknown users are checked against a full-cost hash");
  assert.equal(calls[1], calls[2]);
});
