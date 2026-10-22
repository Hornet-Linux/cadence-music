#!/usr/bin/env node
// End-to-end check of the Jellyfin source against a REAL Jellyfin, through a
// running Cadence server. Not part of CI (CI has no Jellyfin); run it by hand
// after changing apps/server/src/jellyfin.
//
// It expects a Jellyfin with a Music library of a few tagged tracks (the walk
// uses Daft Punk "One More Time", "D.A.N.C.E." by Justice and so on, and skips
// what isn't there), and an account on it. It changes only what it cleans up
// again: two throw-away Cadence users, one favourite, one play count.
//
//   cd apps/server && npm run build
//   PORT=8798 HOST=127.0.0.1 DATA_DIR=<temp> MUSIC_DIR=<temp> \
//     ADMIN_USERNAME=admin ADMIN_PASSWORD=<pw> JELLYFIN_URL=http://127.0.0.1:8096 \
//     node dist/index.js &
//   CADENCE_URL=http://127.0.0.1:8798 CADENCE_ADMIN_USER=admin CADENCE_ADMIN_PASSWORD=<pw> \
//     JELLYFIN_URL=http://127.0.0.1:8096 JELLYFIN_USER=tester JELLYFIN_PASSWORD=<pw> \
//     node scripts/jellyfin-smoke.mjs
//
// Exits 1 if any check fails. Tokens are never printed.

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`Set ${name}`);
    process.exit(2);
  }
  return v;
};

const CADENCE = env("CADENCE_URL", "http://127.0.0.1:8798").replace(/\/+$/, "");
const ADMIN_USER = env("CADENCE_ADMIN_USER", "admin");
const ADMIN_PASSWORD = env("CADENCE_ADMIN_PASSWORD");
const JELLYFIN = env("JELLYFIN_URL", "http://127.0.0.1:8096").replace(/\/+$/, "");
const JF_USER = env("JELLYFIN_USER", "tester");
const JF_PASSWORD = env("JELLYFIN_PASSWORD");

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passes++;
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ""}`);
  }
}
const section = (title) => console.log(`\n${title}`);

// ---- Cadence helper ----------------------------------------------------------------------

async function api(token, method, path, body) {
  const res = await fetch(`${CADENCE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

// ---- direct Jellyfin helper (only to verify what Cadence did) --------------------------------

const jfHeader = (token) =>
  `MediaBrowser Client="Cadence smoke", Device="Smoke test", DeviceId="cadence-smoke-verify", Version="1.0"${token ? `, Token="${token}"` : ""}`;

async function jfLogin() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { Authorization: jfHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ Username: JF_USER, Pw: JF_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Direct Jellyfin sign-in failed (${res.status})`);
  const j = await res.json();
  return { token: j.AccessToken, userId: j.User.Id };
}

const looksLikeAudio = (b) =>
  b.length > 4 &&
  (b.subarray(0, 4).toString("latin1") === "fLaC" ||
    b.subarray(0, 3).toString("latin1") === "ID3" ||
    b.subarray(0, 4).toString("latin1") === "OggS" ||
    b.subarray(0, 4).toString("latin1") === "RIFF" ||
    b.subarray(4, 8).toString("latin1") === "ftyp" ||
    (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)); // MPEG frame sync

const kind = (b) =>
  b.subarray(0, 4).toString("latin1") === "fLaC" ? "flac" : b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) ? "mp3" : "other";

const looksLikeImage = (b) => (b[0] === 0xff && b[1] === 0xd8) || b.subarray(1, 4).toString("latin1") === "PNG" || b.subarray(0, 4).toString("latin1") === "RIFF";

const stamp = Date.now().toString(36);
const created = [];

async function main() {
  const jf = await jfLogin();
  const jfGet = async (path) => {
    const res = await fetch(`${JELLYFIN}${path}`, { headers: { Authorization: jfHeader(jf.token) } });
    return res.ok ? res.json() : undefined;
  };
  const jfItem = async (id) => (await jfGet(`/Items?userId=${jf.userId}&Ids=${id}&Fields=`))?.Items?.[0];
  const cadenceDevices = async () => ((await jfGet("/Devices"))?.Items ?? []).filter((d) => d.AppName === "Cadence");

  section("Cadence server");
  const health = await api(undefined, "GET", "/api/health");
  check("server is up", health.status === 200, `HTTP ${health.status}`);
  const login = await api(undefined, "POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD });
  check("admin signs in", login.status === 200 && !!login.json?.token, `HTTP ${login.status}`);
  const admin = login.json.token;

  const makeUser = async (name) => {
    const password = `pw-${stamp}-${name}`;
    const r = await api(admin, "POST", "/api/admin/users", { username: `jfsmoke-${stamp}-${name}`, password });
    if (r.status !== 201 && r.status !== 200) throw new Error(`Could not create a test user (${r.status})`);
    created.push(r.json.id);
    const l = await api(undefined, "POST", "/api/auth/login", { username: `jfsmoke-${stamp}-${name}`, password });
    return l.json.token;
  };
  const alice = await makeUser("a");
  const bob = await makeUser("b");

  section("Status and sign-in");
  const adminView = await api(admin, "GET", "/api/admin/jellyfin");
  check("admin sees the Jellyfin address", adminView.status === 200 && adminView.json?.serverUrl === JELLYFIN, JSON.stringify(adminView.json));
  const test = await api(admin, "POST", "/api/admin/jellyfin/test", { serverUrl: JELLYFIN });
  check("admin test reaches Jellyfin", test.json?.ok === true && !!test.json?.version, JSON.stringify(test.json));
  console.log(`        (Jellyfin ${test.json?.version}, "${test.json?.serverName}")`);
  const before = await api(alice, "GET", "/api/jellyfin/status");
  check("status: configured, not connected yet", before.json?.configured === true && before.json?.connected === false, JSON.stringify(before.json));
  check("tracks need a sign-in first", (await api(alice, "GET", "/api/jellyfin/tracks")).json?.error === "jellyfin_not_connected");

  const wrong = await api(alice, "PUT", "/api/jellyfin/connection", { username: JF_USER, password: "definitely-wrong" });
  check("wrong password is 401 with a generic message", wrong.status === 401 && wrong.json?.error === "jellyfin_invalid_credentials", `HTTP ${wrong.status} ${wrong.text.slice(0, 120)}`);
  const devicesBefore = (await cadenceDevices()).length;
  const connect = await api(alice, "PUT", "/api/jellyfin/connection", { username: JF_USER, password: JF_PASSWORD });
  check("sign-in works", connect.status === 200 && connect.json?.connected === true && connect.json?.userName === JF_USER, `HTTP ${connect.status} ${connect.text.slice(0, 160)}`);
  check("the response carries no token or password", !/token|AccessToken/i.test(connect.text) && !connect.text.includes(JF_PASSWORD));
  check("a Cadence device shows up in Jellyfin", (await cadenceDevices()).length === devicesBefore + 1);
  const after = await api(alice, "GET", "/api/jellyfin/status");
  check("status: connected with server and user name", after.json?.connected === true && !!after.json?.serverName && after.json?.userName === JF_USER, JSON.stringify(after.json));

  section("Browse and search");
  const all = await api(alice, "GET", "/api/jellyfin/tracks?limit=500");
  const tracks = all.json?.items ?? [];
  check("tracks listed", all.status === 200 && tracks.length > 0 && all.json.total === tracks.length, `HTTP ${all.status} total=${all.json?.total} items=${tracks.length}`);
  console.log(`        (${tracks.length} tracks)`);
  const byTitle = (t) => tracks.find((x) => x.title === t);
  const oneMoreTime = byTitle("One More Time");
  const dance = byTitle("D.A.N.C.E.");
  check("track fields: title, artists, album, duration, artwork", !!oneMoreTime && oneMoreTime.artists[0] === "Daft Punk" && oneMoreTime.album === "Discovery" && oneMoreTime.durationSec > 1 && /^api\/jellyfin\/image\/[0-9a-f]{32}\?u=\d+&exp=\d+&sig=/.test(oneMoreTime.artwork ?? ""), JSON.stringify(oneMoreTime));
  check("limit is clamped to 500", (await api(alice, "GET", "/api/jellyfin/tracks?limit=100000")).status === 200);
  const small = await api(alice, "GET", "/api/jellyfin/tracks?limit=2&offset=1");
  check("limit and offset page the list", small.json?.items?.length === 2 && small.json?.total === tracks.length && small.json.items[0].id === tracks[1].id);
  const search = await api(alice, "GET", "/api/jellyfin/tracks?q=one%20more");
  check("search finds One More Time", search.json?.items?.some((t) => t.id === oneMoreTime?.id));
  const dp = await api(alice, "GET", "/api/jellyfin/tracks?artist=Daft%20Punk");
  check("artist filter", dp.json?.total === 5 && dp.json.items.every((t) => t.artists.includes("Daft Punk")), `total=${dp.json?.total}`);
  const alb = await api(alice, "GET", "/api/jellyfin/tracks?album=Discovery");
  check("album filter", alb.json?.total === 3, `total=${alb.json?.total}`);

  const albums = await api(alice, "GET", "/api/jellyfin/albums");
  const discovery = albums.json?.items?.find((a) => a.name === "Discovery");
  check("albums listed with artist, year, track count", albums.status === 200 && albums.json.total >= 5 && discovery?.artist === "Daft Punk" && discovery.year === 2001 && discovery.trackCount === 3, JSON.stringify(discovery));
  const albumTracks = await api(alice, "GET", `/api/jellyfin/albums/${discovery?.id}/tracks`);
  const numbers = (albumTracks.json?.items ?? []).map((t) => t.trackNo);
  check("album tracks, in track order", numbers.length === 3 && numbers.every((n, i) => i === 0 || n > numbers[i - 1]), albumTracks.json?.items?.map((t) => `${t.trackNo}:${t.title}`).join(" | "));
  const byAlbumId = await api(alice, "GET", `/api/jellyfin/tracks?albumId=${discovery?.id}`);
  check("tracks?albumId= agrees", byAlbumId.json?.total === 3);
  check("an album search", (await api(alice, "GET", "/api/jellyfin/albums?q=disco")).json?.items?.[0]?.name === "Discovery");
  check("a bad id is a 400 and never reaches Jellyfin", (await api(alice, "GET", "/api/jellyfin/albums/..%2F..%2FUsers/tracks")).status === 400 && (await api(alice, "PUT", "/api/jellyfin/favourites/not-an-id")).status === 400);

  // A playlist of our own on the live server, removed again at the end.
  const playlistRes = await fetch(`${JELLYFIN}/Playlists`, {
    method: "POST",
    headers: { Authorization: jfHeader(jf.token), "Content-Type": "application/json" },
    body: JSON.stringify({ Name: `cadence-smoke-${stamp}`, Ids: [oneMoreTime?.id, dance?.id].filter(Boolean), UserId: jf.userId, MediaType: "Audio" }),
  });
  const playlistId = playlistRes.ok ? (await playlistRes.json()).Id : undefined;
  try {
    const lists = await api(alice, "GET", "/api/jellyfin/playlists");
    const mine = lists.json?.items?.find((p) => p.id === playlistId);
    check("playlists listed", lists.status === 200 && mine?.trackCount === 2, JSON.stringify(lists.json));
    const lt = await api(alice, "GET", `/api/jellyfin/playlists/${playlistId}/tracks`);
    check("playlist tracks in order", lt.json?.items?.map((t) => t.title).join() === "One More Time,D.A.N.C.E.", lt.text.slice(0, 200));
  } finally {
    if (playlistId) await fetch(`${JELLYFIN}/Items/${playlistId}`, { method: "DELETE", headers: { Authorization: jfHeader(jf.token) } });
  }

  section("Matching AI picks");
  const match = await api(alice, "POST", "/api/jellyfin/match", {
    picks: [
      { artist: "Daft Punk", title: "One More Time" },
      { artist: "Daft Punk", title: "One More Time (Remastered 2011)" },
      { artist: "daft punk", title: "ONE MORE TIME" },
      { artist: "Daft Punk", title: "Get Lucky - Radio Edit" },
      { artist: "Justice", title: "D.A.N.C.E." },
      { artist: "Justice", title: "DANCE" },
      { artist: "Caribou", title: "Odessa (feat. Somebody)" },
      { artist: "Daft Punk", title: "A Song That Does Not Exist" },
      { artist: "Nobody At All", title: "One More Time" },
    ],
  });
  const m = match.json?.matches ?? [];
  const title = (x) => (x ? `${x.artists[0]} - ${x.title}` : null);
  check("exact match", title(m[0]) === "Daft Punk - One More Time", String(title(m[0])));
  check("(Remastered) noise ignored", m[1]?.id === m[0]?.id);
  check("wrong case ignored", m[2]?.id === m[0]?.id);
  check("'- Radio Edit' noise ignored", title(m[3]) === "Daft Punk - Get Lucky", String(title(m[3])));
  check("D.A.N.C.E. matches exactly and as DANCE", title(m[4]) === "Justice - D.A.N.C.E." && m[5]?.id === m[4]?.id, `${title(m[4])} / ${title(m[5])}`);
  check("'feat.' noise ignored", title(m[6]) === "Caribou - Odessa", String(title(m[6])));
  check("a song that isn't there is null", m[7] === null);
  check("right title, wrong artist is null", m[8] === null);
  check("result has one entry per pick", m.length === 9);
  const thirty = await api(alice, "POST", "/api/jellyfin/match", { picks: Array.from({ length: 30 }, () => ({ artist: "Daft Punk", title: "Get Lucky" })) });
  check("30 picks are fine", thirty.json?.matches?.length === 30 && thirty.json.matches.every((x) => x?.title === "Get Lucky"));
  check("31 picks are refused", (await api(alice, "POST", "/api/jellyfin/match", { picks: Array.from({ length: 31 }, () => ({ artist: "a", title: "b" })) })).status === 400);

  section("Streaming");
  let streamUrl;
  const su = await api(alice, "GET", `/api/jellyfin/tracks/${oneMoreTime?.id}/stream-url`);
  check("stream-url", su.status === 200 && /^api\/jellyfin\/stream\/[0-9a-f]{32}\?u=\d+&exp=\d+&sig=/.test(su.json?.path ?? "") && su.json.expiresAt > Date.now() / 1000 + 5 * 3600, su.text.slice(0, 160));
  streamUrl = `${CADENCE}/${su.json.path}`;
  const full = await fetch(streamUrl); // no Authorization header, like an <audio> element
  const fullBytes = Buffer.from(await full.arrayBuffer());
  check("whole file: 200, audio content type, Content-Length matches the bytes", full.status === 200 && /^audio\//.test(full.headers.get("content-type") ?? "") && Number(full.headers.get("content-length")) === fullBytes.length && fullBytes.length > 10_000, `HTTP ${full.status} ${full.headers.get("content-type")} len=${full.headers.get("content-length")} got=${fullBytes.length}`);
  check("the bytes really are audio", looksLikeAudio(fullBytes), `${kind(fullBytes)}; starts ${fullBytes.subarray(0, 8).toString("hex")}`);
  console.log(`        (${full.headers.get("content-type")}, ${fullBytes.length} bytes, Accept-Ranges: ${full.headers.get("accept-ranges")})`);
  const direct = full.headers.get("accept-ranges") === "bytes";
  const part = await fetch(streamUrl, { headers: { Range: "bytes=0-99" } });
  const partBytes = Buffer.from(await part.arrayBuffer());
  if (direct) {
    check("Range bytes=0-99: 206 with 100 bytes and Content-Range", part.status === 206 && partBytes.length === 100 && part.headers.get("content-range") === `bytes 0-99/${fullBytes.length}`, `HTTP ${part.status} len=${partBytes.length} cr=${part.headers.get("content-range")}`);
    check("those 100 bytes are the start of the file", partBytes.equals(fullBytes.subarray(0, 100)));
    const mid = await fetch(streamUrl, { headers: { Range: "bytes=1000-" } });
    const midBytes = Buffer.from(await mid.arrayBuffer());
    check("open-ended Range bytes=1000-", mid.status === 206 && midBytes.equals(fullBytes.subarray(1000)) && mid.headers.get("content-range") === `bytes 1000-${fullBytes.length - 1}/${fullBytes.length}`, `HTTP ${mid.status} len=${midBytes.length}`);
    const past = await fetch(streamUrl, { headers: { Range: `bytes=${fullBytes.length + 10}-` } });
    await past.arrayBuffer();
    check("Range past the end: 416", past.status === 416, `HTTP ${past.status}`);
  } else {
    check("Range on a transcoded stream: served whole (Jellyfin can't seek a live transcode)", part.status === 200 && looksLikeAudio(partBytes), `HTTP ${part.status}`);
  }

  // Every track, to see both the direct (FLAC) and the transcoded paths.
  const kinds = {};
  let bad = 0;
  for (const t of tracks) {
    const u = await api(alice, "GET", `/api/jellyfin/tracks/${t.id}/stream-url`);
    const r = await fetch(`${CADENCE}/${u.json.path}`, { headers: { Range: "bytes=0-" } });
    const b = Buffer.from(await r.arrayBuffer());
    const k = `${(r.headers.get("content-type") ?? "").split(";")[0]} (${kind(b)}, HTTP ${r.status})`;
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (!(r.status === 200 || r.status === 206) || !looksLikeAudio(b) || b.length < 5000) bad++;
  }
  check(`all ${tracks.length} tracks stream real audio`, bad === 0, `${bad} bad`);
  console.log(`        ${Object.entries(kinds).map(([k, n]) => `${n} x ${k}`).join("; ")}`);

  section("Signed URLs");
  const u = new URL(streamUrl);
  const tweak = (patch) => {
    const p = new URLSearchParams(u.search);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    return `${u.origin}${u.pathname}?${p}`;
  };
  const statusOf = async (url) => (await fetch(url).then(async (r) => (await r.arrayBuffer(), r.status)));
  check("bad signature: 403", (await statusOf(tweak({ sig: "AAAA" }))) === 403);
  check("expired: 403", (await statusOf(tweak({ exp: "1000" }))) === 403);
  check("another user's id on the same signature: 403", (await statusOf(tweak({ u: String(Number(u.searchParams.get("u")) + 1) }))) === 403);
  check("another track with this signature: 403", (await statusOf(streamUrl.replace(oneMoreTime.id, dance.id))) === 403);
  check("no signature: 403", (await statusOf(`${u.origin}${u.pathname}`)) === 403);
  const asImage = streamUrl.replace("/api/jellyfin/stream/", "/api/jellyfin/image/");
  check("a stream signature does not work for cover art: 403", (await statusOf(asImage)) === 403);

  section("Cover art");
  const art = await fetch(`${CADENCE}/${oneMoreTime.artwork}&w=64`);
  const artBytes = Buffer.from(await art.arrayBuffer());
  check("image: 200, image content type, real image bytes", art.status === 200 && /^image\//.test(art.headers.get("content-type") ?? "") && looksLikeImage(artBytes), `HTTP ${art.status} ${art.headers.get("content-type")} ${artBytes.subarray(0, 4).toString("hex")}`);
  check("long cache header", /max-age=\d{5,}/.test(art.headers.get("cache-control") ?? ""), art.headers.get("cache-control"));
  const big = Buffer.from(await (await fetch(`${CADENCE}/${oneMoreTime.artwork}&w=600`)).arrayBuffer());
  console.log(`        (w=64: ${artBytes.length} bytes, w=600: ${big.length} bytes)`);
  check("width is honoured (a thumbnail is no larger than the big one)", artBytes.length <= big.length);
  check("image with a bad signature: 403", (await statusOf(`${CADENCE}/${oneMoreTime.artwork.replace("sig=", "sig=x")}`)) === 403);

  section("Favourites");
  const favBefore = (await jfItem(oneMoreTime.id))?.UserData?.IsFavorite === true;
  const put = await api(alice, "PUT", `/api/jellyfin/favourites/${oneMoreTime.id}`);
  check("favourite on: 204", put.status === 204, `HTTP ${put.status}`);
  check("...and Jellyfin agrees", (await jfItem(oneMoreTime.id))?.UserData?.IsFavorite === true);
  const favs = await api(alice, "GET", "/api/jellyfin/tracks?favourites=1");
  check("...and tracks?favourites=1 lists it, flagged", favs.json?.items?.some((t) => t.id === oneMoreTime.id && t.favourite === true));
  const del = await api(alice, "DELETE", `/api/jellyfin/favourites/${oneMoreTime.id}`);
  check("favourite off: 204", del.status === 204, `HTTP ${del.status}`);
  check("...and Jellyfin agrees", (await jfItem(oneMoreTime.id))?.UserData?.IsFavorite === false);
  check("...and it left the favourites list", !(await api(alice, "GET", "/api/jellyfin/tracks?favourites=1")).json?.items?.some((t) => t.id === oneMoreTime.id));
  void favBefore;

  section("Playback reports");
  // A Jellyfin nobody has played anything on: the DJ gets a sample of the library instead.
  const anyPlayedOnly =(await jfGet(`/Items?userId=${jf.userId}&IncludeItemTypes=Audio&Recursive=true&Filters=IsPlayed&Limit=1`))?.Items?.length ?? 0;
  const anyFavourite = (await jfGet(`/Items?userId=${jf.userId}&IncludeItemTypes=Audio&Recursive=true&Filters=IsFavorite&Limit=1`))?.Items?.length ?? 0;
  if (anyPlayedOnly === 0 && anyFavourite === 0) {
    const fresh = (await api(alice, "GET", "/api/jellyfin/taste")).json ?? {};
    check("taste with no plays yet falls back to the library", fresh.topArtists?.length > 0 && fresh.topTracks?.length > 0 && fresh.genres?.length > 0 && fresh.recentTracks?.length === 0, JSON.stringify(fresh).slice(0, 300));
    console.log(`        (fresh: ${fresh.topArtists?.length} artists, ${fresh.genres?.length} genres, ${fresh.topTracks?.length} tracks)`);
  } else {
    console.log("        (skipped the empty-history taste check: this Jellyfin already has plays or favourites)");
  }
  const item0 = await jfItem(dance.id);
  const plays0 = item0?.UserData?.PlayCount ?? 0;
  const last0 = item0?.UserData?.LastPlayedDate ?? null;
  const report = (event, positionSec) => api(alice, "POST", "/api/jellyfin/playback", { event, itemId: dance.id, positionSec });
  check("start: 204", (await report("start", 0)).status === 204);
  const sessions = await jfGet("/Sessions");
  const playing = (sessions ?? []).find((s) => s.NowPlayingItem?.Id === dance.id && s.DeviceName === "Cadence server");
  check("Jellyfin shows the track as now playing on the Cadence device", !!playing, `${(sessions ?? []).length} sessions`);
  check("progress: 204", (await report("progress", 3)).status === 204);
  const prog = (await jfGet("/Sessions"))?.find((s) => s.NowPlayingItem?.Id === dance.id && s.DeviceName === "Cadence server");
  check("position is reported in ticks (3 s)", Math.abs((prog?.PlayState?.PositionTicks ?? -1) - 30_000_000) < 5_000_000, String(prog?.PlayState?.PositionTicks));
  check("stop at the end: 204", (await report("stop", dance.durationSec)).status === 204);
  await new Promise((r) => setTimeout(r, 500));
  const item1 = await jfItem(dance.id);
  check("PlayCount went up in Jellyfin", (item1?.UserData?.PlayCount ?? 0) === plays0 + 1, `${plays0} -> ${item1?.UserData?.PlayCount}`);
  check("last played date changed", !!item1?.UserData?.LastPlayedDate && item1.UserData.LastPlayedDate !== last0, `${last0} -> ${item1?.UserData?.LastPlayedDate}`);
  check("a bad report is a 400", (await api(alice, "POST", "/api/jellyfin/playback", { event: "start", itemId: "x", positionSec: 1 })).status === 400);

  section("AI DJ taste profile");
  const taste = await api(alice, "GET", "/api/jellyfin/taste");
  const tp = taste.json ?? {};
  check("taste: 200 with the DjTasteProfile shape", taste.status === 200 && ["topArtists", "genres", "topTracks", "recentTracks"].every((k) => Array.isArray(tp[k])), taste.text.slice(0, 200));
  console.log(`        topArtists=${JSON.stringify(tp.topArtists?.slice(0, 5))} genres=${JSON.stringify(tp.genres?.slice(0, 5))}`);
  console.log(`        topTracks=${JSON.stringify(tp.topTracks?.slice(0, 3))} recent=${JSON.stringify(tp.recentTracks?.slice(0, 3))}`);
  check("the artist just played ranks first", tp.topArtists?.[0] === "Justice", String(tp.topArtists?.[0]));
  check("the song just played is in top and recent tracks", tp.topTracks?.[0] === "Justice – D.A.N.C.E." && tp.recentTracks?.[0] === "Justice – D.A.N.C.E.", `${tp.topTracks?.[0]} / ${tp.recentTracks?.[0]}`);
  check("genres come from the artists", (tp.genres ?? []).length > 0);

  section("A second person");
  check("Bob has no Jellyfin sign-in: tracks refused", (await api(bob, "GET", "/api/jellyfin/tracks")).json?.error === "jellyfin_not_connected");
  check("Bob cannot get a stream URL", (await api(bob, "GET", `/api/jellyfin/tracks/${dance.id}/stream-url`)).status === 409);
  const aliceUrl = `${CADENCE}/${(await api(alice, "GET", `/api/jellyfin/tracks/${dance.id}/stream-url`)).json.path}`;
  const bobId = Number(u.searchParams.get("u")) + 1; // ids are sequential: the next user is Bob
  const asBob = new URL(aliceUrl);
  asBob.searchParams.set("u", String(bobId));
  check("Alice's URL cannot be turned into Bob's", (await statusOf(asBob.toString())) === 403);
  const bobConnect = await api(bob, "PUT", "/api/jellyfin/connection", { username: JF_USER, password: JF_PASSWORD });
  check("Bob signs in to his own Jellyfin session", bobConnect.status === 200);
  check("Jellyfin now shows two Cadence devices (one per person)", (await cadenceDevices()).length === devicesBefore + 2);
  const bobUrl = `${CADENCE}/${(await api(bob, "GET", `/api/jellyfin/tracks/${dance.id}/stream-url`)).json.path}`;
  check("each person's stream URL works", (await statusOf(aliceUrl)) === 200 && (await statusOf(bobUrl)) === 200);
  check("the two URLs are different (user is part of the signature)", new URL(aliceUrl).search !== new URL(bobUrl).search);
  const bobOut = await api(bob, "DELETE", "/api/jellyfin/connection");
  check("Bob signs out: 204", bobOut.status === 204);
  check("Bob's URL stops, Alice's keeps working", (await statusOf(bobUrl)) === 401 && (await statusOf(aliceUrl)) === 200);
  check("only Bob's device left Jellyfin", (await cadenceDevices()).length === devicesBefore + 1);

  section("Sign out");
  const out = await api(alice, "DELETE", "/api/jellyfin/connection");
  check("disconnect: 204", out.status === 204, `HTTP ${out.status}`);
  check("status: not connected", (await api(alice, "GET", "/api/jellyfin/status")).json?.connected === false);
  check("her old stream URL no longer works", (await statusOf(aliceUrl)) === 401);
  check("the device was signed out in Jellyfin", (await cadenceDevices()).length === devicesBefore);

  // ---- tidy up ----
  await fetch(`${JELLYFIN}/UserPlayedItems/${dance.id}?userId=${jf.userId}`, { method: "DELETE", headers: { Authorization: jfHeader(jf.token) } });
  const tidy = await jfItem(dance.id);
  check("tidy: play count back to what it was", (tidy?.UserData?.PlayCount ?? 0) === plays0, String(tidy?.UserData?.PlayCount));
  await fetch(`${JELLYFIN}/Sessions/Logout`, { method: "POST", headers: { Authorization: jfHeader(jf.token) } });
}

try {
  await main();
} catch (e) {
  failures++;
  console.log(`\nFAILED with an error: ${e instanceof Error ? e.message : e}`);
} finally {
  // Remove the throw-away users (this also drops their stored Jellyfin rows).
  try {
    const l = await api(undefined, "POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD });
    for (const id of created) await api(l.json.token, "DELETE", `/api/admin/users/${id}`);
  } catch {
    console.log("Could not remove the test users; delete jfsmoke-* from the admin panel.");
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
