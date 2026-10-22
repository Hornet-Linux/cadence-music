import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in Jellyfin for tests. It follows the rules of the real Jellyfin 12:
 * calls need `Authorization: MediaBrowser ..., Token="..."` (or ApiKey=); the
 * older X-Emby-Token header and api_key parameter are refused with 401.
 * Lives next to the tests; not imported by the server.
 */

export const hex = (n: number): string => n.toString(16).padStart(32, "0");

export const IDS = {
  oneMoreTime: hex(1),
  dance: hex(2),
  getLucky: hex(3),
  instantCrush: hex(4),
  discovery: hex(100),
  cross: hex(101),
  ram: hex(102),
  playlist: hex(200),
  /** Streams one chunk and then goes quiet. */
  stall: hex(900),
  /** Streams forever, quickly. */
  endless: hex(901),
};

interface Item {
  Id: string;
  Name: string;
  Type: "Audio" | "MusicAlbum" | "Playlist" | "MusicArtist";
  Artists?: string[];
  AlbumArtist?: string;
  Album?: string;
  AlbumId?: string;
  AlbumPrimaryImageTag?: string;
  ImageTags?: { Primary?: string };
  RunTimeTicks?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ChildCount?: number;
  Genres?: string[];
}

const audio = (n: number, name: string, artist: string, album: string, albumId: string, extra: Partial<Item> = {}): Item => ({
  Id: hex(n),
  Name: name,
  Type: "Audio",
  Artists: [artist],
  AlbumArtist: artist,
  Album: album,
  AlbumId: albumId,
  AlbumPrimaryImageTag: "tag",
  RunTimeTicks: 80_000_000,
  IndexNumber: n,
  ProductionYear: 2001,
  ...extra,
});

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

export const PAYLOAD = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));

export class FakeJellyfin {
  readonly server: http.Server;
  url = "";
  readonly calls: FakeCall[] = [];
  /** Tokens it accepts. */
  readonly tokens = new Set<string>();
  readonly users: Record<string, string> = { tester: "jellyfin-test-pass", other: "other-pass" };
  readonly favourites = new Set<string>();
  readonly plays = new Map<string, number>();
  readonly items: Item[];
  /** Answer 500 with this body to everything that needs a token. */
  failWith: string | null = null;
  /** Redirect token-bearing calls here. */
  redirectTo: string | null = null;
  /** Only serve the older per-user favourites route (like Jellyfin before 10.9). */
  legacyFavouritesOnly = false;
  /** Set when a streaming response ended early because the client went away. */
  readonly aborted: string[] = [];
  private nextToken = 1;

  constructor() {
    this.items = [
      audio(1, "One More Time", "Daft Punk", "Discovery", IDS.discovery),
      audio(2, "D.A.N.C.E.", "Justice", "Cross", IDS.cross, { ImageTags: { Primary: "own" } }),
      audio(3, "Get Lucky", "Daft Punk", "Random Access Memories", IDS.ram),
      audio(4, "Instant Crush (feat. Julian Casablancas)", "Daft Punk", "Random Access Memories", IDS.ram),
      { Id: IDS.discovery, Name: "Discovery", Type: "MusicAlbum", AlbumArtist: "Daft Punk", Artists: ["Daft Punk"], ProductionYear: 2001, ChildCount: 1, ImageTags: { Primary: "a" } },
      { Id: IDS.cross, Name: "Cross", Type: "MusicAlbum", AlbumArtist: "Justice", Artists: ["Justice"], ProductionYear: 2007, ChildCount: 1 },
      { Id: IDS.ram, Name: "Random Access Memories", Type: "MusicAlbum", AlbumArtist: "Daft Punk", Artists: ["Daft Punk"], ProductionYear: 2013, ChildCount: 2 },
      { Id: IDS.playlist, Name: "Night drive", Type: "Playlist", ChildCount: 2 },
      { Id: hex(300), Name: "Daft Punk", Type: "MusicArtist", Genres: ["electronic", "house"] },
      { Id: hex(301), Name: "Justice", Type: "MusicArtist", Genres: ["electronic", "electro"] },
      { Id: IDS.stall, Name: "Stall", Type: "Audio", Artists: ["Nobody"], Album: "Nothing", AlbumId: IDS.discovery },
      { Id: IDS.endless, Name: "Endless", Type: "Audio", Artists: ["Nobody"], Album: "Nothing", AlbumId: IDS.discovery },
    ];
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  /** Calls other than the unauthenticated ones, newest last. */
  callsTo(path: RegExp | string): FakeCall[] {
    return this.calls.filter((c) => (typeof path === "string" ? c.path === path : path.test(c.path)));
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private token(req: http.IncomingMessage, query: URLSearchParams): string | null {
    // Only the MediaBrowser header (or ApiKey) counts. X-Emby-Token and api_key are not accepted.
    const m = /Token="([^"]+)"/.exec(String(req.headers.authorization ?? ""));
    const t = m?.[1] ?? query.get("ApiKey");
    return t && this.tokens.has(t) ? t : null;
  }

  private userData(id: string) {
    return { IsFavorite: this.favourites.has(id), PlayCount: this.plays.get(id) ?? 0 };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      this.calls.push({
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      this.route(req, res, url, body);
    });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: unknown) {
    const p = url.pathname;
    const q = url.searchParams;
    const method = req.method ?? "GET";

    if (p === "/System/Info/Public") {
      return this.json(res, 200, { ServerName: "Fake Jelly", Version: "12.2.0", ProductName: "Jellyfin Server", Id: "abc123" });
    }
    if (p === "/Users/AuthenticateByName" && method === "POST") {
      const b = body as { Username?: string; Pw?: string } | undefined;
      const header = String(req.headers.authorization ?? "");
      if (!header.startsWith("MediaBrowser ") || header.includes("Token=") || !/DeviceId="[^"]+"/.test(header)) {
        return this.json(res, 400, { error: "bad header" });
      }
      if (!b?.Username || this.users[b.Username] === undefined || this.users[b.Username] !== b.Pw) {
        return this.json(res, 401, { error: "no" });
      }
      const token = `token-${b.Username}-${this.nextToken++}`;
      this.tokens.add(token);
      return this.json(res, 200, { AccessToken: token, User: { Id: b.Username === "tester" ? hex(7000) : hex(7001), Name: b.Username } });
    }

    const token = this.token(req, q);
    if (!token) return this.json(res, 401, { error: "unauthorized" });
    if (this.failWith !== null) return this.json(res, 500, { Message: this.failWith });
    if (this.redirectTo) {
      res.writeHead(302, { Location: `${this.redirectTo}${p}` });
      return res.end();
    }

    if (p === "/Sessions/Logout" && method === "POST") {
      this.tokens.delete(token);
      res.writeHead(204).end();
      return;
    }
    if (p.startsWith("/Sessions/Playing") && method === "POST") {
      const b = body as { ItemId?: string; PositionTicks?: number } | undefined;
      if (p.endsWith("/Stopped") && b?.ItemId) this.plays.set(b.ItemId, (this.plays.get(b.ItemId) ?? 0) + 1);
      res.writeHead(204).end();
      return;
    }

    const fav = /^\/UserFavoriteItems\/([0-9a-f]{32})$/.exec(p) ?? /^\/Users\/[0-9a-f]{32}\/FavoriteItems\/([0-9a-f]{32})$/.exec(p);
    if (fav && (method === "POST" || method === "DELETE")) {
      if (this.legacyFavouritesOnly && p.startsWith("/UserFavoriteItems")) return this.json(res, 404, {});
      if (method === "POST") this.favourites.add(fav[1]);
      else this.favourites.delete(fav[1]);
      return this.json(res, 200, this.userData(fav[1]));
    }

    if (p === "/Items" || p === "/Artists") return this.items_(res, p, q);

    const playlist = /^\/Playlists\/([0-9a-f]{32})\/Items$/.exec(p);
    if (playlist) {
      const list = [this.items[0], this.items[1]].map((i) => ({ ...i, UserData: this.userData(i.Id) }));
      return this.json(res, 200, { Items: list, TotalRecordCount: list.length });
    }

    const image = /^\/Items\/([0-9a-f]{32})\/Images\/Primary$/.exec(p);
    if (image) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 4 });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }

    const universal = /^\/Audio\/([0-9a-f]{32})\/universal$/.exec(p);
    if (universal) return this.audio(req, res, universal[1]);

    this.json(res, 404, {});
  }

  private items_(res: http.ServerResponse, path: string, q: URLSearchParams) {
    const types = (q.get("IncludeItemTypes") ?? (path === "/Artists" ? "MusicArtist" : "")).split(",").filter(Boolean);
    let list = this.items.filter((i) => types.length === 0 || types.includes(i.Type));
    const term = q.get("SearchTerm");
    if (term) list = list.filter((i) => i.Name.toLowerCase().includes(term.toLowerCase()));
    const artists = q.get("Artists");
    if (artists) list = list.filter((i) => i.Artists?.includes(artists));
    const albums = q.get("Albums");
    if (albums) list = list.filter((i) => i.Album === albums);
    const parent = q.get("ParentId");
    if (parent) list = list.filter((i) => i.AlbumId === parent);
    const artistIds = q.get("ArtistIds");
    if (artistIds) {
      const names = this.items.filter((i) => artistIds.split(",").includes(i.Id)).map((i) => i.Name);
      list = list.filter((i) => i.Artists?.some((n) => names.includes(n)));
    }
    const albumIds = q.get("AlbumIds");
    if (albumIds) list = list.filter((i) => albumIds.split(",").includes(i.AlbumId ?? ""));
    const ids = q.get("Ids");
    if (ids) list = list.filter((i) => ids.split(",").includes(i.Id));
    const filters = (q.get("Filters") ?? "").split(",");
    if (filters.includes("IsFavorite")) list = list.filter((i) => this.favourites.has(i.Id));
    if (filters.includes("IsPlayed")) list = list.filter((i) => (this.plays.get(i.Id) ?? 0) > 0);
    const weight = (i: Item) => (path === "/Artists" ? this.artistPlays(i.Name) : (this.plays.get(i.Id) ?? 0));
    if (q.get("SortBy") === "PlayCount") list = [...list].sort((a, b) => weight(b) - weight(a));
    const total = list.length;
    const start = Number(q.get("StartIndex") ?? 0);
    const limit = Number(q.get("Limit") ?? 1000);
    const page = list.slice(start, start + limit).map((i) => ({
      ...i,
      UserData: path === "/Artists" ? { IsFavorite: this.favourites.has(i.Id), PlayCount: this.artistPlays(i.Name) } : this.userData(i.Id),
    }));
    this.json(res, 200, { Items: page, TotalRecordCount: total, StartIndex: start });
  }

  private artistPlays(name: string): number {
    return this.items.filter((t) => t.Type === "Audio" && t.Artists?.includes(name)).reduce((n, t) => n + (this.plays.get(t.Id) ?? 0), 0);
  }

  private audio(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    const track = this.items.find((i) => i.Id === id);
    if (!track) return this.json(res, 404, {});
    if (id === IDS.stall || id === IDS.endless) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Transfer-Encoding": "chunked", "Accept-Ranges": "none" });
      res.on("close", () => this.aborted.push(id));
      res.write(Buffer.alloc(1024, 1));
      if (id === IDS.endless) {
        const t = setInterval(() => res.write(Buffer.alloc(16 * 1024, 1)), 5);
        res.on("close", () => clearInterval(t));
      }
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    const headers = { "Content-Type": "audio/flac", "Accept-Ranges": "bytes" };
    if (!range) {
      res.writeHead(200, { ...headers, "Content-Length": PAYLOAD.length });
      return res.end(PAYLOAD);
    }
    const start = range[1] === "" ? PAYLOAD.length - Number(range[2]) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? PAYLOAD.length - 1 : Math.min(Number(range[2]), PAYLOAD.length - 1);
    if (start >= PAYLOAD.length || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}` });
    res.end(PAYLOAD.subarray(start, end + 1));
  }
}
