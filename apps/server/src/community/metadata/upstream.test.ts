import assert from "node:assert/strict";
import test from "node:test";
import { openDb } from "../../db.js";
import { MetadataCache } from "./cache.js";
import { UpstreamError } from "./errors.js";
import { Gate } from "./gate.js";
import { Upstream, type FetchFn } from "./upstream.js";

const UA = "Cadence/9.9.9 (+https://example.test)";

function setup(handler: (url: string, headers: Record<string, string>) => Response | Promise<Response>) {
  const clock = { t: 1_700_000_000_000 };
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, at: clock.t });
    return handler(url, init?.headers ?? {});
  };
  const cache = new MetadataCache(openDb(":memory:"), () => clock.t);
  const upstream = new Upstream({
    cache,
    userAgent: UA,
    fetchFn,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  return { clock, sleeps, calls, cache, upstream };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("every request carries the Cadence User-Agent and asks for JSON", async () => {
  const { upstream, calls } = setup(() => json({ ok: 1 }));
  await upstream.getJson("musicbrainz", "https://mb.test/ws/2/artist/1");
  assert.equal(calls[0].headers["user-agent"], UA);
  assert.equal(calls[0].headers.accept, "application/json");
});

test("a second identical lookup is served from the cache", async () => {
  const { upstream, calls } = setup(() => json({ n: 1 }));
  const first = await upstream.getJson("wikipedia", "https://w.test/a");
  const second = await upstream.getJson("wikipedia", "https://w.test/a");
  assert.equal(first.from, "network");
  assert.equal(second.from, "cache");
  assert.deepEqual(second.data, { n: 1 });
  assert.equal(calls.length, 1);
});

test("a cached answer expires after its time to live", async () => {
  const { upstream, calls, clock } = setup(() => json({ n: 1 }));
  await upstream.getJson("bandsintown", "https://b.test/events"); // 6 hour TTL
  clock.t += 5 * 3_600_000;
  assert.equal((await upstream.getJson("bandsintown", "https://b.test/events")).from, "cache");
  clock.t += 2 * 3_600_000;
  const again = await upstream.getJson("bandsintown", "https://b.test/events");
  assert.equal(again.from, "network");
  assert.equal(calls.length, 2);
});

test("a custom time to live is honoured", async () => {
  const { upstream, calls, clock } = setup(() => json({}));
  await upstream.getJson("musicbrainz", "https://m.test/x", { ttlMs: 1000 });
  clock.t += 1500;
  await upstream.getJson("musicbrainz", "https://m.test/x", { ttlMs: 1000 });
  assert.equal(calls.length, 2);
});

test("calls to one service are spaced at least a second apart (MusicBrainz)", async () => {
  const { upstream, calls } = setup(() => json({}));
  await Promise.all([1, 2, 3, 4].map((n) => upstream.getJson("musicbrainz", "https://m.test/" + n)));
  assert.equal(calls.length, 4);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 1000, "gap " + i);
  assert.deepEqual(
    calls.map((c) => c.url),
    [1, 2, 3, 4].map((n) => "https://m.test/" + n),
    "served in the order asked",
  );
});

test("different services do not wait for each other", async () => {
  const { upstream, sleeps } = setup(() => json({}));
  await Promise.all([upstream.getJson("musicbrainz", "https://m.test/1"), upstream.getJson("wikipedia", "https://w.test/1")]);
  assert.deepEqual(sleeps, []);
});

test("simultaneous identical lookups share one upstream call", async () => {
  const { upstream, calls } = setup(() => json({ same: true }));
  const [a, b] = await Promise.all([upstream.getJson("fanart", "https://f.test/x"), upstream.getJson("fanart", "https://f.test/x")]);
  assert.deepEqual(a.data, b.data);
  assert.equal(calls.length, 1);
});

test("a 404 is remembered so the service is not asked again", async () => {
  const { upstream, calls } = setup(() => new Response("nope", { status: 404 }));
  await assert.rejects(upstream.getJson("wikipedia", "https://w.test/missing"), (e: UpstreamError) => e.kind === "not_found");
  await assert.rejects(upstream.getJson("wikipedia", "https://w.test/missing"), (e: UpstreamError) => e.kind === "not_found");
  assert.equal(calls.length, 1);
});

test("upstream failures map to fixed kinds and are never cached", async () => {
  const cases: [Response | Error, string][] = [
    [new Response("", { status: 401 }), "auth"],
    [new Response("", { status: 403 }), "auth"],
    [new Response("", { status: 429, headers: { "retry-after": "7" } }), "rate_limited"],
    [new Response("", { status: 503 }), "rate_limited"],
    [new Response("oops", { status: 500 }), "bad_response"],
    [new Response("<html>not json</html>", { status: 200 }), "bad_response"],
    [Object.assign(new Error("slow"), { name: "TimeoutError" }), "timeout"],
    [new TypeError("fetch failed"), "unreachable"],
  ];
  for (const [outcome, kind] of cases) {
    const { upstream, cache } = setup(() => {
      if (outcome instanceof Error) throw outcome;
      return outcome.clone();
    });
    await assert.rejects(upstream.getJson("discogs", "https://d.test/x"), (e: UpstreamError) => e.kind === kind, kind);
    assert.equal(cache.count(), 0, "failure " + kind + " is not cached");
  }
});

test("a rate limit carries the retry-after header of the service", async () => {
  const { upstream } = setup(() => new Response("", { status: 429, headers: { "retry-after": "12" } }));
  await assert.rejects(upstream.getJson("musicbrainz", "https://m.test/x"), (e: UpstreamError) => e.kind === "rate_limited" && e.retryAfterSec === 12);
});

test("an old answer is served when the service is down", async () => {
  let down = false;
  const { upstream, clock } = setup(() => (down ? new Response("", { status: 500 }) : json({ v: "old" })));
  await upstream.getJson("wikipedia", "https://w.test/a");
  clock.t += 8 * 86_400_000; // past the 7 day TTL
  down = true;
  const result = await upstream.getJson<{ v: string }>("wikipedia", "https://w.test/a");
  assert.equal(result.from, "stale");
  assert.equal(result.data.v, "old");
});

test("a bad key is reported even when an old answer exists", async () => {
  let auth = false;
  const { upstream, clock } = setup(() => (auth ? new Response("", { status: 401 }) : json({ v: 1 })));
  await upstream.getJson("fanart", "https://f.test/a");
  clock.t += 8 * 86_400_000;
  auth = true;
  await assert.rejects(upstream.getJson("fanart", "https://f.test/a"), (e: UpstreamError) => e.kind === "auth");
});

test("the gate refuses work when too many callers are waiting", async () => {
  const gate = new Gate({ gapMs: 0, maxQueue: 2, sleep: async () => undefined });
  let release: () => void = () => undefined;
  const hold = new Promise<void>((r) => (release = r));
  const first = gate.schedule(() => hold);
  const second = gate.schedule(async () => 2);
  await assert.rejects(gate.schedule(async () => 3), (e: UpstreamError) => e.kind === "busy");
  release();
  await first;
  assert.equal(await second, 2);
});

test("the cache purges long-expired rows only", () => {
  const clock = { t: 1_000_000_000_000 };
  const cache = new MetadataCache(openDb(":memory:"), () => clock.t);
  cache.set("old", { a: 1 }, 1000);
  clock.t += 20 * 86_400_000;
  cache.set("fresh", { b: 2 }, 1000);
  assert.equal(cache.purge(), 1);
  assert.equal(cache.get("old"), undefined);
  assert.deepEqual(cache.get("fresh")?.value, { b: 2 });
});
