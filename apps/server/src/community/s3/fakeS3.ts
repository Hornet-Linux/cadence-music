import http from "node:http";
import type { AddressInfo } from "node:net";
import { amzDate, authorizationHeader, expectedPresignedSignature } from "./sigv4.js";

/**
 * A stand-in S3 for tests (path-style, like MinIO): ListObjectsV2 with prefixes, delimiters and
 * paging, and GET with byte ranges. Every request must be signed with SigV4, either in the
 * Authorization header or in the query string (presigned); the signature is checked by recomputing it,
 * and a presigned URL stops working once its X-Amz-Expires has passed on the fake's clock.
 * Lives next to the tests; not imported by the server.
 */
export interface FakeS3Call {
  kind: "header" | "presigned" | "unsigned";
  method: string;
  path: string;
  query: Record<string, string>;
  range?: string;
  hadAuthorizationHeader: boolean;
  expires?: number;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class FakeS3 {
  objects = new Map<string, { data: Buffer; mtime: Date }>();
  calls: FakeS3Call[] = [];
  /** Keys per listing page, to exercise continuation tokens. */
  pageSize = 1000;
  /** The clock the fake uses to judge presigned expiry. */
  clock: () => number = () => Date.now();
  private server: http.Server | null = null;
  url = "";

  constructor(
    readonly bucket = "music",
    readonly accessKeyId = "AKIAFAKEFAKEFAKE",
    public secretAccessKey = "fake/secret/key+for+tests",
    readonly region = "us-east-1",
  ) {}

  /** `host`/`port` choose where to listen; `publicHost` is the name clients use to reach it. */
  async start(opts: { host?: string; port?: number; publicHost?: string } = {}): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
    this.url = `http://${opts.publicHost ?? "127.0.0.1"}:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  add(key: string, data: Buffer, mtime = new Date("2024-06-01T08:00:00Z")): this {
    this.objects.set(key, { data, mtime });
    return this;
  }

  private error(res: http.ServerResponse, status: number, code: string, extra = ""): void {
    res.writeHead(status, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message>${extra}</Error>`);
  }

  /** Returns null when the request is properly signed, or the error to send. */
  private verify(req: http.IncomingMessage, url: URL, call: FakeS3Call): { status: number; code: string; extra?: string } | null {
    const auth = req.headers.authorization;
    if (auth) {
      call.kind = "header";
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
      if (!m) return { status: 400, code: "AuthorizationHeaderMalformed" };
      const [, key, , region, signedHeaders, signature] = m;
      if (key !== this.accessKeyId) return { status: 403, code: "InvalidAccessKeyId" };
      if (region !== this.region) return { status: 400, code: "AuthorizationHeaderMalformed", extra: `<Region>${this.region}</Region>` };
      const headers: Record<string, string> = {};
      for (const name of signedHeaders!.split(";")) headers[name] = String(req.headers[name] ?? "");
      const stamp = String(req.headers["x-amz-date"] ?? "");
      const date = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)));
      const expected = authorizationHeader({
        method: req.method ?? "GET",
        url,
        headers,
        payloadHash: String(req.headers["x-amz-content-sha256"] ?? ""),
        region: this.region,
        service: "s3",
        credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
        date,
      });
      if (amzDate(date) !== stamp) return { status: 403, code: "RequestTimeTooSkewed" };
      return expected.signature === signature ? null : { status: 403, code: "SignatureDoesNotMatch" };
    }
    const q = url.searchParams;
    if (q.has("X-Amz-Signature")) {
      call.kind = "presigned";
      call.expires = Number(q.get("X-Amz-Expires"));
      if (!q.get("X-Amz-Credential")?.startsWith(this.accessKeyId + "/")) return { status: 403, code: "InvalidAccessKeyId" };
      const stamp = q.get("X-Amz-Date") ?? "";
      const issued = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
      if (this.clock() > issued + call.expires * 1000) return { status: 403, code: "AccessDenied", extra: "<Detail>Request has expired</Detail>" };
      return expectedPresignedSignature(url, req.method ?? "GET", this.secretAccessKey) === q.get("X-Amz-Signature") ? null : { status: 403, code: "SignatureDoesNotMatch" };
    }
    return { status: 403, code: "AccessDenied" };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const call: FakeS3Call = {
      kind: "unsigned",
      method: req.method ?? "",
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      range: req.headers.range,
      hadAuthorizationHeader: !!req.headers.authorization,
    };
    this.calls.push(call);
    req.resume();
    const bad = this.verify(req, url, call);
    if (bad) return this.error(res, bad.status, bad.code, bad.extra);

    const path = decodeURIComponent(url.pathname);
    const prefixOfBucket = `/${this.bucket}`;
    if (path !== prefixOfBucket && !path.startsWith(prefixOfBucket + "/")) return this.error(res, 404, "NoSuchBucket");
    const key = path.slice(prefixOfBucket.length + 1);

    if (key === "") {
      const q = url.searchParams;
      if (q.get("list-type") !== "2") return this.error(res, 400, "InvalidRequest");
      const prefix = q.get("prefix") ?? "";
      const delimiter = q.get("delimiter") ?? "";
      const after = q.get("continuation-token") ? Buffer.from(q.get("continuation-token")!, "base64url").toString() : "";
      const maxKeys = Math.min(Number(q.get("max-keys") ?? 1000), this.pageSize);
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const contents: string[] = [];
      const common = new Set<string>();
      let count = 0;
      let last = "";
      let truncated = false;
      for (const k of keys) {
        if (k <= after) continue;
        const rest = k.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        const entryKey = cut >= 0 ? prefix + rest.slice(0, cut + delimiter.length) : k;
        if (cut >= 0 && common.has(entryKey)) {
          last = k;
          continue;
        }
        if (count >= maxKeys) {
          truncated = true;
          break;
        }
        count++;
        last = k;
        if (cut >= 0) common.add(entryKey);
        else {
          const o = this.objects.get(k)!;
          contents.push(`<Contents><Key>${escapeXml(k)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>&quot;${o.mtime.getTime().toString(16)}${o.data.length}&quot;</ETag><Size>${o.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
        }
      }
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${this.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${count}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${Buffer.from(last).toString("base64url")}</NextContinuationToken>` : ""}${contents.join("")}${[...common].map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
      );
      return;
    }

    const object = this.objects.get(key);
    if (!object) return this.error(res, 404, "NoSuchKey");
    const size = object.data.length;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Content-Type": "binary/octet-stream" });
      res.end(object.data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Length": size, "Content-Type": "binary/octet-stream", "Accept-Ranges": "bytes" });
    res.end(object.data);
  }
}
