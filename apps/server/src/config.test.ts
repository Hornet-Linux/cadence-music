import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseTrustProxy } from "./config.js";

test("TRUST_PROXY defaults to a single proxy hop, never every hop", () => {
  assert.equal(loadConfig({}).trustProxy, 1);
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy(""), 1);
  assert.equal(parseTrustProxy("true"), 1);
});

test("TRUST_PROXY can be off, a hop count, or an address list", () => {
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("FALSE"), false);
  assert.equal(parseTrustProxy("0"), false);
  assert.equal(parseTrustProxy("2"), 2);
  assert.deepEqual(parseTrustProxy("172.18.0.0/16, 10.0.0.5"), ["172.18.0.0/16", "10.0.0.5"]);
  assert.deepEqual(parseTrustProxy("loopback,::1,fd00::/8"), ["loopback", "::1", "fd00::/8"]);
  assert.equal(loadConfig({ TRUST_PROXY: "3" }).trustProxy, 3);
});

test("TRUST_PROXY rejects nonsense", () => {
  assert.throws(() => parseTrustProxy("yes"), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy("10.0.0.0/33"), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy("10.0.0.1/8/8"), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy("1.2.3.4,nope"), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy("99"), /TRUST_PROXY/);
});
