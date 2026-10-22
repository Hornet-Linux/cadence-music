import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { hosts, testUpstream } from "./http.js";
import { StreamingKit, type ServiceDef } from "./kit.js";

const KEYS = ["CADENCE_TESTING", "CADENCE_STREAMING_TEST_UPSTREAM"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const DEFAULTS = { api: "https://api.example.com", auth: "https://auth.example.com" };

test("the test upstream is ignored unless CADENCE_TESTING=1 is also set", () => {
  process.env.CADENCE_STREAMING_TEST_UPSTREAM = "http://127.0.0.1:9261";
  delete process.env.CADENCE_TESTING;
  assert.equal(testUpstream(), null);
  assert.deepEqual(hosts("demo", DEFAULTS), DEFAULTS);

  process.env.CADENCE_TESTING = "true"; // only the exact value 1 counts
  assert.deepEqual(hosts("demo", DEFAULTS), DEFAULTS);
  process.env.CADENCE_TESTING = "0";
  assert.deepEqual(hosts("demo", DEFAULTS), DEFAULTS);
});

test("CADENCE_TESTING=1 alone changes nothing", () => {
  process.env.CADENCE_TESTING = "1";
  delete process.env.CADENCE_STREAMING_TEST_UPSTREAM;
  assert.equal(testUpstream(), null);
  assert.deepEqual(hosts("demo", DEFAULTS), DEFAULTS);
});

test("with both set, every endpoint (token exchange included) points at the test host", () => {
  process.env.CADENCE_TESTING = "1";
  process.env.CADENCE_STREAMING_TEST_UPSTREAM = "http://127.0.0.1:9261/";
  assert.deepEqual(hosts("demo", DEFAULTS), { api: "http://127.0.0.1:9261/demo/api", auth: "http://127.0.0.1:9261/demo/auth" });
});

const def: ServiceDef = {
  slug: "demo",
  id: "cadence.demo",
  name: "Demo",
  fields: [],
  isConfigured: () => true,
  features: { search: true, library: false, playlists: false, playback: "link" },
};

function warnings() {
  const calls: { obj: unknown; msg: string }[] = [];
  const ctx = { log: { warn: (obj: unknown, msg: string) => calls.push({ obj, msg }) } };
  new StreamingKit(def, {} as never, ctx as never);
  return calls;
}

test("start-up logs a loud warning naming the plugin and target only when the hook is active", () => {
  delete process.env.CADENCE_TESTING;
  process.env.CADENCE_STREAMING_TEST_UPSTREAM = "http://127.0.0.1:9261";
  assert.equal(warnings().length, 0, "ignored without CADENCE_TESTING=1, so nothing to warn about");

  process.env.CADENCE_TESTING = "1";
  const calls = warnings();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.obj, { plugin: "cadence.demo", target: "http://127.0.0.1:9261" });
  assert.match(calls[0]!.msg, /Never use this in production/);
});
