import type http from "node:http";
import type { Fake, Harness } from "../_sourcekit/testkit.js";
import { fake } from "../_sourcekit/testkit.js";

export const AUDIO = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz");
export const COVER = Buffer.from("ffd8ffe000104a464946", "hex");

interface Progress {
  libraryItemId: string;
  currentTime: number;
  duration: number;
  progress: number;
  isFinished: boolean;
  lastUpdate: number;
}

export interface FakeAbsOptions {
  /** Logins return an access token that expires after this many authorised calls, plus a refresh token. */
  shortLivedTokens?: number;
}

/** A small stand-in for an Audiobookshelf server, with two accounts that keep separate progress and bookmarks. */
export class FakeAbs {
  fake!: Fake;
  accounts: Record<string, { password: string; id: string }> = { ann: { password: "ann-pass", id: "usr_ann" }, ben: { password: "ben-pass", id: "usr_ben" } };
  tokens = new Map<string, { user: string; uses: number }>();
  refreshTokens = new Map<string, string>();
  progress = new Map<string, Map<string, Progress>>();
  bookmarks = new Map<string, { libraryItemId: string; time: number; title: string; createdAt: number }[]>();
  sessions = new Map<string, { user: string; itemId: string; syncs: { currentTime: number; timeListened: number }[]; closed: boolean }>();
  /** Requests as seen: method, path, authorization header. */
  log: { method: string; url: string; auth?: string; range?: string; body: string }[] = [];
  dropSessions = false;
  private n = 0;

  constructor(private readonly options: FakeAbsOptions = {}) {}

  get url(): string {
    return this.fake.url;
  }

  async start(h: Harness): Promise<this> {
    this.fake = await fake(h, (req, res, body) => this.handle(req, res, body));
    return this;
  }

  stop(): Promise<void> {
    return this.fake.close();
  }

  private book(id: string, title: string, author: string) {
    return {
      id,
      libraryId: "lib_books",
      media: {
        metadata: { title, subtitle: "Sub", authorName: author, narratorName: "Nora Narrator", seriesName: "Saga #1", authors: [{ name: author }], description: "<p>A <b>long</b> story.</p>", publishedYear: "2001" },
        duration: 3600,
        chapters: [
          { id: 0, start: 0, end: 1200, title: "One" },
          { id: 1, start: 1200, end: 3600, title: "Two" },
        ],
      },
    };
  }

  private send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, body === undefined ? headers : { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const auth = req.headers.authorization;
    this.log.push({ method: req.method ?? "", url: req.url ?? "", auth, range: req.headers.range, body });
    const json = (): Record<string, unknown> => {
      try {
        return JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    if (path === "/ping") return this.send(res, 200, { success: true });
    if (path === "/login" && req.method === "POST") {
      const b = json();
      const acct = this.accounts[String(b.username)];
      if (!acct || acct.password !== b.password) return void res.writeHead(401, { "Content-Type": "text/plain" }).end("Invalid username or password");
      const token = `tok-${++this.n}-${String(b.username)}`;
      this.tokens.set(token, { user: String(b.username), uses: 0 });
      const user: Record<string, unknown> = { id: acct.id, username: b.username, token };
      if (this.options.shortLivedTokens !== undefined && req.headers["x-return-tokens"] === "true") {
        user.accessToken = token;
        const refresh = `refresh-${this.n}-${String(b.username)}`;
        this.refreshTokens.set(refresh, String(b.username));
        user.refreshToken = refresh;
      }
      return this.send(res, 200, { user, userDefaultLibraryId: "lib_books" });
    }
    if (path === "/auth/refresh" && req.method === "POST") {
      const user = this.refreshTokens.get(String(req.headers["x-refresh-token"]));
      if (!user) return this.send(res, 401, { error: "bad refresh" });
      const token = `tok-${++this.n}-${user}`;
      this.tokens.set(token, { user, uses: 0 });
      return this.send(res, 200, { user: { id: this.accounts[user].id, username: user, accessToken: token } });
    }
    const t = auth?.startsWith("Bearer ") ? this.tokens.get(auth.slice(7)) : undefined;
    if (!t) return this.send(res, 401, { error: "unauthorized" });
    if (this.options.shortLivedTokens !== undefined && ++t.uses > this.options.shortLivedTokens) {
      this.tokens.delete(auth!.slice(7));
      return this.send(res, 401, { error: "expired" });
    }
    const user = t.user;
    const prog = this.progress.get(user) ?? new Map<string, Progress>();
    this.progress.set(user, prog);
    const books: Record<string, ReturnType<FakeAbs["book"]>> = { li_one: this.book("li_one", "The First Book", "Ann Author"), li_two: this.book("li_two", "Second Book", "Bo Writer") };

    if (path === "/api/libraries") return this.send(res, 200, { libraries: [{ id: "lib_books", name: "Books", mediaType: "book" }, { id: "lib_pods", name: "Pods", mediaType: "podcast" }] });
    let m = /^\/api\/libraries\/([\w-]+)\/items$/.exec(path);
    if (m) {
      const limit = Number(url.searchParams.get("limit"));
      const page = Number(url.searchParams.get("page"));
      const all = Object.values(books);
      return this.send(res, 200, { results: all.slice(page * limit, page * limit + limit), total: all.length, limit, page });
    }
    m = /^\/api\/libraries\/([\w-]+)\/search$/.exec(path);
    if (m) {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return this.send(res, 200, { book: Object.values(books).filter((b) => b.media.metadata.title.toLowerCase().includes(q)).map((b) => ({ libraryItem: b })), podcast: [] });
    }
    if (path === "/api/me/items-in-progress") {
      return this.send(res, 200, { libraryItems: [...prog.values()].filter((p) => !p.isFinished).map((p) => books[p.libraryItemId]).filter(Boolean) });
    }
    if (path === "/api/me") return this.send(res, 200, { id: this.accounts[user].id, username: user, mediaProgress: [...prog.values()], bookmarks: this.bookmarks.get(user) ?? [] });
    m = /^\/api\/items\/([\w-]+)$/.exec(path);
    if (m) {
      const b = books[m[1]];
      if (!b) return this.send(res, 404, undefined);
      return this.send(res, 200, { ...b, userMediaProgress: prog.get(m[1]) });
    }
    m = /^\/api\/items\/([\w-]+)\/cover$/.exec(path);
    if (m) return void res.writeHead(200, { "Content-Type": "image/jpeg" }).end(COVER);
    m = /^\/api\/items\/([\w-]+)\/play$/.exec(path);
    if (m && req.method === "POST") {
      const b = books[m[1]];
      if (!b) return this.send(res, 404, undefined);
      const sid = `play-${++this.n}`;
      this.sessions.set(sid, { user, itemId: m[1], syncs: [], closed: false });
      const start = prog.get(m[1])?.currentTime ?? 0;
      return this.send(res, 200, {
        id: sid,
        duration: 3600,
        startTime: start,
        currentTime: start,
        chapters: b.media.chapters,
        audioTracks: [
          { index: 1, startOffset: 0, duration: 1800, title: "a.mp3", contentUrl: `/public/session/${sid}/track/1`, mimeType: "audio/mpeg" },
          { index: 2, startOffset: 1800, duration: 1800, title: "b.mp3", contentUrl: `/public/session/${sid}/track/2`, mimeType: "audio/mpeg" },
        ],
      });
    }
    m = /^\/public\/session\/([\w-]+)\/track\/(\d+)$/.exec(path);
    if (m) {
      if (this.dropSessions) return this.send(res, 404, undefined);
      const range = req.headers.range;
      if (range) {
        const r = /bytes=(\d*)-(\d*)/.exec(range)!;
        const start = Number(r[1] || 0);
        const end = Math.min(Number(r[2] || AUDIO.length - 1), AUDIO.length - 1);
        return void res.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${start}-${end}/${AUDIO.length}`, "Content-Length": String(end - start + 1) }).end(AUDIO.subarray(start, end + 1));
      }
      return void res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO.length), "Accept-Ranges": "bytes" }).end(AUDIO);
    }
    m = /^\/api\/session\/([\w-]+)\/(sync|close)$/.exec(path);
    if (m && req.method === "POST") {
      const s = this.sessions.get(m[1]);
      if (!s || this.dropSessions || s.user !== user) return this.send(res, 404, undefined);
      const b = json();
      s.syncs.push({ currentTime: Number(b.currentTime), timeListened: Number(b.timeListened) });
      if (m[2] === "close") s.closed = true;
      prog.set(s.itemId, { libraryItemId: s.itemId, currentTime: Number(b.currentTime), duration: 3600, progress: Number(b.currentTime) / 3600, isFinished: false, lastUpdate: Date.now() });
      return this.send(res, 200, undefined);
    }
    m = /^\/api\/me\/progress\/([\w-]+)$/.exec(path);
    if (m && req.method === "PATCH") {
      const b = json();
      const old = prog.get(m[1]);
      prog.set(m[1], { libraryItemId: m[1], currentTime: Number(b.currentTime ?? old?.currentTime ?? 0), duration: Number(b.duration ?? 3600), progress: Number(b.progress ?? 0), isFinished: b.isFinished === true, lastUpdate: Date.now() });
      return this.send(res, 200, undefined);
    }
    m = /^\/api\/me\/item\/([\w-]+)\/bookmark(?:\/(\d+))?$/.exec(path);
    if (m) {
      const list = this.bookmarks.get(user) ?? [];
      this.bookmarks.set(user, list);
      if (req.method === "POST") {
        const b = json();
        list.push({ libraryItemId: m[1], time: Number(b.time), title: String(b.title), createdAt: Date.now() });
        return this.send(res, 200, list.at(-1));
      }
      if (req.method === "DELETE") {
        const i = list.findIndex((x) => x.libraryItemId === m![1] && x.time === Number(m![2]));
        if (i < 0) return this.send(res, 404, undefined);
        list.splice(i, 1);
        return this.send(res, 200, undefined);
      }
    }
    return this.send(res, 404, undefined);
  }
}