import { RemoteError, type RemoteFile } from "../../sources/indexer.js";
import { readBody, request, type NetPolicy, type UpstreamResponse } from "../../sources/net.js";
import { isAudioName } from "../../sources/tags.js";
import { child, childText, children, parseXml, XmlError, type XmlNode } from "../../sources/xml.js";
import { amzDate, authorizationHeader, canonicalQuery, EMPTY_SHA256, presignUrl, uriEncode, type S3Credentials } from "./sigv4.js";

/** An S3-compatible bucket: AWS S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi... */
export interface S3Connection {
  /** Address of the service for non-AWS providers (no bucket in it); empty for AWS. */
  endpoint?: string;
  region: string;
  bucket: string;
  credentials: S3Credentials;
  /** Put the bucket in the path (`host/bucket/key`) instead of the host name (`bucket.host/key`). */
  pathStyle: boolean;
}

const MAX_LISTING_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 5_000;
const MAX_FILES = 1_000_000;
/** Links used for streaming only live this long: they are made and used inside the server. */
export const PRESIGN_SECONDS = 60;

export function isPathStyleByDefault(endpoint: string | undefined, bucket: string): boolean {
  // Dots in a bucket name break the wildcard certificate of the virtual-hosted address on AWS.
  return !!endpoint || bucket.includes(".");
}

function baseUrl(c: S3Connection): URL {
  if (c.endpoint) {
    const e = new URL(c.endpoint);
    if (c.pathStyle) return new URL(`${e.origin}${e.pathname.replace(/\/+$/, "")}/${c.bucket}`);
    return new URL(`${e.protocol}//${c.bucket}.${e.host}${e.pathname.replace(/\/+$/, "")}`);
  }
  if (c.pathStyle) return new URL(`https://s3.${c.region}.amazonaws.com/${c.bucket}`);
  return new URL(`https://${c.bucket}.s3.${c.region}.amazonaws.com`);
}

/** The address of an object, with the key encoded the way SigV4 canonicalises it. */
export function objectUrl(c: S3Connection, key: string): URL {
  const b = baseUrl(c);
  const path = key
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/");
  return new URL(`${b.origin}${b.pathname.replace(/\/+$/, "")}/${path}`);
}

function bucketUrl(c: S3Connection, query: [string, string][]): URL {
  const b = baseUrl(c);
  const url = new URL(`${b.origin}${b.pathname.replace(/\/+$/, "")}/`);
  url.search = canonicalQuery(query);
  return url;
}

export interface S3Object {
  key: string;
  size: number;
  mtimeMs: number;
  etag?: string;
}

export interface S3Page {
  objects: S3Object[];
  prefixes: string[];
  nextToken?: string;
  /** The region the service says the bucket is in, when it tells us. */
  bucketRegion?: string;
}

function failFor(status: number, body: string, headers: Record<string, string | string[] | undefined>): RemoteError {
  let code = "";
  let region = (typeof headers["x-amz-bucket-region"] === "string" ? headers["x-amz-bucket-region"] : undefined) ?? "";
  try {
    const root = parseXml(body);
    code = childText(root, "code") ?? "";
    region = childText(root, "region") ?? region;
  } catch {
    // Not XML (HEAD, proxies): the status says enough.
  }
  const err = (kind: RemoteError["code"], extra?: string) => new RemoteError(kind, extra ?? (code || String(status)), status);
  if (code === "AuthorizationHeaderMalformed" || code === "PermanentRedirect" || code === "IllegalLocationConstraintException" || (status === 301 && region)) {
    return err("bad_response", `region:${region}`);
  }
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "InvalidToken", "ExpiredToken", "AllAccessDisabled"].includes(code) || status === 401 || status === 403) {
    return err("auth_failed");
  }
  if (code === "NoSuchBucket" || code === "NoSuchKey" || status === 404) return err("not_found");
  return err("upstream");
}

/** Pulls the region out of the error `listObjects` raises when the bucket lives elsewhere. */
export function regionHint(e: unknown): string | null {
  if (e instanceof RemoteError && e.code === "bad_response" && e.message.startsWith("region:")) return e.message.slice(7) || null;
  return null;
}

function parseListing(xml: string): S3Page {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new RemoteError("bad_response", e.message);
    throw e;
  }
  if (root.name !== "listbucketresult") throw new RemoteError("bad_response", "not a listing");
  const objects: S3Object[] = [];
  for (const c of children(root, "contents")) {
    const key = childText(c, "key") ?? child(c, "key")?.text;
    if (!key) continue;
    const size = Number(childText(c, "size"));
    const t = Date.parse(childText(c, "lastmodified") ?? "");
    const etag = childText(c, "etag");
    objects.push({ key, size: Number.isFinite(size) && size >= 0 ? size : 0, mtimeMs: Number.isFinite(t) ? t : 0, etag: etag ? etag.replace(/^"|"$/g, "") : undefined });
  }
  const prefixes = children(root, "commonprefixes")
    .map((p) => childText(p, "prefix"))
    .filter((p): p is string => !!p);
  const truncated = childText(root, "istruncated") === "true";
  return { objects, prefixes, nextToken: truncated ? childText(root, "nextcontinuationtoken") || undefined : undefined };
}

async function signedRequest(
  c: S3Connection,
  method: string,
  url: URL,
  policy: NetPolicy,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<UpstreamResponse> {
  const date = now();
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate(date) };
  if (c.credentials.sessionToken) headers["x-amz-security-token"] = c.credentials.sessionToken;
  const signed = authorizationHeader({ method, url, headers, payloadHash: EMPTY_SHA256, region: c.region, service: "s3", credentials: c.credentials, date });
  return request(url, { method, headers: { ...headers, Authorization: signed.authorization }, policy, signal, headerTimeoutMs: 20_000, maxRedirects: 0 });
}

export interface ListOptions {
  prefix: string;
  /** "/" groups keys into folders (the folder picker); empty lists everything below the prefix. */
  delimiter?: string;
  token?: string;
  maxKeys?: number;
}

export async function listObjects(
  c: S3Connection,
  opts: ListOptions,
  policy: NetPolicy,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<S3Page> {
  const q: [string, string][] = [["list-type", "2"], ["max-keys", String(opts.maxKeys ?? 1000)]];
  if (opts.prefix) q.push(["prefix", opts.prefix]);
  if (opts.delimiter) q.push(["delimiter", opts.delimiter]);
  if (opts.token) q.push(["continuation-token", opts.token]);
  const res = await signedRequest(c, "GET", bucketUrl(c, q), policy, signal, now);
  const text = (await readBody(res, MAX_LISTING_BYTES)).toString("utf8");
  if (res.status !== 200) throw failFor(res.status, text, res.headers);
  const page = parseListing(text);
  const region = res.headers["x-amz-bucket-region"];
  return { ...page, bucketRegion: typeof region === "string" ? region : undefined };
}

/** Cheap check that the endpoint, bucket and keys work. */
export async function testBucket(c: S3Connection, policy: NetPolicy, signal?: AbortSignal, now?: () => Date): Promise<void> {
  await listObjects(c, { prefix: "", maxKeys: 1, delimiter: "/" }, policy, signal, now);
}

/** Normalises a prefix typed or chosen by a person: no leading slash, a trailing slash unless empty, no "..". */
export function normalizePrefix(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 1000 || /[\u0000-\u001f\\]/.test(raw)) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.length ? parts.join("/") + "/" : "";
}

/** Sub-folders of a prefix (S3 has no real folders; these are the shared key prefixes). */
export async function listPrefixes(c: S3Connection, prefix: string, policy: NetPolicy, signal?: AbortSignal, now?: () => Date): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await listObjects(c, { prefix, delimiter: "/", token }, policy, signal, now);
    for (const p of r.prefixes) {
      const name = p.slice(prefix.length).replace(/\/$/, "");
      if (name && !name.startsWith(".")) out.push({ name, path: p });
    }
    token = r.nextToken;
    if (!token) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Every audio object under the chosen prefixes (default: the whole bucket). Throws if a listing can't be completed. */
export async function* walkAudio(
  c: S3Connection,
  prefixes: string[],
  policy: NetPolicy,
  signal: AbortSignal,
  now?: () => Date,
): AsyncGenerator<RemoteFile> {
  const seen = new Set<string>();
  let files = 0;
  for (const prefix of prefixes.length ? prefixes : [""]) {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal.aborted) return;
      const r = await listObjects(c, { prefix, token }, policy, signal, now);
      for (const o of r.objects) {
        if (o.key.endsWith("/") || seen.has(o.key)) continue;
        const name = o.key.slice(o.key.lastIndexOf("/") + 1);
        if (name.startsWith(".") || !isAudioName(name)) continue;
        seen.add(o.key);
        if (++files > MAX_FILES) throw new RemoteError("bad_response", "too many files");
        yield { path: o.key, location: o.key, size: o.size, mtimeMs: o.mtimeMs, etag: o.etag };
      }
      token = r.nextToken;
      if (!token) break;
    }
  }
}

/**
 * Opens an object for streaming through a one-minute presigned address that is made, used and dropped
 * inside the server. Clients never see it, and it is useless a minute later.
 */
export function openObject(
  c: S3Connection,
  key: string,
  range: string | undefined,
  policy: NetPolicy,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<UpstreamResponse> {
  const url = presignUrl({ method: "GET", url: objectUrl(c, key), region: c.region, service: "s3", credentials: c.credentials, date: now(), expiresSec: PRESIGN_SECONDS });
  return request(url, { headers: { ...(range ? { Range: range } : {}) }, policy, signal, maxRedirects: 0 });
}
