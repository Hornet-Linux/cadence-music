import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DeliveryError,
  LASTFM,
  LIBREFM,
  lastfmGetSession,
  lastfmGetToken,
  lastfmScrobble,
  lastfmSignature,
  listenBrainzListen,
  listenBrainzSubmit,
  listenBrainzValidate,
  malojaScrobble,
  malojaTest,
  parseServiceUrl,
  retryAfterMs,
  type Scrobble,
} from "./services.js";

const keys = { apiKey: "0123456789abcdef", apiSecret: "secretsecret1234" };
const play: Scrobble = {
  artist: "Boards of Canada",
  artists: ["Boards of Canada"],
  title: "Roygbiv",
  album: "Music Has the Right to Children",
  durationSec: 151,
  playedAt: 1_700_000_000,
};

interface Call {
  url: URL;
  init: RequestInit;
  form: URLSearchParams | null;
  json: Record<string, unknown> | null;
}

/** A fetch that records requests and answers from `reply`. */
function mock(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    const type = String((init.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "");
    const call: Call = {
      url: new URL(String(input)),
      init,
      form: type.includes("x-www-form-urlencoded") ? new URLSearchParams(body) : null,
      json: type.includes("json") ? (JSON.parse(body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Recompute a Last.fm signature the way the service does, from what it received. */
function serverSideSignature(params: URLSearchParams, secret: string): string {
  const pairs = [...params.entries()].filter(([k]) => k !== "api_sig" && k !== "format" && k !== "callback");
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("md5").update(pairs.map(([k, v]) => k + v).join("") + secret, "utf8").digest("hex");
}

test("Last.fm signature is the md5 of sorted name+value pairs plus the secret, without format", () => {
  const sig = lastfmSignature({ method: "auth.getToken", api_key: "xxx", format: "json" }, "sss");
  assert.equal(sig, createHash("md5").update("api_keyxxxmethodauth.getTokensss").digest("hex"));
  // Unicode is signed as UTF-8.
  const uni = lastfmSignature({ artist: "Björk", method: "x" }, "s");
  assert.equal(uni, createHash("md5").update("artistBjörkmethodxs", "utf8").digest("hex"));
});

test("Last.fm getToken signs the request and builds the approval link", async () => {
  const m = mock(() => json({ token: "tok123" }));
  const out = await lastfmGetToken(m.fn, LASTFM, keys, "https://cadence.example/app/");
  assert.equal(out.token, "tok123");
  const url = new URL(out.approveUrl);
  assert.equal(url.origin + url.pathname, "https://www.last.fm/api/auth/");
  assert.equal(url.searchParams.get("api_key"), keys.apiKey);
  assert.equal(url.searchParams.get("token"), "tok123");
  assert.equal(url.searchParams.get("cb"), "https://cadence.example/app/");
  const sent = m.calls[0]!.url;
  assert.equal(sent.origin + sent.pathname, "https://ws.audioscrobbler.com/2.0/");
  assert.equal(sent.searchParams.get("method"), "auth.getToken");
  assert.equal(sent.searchParams.get("format"), "json");
  assert.equal(sent.searchParams.get("api_sig"), serverSideSignature(sent.searchParams, keys.apiSecret));
  assert.equal(sent.searchParams.has("api_secret"), false, "the secret never travels");
});

test("Last.fm getSession returns the session key; an unapproved token is an auth failure", async () => {
  const ok = mock(() => json({ session: { name: "rj", key: "sessionkey", subscriber: 0 } }));
  assert.deepEqual(await lastfmGetSession(ok.fn, LASTFM, keys, "tok"), { sessionKey: "sessionkey", username: "rj" });
  assert.equal(ok.calls[0]!.url.searchParams.get("token"), "tok");

  const pending = mock(() => json({ error: 14, message: "This token has not been authorized" }));
  await assert.rejects(lastfmGetSession(pending.fn, LASTFM, keys, "tok"), (e: DeliveryError) => e.kind === "auth");
});

test("Last.fm scrobble posts indexed form fields with a valid signature", async () => {
  const m = mock(() => json({ scrobbles: { "@attr": { accepted: 2, ignored: 0 } } }));
  const second: Scrobble = { artist: "Aphex Twin", artists: ["Aphex Twin"], title: "Xtal", playedAt: 1_700_000_300 };
  await lastfmScrobble(m.fn, LASTFM, keys, "sk1", [play, second]);
  const call = m.calls[0]!;
  assert.equal(call.init.method, "POST");
  const f = call.form!;
  assert.equal(f.get("method"), "track.scrobble");
  assert.equal(f.get("sk"), "sk1");
  assert.equal(f.get("artist[0]"), "Boards of Canada");
  assert.equal(f.get("track[0]"), "Roygbiv");
  assert.equal(f.get("album[0]"), "Music Has the Right to Children");
  assert.equal(f.get("timestamp[0]"), "1700000000");
  assert.equal(f.get("duration[0]"), "151");
  assert.equal(f.get("artist[1]"), "Aphex Twin");
  assert.equal(f.has("album[1]"), false);
  assert.equal(f.get("api_sig"), serverSideSignature(f, keys.apiSecret));
});

test("Libre.fm uses its own endpoints with the same scheme", async () => {
  const m = mock(() => json({ scrobbles: {} }));
  await lastfmScrobble(m.fn, LIBREFM, keys, "sk", [play]);
  assert.equal(m.calls[0]!.url.origin + m.calls[0]!.url.pathname, "https://libre.fm/2.0/");
  const t = mock(() => json({ token: "x" }));
  const { approveUrl } = await lastfmGetToken(t.fn, LIBREFM, keys);
  assert.equal(new URL(approveUrl).origin, "https://libre.fm");
});

test("Last.fm errors map to retry, auth or drop", async () => {
  const kind = async (error: number) => {
    const m = mock(() => json({ error, message: "m" }));
    try {
      await lastfmScrobble(m.fn, LASTFM, keys, "sk", [play]);
    } catch (e) {
      return (e as DeliveryError).kind;
    }
    return "ok";
  };
  assert.equal(await kind(9), "auth", "invalid session key");
  assert.equal(await kind(11), "retry", "service offline");
  assert.equal(await kind(16), "retry", "temporary error");
  assert.equal(await kind(29), "retry", "rate limit");
  assert.equal(await kind(6), "drop", "invalid parameters");
  const http500 = mock(() => new Response("oops", { status: 503 }));
  await assert.rejects(lastfmScrobble(http500.fn, LASTFM, keys, "sk", [play]), (e: DeliveryError) => e.kind === "retry");
});

test("a network failure is retryable and a redirect is refused", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(listenBrainzValidate(down, "https://lb.example", "token-value"), (e: DeliveryError) => e.kind === "retry");
  const redirect = mock(() => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }));
  await assert.rejects(malojaTest(redirect.fn, "https://m.example", "key"), (e: DeliveryError) => e.kind === "drop");
  assert.equal(redirect.calls.length, 1, "the redirect is not followed");
});

test("ListenBrainz sends one play as a single listen with a Token header", async () => {
  const m = mock(() => json({ status: "ok" }));
  await listenBrainzSubmit(m.fn, "https://api.listenbrainz.org", "my-lb-token", [play]);
  const c = m.calls[0]!;
  assert.equal(c.url.href, "https://api.listenbrainz.org/1/submit-listens");
  assert.equal((c.init.headers as Record<string, string>).Authorization, "Token my-lb-token");
  const body = c.json as { listen_type: string; payload: { listened_at: number; track_metadata: Record<string, unknown> }[] };
  assert.equal(body.listen_type, "single");
  assert.equal(body.payload.length, 1);
  assert.equal(body.payload[0]!.listened_at, 1_700_000_000);
  const tm = body.payload[0]!.track_metadata as { artist_name: string; track_name: string; release_name: string; additional_info: Record<string, unknown> };
  assert.equal(tm.artist_name, "Boards of Canada");
  assert.equal(tm.track_name, "Roygbiv");
  assert.equal(tm.release_name, "Music Has the Right to Children");
  assert.equal(tm.additional_info.media_player, "Cadence");
  assert.equal(tm.additional_info.duration, 151);
});

test("ListenBrainz batches use the import type, work with a self-hosted address, and tag Spotify tracks", async () => {
  const m = mock(() => json({ status: "ok" }));
  const spotify: Scrobble = { ...play, artists: ["A", "B"], artist: "A", trackId: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", playedAt: 1_700_000_500 };
  await listenBrainzSubmit(m.fn, "https://lb.home.example/", "tok-12345678", [play, spotify]);
  assert.equal(m.calls[0]!.url.href, "https://lb.home.example/1/submit-listens");
  const body = m.calls[0]!.json as { listen_type: string; payload: unknown[] };
  assert.equal(body.listen_type, "import");
  assert.equal(body.payload.length, 2);
  const info = (listenBrainzListen(spotify).track_metadata as { artist_name: string; additional_info: Record<string, unknown> });
  assert.equal(info.artist_name, "A, B");
  assert.equal(info.additional_info.music_service, "spotify.com");
  assert.equal(info.additional_info.origin_url, "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
});

test("ListenBrainz status codes: 401 auth, 429 retry with delay, 400 drop, 500 retry", async () => {
  const run = async (status: number, headers: Record<string, string> = {}) => {
    const m = mock(() => json({ code: status }, status, headers));
    try {
      await listenBrainzSubmit(m.fn, "https://api.listenbrainz.org", "token-1234", [play]);
    } catch (e) {
      return e as DeliveryError;
    }
    return null;
  };
  assert.equal((await run(401))!.kind, "auth");
  const limited = (await run(429, { "X-RateLimit-Reset-In": "12" }))!;
  assert.equal(limited.kind, "retry");
  assert.equal(limited.retryAfterMs, 12_000);
  assert.equal((await run(400))!.kind, "drop");
  assert.equal((await run(500))!.kind, "retry");
});

test("ListenBrainz validate-token returns the user name and rejects an invalid token", async () => {
  const good = mock(() => json({ valid: true, user_name: "rj" }));
  assert.equal(await listenBrainzValidate(good.fn, "https://api.listenbrainz.org", "token-1234"), "rj");
  assert.equal(good.calls[0]!.url.pathname, "/1/validate-token");
  const bad = mock(() => json({ valid: false, message: "Invalid token" }));
  await assert.rejects(listenBrainzValidate(bad.fn, "https://api.listenbrainz.org", "token-1234"), (e: DeliveryError) => e.kind === "auth");
});

test("Maloja posts the play with the key and time", async () => {
  const m = mock(() => json({ status: "success" }));
  await malojaScrobble(m.fn, "https://maloja.example", "apikey1", { ...play, artists: ["X", "Y"], artist: "X" });
  const c = m.calls[0]!;
  assert.equal(c.url.href, "https://maloja.example/apis/mlj_1/newscrobble");
  assert.deepEqual(c.json, {
    artists: ["X", "Y"],
    title: "Roygbiv",
    album: "Music Has the Right to Children",
    duration: 151,
    time: 1_700_000_000,
    key: "apikey1",
  });
  const denied = mock(() => json({ status: "error" }, 403));
  await assert.rejects(malojaScrobble(denied.fn, "https://maloja.example", "bad", play), (e: DeliveryError) => e.kind === "auth");
});

test("Maloja test falls back to serverinfo on versions without the test route", async () => {
  const old = mock((c) => (c.url.pathname.endsWith("/test") ? new Response("", { status: 404 }) : json({ name: "maloja" })));
  assert.deepEqual(await malojaTest(old.fn, "https://m.example", "k"), { keyChecked: false });
  const modern = mock(() => json({ status: "ok" }));
  assert.deepEqual(await malojaTest(modern.fn, "https://m.example", "k"), { keyChecked: true });
  assert.equal(modern.calls[0]!.url.searchParams.get("key"), "k");
});

test("addresses: http(s) only, no credentials or queries, no metadata endpoints", () => {
  assert.equal(parseServiceUrl("https://maloja.example.com/"), "https://maloja.example.com");
  assert.equal(parseServiceUrl("lb.example.com:8000/base/"), "https://lb.example.com:8000/base");
  assert.equal(parseServiceUrl("http://192.168.1.5:42010"), "http://192.168.1.5:42010");
  for (const bad of ["", "ftp://x.example", "file:///etc/passwd", "https://u:p@x.example", "https://x.example/?a=1", "http://169.254.169.254/latest", "has space.com", "javascript:alert(1)"]) {
    assert.throws(() => parseServiceUrl(bad), Error, bad);
  }
});

test("Retry-After accepts seconds and dates and is capped", () => {
  assert.equal(retryAfterMs(new Headers({ "Retry-After": "30" })), 30_000);
  assert.equal(retryAfterMs(new Headers({ "Retry-After": "999999999" })), 24 * 3600_000);
  assert.equal(retryAfterMs(new Headers({ "Retry-After": new Date(10_000).toUTCString() }), 4000), 6000);
  assert.equal(retryAfterMs(new Headers()), undefined);
});
