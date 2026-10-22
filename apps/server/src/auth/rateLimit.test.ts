import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rateLimit.js";

function limiter(max = 3, maxEntries = 5) {
  const clock = { now: 1_000 };
  const rl = new RateLimiter({ max, windowMs: 100, maxEntries, now: () => clock.now });
  return { rl, clock };
}

test("limits a key after max hits and releases it when the window ends", () => {
  const { rl, clock } = limiter();
  rl.hit("a");
  rl.hit("a");
  assert.equal(rl.isLimited("a"), false);
  rl.hit("a");
  assert.equal(rl.isLimited("a"), true);
  assert.equal(rl.isLimited("b"), false);
  clock.now += 100;
  assert.equal(rl.isLimited("a"), false);
  rl.hit("a");
  assert.equal(rl.isLimited("a"), false, "a new window starts at one hit");
});

test("reset clears a key", () => {
  const { rl } = limiter(1);
  rl.hit("a");
  assert.equal(rl.isLimited("a"), true);
  rl.reset("a");
  assert.equal(rl.isLimited("a"), false);
});

test("a full table evicts expired entries before live lockouts", () => {
  const { rl, clock } = limiter(1, 3);
  rl.hit("old1");
  rl.hit("old2");
  clock.now += 100; // both expire
  rl.hit("locked");
  rl.hit("new");
  assert.equal(rl.size, 2, "expired entries were dropped to make room");
  rl.hit("other");
  assert.equal(rl.isLimited("locked"), true);
  assert.equal(rl.isLimited("new"), true);
  assert.equal(rl.isLimited("other"), true);
  assert.equal(rl.size, 3);
});

test("with nothing expired, only the oldest entry is dropped", () => {
  const { rl } = limiter(1, 3);
  rl.hit("first");
  rl.hit("second");
  rl.hit("third");
  rl.hit("fourth");
  assert.equal(rl.size, 3);
  assert.equal(rl.isLimited("first"), false, "oldest evicted");
  assert.equal(rl.isLimited("second"), true);
  assert.equal(rl.isLimited("third"), true);
  assert.equal(rl.isLimited("fourth"), true);
});

test("a flood of distinct keys never grows the table past the cap", () => {
  const { rl } = limiter(1, 50);
  for (let i = 0; i < 200; i++) rl.hit(`k${i}`);
  assert.equal(rl.size, 50);
});
