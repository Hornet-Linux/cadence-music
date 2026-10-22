import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Google (OAuth 2.0 + Drive v3) and Microsoft (identity platform + Graph OneDrive), built from their
 * public documentation. It checks what a well-behaved client must do (PKCE verifier, client secret, bearer tokens,
 * no token on the download redirect) but it is NOT the real service: nothing here has been run against Google or
 * Microsoft. Lives next to the tests; not imported by the server.
 */
type P = "google" | "microsoft";

interface Node {
  id: string;
  name: string;
  parent: string;
  folder: boolean;
  data?: Buffer;
  mtime: Date;
}

export interface FakeCloudCall {
  provider: P;
  kind: "token" | "api" | "download";
  method: string;
  path: string;
  authorization?: string;
  range?: string;
  host?: string;
}

export class FakeCloud {
  readonly clientId = "client-id-123456";
  readonly clientSecret = "client-secret-abc";
  nodes = new Map<P, Map<string, Node>>([
    ["google", new Map()],
    ["microsoft", new Map()],
  ]);
  calls: FakeCloudCall[] = [];
  /** Page size for listings, to exercise paging. */
  pageSize = 1000;
  /** What the Graph "next page" link points at, to test that the client does not follow other hosts. */
  evilNextLink: string | null = null;
  private codes = new Map<string, { provider: P; challenge: string; redirectUri: string }>();
  private refreshTokens = new Map<P, Set<string>>([
    ["google", new Set()],
    ["microsoft", new Set()],
  ]);
  private accessTokens = new Map<string, P>();
  private server: http.Server | null = null;
  url = "";
  /** Same machine, different host name: counts as another origin for redirect tests. */
  altUrl = "";
  tokenLifetimeSec = 3600;
  accounts: Record<P, string> = { google: "me@gmail.example", microsoft: "me@outlook.example" };

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}`;
    this.altUrl = `http://localhost:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  endpoints(p: P) {
    const base = p === "google" ? "/google" : "/ms";
    return { authorize: `${this.url}${base}/authorize`, token: `${this.url}${base}/token`, api: `${this.url}${base}/api` };
  }

  folder(p: P, name: string, parent = "root", id = `fld${randomBytes(5).toString("hex")}`): string {
    this.nodes.get(p)!.set(id, { id, name, parent, folder: true, mtime: new Date("2024-01-01") });
    return id;
  }

  file(p: P, name: string, parent: string, data: Buffer, id = `fil${randomBytes(5).toString("hex")}`): string {
    this.nodes.get(p)!.set(id, { id, name, parent, folder: false, data, mtime: new Date("2024-03-01T12:00:00Z") });
    return id;
  }

  /** What the browser step does: the person agrees, and the provider sends them back with a code. */
  consent(p: P, authorizeUrl: string): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const q = u.searchParams;
    if (q.get("client_id") !== this.clientId) throw new Error("unknown client");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) throw new Error("PKCE required");
    if (q.get("response_type") !== "code") throw new Error("response_type");
    const code = randomBytes(8).toString("hex");
    this.codes.set(code, { provider: p, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")! });
    return { code, state: q.get("state")! };
  }

  /** The person removed the app in their account, or the refresh token expired. */
  revokeRefreshTokens(p: P): void {
    this.refreshTokens.get(p)!.clear();
  }

  /** Access tokens stop working (the clock ran past their lifetime). */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  private issue(p: P): { access_token: string; refresh_token: string; expires_in: number } {
    const access = randomBytes(12).toString("hex");
    this.accessTokens.set(access, p);
    const refresh = randomBytes(12).toString("hex");
    this.refreshTokens.get(p)!.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: this.tokenLifetimeSec };
  }

  private async token(p: P, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const f = await this.readForm(req);
    if (f.get("client_id") !== this.clientId || f.get("client_secret") !== this.clientSecret) return this.json(res, 401, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      const grant = this.codes.get(f.get("code") ?? "");
      this.codes.delete(f.get("code") ?? "");
      const verifier = f.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!grant || grant.provider !== p || grant.challenge !== challenge || grant.redirectUri !== f.get("redirect_uri")) return this.json(res, 400, { error: "invalid_grant" });
      const t = this.issue(p);
      // Google only returns a refresh token on the first consent unless asked again; the client asks.
      return this.json(res, 200, t);
    }
    if (f.get("grant_type") === "refresh_token") {
      const rt = f.get("refresh_token") ?? "";
      if (!this.refreshTokens.get(p)!.has(rt)) return this.json(res, 400, { error: "invalid_grant" });
      if (p === "microsoft") {
        // Microsoft rotates refresh tokens: the old one is spent.
        this.refreshTokens.get(p)!.delete(rt);
        return this.json(res, 200, this.issue(p));
      }
      const access = randomBytes(12).toString("hex");
      this.accessTokens.set(access, p);
      return this.json(res, 200, { access_token: access, expires_in: this.tokenLifetimeSec }); // Google keeps the same refresh token
    }
    this.json(res, 400, { error: "unsupported_grant_type" });
  }

  private authed(p: P, req: http.IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return !!m && this.accessTokens.get(m[1]!) === p;
  }

  private children(p: P, parent: string): Node[] {
    return [...this.nodes.get(p)!.values()].filter((n) => n.parent === parent).sort((a, b) => a.name.localeCompare(b.name));
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse, n: Node): void {
    const data = n.data ?? Buffer.alloc(0);
    const size = data.length;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Content-Type": "application/octet-stream" });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Length": size, "Content-Type": "application/octet-stream" });
    res.end(data);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const p: P = path.startsWith("/google") ? "google" : "microsoft";
    const record = (kind: FakeCloudCall["kind"]) =>
      this.calls.push({ provider: p, kind, method: req.method ?? "", path: path + url.search, authorization: req.headers.authorization, range: req.headers.range, host: req.headers.host });

    if (path.endsWith("/token") && req.method === "POST") {
      record("token");
      return this.token(p, req, res);
    }

    // The Microsoft download address (another host name, pre-authorised by its own token in the query).
    const dl = /^\/ms\/download\/([^/]+)$/.exec(path);
    if (dl) {
      record("download");
      const n = this.nodes.get("microsoft")!.get(dl[1]!);
      if (url.searchParams.get("tempauth") !== "ok" || !n || n.folder) return void res.writeHead(404).end();
      return this.serve(req, res, n);
    }

    record("api");
    req.resume();
    if (!this.authed(p, req)) return this.json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "token expired" } });

    if (p === "google") {
      const api = path.slice("/google/api".length);
      if (api === "/about") return this.json(res, 200, { user: { emailAddress: this.accounts.google, displayName: "Me" } });
      if (api === "/files") {
        const q = url.searchParams.get("q") ?? "";
        const m = /^'([^']+)' in parents and trashed = false$/.exec(q);
        if (!m) return this.json(res, 400, { error: { message: "bad query" } });
        const all = this.children("google", m[1]!);
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const slice = all.slice(start, start + Math.min(this.pageSize, Number(url.searchParams.get("pageSize") ?? 100)));
        return this.json(res, 200, {
          ...(start + slice.length < all.length ? { nextPageToken: String(start + slice.length) } : {}),
          files: slice.map((n) => ({
            id: n.id,
            name: n.name,
            mimeType: n.folder ? "application/vnd.google-apps.folder" : "audio/mpeg",
            ...(n.folder ? {} : { size: String(n.data!.length), md5Checksum: createHash("md5").update(n.data!).digest("hex") }),
            modifiedTime: n.mtime.toISOString(),
          })),
        });
      }
      const f = /^\/files\/([^/]+)$/.exec(api);
      if (f && url.searchParams.get("alt") === "media") {
        const n = this.nodes.get("google")!.get(f[1]!);
        if (!n || n.folder) return void res.writeHead(404).end();
        return this.serve(req, res, n);
      }
      return void res.writeHead(404).end();
    }

    const api = path.slice("/ms/api".length);
    if (api === "/me") return this.json(res, 200, { mail: this.accounts.microsoft, displayName: "Me" });
    const kids = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(api);
    if (kids) {
      const parent = kids[1] ?? "root";
      const all = this.children("microsoft", parent);
      const start = Number(url.searchParams.get("skip") ?? 0);
      const slice = all.slice(start, start + this.pageSize);
      const next = new URL(url.href);
      next.searchParams.set("skip", String(start + slice.length));
      return this.json(res, 200, {
        value: slice.map((n) => ({
          id: n.id,
          name: n.name,
          lastModifiedDateTime: n.mtime.toISOString(),
          eTag: `"{${n.id}},1"`,
          ...(n.folder ? { folder: { childCount: 0 } } : { size: n.data!.length, file: { mimeType: "audio/mpeg" } }),
        })),
        ...(this.evilNextLink ? { "@odata.nextLink": this.evilNextLink } : start + slice.length < all.length ? { "@odata.nextLink": next.toString() } : {}),
      });
    }
    const content = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(api);
    if (content) {
      const n = this.nodes.get("microsoft")!.get(content[1]!);
      if (!n || n.folder) return void res.writeHead(404).end();
      res.writeHead(302, { Location: `${this.altUrl}/ms/download/${n.id}?tempauth=ok` });
      return void res.end();
    }
    res.writeHead(404).end();
  }
}
