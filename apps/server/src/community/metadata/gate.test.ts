import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "./gate.js";

test("the gap is counted from when a slow request finishes, not when it started", async () => {
  let clock = 0;
  const starts: number[] = [];
  const gate = new Gate({ gapMs: 1000, now: () => clock, sleep: async (ms) => void (clock += ms) });
  await gate.schedule(async () => {
    starts.push(clock);
    clock += 900; // a slow DNS lookup / connect before the request reaches the service
  });
  await gate.schedule(async () => void starts.push(clock));
  assert.deepEqual(starts, [0, 1900]);
});
