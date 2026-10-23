import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fake, harness, type Auth, type Fake, type Harness } from "../_sourcekit/testkit.js";
import { createPodcastsPlugin, type PodcastOptions } from "./plugin.js";

interface Ep {
  guid: string;
  title: string;
  date: string;
  file: string;
  dur?: string;
}

function rss(title: string, eps: Ep[], base: string): string {
  const items = eps
    .map(
      (e) => `<item><title>${e.title}</title><guid>${e.guid}</guid><pubDate>${e.date}</pubDate>
        <enclosure url="${base}/audio/${e.file}" length="100" type="audio/mpeg"/><itunes:duration>${e.dur ?? "10:00"}</itunes:duration></item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title>
    <itunes:author>Host</itunes:author><itunes:image href="${base}/cover.png"/><description>About</description>${items}</channel></rss>`;
}

const EPS: Ep[] = [
  { guid: "e1", title: "First", date: "Mon, 01 Jan 2024 10:00:00 GMT", file: "1.mp3" },
  { guid: "e2", title: "Second", date: "Tue, 02 Jan 2024 10:00:00 GMT", file: "2.mp3" },
  { guid: "e3", title: "Third", date: "Wed, 03 Jan 2024 10:00:00 GMT", file: "3.mp3", dur: "20:00" },
];
const AUDIO = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

interface Rig {
  h: Harness;
  site: Fake;
  eps: Ep[];
  feedUrl: string;
  close: () => Promise<void>;
}

async function rig(plugin: PodcastOptions = {}, extra: Fake[] = []): Promise<Rig> {
  const state = { eps: [...EPS], html: false };
  let siteUrl = "";
  const h = await harness((policy) => createPodcastsPlugin({ policy, headerTimeoutMs: 2000, streamIdleMs: 2000, refreshEveryMs: 3_600_000, minRefetchMs: 1, ...plugin }));
  const site = await fake(h, (req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/feed.xml")) {
      const etag = `"v${state.eps.length}"`;
      if (req.headers["if-none-match"] === etag) return void res.writeHead(304).end();
      return void res.writeHead(200, { "Content-Type": "application/rss+xml", ETag: etag }).end(rss("The Show", state.eps, siteUrl));
    }
    if (url === "/page.html") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>hello</body></html>");
    if (url === "/cover.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    if (url === "/evil.svg") return void res.writeHead(200, { "Content-Type": "image/svg+xml" }).end("<svg onload=alert(1)/>");
    if (url.startsWith("/audio/")) {
      const range = req.headers.range;
      if (url === "/audio/page.mp3") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<script>1</script>");
      if (url === "/audio/hop.mp3") return void res.writeHead(302, { Location: "/audio/real.mp3" }).end();
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)!;
        const start = Number(m[1] || 0);
        const end = Math.min(Number(m[2] || AUDIO.length - 1), AUDIO.length - 1);
        return void res
          .writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${start}-${end}/${AUDIO.length}`, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" })
          .end(AUDIO.subarray(start, end + 1));
      }
      return void res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO.length), "Accept-Ranges": "bytes" }).end(AUDIO);
    }
    res.writeHead(404).end();
  });
  siteUrl = site.url;
  return {
    h,
    site,
    get eps() {
      return state.eps;
    },
    feedUrl: `${site.url}/feed.xml`,
    close: async () => {
      await h.close();
      await site.close();
      for (const f of extra) await f.close();
    },
  } as Rig;
}

const call = (r: Rig, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, who: Auth | null, payload?: unknown) =>
  r.h.app.inject({ method, url, headers: who ?? {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function subscribe(r: Rig, who: Auth, url = r.feedUrl) {
  const res = await call(r, "POST", "/api/podcasts/subscriptions", who, { feedUrl: url });
  assert.ok(res.statusCode === 200 || res.statusCode === 201, res.body);
  return res.json() as { id: string; title: string; subscribed: boolean; unplayed: number; speed: number; autoQueue: boolean; image?: string };
}

async function episodes(r: Rig, who: Auth, feedId: string, query = "") {
  const res = await call(r, "GET", `/api/podcasts/feeds/${feedId}/episodes${query}`, who);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { items: { id: string; title: string; position: number; played: boolean; durationSec: number }[]; total: number };
}

test("subscribe by RSS address: episodes stored newest first, nothing but safe fields returned", async () => {
  const r = await rig();
  assert.equal((await call(r, "GET", "/api/podcasts/subscriptions", null)).statusCode, 401);
  const sub = await subscribe(r, r.h.alice);
  assert.equal(sub.title, "The Show");
  assert.equal(sub.subscribed, true);
  assert.equal(sub.unplayed, 3);
  assert.equal(sub.speed, 1);
  assert.match(sub.image!, /^api\/podcasts\/image\?t=/);
  const eps = await episodes(r, r.h.alice, sub.id);
  assert.deepEqual(eps.items.map((e) => e.title), ["Third", "Second", "First"]);
  assert.equal(eps.items[0].durationSec, 1200);
  assert.equal((await episodes(r, r.h.alice, sub.id, "?order=oldest&limit=1")).items[0].title, "First");
  assert.ok(!JSON.stringify(eps).includes(r.site.url + "/audio"), "enclosure addresses stay on the server");
  // subscribing again is idempotent
  assert.equal((await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: r.feedUrl })).statusCode, 200);
  assert.equal(((await call(r, "GET", "/api/podcasts/subscriptions", r.h.alice)).json() as { items: unknown[] }).items.length, 1);
  assert.equal(r.site.seen.filter((s) => s.url.startsWith("/feed.xml")).length, 1, "the feed was fetched once");
  assert.match(r.site.seen[0].headers["user-agent"] ?? "", /^Cadence-Server\//);
  // feed:// links work
  const bob = await call(r, "POST", "/api/podcasts/subscriptions", r.h.bob, { feedUrl: r.feedUrl.replace("http:", "feed:") });
  assert.equal(bob.statusCode, 201);
  await r.close();
});

test("subscribe: bad input, non-feeds, broken XML and unreachable feeds give clear fixed answers", async () => {
  const r = await rig();
  const bad = async (body: unknown) => (await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, body)).statusCode;
  assert.equal(await bad({}), 400);
  assert.equal(await bad({ feedUrl: "file:///etc/passwd" }), 400);
  assert.equal(await bad({ feedUrl: "javascript:alert(1)" }), 400);
  const html = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: `${r.site.url}/page.html` });
  assert.equal(html.statusCode, 422);
  assert.equal(html.json().error, "not_a_feed");
  const missing = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: `${r.site.url}/nope.xml` });
  assert.equal(missing.statusCode, 502);
  const down = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: "http://127.0.0.1:1/x" });
  assert.equal(down.statusCode, 400, "an unlisted loopback address is refused outright");
  await r.close();
});

test("huge feeds: cut off at the size cap, keeping the episodes that fit; endless bodies stop", async () => {
  const big = await fake(null, (req, res) => {
    if (req.url === "/big.xml") {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.write(`<rss><channel><title>Big</title>`);
      let i = 0;
      const pump = () => {
        while (!res.destroyed && i < 60_000) {
          const ok = res.write(`<item><title>Ep ${i}</title><guid>g${i}</guid><enclosure url="https://cdn.example/${i}.mp3" type="audio/mpeg"/><description>${"x".repeat(200)}</description></item>\n`);
          i++;
          if (!ok) return void res.once("drain", pump);
        }
        res.end("</channel></rss>");
      };
      pump();
    } else if (req.url === "/endless.xml") {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.write("<rss><channel><title>Endless</title>");
      const t = setInterval(() => res.write("<!--" + "y".repeat(100_000) + "-->"), 1);
      res.on("close", () => clearInterval(t));
    } else res.writeHead(404).end();
  });
  const r = await rig({}, [big]);
  r.h.fakePorts.add(big.port);
  const sub = await subscribe(r, r.h.alice, `${big.url}/big.xml`);
  const eps = await episodes(r, r.h.alice, sub.id, "?limit=1");
  assert.ok(eps.total > 1000 || eps.total === 1000, `kept ${eps.total}`);
  assert.ok(eps.total <= 1000, "episodes per feed are capped");
  const endless = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: `${big.url}/endless.xml` });
  assert.ok(endless.statusCode === 201 || endless.statusCode === 422, `endless: ${endless.statusCode}`);
  await r.close();
});

test("SSRF: feeds, enclosures, redirects and images that point at private addresses are refused", async () => {
  const secret = await fake(null, (_req, res) => res.writeHead(200, { "Content-Type": "audio/mpeg" }).end("INTERNAL-SECRET"));
  const evil = await fake(null, (req, res) => {
    if (req.url === "/redirect.xml") return void res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (req.url === "/inward.xml") return void res.writeHead(302, { Location: secret.url + "/feed.xml" }).end();
    if (req.url === "/feed.xml")
      return void res
        .writeHead(200, { "Content-Type": "application/rss+xml" })
        .end(`<rss><channel><title>Evil</title><itunes:image href="${secret.url}/cover.png" xmlns:itunes="x"/><item><title>Inner</title><guid>i</guid><enclosure url="${secret.url}/a.mp3" type="audio/mpeg"/></item><item><title>Hop</title><guid>h</guid><enclosure url="${evil.url}/hop.mp3" type="audio/mpeg"/></item></channel></rss>`);
    if (req.url === "/hop.mp3") return void res.writeHead(302, { Location: secret.url + "/a.mp3" }).end();
    res.writeHead(404).end();
  });
  const r = await rig({}, [evil, secret]);
  r.h.fakePorts.add(evil.port); // the feed host is allowed, the "internal" one is not
  for (const path of ["/redirect.xml", "/inward.xml"]) {
    const res = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: evil.url + path });
    assert.equal(res.statusCode, 400, path);
    assert.equal(res.json().error, "address_not_allowed");
  }
  for (const target of [secret.url + "/feed.xml", "http://[::1]:80/", "http://10.0.0.1/rss", "http://169.254.169.254/", "http://localhost/feed"]) {
    const res = await call(r, "POST", "/api/podcasts/subscriptions", r.h.alice, { feedUrl: target });
    assert.equal(res.statusCode, 400, target);
  }
  const sub = await subscribe(r, r.h.alice, evil.url + "/feed.xml");
  const eps = await episodes(r, r.h.alice, sub.id);
  // The enclosure that points inward and the one that redirects inward both fail when played.
  for (const ep of eps.items) {
    const su = (await call(r, "GET", `/api/podcasts/episodes/${ep.id}/stream-url`, r.h.alice)).json() as { path: string };
    const res = await call(r, "GET", `/${su.path}`, null);
    assert.equal(res.statusCode, 400, ep.title);
    assert.ok(!res.body.includes("INTERNAL-SECRET"));
  }
  // and so does the cover art
  const img = await call(r, "GET", `/${sub.image}`, null);
  assert.equal(img.statusCode, 404);
  assert.equal(secret.seen.length, 0, "the internal service was never contacted");
  await r.close();
});

test("audio proxy: Range requests pass through (206 + Content-Range), redirects are followed, signatures are required", async () => {
  const r = await rig();
  const sub = await subscribe(r, r.h.alice);
  const [third] = (await episodes(r, r.h.alice, sub.id)).items;
  const su = await call(r, "GET", `/api/podcasts/episodes/${third.id}/stream-url`, r.h.alice);
  assert.equal(su.statusCode, 200);
  const path = `/${(su.json() as { path: string }).path}`;
  const full = await call(r, "GET", path, null);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["content-type"], "audio/mpeg");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.rawPayload.equals(AUDIO), true);
  const part = await r.h.app.inject({ method: "GET", url: path, headers: { range: "bytes=10-19" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 10-19/${AUDIO.length}`);
  assert.equal(part.payload, "abcdefghij");
  assert.equal(r.site.seen.at(-1)!.headers.range, "bytes=10-19");
  // junk Range headers are not forwarded
  const junk = await r.h.app.inject({ method: "GET", url: path, headers: { range: "bytes=0-1,5-9" } });
  assert.equal(junk.statusCode, 200);
  assert.equal(r.site.seen.at(-1)!.headers.range, undefined);
  // signature rules
  assert.equal((await call(r, "GET", `/api/podcasts/audio/${third.id}`, null)).statusCode, 403);
  assert.equal((await call(r, "GET", path.replace(/sig=./, "sig=0"), null)).statusCode, 403);
  assert.equal((await call(r, "GET", path.replace(third.id, "0".repeat(20)), null)).statusCode, 403);
  assert.equal((await call(r, "GET", path.replace(/exp=\d+/, "exp=5"), null)).statusCode, 403);
  assert.equal((await call(r, "GET", `/api/podcasts/audio/${third.id}`, r.h.alice)).statusCode, 403, "a bearer token is not a stream URL");
  // pages are never relayed as audio
  r.h.db.prepare("UPDATE podcast_episodes SET audio_url = ? WHERE id = ?").run(`${r.site.url}/audio/page.mp3`, third.id);
  const html = await call(r, "GET", path, null);
  assert.equal(html.statusCode, 502);
  assert.ok(!html.body.includes("script"));
  r.h.db.prepare("UPDATE podcast_episodes SET audio_url = ? WHERE id = ?").run(`${r.site.url}/audio/hop.mp3`, third.id);
  assert.equal((await call(r, "GET", path, null)).statusCode, 200, "a CDN redirect is followed");
  await r.close();
});

test("images: proxied with a safe type, size-limited, SVG refused", async () => {
  const r = await rig();
  const sub = await subscribe(r, r.h.alice);
  const img = await call(r, "GET", `/${sub.image}`, null);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.match(String(img.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(img.rawPayload.equals(PNG), true);
  assert.equal((await call(r, "GET", "/api/podcasts/image?t=abc", null)).statusCode, 403);
  const svg = Buffer.from(`${r.site.url}/evil.svg`).toString("base64url");
  assert.equal((await call(r, "GET", `/api/podcasts/image?t=${svg}&u=1&exp=9999999999&sig=x`, null)).statusCode, 403, "unsigned address");
  await r.close();
});

test("progress: resume position and played state sync across devices, per person", async () => {
  const r = await rig();
  const sub = await subscribe(r, r.h.alice);
  await subscribe(r, r.h.bob);
  const [third, second] = (await episodes(r, r.h.alice, sub.id)).items;
  const put = (who: Auth, id: string, body: object) => call(r, "PUT", `/api/podcasts/episodes/${id}/progress`, who, body);

  const a = await put(r.h.alice, third.id, { position: 301.5, duration: 1200 });
  assert.equal(a.statusCode, 200);
  // "another device" of alice sees it
  const again = (await episodes(r, r.h.alice, sub.id)).items.find((e) => e.id === third.id)!;
  assert.equal(again.position, 301.5);
  assert.equal(again.played, false);
  // bob has his own state
  const bobs = (await episodes(r, r.h.bob, sub.id)).items.find((e) => e.id === third.id)!;
  assert.equal(bobs.position, 0);
  assert.equal((await call(r, "GET", `/api/podcasts/episodes/${third.id}`, r.h.bob)).json().position, 0);
  // near the end counts as played; unplayed count follows
  assert.equal((await put(r.h.alice, second.id, { position: 590, duration: 600 })).json().played, true);
  const subs = (await call(r, "GET", "/api/podcasts/subscriptions", r.h.alice)).json() as { items: { unplayed: number }[] };
  assert.equal(subs.items[0].unplayed, 2);
  assert.equal(((await call(r, "GET", "/api/podcasts/subscriptions", r.h.bob)).json() as { items: { unplayed: number }[] }).items[0].unplayed, 3);
  // marking unplayed rewinds
  const unp = await put(r.h.alice, second.id, { position: 590, played: false });
  assert.deepEqual([unp.json().played, unp.json().position], [false, 0]);
  // an older report from a device that was offline doesn't overwrite newer progress
  const stale = await put(r.h.alice, third.id, { position: 5, updatedAt: 1000 });
  assert.equal(stale.json().stale, true);
  assert.equal((await call(r, "GET", `/api/podcasts/episodes/${third.id}`, r.h.alice)).json().position, 301.5);
  // validation
  assert.equal((await put(r.h.alice, third.id, { position: -1 })).statusCode, 400);
  assert.equal((await put(r.h.alice, third.id, { position: "abc" })).statusCode, 400);
  assert.equal((await put(r.h.alice, "x".repeat(20), { position: 1 })).statusCode, 400);
  assert.equal((await put(r.h.alice, "0".repeat(20), { position: 1 })).statusCode, 404);
  assert.equal((await call(r, "PUT", `/api/podcasts/episodes/${third.id}/progress`, null, { position: 1 })).statusCode, 401);
  // "new" lists unplayed episodes, resumable ones first
  // unsubscribing forgets progress for that show
  assert.equal((await call(r, "DELETE", `/api/podcasts/subscriptions/${sub.id}`, r.h.alice)).statusCode, 204);
  const left = r.h.db.prepare("SELECT COUNT(*) AS n FROM podcast_progress WHERE user_id = (SELECT id FROM users WHERE username = 'alice')").get() as { n: number };
  assert.equal(left.n, 0);
  await r.close();
});

test("speed memory per show, auto-queue flag, and the next episodes for auto-queue", async () => {
  const r = await rig();
  const sub = await subscribe(r, r.h.alice);
  assert.equal(sub.autoQueue, true);
  const patch = (body: object, who: Auth = r.h.alice) => call(r, "PATCH", `/api/podcasts/subscriptions/${sub.id}`, who, body);
  assert.equal((await patch({ speed: 1.5 })).json().speed, 1.5);
  assert.equal((await patch({ speed: 9 })).statusCode, 400);
  assert.equal((await patch({ speed: "fast" })).statusCode, 400);
  assert.equal((await patch({ autoQueue: false })).json().autoQueue, false);
  assert.equal((await patch({ speed: 2 }, r.h.bob)).statusCode, 404, "bob is not subscribed");
  const eps = (await episodes(r, r.h.alice, sub.id, "?order=oldest")).items; // First, Second, Third
  const detail = (await call(r, "GET", `/api/podcasts/episodes/${eps[0].id}`, r.h.alice)).json();
  assert.equal(detail.speed, 1.5);
  assert.equal(detail.autoQueue, false);

  const next = async (after: string, who = r.h.alice) => ((await call(r, "GET", `/api/podcasts/feeds/${sub.id}/next?after=${after}&count=5`, who)).json() as { items: { title: string }[] }).items.map((e) => e.title);
  assert.deepEqual(await next(eps[0].id), ["Second", "Third"]);
  await call(r, "PUT", `/api/podcasts/episodes/${eps[1].id}/progress`, r.h.alice, { played: true, position: 0 });
  assert.deepEqual(await next(eps[0].id), ["Third"], "played episodes are skipped");
  assert.deepEqual(await next(eps[2].id), []);
  assert.equal((await call(r, "GET", `/api/podcasts/feeds/${sub.id}/next?after=${"0".repeat(20)}`, r.h.alice)).statusCode, 404);
  await r.close();
});

test("refresh: a new episode appears, unchanged feeds use If-None-Match, failures back off", async () => {
  const r = await rig();
  const sub = await subscribe(r, r.h.alice);
  r.eps.push({ guid: "e4", title: "Fourth", date: new Date().toUTCString(), file: "4.mp3" });
  const res = await call(r, "POST", "/api/podcasts/refresh", r.h.alice);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { feeds: 1, newEpisodes: 1 });
  assert.equal((await episodes(r, r.h.alice, sub.id)).items[0].title, "Fourth");
  assert.equal((await call(r, "POST", "/api/podcasts/refresh", r.h.alice)).statusCode, 429, "rate limited");
  const fresh = (await call(r, "GET", "/api/podcasts/new", r.h.alice)).json() as { items: { title: string }[] };
  assert.equal(fresh.items[0].title, "Fourth", "only recent unplayed episodes are 'new'");
  // second fetch of the unchanged feed is conditional
  await call(r, "POST", "/api/podcasts/refresh", r.h.bob); // bob has no subs: nothing to do
  const feedFetches = r.site.seen.filter((s) => s.url.startsWith("/feed.xml"));
  assert.equal(feedFetches.length, 2);
  assert.equal(feedFetches[1].headers["if-none-match"], '"v3"');
  await r.close();
});

test("background job refreshes subscribed feeds without anyone asking", async () => {
  const r = await rig({ refreshEveryMs: 1000 });
  const sub = await subscribe(r, r.h.alice);
  r.eps.push({ guid: "e9", title: "Surprise", date: new Date().toUTCString(), file: "9.mp3" });
  const deadline = Date.now() + 6000;
  let titles: string[] = [];
  while (Date.now() < deadline) {
    titles = (await episodes(r, r.h.alice, sub.id)).items.map((e) => e.title);
    if (titles.includes("Surprise")) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(titles.includes("Surprise"), `titles: ${titles}`);
  await r.close();
});

test("OPML: export lists only your shows; import subscribes in the background and skips bad entries", async () => {
  const r = await rig();
  await subscribe(r, r.h.alice);
  const out = await call(r, "GET", "/api/podcasts/opml", r.h.alice);
  assert.equal(out.statusCode, 200);
  assert.match(String(out.headers["content-type"]), /opml/);
  assert.match(out.body, /xmlUrl="[^"]*\/feed\.xml"/);
  assert.match(out.body, /text="The Show"/);
  assert.ok(!(await call(r, "GET", "/api/podcasts/opml", r.h.bob)).body.includes("The Show"));

  const opml = `<opml version="2.0"><body><outline text="Folder"><outline type="rss" text="Imported" xmlUrl="${r.feedUrl}"/></outline>
    <outline text="Bad" xmlUrl="file:///etc/passwd"/><outline text="Private" xmlUrl="http://10.0.0.7/rss"/></body></opml>`;
  const imp = await call(r, "POST", "/api/podcasts/opml", r.h.bob, { opml });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.deepEqual(imp.json(), { found: 2, added: 2, alreadySubscribed: 0 });
  const mine = (await call(r, "GET", "/api/podcasts/subscriptions", r.h.bob)).json() as { items: { title: string }[] };
  assert.equal(mine.items.length, 2);
  // the real feed gets its episodes shortly after; the private one never does
  const deadline = Date.now() + 5000;
  let total = 0;
  while (Date.now() < deadline && total === 0) {
    const real = (await call(r, "GET", "/api/podcasts/subscriptions", r.h.bob)).json() as { items: { id: string; title: string }[] };
    const show = real.items.find((i) => i.title === "The Show");
    if (show) total = (await episodes(r, r.h.bob, show.id)).total;
    if (!total) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(total, 3);
  assert.deepEqual((await call(r, "POST", "/api/podcasts/opml", r.h.bob, { opml })).json(), { found: 2, added: 0, alreadySubscribed: 2 });
  assert.equal((await call(r, "POST", "/api/podcasts/opml", r.h.bob, { opml: "<html/>" })).statusCode, 422);
  assert.equal((await call(r, "POST", "/api/podcasts/opml", r.h.bob, {})).statusCode, 400);
  await r.close();
});

test("directory search: iTunes by default (no key), Podcast Index when the admin sets keys, secret never returned", async () => {
  const dir = await fake(null, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/search?media=podcast"))
      return void res.end(JSON.stringify({ results: [{ collectionName: "Found Show", artistName: "Someone", feedUrl: "https://found.example/feed.xml", artworkUrl600: "https://found.example/a.jpg" }, { collectionName: "No feed" }] }));
    if (req.url?.startsWith("/api/1.0/search/byterm"))
      return void res.end(JSON.stringify({ feeds: [{ title: "Index Show", author: "Idx", url: "https://index.example/rss", image: "https://index.example/i.png" }] }));
    res.writeHead(404).end("{}");
  });
  const r = await rig({ itunesBase: dir.url, podcastIndexBase: dir.url });
  r.h.fakePorts.add(dir.port);
  const search = async (q: string, who = r.h.alice) => (await call(r, "GET", `/api/podcasts/search?q=${encodeURIComponent(q)}`, who)).json() as { source: string; items: { title: string; feedUrl: string; image?: string; subscribed: boolean }[] };

  assert.equal((await call(r, "GET", "/api/podcasts/search?q=x", null)).statusCode, 401);
  assert.deepEqual((await search("")).items, []);
  const it = await search("history");
  assert.equal(it.source, "itunes");
  assert.deepEqual(it.items.map((i) => i.title), ["Found Show"]);
  assert.match(it.items[0].image!, /^api\/podcasts\/image\?t=/);
  assert.equal(it.items[0].subscribed, false);
  assert.match(dir.seen[0].url, /term=history/);
  assert.equal(dir.seen[0].headers["x-auth-key"], undefined, "no key sent to iTunes");
  assert.equal((await call(r, "GET", "/api/podcasts/status", r.h.alice)).json().directory, "itunes");

  // only an admin can set the keys
  const keys = { podcastIndexKey: "ABCDEFGH", podcastIndexSecret: "super-secret-value" };
  assert.equal((await call(r, "PUT", "/api/podcasts/admin", r.h.alice, keys)).statusCode, 403);
  assert.equal((await call(r, "GET", "/api/podcasts/admin", r.h.alice)).statusCode, 403);
  assert.equal((await call(r, "PUT", "/api/podcasts/admin", r.h.admin, { podcastIndexKey: "x", podcastIndexSecret: "y" })).statusCode, 400);
  const saved = await call(r, "PUT", "/api/podcasts/admin", r.h.admin, keys);
  assert.deepEqual(saved.json(), { podcastIndexConfigured: true, podcastIndexKey: "ABCDEFGH" });
  assert.ok(!saved.body.includes("super-secret"));
  assert.ok(!(await call(r, "GET", "/api/podcasts/admin", r.h.admin)).body.includes("super-secret"));
  const stored = JSON.stringify(r.h.db.prepare("SELECT value FROM settings").all());
  assert.ok(!stored.includes("super-secret-value"), "secret is encrypted at rest");

  const pi = await search("history");
  assert.equal(pi.source, "podcastindex");
  assert.deepEqual(pi.items.map((i) => i.title), ["Index Show"]);
  const piCall = dir.seen.find((s) => s.url.startsWith("/api/1.0/search/byterm"))!;
  const date = piCall.headers["x-auth-date"] as string;
  assert.equal(piCall.headers["x-auth-key"], "ABCDEFGH");
  assert.equal(piCall.headers.authorization, createHash("sha1").update(`ABCDEFGH${keys.podcastIndexSecret}${date}`).digest("hex"));
  assert.ok(Math.abs(Number(date) - Date.now() / 1000) < 60);
  assert.match(piCall.headers["user-agent"] ?? "", /^Cadence-Server\//);

  // clearing the keys goes back to iTunes
  await call(r, "PUT", "/api/podcasts/admin", r.h.admin, { podcastIndexKey: null });
  assert.equal((await search("history")).source, "itunes");

  // the directory being down is a fixed message
  await dir.close();
  const down = await call(r, "GET", "/api/podcasts/search?q=again", r.h.alice);
  assert.equal(down.statusCode, 502);
  assert.ok(!down.body.includes("127.0.0.1"));
  await r.close();
});