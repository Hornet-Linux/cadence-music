import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in WebDAV server for tests: Basic auth, PROPFIND (depth 0 and 1) answering with a
 * multistatus document, and GET with byte ranges. Lives next to the tests; not imported by the server.
 */
export interface FakeDavFile {
  data: Buffer;
  mtime: Date;
}

export interface FakeDavCall {
  method: string;
  path: string;
  depth?: string;
  range?: string;
  authorization?: string;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class FakeWebdav {
  /** Files by path under the base, e.g. "/Music/Artist/song.mp3". */
  files = new Map<string, FakeDavFile>();
  calls: FakeDavCall[] = [];
  /** Answer Range requests with the whole file, like a few real servers do. */
  ignoreRange = false;
  /** Make every PROPFIND fail with this status. */
  propfindStatus: number | null = null;
  /** Add odd entries to every listing (other host, outside the base, parent traversal). */
  hostile = false;
  /** Use lower-case, prefix-less XML like some servers. */
  plainXml = false;
  private server: http.Server | null = null;
  url = "";

  constructor(
    readonly base = "/dav",
    private readonly user = "alice",
    private readonly pass = "app-password",
  ) {}

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${this.base}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  add(path: string, data: Buffer, mtime = new Date("2024-05-01T10:00:00Z")): this {
    this.files.set(path, { data, mtime });
    return this;
  }

  private dirs(): Set<string> {
    const dirs = new Set<string>(["/"]);
    for (const p of this.files.keys()) {
      const parts = p.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add("/" + parts.slice(0, i).join("/"));
    }
    return dirs;
  }

  private entry(path: string, isDir: boolean, file?: FakeDavFile): string {
    const p = this.plainXml ? "" : "D:";
    const href = this.base + (path === "/" ? "/" : encodePath(path)) + (isDir && path !== "/" ? "/" : "");
    const props = isDir
      ? `<${p}resourcetype><${p}collection/></${p}resourcetype>`
      : `<${p}resourcetype/><${p}getcontentlength>${file!.data.length}</${p}getcontentlength><${p}getlastmodified>${file!.mtime.toUTCString()}</${p}getlastmodified><${p}getetag>"${file!.mtime.getTime().toString(16)}-${file!.data.length}"</${p}getetag>`;
    return `<${p}response><${p}href>${escapeXml(href)}</${p}href><${p}propstat><${p}prop>${props}</${p}prop><${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat></${p}response>`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const raw = decodeURIComponent(url.pathname);
    this.calls.push({
      method: req.method ?? "",
      path: raw,
      depth: req.headers.depth as string | undefined,
      range: req.headers.range,
      authorization: req.headers.authorization,
    });
    const expected = "Basic " + Buffer.from(`${this.user}:${this.pass}`).toString("base64");
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fake"' }).end();
      return;
    }
    if (raw !== this.base && !raw.startsWith(this.base + "/")) {
      res.writeHead(404).end();
      return;
    }
    const rel = raw.slice(this.base.length).replace(/\/+$/, "") || "/";

    if (req.method === "PROPFIND") {
      req.resume();
      if (this.propfindStatus) {
        res.writeHead(this.propfindStatus).end();
        return;
      }
      const dirs = this.dirs();
      const depth = req.headers.depth === "0" ? 0 : 1;
      const parts: string[] = [];
      if (dirs.has(rel)) {
        parts.push(this.entry(rel, true));
        if (depth === 1) {
          const prefix = rel === "/" ? "/" : rel + "/";
          for (const d of [...dirs].sort()) {
            if (d !== rel && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) parts.push(this.entry(d, true));
          }
          for (const [p, f] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
            if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) parts.push(this.entry(p, false, f));
          }
          if (this.hostile) {
            parts.push(`<D:response><D:href>http://evil.example/dav/steal.mp3</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
            parts.push(`<D:response><D:href>/elsewhere/other.mp3</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
            parts.push(`<D:response><D:href>${this.base}/../etc/passwd.mp3</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
          }
        }
      } else if (this.files.has(rel)) {
        parts.push(this.entry(rel, false, this.files.get(rel)));
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      const ns = this.plainXml ? "" : ' xmlns:D="DAV:"';
      res.end(`<?xml version="1.0" encoding="utf-8"?><${this.plainXml ? "" : "D:"}multistatus${ns}>${parts.join("")}</${this.plainXml ? "" : "D:"}multistatus>`);
      return;
    }

    if (req.method === "GET") {
      const file = this.files.get(rel);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      const size = file.data.length;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && !this.ignoreRange) {
        let start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (start >= size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
          return;
        }
        start = Math.max(0, start);
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Content-Type": "application/octet-stream" });
        res.end(file.data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "Content-Length": size, "Content-Type": "application/octet-stream" });
      res.end(file.data);
      return;
    }
    res.writeHead(405).end();
  }
}
