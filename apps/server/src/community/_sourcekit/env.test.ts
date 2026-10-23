import { test } from "node:test";
import assert from "node:assert/strict";
import { envPolicy, envUrl } from "./env.js";

test("operator knobs: private networks stay blocked unless the operator opts in", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CADENCE_SOURCES_ALLOW_PRIVATE;
    assert.deepEqual(envPolicy(), {});
    process.env.CADENCE_SOURCES_ALLOW_PRIVATE = "true";
    assert.deepEqual(envPolicy(), {}, "only 1 turns it on");
    process.env.CADENCE_SOURCES_ALLOW_PRIVATE = "1";
    assert.deepEqual(envPolicy(), { allowPrivate: true });
  } finally {
    process.env = saved;
  }
});

test("operator mirror addresses must be http(s) and lose a trailing slash", () => {
  const saved = { ...process.env };
  try {
    process.env.CADENCE_ARCHIVE_URL = "http://mirror.lan:8080/";
    assert.equal(envUrl("CADENCE_ARCHIVE_URL"), "http://mirror.lan:8080");
    process.env.CADENCE_ARCHIVE_URL = "ftp://x";
    assert.equal(envUrl("CADENCE_ARCHIVE_URL"), undefined);
    process.env.CADENCE_ARCHIVE_URL = "not a url";
    assert.equal(envUrl("CADENCE_ARCHIVE_URL"), undefined);
    delete process.env.CADENCE_ARCHIVE_URL;
    assert.equal(envUrl("CADENCE_ARCHIVE_URL"), undefined);
  } finally {
    process.env = saved;
  }
});
