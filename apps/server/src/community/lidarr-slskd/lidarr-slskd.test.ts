import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "../_ops/testkit.js";
import { LEGAL_NOTICE, NOTICE_VERSION, createLidarrSlskdPlugin } from "./plugin.js";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A pretend Lidarr and slskd, answering on two made-up hosts. */
function fakes() {
  const calls: Call[] = [];
  const lidarrAlbums: Record<string, { id?: number; title: string; foreignAlbumId: string; artist: { artistName: string; foreignArtistId: string } }> = {
    "aaaaaaaa-0000-4000-8000-000000000001": { title: "OK Computer", foreignAlbumId: "aaaaaaaa-0000-4000-8000-000000000001", artist: { artistName: "Radiohead", foreignArtistId: "artist-1" } },
    "aaaaaaaa-0000-4000-8000-000000000002": { id: 42, title: "Kid A", foreignAlbumId: "aaaaaaaa-0000-4000-8000-000000000002", artist: { artistName: "Radiohead", foreignArtistId: "artist-1" } },
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method: init?.method ?? "GET", url, headers, body };
    calls.push(call);
    const path = url.pathname;
    if (url.hostname === "lidarr.test") {
      if (headers["x-api-key"] !== "lidarr-key") return json({ error: "Unauthorized" }, 401);
      if (path === "/api/v1/system/status") return json({ appName: "Lidarr", version: "2.5.0", instanceName: "Lidarr" });
      if (path === "/api/v1/rootfolder") return json([{ id: 1, path: "/music" }]);
      if (path === "/api/v1/qualityprofile") return json([{ id: 7, name: "Any" }]);
      if (path === "/api/v1/metadataprofile") return json([{ id: 3, name: "Standard" }]);
      if (path === "/api/v1/album/lookup") {
        const term = url.searchParams.get("term") ?? "";
        if (term.startsWith("lidarr:")) return json([lidarrAlbums[term.slice(7)]].filter(Boolean));
        return json(Object.values(lidarrAlbums).map((a) => ({ ...a, releaseDate: "1997-05-21T00:00:00Z", albumType: "Album", monitored: Boolean(a.id), images: [{ coverType: "cover", remoteUrl: "https://img.test/c.jpg" }] })));
      }
      if (path === "/api/v1/album" && call.method === "GET") {
        const found = lidarrAlbums[url.searchParams.get("foreignAlbumId") ?? ""];
        return json(found?.id ? [found] : []);
      }
      if (path === "/api/v1/album" && call.method === "POST") return json({ id: 99, title: "OK Computer" });
      if (path === "/api/v1/album/monitor" && call.method === "PUT") return json([]);
      if (path === "/api/v1/command" && call.method === "POST") return json({ id: 1 });
      if (path === "/api/v1/queue") return json({ records: [{ title: "Radiohead - OK Computer", size: 1000, sizeleft: 250, trackedDownloadState: "downloading", timeleft: "00:10:00", album: { title: "OK Computer" }, artist: { artistName: "Radiohead" } }] });
      if (path === "/api/v1/wanted/missing") return json({ totalRecords: 12 });
    }
    if (url.hostname === "slskd.test") {
      if (headers["x-api-key"] !== "slskd-key") return json({}, 401);
      if (path === "/api/v0/application") return json({ version: "0.21.0", server: { state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true }, user: { username: "me" } });
      if (path === "/api/v0/searches" && call.method === "POST") return json({ id: (body as { id: string }).id });
      if (/^\/api\/v0\/searches\/[^/]+$/.test(path) && call.method === "GET") return json({ searchText: "radiohead", state: "Completed, TimedOut", isComplete: true, responseCount: 2, fileCount: 30 });
      if (/\/responses$/.test(path)) {
        return json([
          { username: "slow", freeUploadSlots: 0, uploadSpeed: 10, fileCount: 1, files: [{ filename: "a.mp3", size: 5, extension: "mp3" }] },
          { username: "fast", freeUploadSlots: 2, uploadSpeed: 9000, fileCount: 1, files: [{ filename: "b.flac", size: 50, bitRate: 900, length: 240, extension: "flac" }] },
        ]);
      }
      if (/^\/api\/v0\/searches\/[^/]+$/.test(path) && call.method === "DELETE") return new Response(null, { status: 204 });
    }
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function setup() {
  const f = fakes();
  const t = await makeApp([createLidarrSlskdPlugin({ fetchFn: f.fetchFn })]);
  const admin = t.auth(t.adminToken);
  return { ...f, t, admin };
}

const configure = (t: Awaited<ReturnType<typeof setup>>) =>
  t.t.app.inject({
    method: "PUT",
    url: "/api/lidarr/config",
    headers: t.admin,
    payload: { acknowledged: true, noticeVersion: NOTICE_VERSION, lidarr: { url: "http://lidarr.test:8686", apiKey: "lidarr-key" }, slskd: { url: "http://slskd.test:5030/", apiKey: "slskd-key" } },
  });

test("nothing works until the administrator accepts the legal notice, and only admins can ask", async () => {
  const s = await setup();
  try {
    const user = s.t.auth(s.t.userToken);
    assert.equal((await s.t.app.inject({ method: "GET", url: "/api/lidarr/config", headers: user })).statusCode, 403);
    const before = await s.t.app.inject({ method: "GET", url: "/api/lidarr/search?q=radiohead", headers: s.admin });
    assert.equal(before.statusCode, 403);
    assert.equal((before.json() as { error: string }).error, "notice_not_accepted");
    // Saving addresses alone does not accept the notice.
    await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { lidarr: { url: "http://lidarr.test:8686", apiKey: "lidarr-key" } } });
    assert.equal((await s.t.app.inject({ method: "GET", url: "/api/lidarr/status", headers: s.admin })).statusCode, 403);
    // Accepting needs the notice version that was shown.
    assert.equal((await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { acknowledged: true } })).statusCode, 400);
    assert.equal(s.calls.length, 0, "no request reached Lidarr or slskd");
    assert.ok(LEGAL_NOTICE.includes("responsible"));
  } finally {
    await s.t.cleanup();
  }
});

test("settings keep API keys sealed and never return them; a changed address needs the key again", async () => {
  const s = await setup();
  try {
    const saved = await configure(s);
    assert.equal(saved.statusCode, 200);
    const body = saved.json() as { lidarr: { url: string; apiKeySet: boolean }; slskd: { url: string }; acknowledged: { by: string } };
    assert.equal(body.lidarr.apiKeySet, true);
    assert.equal(body.slskd.url, "http://slskd.test:5030");
    assert.equal(body.acknowledged.by, "admin");
    assert.ok(!saved.body.includes("lidarr-key") && !saved.body.includes("slskd-key"));
    const stored = (s.t.db.prepare("SELECT value FROM settings WHERE key = 'plugin:cadence.lidarr-slskd:config'").get() as { value: string }).value;
    assert.ok(!stored.includes("lidarr-key") && !stored.includes("slskd-key"));
    // A blank key keeps the saved one (same address)...
    const same = await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { lidarr: { url: "http://lidarr.test:8686", apiKey: "", rootFolderPath: "/media" } } });
    assert.equal(same.statusCode, 200);
    assert.equal((await s.t.app.inject({ method: "GET", url: "/api/lidarr/search?q=radiohead", headers: s.admin })).statusCode, 200);
    // ...but is refused for a different host, so the key can't be sent somewhere new.
    const moved = await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { lidarr: { url: "http://evil.test:8686", apiKey: "" } } });
    assert.equal(moved.statusCode, 400);
    assert.equal((await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { lidarr: { url: "ftp://x", apiKey: "k" } } })).statusCode, 400);
  } finally {
    await s.t.cleanup();
  }
});

test("Lidarr: test, search, add a new album, monitor a known one, and show the queue", async () => {
  const s = await setup();
  try {
    await configure(s);
    const test = (await s.t.app.inject({ method: "POST", url: "/api/lidarr/test", headers: s.admin })).json() as { lidarr: { ok: boolean; version: string; rootFolders: string[] }; slskd: { ok: boolean; connected: boolean } };
    assert.equal(test.lidarr.ok, true);
    assert.equal(test.lidarr.version, "2.5.0");
    assert.deepEqual(test.lidarr.rootFolders, ["/music"]);
    assert.equal(test.slskd.connected, true);

    const search = (await s.t.app.inject({ method: "GET", url: "/api/lidarr/search?q=radiohead", headers: s.admin })).json() as { items: { foreignAlbumId: string; title: string; inLibrary: boolean; cover: string; releaseDate: string }[] };
    assert.deepEqual(search.items.map((i) => [i.title, i.inLibrary]), [["OK Computer", false], ["Kid A", true]]);
    assert.equal(search.items[0].releaseDate, "1997-05-21");
    assert.equal(search.items[0].cover, "https://img.test/c.jpg");

    const added = await s.t.app.inject({ method: "POST", url: "/api/lidarr/request", headers: s.admin, payload: { foreignAlbumId: "aaaaaaaa-0000-4000-8000-000000000001" } });
    assert.equal(added.statusCode, 201);
    assert.equal((added.json() as { action: string }).action, "added");
    const post = s.calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v1/album")!;
    const sent = post.body as { monitored: boolean; addOptions: { searchForNewAlbum: boolean }; artist: { rootFolderPath: string; qualityProfileId: number; metadataProfileId: number; addOptions: { monitor: string; albumsToMonitor: string[] } } };
    assert.equal(sent.monitored, true);
    assert.equal(sent.addOptions.searchForNewAlbum, true);
    assert.equal(sent.artist.rootFolderPath, "/music");
    assert.equal(sent.artist.qualityProfileId, 7);
    assert.equal(sent.artist.metadataProfileId, 3);
    assert.deepEqual(sent.artist.addOptions, { monitor: "none", albumsToMonitor: ["aaaaaaaa-0000-4000-8000-000000000001"], searchForMissingAlbums: false });
    assert.equal(post.headers["x-api-key"], "lidarr-key");

    const monitored = await s.t.app.inject({ method: "POST", url: "/api/lidarr/request", headers: s.admin, payload: { foreignAlbumId: "aaaaaaaa-0000-4000-8000-000000000002" } });
    assert.equal((monitored.json() as { action: string }).action, "monitored");
    assert.deepEqual(s.calls.find((c) => c.url.pathname === "/api/v1/album/monitor")!.body, { albumIds: [42], monitored: true });
    assert.deepEqual(s.calls.find((c) => c.url.pathname === "/api/v1/command")!.body, { name: "AlbumSearch", albumIds: [42] });

    assert.equal((await s.t.app.inject({ method: "POST", url: "/api/lidarr/request", headers: s.admin, payload: { foreignAlbumId: "../etc" } })).statusCode, 400);

    const status = (await s.t.app.inject({ method: "GET", url: "/api/lidarr/status", headers: s.admin })).json() as { connected: boolean; missing: number; queue: { title: string; artist: string; progress: number; status: string }[] };
    assert.equal(status.missing, 12);
    assert.deepEqual(status.queue[0], { title: "OK Computer", artist: "Radiohead", status: "downloading", progress: 75, timeLeft: "00:10:00", errorMessage: null });

    const requests = (await s.t.app.inject({ method: "GET", url: "/api/lidarr/requests", headers: s.admin })).json() as { items: { title: string; action: string; requestedBy: string }[] };
    assert.deepEqual(requests.items.map((r) => [r.title, r.action, r.requestedBy]), [["Kid A", "monitored", "admin"], ["OK Computer", "added", "admin"]]);
  } finally {
    await s.t.cleanup();
  }
});

test("an upstream failure is reported, not thrown", async () => {
  const s = await setup();
  try {
    await s.t.app.inject({ method: "PUT", url: "/api/lidarr/config", headers: s.admin, payload: { acknowledged: true, noticeVersion: NOTICE_VERSION, lidarr: { url: "http://lidarr.test:8686", apiKey: "wrong" } } });
    const res = await s.t.app.inject({ method: "GET", url: "/api/lidarr/search?q=radiohead", headers: s.admin });
    assert.equal(res.statusCode, 401);
    assert.match((res.json() as { message: string }).message, /lidarr\.test/);
    assert.equal((await s.t.app.inject({ method: "GET", url: "/api/slskd/status", headers: s.admin })).statusCode, 409);
  } finally {
    await s.t.cleanup();
  }
});

test("slskd: status and search only, and the strongest sources come first", async () => {
  const s = await setup();
  try {
    await configure(s);
    const status = (await s.t.app.inject({ method: "GET", url: "/api/slskd/status", headers: s.admin })).json() as { connected: boolean; version: string; username: string };
    assert.deepEqual([status.connected, status.version, status.username], [true, "0.21.0", "me"]);
    const started = await s.t.app.inject({ method: "POST", url: "/api/slskd/search", headers: s.admin, payload: { query: "radiohead ok computer" } });
    assert.equal(started.statusCode, 202);
    const id = (started.json() as { id: string }).id;
    const post = s.calls.find((c) => c.method === "POST" && c.url.pathname === "/api/v0/searches")!;
    assert.equal((post.body as { searchText: string }).searchText, "radiohead ok computer");
    const result = (await s.t.app.inject({ method: "GET", url: `/api/slskd/search/${id}`, headers: s.admin })).json() as { isComplete: boolean; responses: { username: string; files: { lengthSec: number | null }[] }[] };
    assert.equal(result.isComplete, true);
    assert.deepEqual(result.responses.map((r) => r.username), ["fast", "slow"]);
    assert.equal(result.responses[0].files[0].lengthSec, 240);
    assert.equal((await s.t.app.inject({ method: "DELETE", url: `/api/slskd/search/${id}`, headers: s.admin })).statusCode, 204);
    assert.equal((await s.t.app.inject({ method: "GET", url: "/api/slskd/search/not-an-id", headers: s.admin })).statusCode, 400);
    // Cadence never touches slskd's transfer (download) endpoints.
    const slskdCalls = s.calls.filter((c) => c.url.hostname === "slskd.test");
    assert.ok(slskdCalls.every((c) => /^\/api\/v0\/(application|searches)/.test(c.url.pathname)), slskdCalls.map((c) => c.url.pathname).join(","));
    assert.ok(!slskdCalls.some((c) => /transfers|downloads/i.test(c.url.pathname)));
  } finally {
    await s.t.cleanup();
  }
});
test("a refused request still explains itself over a real connection", async () => {
  const s = await setup();
  try {
    await s.t.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = s.t.app.server.address() as import("node:net").AddressInfo;
    for (const path of ["/api/lidarr/status", "/api/slskd/status", "/api/lidarr/search?q=x"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: s.admin });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "notice_not_accepted", path);
    }
  } finally {
    await s.t.cleanup();
  }
});
