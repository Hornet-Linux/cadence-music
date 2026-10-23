import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeUpstream, json, setupApp } from "../_streaming/fakes.js";
import { createYouTubePlugin, decodeEntities, toTrack } from "./plugin.js";

const SEARCH = {
  items: [
    { id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Rock &amp; Roll &#39;99", channelTitle: "The Band - Topic", thumbnails: { medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" } } } },
    { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Embedding switched off", channelTitle: "C" } },
    { id: { videoId: "short" }, snippet: { title: "bad id" } },
    { id: { videoId: "bbbbbbbbbbb" }, snippet: { title: "Live-ish", channelTitle: "L" } },
  ],
};

const VIDEOS = {
  items: [
    { id: "dQw4w9WgXcQ", contentDetails: { duration: "PT3M32S" }, status: { embeddable: true } },
    { id: "aaaaaaaaaaa", contentDetails: { duration: "PT1M" }, status: { embeddable: false } },
    { id: "bbbbbbbbbbb", contentDetails: { duration: "P0D" }, status: { embeddable: true } },
  ],
};

async function setup(opts: { videos?: () => Response | object } = {}) {
  const fake = new FakeUpstream();
  fake.route("GET www.googleapis.com/youtube/v3/search", () => SEARCH);
  fake.route("GET www.googleapis.com/youtube/v3/videos", opts.videos ?? (() => VIDEOS));
  const t = await setupApp(createYouTubePlugin({ fetchFn: fake.fetchFn }));
  return { ...t, fake };
}

test("without an API key it says so and does not call YouTube", async () => {
  const { app, alice, fake } = await setup();
  const status = (await app.inject({ url: "/api/streaming/youtube-music/status", headers: alice })).json();
  assert.equal(status.configured, false);
  assert.equal(status.hasLogin, false);
  const res = await app.inject({ url: "/api/streaming/youtube-music/search?q=x", headers: alice });
  assert.equal(res.statusCode, 409);
  assert.equal(fake.calls.length, 0);
});

test("search asks only for embeddable music videos, keeps the key server-side, and maps results", async () => {
  const t = await setup();
  assert.equal((await t.app.inject({ method: "PUT", url: "/api/streaming/youtube-music/config", headers: t.admin, payload: { apiKey: "AIza-test-key" } })).statusCode, 204);
  const read = await t.app.inject({ url: "/api/streaming/youtube-music/config", headers: t.admin });
  assert.ok(!read.body.includes("AIza-test-key"));

  const res = (await t.app.inject({ url: "/api/streaming/youtube-music/search?q=rock", headers: t.alice })).json();
  assert.ok(!JSON.stringify(res).includes("AIza"));
  const search = t.fake.calls.find((c) => c.url.pathname.endsWith("/search"))!;
  assert.equal(search.url.searchParams.get("videoEmbeddable"), "true");
  assert.equal(search.url.searchParams.get("type"), "video");
  assert.equal(search.url.searchParams.get("videoCategoryId"), "10");
  assert.equal(search.url.searchParams.get("key"), "AIza-test-key");
  const videos = t.fake.calls.find((c) => c.url.pathname.endsWith("/videos"))!;
  assert.equal(videos.url.searchParams.get("id"), "dQw4w9WgXcQ,aaaaaaaaaaa,bbbbbbbbbbb");

  // The malformed id and the video that stopped allowing embedding are dropped.
  assert.deepEqual(
    res.items.map((i: { id: string }) => i.id),
    ["dQw4w9WgXcQ", "bbbbbbbbbbb"],
  );
  assert.deepEqual(res.items[0], {
    id: "dQw4w9WgXcQ",
    title: "Rock & Roll '99",
    artists: ["The Band"],
    artwork: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    durationSec: 212,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    playback: "iframe",
  });
  assert.equal(res.items[1].durationSec, undefined, "live or zero-length videos get no duration");
});

test("if the details lookup fails the search results are still returned", async () => {
  const t = await setup({ videos: () => json(500, {}) });
  await t.app.inject({ method: "PUT", url: "/api/streaming/youtube-music/config", headers: t.admin, payload: { apiKey: "k" } });
  const res = await t.app.inject({ url: "/api/streaming/youtube-music/search?q=x", headers: t.alice });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().items.length, 3);
});

test("quota or key problems show a fixed message", async () => {
  const fake = new FakeUpstream().route("GET www.googleapis.com/youtube/v3/search", () => json(403, { error: { errors: [{ reason: "quotaExceeded" }] } }));
  const t = await setupApp(createYouTubePlugin({ fetchFn: fake.fetchFn }));
  await t.app.inject({ method: "PUT", url: "/api/streaming/youtube-music/config", headers: t.admin, payload: { apiKey: "k" } });
  const res = await t.app.inject({ url: "/api/streaming/youtube-music/search?q=x", headers: t.alice });
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes("quotaExceeded"));
});

test("searches are rate limited per person", async () => {
  const t = await setup();
  await t.app.inject({ method: "PUT", url: "/api/streaming/youtube-music/config", headers: t.admin, payload: { apiKey: "k" } });
  let limited = 0;
  for (let i = 0; i < 65; i++) {
    const r = await t.app.inject({ url: "/api/streaming/youtube-music/search?q=x", headers: t.alice });
    if (r.statusCode === 429) limited++;
  }
  assert.equal(limited, 5);
  assert.equal((await t.app.inject({ url: "/api/streaming/youtube-music/search?q=x", headers: t.bob })).statusCode, 200);
});

test("entity decoding and mapping helpers", () => {
  assert.equal(decodeEntities("A &amp; B &lt;3 &#x41;"), "A & B <3 A");
  assert.equal(toTrack({ id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "t" } }, { status: { privacyStatus: "private" } }), null);
});
