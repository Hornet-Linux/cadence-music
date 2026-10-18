import { test } from "node:test";
import assert from "node:assert/strict";
import { streamPath, verifyStream } from "./streamSigning.js";

const secret = "s".repeat(64);
const now = 1_700_000_000;

function parse(path: string) {
  const url = new URL(path, "http://server/");
  return {
    id: decodeURIComponent(url.pathname.split("/").pop()!),
    exp: url.searchParams.get("exp") ?? undefined,
    sig: url.searchParams.get("sig") ?? undefined,
  };
}

test("signed stream paths verify until they expire", () => {
  const { path, expiresAt } = streamPath(secret, "track1", 60, now);
  assert.equal(expiresAt, now + 60);
  assert.match(path, /^api\/stream\/track1\?exp=\d+&sig=/);
  const p = parse(path);
  assert.equal(verifyStream(secret, p.id, p.exp, p.sig, now), true);
  assert.equal(verifyStream(secret, p.id, p.exp, p.sig, now + 61), false);
});

test("tampering breaks the signature", () => {
  const p = parse(streamPath(secret, "track1", 60, now).path);
  assert.equal(verifyStream(secret, "track2", p.exp, p.sig, now), false);
  assert.equal(verifyStream(secret, p.id, String(now + 9999), p.sig, now), false);
  assert.equal(verifyStream("other".repeat(13), p.id, p.exp, p.sig, now), false);
  assert.equal(verifyStream(secret, p.id, undefined, p.sig, now), false);
  assert.equal(verifyStream(secret, p.id, "abc", p.sig, now), false);
});
