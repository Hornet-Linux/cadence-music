import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Stand-ins for plex.tv (link codes) and a Plex Media Server, for tests. They follow
 * the public shapes: JSON answers wrapped in `MediaContainer`, the token in the
 * `X-Plex-Token` header, `userRating` on a 0-10 scale, parts under /library/parts.
 * Lives next to the tests; not imported by the server.
 */

export const PAYLOAD = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));

interface Track {
  id: number;
  title: string;
  artistId: number;
  artist: string;
  albumId: number;
  album: string;
  index: number;
  container: string;
  codec: string;
  type: string;
}

export const IDS = { oneMoreTime: "101", dance: "102", getLucky: "103", oggSong: "104", stall: "900", endless: "901", gone: "999" };

const ARTISTS = [
  { id: 11, name: "Daft Punk" },
  { id: 12, name: "Justice" },
  { id: 13, name: "Nobody" },
];
const ALBUMS = [
  { id: 21, name: "Discovery", artistId: 11, year: 2001 },
  { id: 22, name: "Cross", artistId: 12, year: 2007 },
  { id: 23, name: "Random Access Memories", artistId: 11, year: 2013 },
  { id: 24, name: "Nothing", artistId: 13, year: 2020 },
];

const track = (id: number, title: string, albumId: number, container: string, codec: string): Track => {
  const album = ALBUMS.find((a) => a.id === albumId)!;
  const artist = ARTISTS.find((a) => a.id === album.artistId)!;
  return { id, title, artistId: artist.id, artist: artist.name, albumId, album: album.name, index: id % 100, container, codec, type: "track" };
};

export interface FakeCall {
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}

export class FakePlex {
  readonly pms: http.Server;
  readonly tvServer: http.Server;
  url = "";
  tvUrl = "";
  readonly calls: FakeCall[] = [];
  readonly tvCalls: FakeCall[] = [];
  /** Accounts allowed on the server. */
  readonly access = new Set<string>(["tester", "other"]);
  /** Plex tokens and the account each belongs to. */
  readonly tokens = new Map<string, string>();
  private readonly pinRows: { id: number; code: string; clientId: string; authToken: string | null; expired: boolean }[] = [];
  readonly ratings = new Map<string, Map<string, number>>();
  readonly plays = new Map<string, number>();
  readonly timeline: { id: string; state: string; time: number }[] = [];
  readonly tracks: Track[];
  /** A second music library on the server. */
  twoLibraries = false;
  failWith: string | null = null;
  redirectTo: string | null = null;
  huge = false;
  /** Set when the token showed up in a URL (it must only travel in a header). */
  tokenInUrl = false;
  readonly aborted: string[] = [];
  private nextToken = 1;

  constructor() {
    this.tracks = [
      track(101, "One More Time", 21, "flac", "flac"),
      track(102, "D.A.N.C.E.", 22, "mp3", "mp3"),
      track(103, "Get Lucky", 23, "mp4", "aac"),
      track(104, "Ogg Song", 23, "ogg", "vorbis"),
      track(900, "Stall", 24, "mp3", "mp3"),
      track(901, "Endless", 24, "mp3", "mp3"),
    ];
    this.pms = http.createServer((req, res) => this.handle(req, res, false));
    this.tvServer = http.createServer((req, res) => this.handle(req, res, true));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.pms.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => this.tvServer.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.pms.address() as AddressInfo).port}`;
    this.tvUrl = `http://127.0.0.1:${(this.tvServer.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of [this.pms, this.tvServer]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }

  callsTo(path: RegExp | string): FakeCall[] {
    return this.calls.filter((c) => (typeof path === "string" ? c.path === path : path.test(c.path)));
  }

  /** What the person does at plex.tv/link: enter the code while signed in as `account`. */
  link(code: string, account: string): string {
    const pin = this.pinRows.find((p) => p.code === code);
    if (!pin) throw new Error("no such code");
    const token = `plextok-${account}-${this.nextToken++}`;
    this.tokens.set(token, account);
    pin.authToken = token;
    return token;
  }

  lastPin(): { id: number; code: string; clientId: string } {
    return this.pinRows[this.pinRows.length - 1];
  }

  expireAllPins(): void {
    for (const p of this.pinRows) p.expired = true;
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private container(res: http.ServerResponse, body: Record<string, unknown>) {
    this.json(res, 200, { MediaContainer: body });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, tv: boolean) {
    const url = new URL(req.url ?? "/", "http://x");
    const call: FakeCall = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      (tv ? this.tvCalls : this.calls).push(call);
      if (url.search.toLowerCase().includes("token")) this.tokenInUrl = true;
      if (tv) this.tvRoute(req, res, url, raw);
      else this.pmsRoute(req, res, url);
    });
  }

  // ---- plex.tv --------------------------------------------------------------------

  private tvRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) {
    const clientId = String(req.headers["x-plex-client-identifier"] ?? "");
    const p = url.pathname;
    if (!clientId) return this.json(res, 400, { errors: [{ code: 1000, message: "missing client identifier" }] });
    if (p === "/api/v2/pins" && req.method === "POST") {
      if (!/strong=false/.test(body)) return this.json(res, 400, { errors: [] });
      const row = { id: 1000 + this.pinRows.length, code: String.fromCharCode(65 + this.pinRows.length) + "BCD", clientId, authToken: null as string | null, expired: false };
      this.pinRows.push(row);
      return this.json(res, 201, { id: row.id, code: row.code, authToken: null, expiresIn: 1800, trusted: false });
    }
    const pin = /^\/api\/v2\/pins\/(\d+)$/.exec(p);
    if (pin && req.method === "GET") {
      const row = this.pinRows.find((r) => r.id === Number(pin[1]));
      if (!row || row.expired || row.clientId !== clientId || url.searchParams.get("code") !== row.code) return this.json(res, 404, { errors: [{ code: 1020, message: "Code not found or expired" }] });
      return this.json(res, 200, { id: row.id, code: row.code, authToken: row.authToken });
    }
    if (p === "/api/v2/user") {
      const account = this.tokens.get(String(req.headers["x-plex-token"] ?? ""));
      if (!account) return this.json(res, 401, { errors: [{ code: 1001, message: "User could not be authenticated" }] });
      return this.json(res, 200, { username: account, title: account, id: 1 });
    }
    this.json(res, 404, {});
  }

  // ---- the media server -------------------------------------------------------------

  private rated(account: string): Map<string, number> {
    let m = this.ratings.get(account);
    if (!m) this.ratings.set(account, (m = new Map()));
    return m;
  }

  private trackJson(account: string, t: Track, full = false) {
    const rating = this.rated(account).get(String(t.id));
    return {
      ratingKey: String(t.id),
      type: "track",
      title: t.title,
      grandparentTitle: t.artist,
      grandparentRatingKey: String(t.artistId),
      parentTitle: t.album,
      parentRatingKey: String(t.albumId),
      parentThumb: `/library/metadata/${t.albumId}/thumb/1700000000`,
      thumb: `/library/metadata/${t.id}/thumb/1700000001`,
      index: t.index,
      duration: 200_000,
      viewCount: this.plays.get(String(t.id)) ?? 0,
      ...(rating !== undefined ? { userRating: rating } : {}),
      ...(full ? { Media: [{ container: t.container, audioCodec: t.codec, Part: [{ key: `/library/parts/${t.id}/1700000000/file.${t.container === "mp4" ? "m4a" : t.container}` }] }] } : {}),
    };
  }

  private albumJson(a: (typeof ALBUMS)[number]) {
    const artist = ARTISTS.find((x) => x.id === a.artistId)!;
    return {
      ratingKey: String(a.id),
      type: "album",
      title: a.name,
      parentTitle: artist.name,
      parentRatingKey: String(artist.id),
      year: a.year,
      leafCount: this.tracks.filter((t) => t.albumId === a.id).length,
      thumb: `/library/metadata/${a.id}/thumb/1700000000`,
    };
  }

  private artistJson(a: (typeof ARTISTS)[number]) {
    return { ratingKey: String(a.id), type: "artist", title: a.name, childCount: ALBUMS.filter((x) => x.artistId === a.id).length, thumb: `/library/metadata/${a.id}/thumb/1700000000` };
  }

  private pmsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname;
    const q = url.searchParams;
    if (this.redirectTo) {
      res.writeHead(302, { Location: `${this.redirectTo}${p}` });
      return void res.end();
    }
    if (p === "/identity") return this.container(res, { machineIdentifier: "abc123", version: "1.40.0.1" });
    const token = String(req.headers["x-plex-token"] ?? "");
    const account = this.tokens.get(token);
    if (!account || !this.access.has(account)) return this.json(res, 401, { errors: [{ code: 1001, message: "User could not be authenticated" }] });
    if (this.failWith !== null) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return void res.end(this.failWith);
    }
    if (p === "/") return this.container(res, { friendlyName: "Fake Plex", machineIdentifier: "abc123" });
    if (p === "/library/sections") {
      const dirs = [{ key: "1", type: "artist", title: "Music" }, { key: "2", type: "movie", title: "Movies" }, ...(this.twoLibraries ? [{ key: "3", type: "artist", title: "Podcasts and live" }] : [])];
      return this.container(res, { size: dirs.length, Directory: dirs });
    }
    const all = /^\/library\/sections\/(\d+)\/all$/.exec(p);
    if (all) return this.sectionAll(res, account, q);
    const kids = /^\/library\/metadata\/(\d+)\/(children|allLeaves)$/.exec(p);
    if (kids) {
      const id = Number(kids[1]);
      if (ALBUMS.some((a) => a.id === id)) return this.container(res, { Metadata: this.tracks.filter((t) => t.albumId === id).map((t) => this.trackJson(account, t)) });
      if (ARTISTS.some((a) => a.id === id)) {
        if (kids[2] === "children") return this.container(res, { Metadata: ALBUMS.filter((a) => a.artistId === id).map((a) => this.albumJson(a)) });
        return this.container(res, { Metadata: this.tracks.filter((t) => t.artistId === id).map((t) => this.trackJson(account, t)) });
      }
      return this.json(res, 404, {});
    }
    const meta = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (meta) {
      const t = this.tracks.find((x) => x.id === Number(meta[1]));
      if (t) return this.container(res, { Metadata: [this.trackJson(account, t, true)] });
      const a = ALBUMS.find((x) => x.id === Number(meta[1]));
      if (a) return this.container(res, { Metadata: [this.albumJson(a)] });
      return this.json(res, 404, {});
    }
    if (p === "/hubs/search") return this.hubs(res, account, q);
    if (p === "/playlists") return this.container(res, { Metadata: [{ ratingKey: "700", type: "playlist", title: "Night drive", leafCount: 2, playlistType: "audio" }] });
    if (p === "/playlists/700/items") return this.container(res, { Metadata: [this.tracks[0], this.tracks[1]].map((t) => this.trackJson(account, t)) });
    if (p === "/:/rate") {
      const key = q.get("key") ?? "";
      if (!this.tracks.some((t) => String(t.id) === key) || q.get("identifier") !== "com.plexapp.plugins.library") return this.json(res, 400, {});
      this.rated(account).set(key, Number(q.get("rating")));
      res.writeHead(200).end();
      return;
    }
    if (p === "/:/timeline") {
      this.timeline.push({ id: q.get("ratingKey") ?? "", state: q.get("state") ?? "", time: Number(q.get("time")) });
      res.writeHead(200).end();
      return;
    }
    if (p === "/:/scrobble") {
      const key = q.get("key") ?? "";
      this.plays.set(key, (this.plays.get(key) ?? 0) + 1);
      res.writeHead(200).end();
      return;
    }
    if (p === "/photo/:/transcode") {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 4 });
      return void res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    const part = /^\/library\/parts\/(\d+)\/\d+\/file\.\w+$/.exec(p);
    if (part) return this.audio(req, res, part[1], false);
    if (p === "/music/:/transcode/universal/start.mp3") {
      const id = /\/library\/metadata\/(\d+)$/.exec(q.get("path") ?? "")?.[1];
      return id ? this.audio(req, res, id, true) : this.json(res, 400, {});
    }
    this.json(res, 404, {});
  }

  private sectionAll(res: http.ServerResponse, account: string, q: URLSearchParams) {
    const type = Number(q.get("type"));
    const title = q.get("title")?.toLowerCase();
    let rows: unknown[];
    if (type === 10) {
      let list = this.tracks.filter((t) => !title || t.title.toLowerCase().includes(title));
      const minRating = q.get("userRating>>");
      if (minRating !== null) list = list.filter((t) => (this.rated(account).get(String(t.id)) ?? -1) >= Number(minRating));
      rows = list.map((t) => this.trackJson(account, t));
    } else if (type === 9) {
      const sort = q.get("sort") ?? "titleSort";
      let list = ALBUMS.filter((a) => !title || a.name.toLowerCase().includes(title));
      list = sort === "addedAt:desc" ? [...list].reverse() : [...list].sort((x, y) => x.name.localeCompare(y.name));
      rows = list.map((a) => this.albumJson(a));
    } else if (type === 8) {
      rows = ARTISTS.filter((a) => !title || a.name.toLowerCase().includes(title)).map((a) => this.artistJson(a));
    } else {
      return this.json(res, 400, {});
    }
    if (this.huge) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"MediaContainer":{"pad":"');
      for (let i = 0; i < 30; i++) res.write("x".repeat(1024 * 1024));
      return void res.end('"}}');
    }
    const start = Number(q.get("X-Plex-Container-Start") ?? 0);
    const size = Number(q.get("X-Plex-Container-Size") ?? 50);
    this.container(res, { size: Math.min(size, Math.max(0, rows.length - start)), totalSize: rows.length, offset: start, Metadata: rows.slice(start, start + size) });
  }

  private hubs(res: http.ServerResponse, account: string, q: URLSearchParams) {
    const term = (q.get("query") ?? "").toLowerCase();
    const tracks = this.tracks.filter((t) => t.title.toLowerCase().includes(term)).map((t) => this.trackJson(account, t));
    const albums = ALBUMS.filter((a) => a.name.toLowerCase().includes(term)).map((a) => this.albumJson(a));
    const artists = ARTISTS.filter((a) => a.name.toLowerCase().includes(term)).map((a) => this.artistJson(a));
    this.container(res, {
      size: 3,
      Hub: [
        { type: "artist", title: "Artists", size: artists.length, ...(artists.length ? { Metadata: artists } : {}) },
        { type: "album", title: "Albums", size: albums.length, ...(albums.length ? { Metadata: albums } : {}) },
        { type: "track", title: "Tracks", size: tracks.length, ...(tracks.length ? { Metadata: tracks } : {}) },
      ],
    });
  }

  private audio(req: http.IncomingMessage, res: http.ServerResponse, id: string, transcoded: boolean) {
    const t = this.tracks.find((x) => String(x.id) === id);
    if (!t) return this.json(res, 404, {});
    if (id === IDS.stall || id === IDS.endless) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Transfer-Encoding": "chunked", "Accept-Ranges": "none" });
      res.on("close", () => this.aborted.push(id));
      res.write(Buffer.alloc(1024, 1));
      if (id === IDS.endless) {
        const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024, 1)), 5);
        res.on("close", () => clearInterval(timer));
      }
      return;
    }
    const type = transcoded ? "audio/mpeg" : t.container === "flac" ? "audio/flac" : t.container === "mp3" ? "audio/mpeg" : t.container === "mp4" ? "audio/mp4" : "audio/ogg";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (!range) {
      res.writeHead(200, { ...headers, "Content-Length": PAYLOAD.length });
      return void res.end(PAYLOAD);
    }
    const start = range[1] === "" ? PAYLOAD.length - Number(range[2]) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? PAYLOAD.length - 1 : Math.min(Number(range[2]), PAYLOAD.length - 1);
    if (start >= PAYLOAD.length || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}` });
    res.end(PAYLOAD.subarray(start, end + 1));
  }
}