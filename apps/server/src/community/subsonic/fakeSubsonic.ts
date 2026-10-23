import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in Subsonic server for tests, following the Subsonic 1.16 / OpenSubsonic rules:
 * every call carries `u` plus either token auth (`t` = md5(password + `s`)) or the
 * old `p=enc:<hex>` password; answers are `{"subsonic-response": {...}}` with status
 * "ok" or "failed" and an error code (40 wrong login, 41 token auth unsupported,
 * 70 not found). Lives next to the tests; not imported by the server.
 */

export const PAYLOAD = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));

interface Song {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  albumId: string;
  track: number;
  year: number;
  duration: number;
  suffix: string;
  contentType: string;
  coverArt?: string;
  genre?: string;
}

const song = (n: number, title: string, artist: string, artistId: string, album: string, albumId: string, extra: Partial<Song> = {}): Song => ({
  id: `s${n}`,
  title,
  artist,
  artistId,
  album,
  albumId,
  track: n,
  year: 2001,
  duration: 200,
  suffix: "flac",
  contentType: "audio/flac",
  coverArt: albumId,
  genre: "Electronic",
  ...extra,
});

export const IDS = { oneMoreTime: "s1", dance: "s2", getLucky: "s3", oggSong: "s4", stall: "s900", endless: "s901", gone: "s999" };

export interface FakeCall {
  endpoint: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}

export class FakeSubsonic {
  readonly server: http.Server;
  url = "";
  readonly calls: FakeCall[] = [];
  readonly users: Record<string, string> = { tester: "subsonic-test-pass", other: "other-pass" };
  /** Starred song ids per user. */
  readonly stars = new Map<string, Set<string>>();
  readonly plays = new Map<string, number>();
  readonly nowPlaying: string[] = [];
  readonly songs: Song[];
  /** Answer 500 to everything. */
  failWith: string | null = null;
  /** Redirect every call here. */
  redirectTo: string | null = null;
  /** Refuse token auth with error 41, like an LDAP-backed server. */
  ldap = false;
  /** Return nothing for an empty search (a server that does not list everything that way). */
  emptyQueryEmpty = false;
  /** Answer search3 with a huge body. */
  huge = false;
  /** Answer stream/getCoverArt with a Subsonic error body (status 200). */
  errorBodyFor: "wrong-login" | "not-found" | null = null;
  /** Set when a streaming response ended early because the client went away. */
  readonly aborted: string[] = [];

  constructor() {
    this.songs = [
      song(1, "One More Time", "Daft Punk", "ar1", "Discovery", "al1"),
      song(2, "D.A.N.C.E.", "Justice", "ar2", "Cross", "al2", { suffix: "mp3", contentType: "audio/mpeg" }),
      song(3, "Get Lucky", "Daft Punk", "ar1", "Random Access Memories", "al3", { suffix: "m4a", contentType: "audio/mp4" }),
      song(4, "Ogg Song", "Daft Punk", "ar1", "Random Access Memories", "al3", { suffix: "ogg", contentType: "audio/ogg" }),
      song(900, "Stall", "Nobody", "ar3", "Nothing", "al4"),
      song(901, "Endless", "Nobody", "ar3", "Nothing", "al4"),
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

  callsTo(endpoint: string): FakeCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  private reply(res: http.ServerResponse, payload: Record<string, unknown>) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", type: "fakesonic", serverVersion: "0.1.0", openSubsonic: true, ...payload } }));
  }

  private fail(res: http.ServerResponse, code: number, message: string) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code, message } } }));
  }

  private starsOf(user: string): Set<string> {
    let s = this.stars.get(user);
    if (!s) this.stars.set(user, (s = new Set()));
    return s;
  }

  /** The signed-in user, or null (after answering with an error). */
  private login(res: http.ServerResponse, q: Record<string, string>): string | null {
    const user = q.u;
    if (!user) {
      this.fail(res, 10, "Required parameter is missing: u");
      return null;
    }
    const password = this.users[user];
    if (q.t !== undefined) {
      if (this.ldap) {
        this.fail(res, 41, "Token authentication not supported");
        return null;
      }
      const ok = password !== undefined && q.s && createHash("md5").update(password + q.s).digest("hex") === q.t;
      if (!ok) {
        this.fail(res, 40, "Wrong username or password");
        return null;
      }
      return user;
    }
    if (q.p !== undefined) {
      const hex = q.p.startsWith("enc:") ? Buffer.from(q.p.slice(4), "hex").toString("utf8") : q.p;
      if (password === undefined || hex !== password) {
        this.fail(res, 40, "Wrong username or password");
        return null;
      }
      return user;
    }
    this.fail(res, 10, "Required parameter is missing: t");
    return null;
  }

  private child(user: string, s: Song) {
    const starred = this.starsOf(user).has(s.id);
    return {
      id: s.id,
      isDir: false,
      title: s.title,
      artist: s.artist,
      artistId: s.artistId,
      album: s.album,
      albumId: s.albumId,
      track: s.track,
      year: s.year,
      duration: s.duration,
      suffix: s.suffix,
      contentType: s.contentType,
      coverArt: s.coverArt,
      genre: s.genre,
      playCount: this.plays.get(s.id) ?? 0,
      ...(starred ? { starred: "2024-01-01T00:00:00Z" } : {}),
    };
  }

  private albums() {
    const names = new Map<string, { id: string; name: string; artist: string; artistId: string; year: number; songs: Song[] }>();
    for (const s of this.songs) {
      const a = names.get(s.albumId) ?? { id: s.albumId, name: s.album, artist: s.artist, artistId: s.artistId, year: s.year, songs: [] };
      a.songs.push(s);
      names.set(s.albumId, a);
    }
    return [...names.values()].sort((x, y) => x.name.localeCompare(y.name));
  }

  private album(a: { id: string; name: string; artist: string; artistId: string; year: number; songs: Song[] }) {
    return { id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, year: a.year, songCount: a.songs.length, coverArt: a.id };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const q = Object.fromEntries(url.searchParams);
    const m = /^\/rest\/(\w+)\.view$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const endpoint = m[1];
    this.calls.push({ endpoint, query: q, headers: req.headers });
    if (this.redirectTo) {
      res.writeHead(302, { Location: `${this.redirectTo}${url.pathname}${url.search}` });
      return void res.end();
    }
    if (this.failWith !== null) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return void res.end(this.failWith);
    }
    // Like a real server, an unauthenticated ping still answers in Subsonic's format.
    const user = this.login(res, q);
    if (user === null) return;

    switch (endpoint) {
      case "ping":
        return this.reply(res, {});
      case "getArtists": {
        const artists = [...new Map(this.songs.map((s) => [s.artistId, s.artist])).entries()].map(([id, name]) => ({
          id,
          name,
          albumCount: this.albums().filter((a) => a.artistId === id).length,
        }));
        return this.reply(res, { artists: { index: [{ name: "A", artist: artists }] } });
      }
      case "getArtist": {
        const albums = this.albums().filter((a) => a.artistId === q.id);
        if (albums.length === 0) return this.fail(res, 70, "Artist not found");
        return this.reply(res, { artist: { id: q.id, name: albums[0].artist, album: albums.map((a) => this.album(a)) } });
      }
      case "getAlbumList2": {
        const all = this.albums();
        const start = Number(q.offset ?? 0);
        const size = Number(q.size ?? 10);
        return this.reply(res, { albumList2: { album: all.slice(start, start + size).map((a) => this.album(a)) } });
      }
      case "getAlbum": {
        const a = this.albums().find((x) => x.id === q.id);
        if (!a) return this.fail(res, 70, "Album not found");
        return this.reply(res, { album: { ...this.album(a), song: a.songs.map((s) => this.child(user, s)) } });
      }
      case "getSong": {
        const s = this.songs.find((x) => x.id === q.id);
        if (!s) return this.fail(res, 70, "Song not found");
        return this.reply(res, { song: this.child(user, s) });
      }
      case "getPlaylists":
        return this.reply(res, { playlists: { playlist: [{ id: "p1", name: "Night drive", songCount: 2, coverArt: "al1" }] } });
      case "getPlaylist":
        if (q.id !== "p1") return this.fail(res, 70, "Playlist not found");
        return this.reply(res, { playlist: { id: "p1", name: "Night drive", songCount: 2, entry: [this.songs[0], this.songs[1]].map((s) => this.child(user, s)) } });
      case "getStarred2": {
        const stars = this.starsOf(user);
        return this.reply(res, { starred2: { song: this.songs.filter((s) => stars.has(s.id)).map((s) => this.child(user, s)) } });
      }
      case "search3":
        return this.search(res, user, q);
      case "star":
      case "unstar": {
        if (!this.songs.some((s) => s.id === q.id)) return this.fail(res, 70, "Not found");
        if (endpoint === "star") this.starsOf(user).add(q.id);
        else this.starsOf(user).delete(q.id);
        return this.reply(res, {});
      }
      case "scrobble": {
        if (q.submission === "false") this.nowPlaying.push(q.id);
        else this.plays.set(q.id, (this.plays.get(q.id) ?? 0) + 1);
        return this.reply(res, {});
      }
      case "getCoverArt": {
        if (this.errorBodyFor) return this.errorBody(res);
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 4 });
        return void res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      case "stream":
        return this.stream(req, res, q);
      default:
        return this.fail(res, 0, "Generic error");
    }
  }

  private errorBody(res: http.ServerResponse) {
    if (this.errorBodyFor === "wrong-login") return this.fail(res, 40, "Wrong username or password");
    return this.fail(res, 70, "Data not found");
  }

  private search(res: http.ServerResponse, user: string, q: Record<string, string>) {
    if (this.huge) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = "x".repeat(1024 * 1024);
      res.write('{"subsonic-response":{"status":"ok","version":"1.16.1","searchResult3":{"pad":"');
      for (let i = 0; i < 30; i++) res.write(chunk);
      return void res.end('"}}}');
    }
    const term = (q.query ?? "").toLowerCase();
    if (term === "" && this.emptyQueryEmpty) return this.reply(res, { searchResult3: {} });
    const match = (s: string) => s.toLowerCase().includes(term);
    const songs = this.songs.filter((s) => match(s.title));
    const albums = this.albums().filter((a) => term !== "" && match(a.name));
    const artists = [...new Map(this.songs.filter((s) => term !== "" && match(s.artist)).map((s) => [s.artistId, s.artist])).entries()].map(([id, name]) => ({ id, name }));
    const sOff = Number(q.songOffset ?? 0);
    const aOff = Number(q.albumOffset ?? 0);
    const result: Record<string, unknown> = {};
    const songCount = Number(q.songCount ?? 20);
    const albumCount = Number(q.albumCount ?? 20);
    const artistCount = Number(q.artistCount ?? 20);
    if (songCount > 0) result.song = songs.slice(sOff, sOff + songCount).map((s) => this.child(user, s));
    if (albumCount > 0) result.album = albums.slice(aOff, aOff + albumCount).map((a) => this.album(a));
    if (artistCount > 0) result.artist = artists.slice(0, artistCount);
    this.reply(res, { searchResult3: result });
  }

  private stream(req: http.IncomingMessage, res: http.ServerResponse, q: Record<string, string>) {
    if (this.errorBodyFor) return this.errorBody(res);
    const s = this.songs.find((x) => x.id === q.id);
    if (!s) return this.fail(res, 70, "Song not found");
    if (s.id === IDS.stall || s.id === IDS.endless) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Transfer-Encoding": "chunked", "Accept-Ranges": "none" });
      res.on("close", () => this.aborted.push(s.id));
      res.write(Buffer.alloc(1024, 1));
      if (s.id === IDS.endless) {
        const t = setInterval(() => res.write(Buffer.alloc(16 * 1024, 1)), 5);
        res.on("close", () => clearInterval(t));
      }
      return;
    }
    const transcoded = q.format === "mp3";
    const headers = { "Content-Type": transcoded ? "audio/mpeg" : s.contentType, "Accept-Ranges": "bytes" };
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