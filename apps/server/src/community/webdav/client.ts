import { RemoteError, type RemoteFile } from "../../sources/indexer.js";
import { readBody, request, type NetPolicy, type UpstreamResponse } from "../../sources/net.js";
import { isAudioName } from "../../sources/tags.js";
import { child, childText, children, parseXml, XmlError, type XmlNode } from "../../sources/xml.js";

/** A WebDAV share: the base address (a Nextcloud user's /remote.php/dav/files/NAME/, a NAS root...) and a login. */
export interface DavConnection {
  baseUrl: string;
  username: string;
  password: string;
}

export interface DavEntry {
  /** Path under the base address, decoded, starting with "/" (folders end without a slash except the root). */
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  etag?: string;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';
const MAX_LISTING_BYTES = 20 * 1024 * 1024;
const MAX_FOLDERS = 50_000;
const MAX_DEPTH = 24;
const MAX_FILES = 500_000;

function basicAuth(conn: DavConnection): string {
  return `Basic ${Buffer.from(`${conn.username}:${conn.password}`, "utf8").toString("base64")}`;
}

/** The base address's path with no trailing slash ("" for the site root). */
function basePath(base: URL): string {
  return base.pathname.replace(/\/+$/, "");
}

/** Normalises a folder or file path typed or chosen by a person: leading slash, no "..", no control characters. */
export function normalizeDavPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2000 || /[\u0000-\u001f\\]/.test(raw)) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return "/" + parts.join("/");
}

/** The request URL for a path under the base address. Always on the base address's own origin. */
export function davUrl(baseUrl: string, relPath: string, trailingSlash = false): URL {
  const base = new URL(baseUrl);
  const rel = normalizeDavPath(relPath);
  if (rel === null) throw new RemoteError("bad_response", "bad path");
  const encoded = rel === "/" ? "" : rel.split("/").map((seg) => (seg ? encodeURIComponent(seg) : seg)).join("/");
  const url = new URL(base.origin + basePath(base) + encoded + (trailingSlash || rel === "/" ? "/" : ""));
  return url;
}

function ms(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Turns a multistatus reply into entries under the base address, dropping anything that points elsewhere. */
export function parseMultistatus(xml: string, baseUrl: string): DavEntry[] {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) throw new RemoteError("bad_response", e.message);
    throw e;
  }
  if (root.name !== "multistatus") throw new RemoteError("bad_response", "not a multistatus");
  const base = new URL(baseUrl);
  const prefix = (() => {
    try {
      return decodeURIComponent(basePath(base));
    } catch {
      return basePath(base);
    }
  })();
  const out: DavEntry[] = [];
  for (const response of children(root, "response")) {
    const href = childText(response, "href");
    if (!href) continue;
    let pathname: string;
    try {
      const u = new URL(href, base.origin + basePath(base) + "/");
      if (u.origin !== base.origin) continue;
      pathname = decodeURIComponent(u.pathname);
    } catch {
      continue;
    }
    pathname = pathname.replace(/\/+$/, "") || "/";
    if (pathname !== prefix && !pathname.startsWith(prefix + "/") && prefix !== "") continue;
    const rel = prefix === "" ? pathname : pathname.slice(prefix.length) || "/";
    const normalized = normalizeDavPath(rel);
    if (normalized === null) continue;

    const propstats = children(response, "propstat");
    const ok = propstats.find((p) => /\s2\d\d(\s|$)/.test(childText(p, "status") ?? "")) ?? propstats[0];
    const prop = ok ? child(ok, "prop") : undefined;
    if (!prop) continue;
    const type = child(prop, "resourcetype");
    const isDir = !!type && child(type, "collection") !== undefined;
    const size = Number(childText(prop, "getcontentlength"));
    const etag = childText(prop, "getetag");
    out.push({
      path: normalized,
      isDir,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mtimeMs: ms(childText(prop, "getlastmodified")),
      etag: etag ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined,
    });
  }
  return out;
}

function failFor(status: number): RemoteError {
  if (status === 401 || status === 403) return new RemoteError("auth_failed", undefined, status);
  if (status === 404 || status === 410) return new RemoteError("not_found", undefined, status);
  return new RemoteError("upstream", undefined, status);
}

/** Lists one folder (depth 1) or asks about one item (depth 0). */
export async function propfind(
  conn: DavConnection,
  relPath: string,
  depth: 0 | 1,
  policy: NetPolicy,
  signal?: AbortSignal,
): Promise<DavEntry[]> {
  const res = await request(davUrl(conn.baseUrl, relPath, true), {
    method: "PROPFIND",
    headers: { Authorization: basicAuth(conn), Depth: String(depth), "Content-Type": "application/xml; charset=utf-8", Accept: "application/xml, text/xml" },
    body: PROPFIND_BODY,
    policy,
    signal,
    headerTimeoutMs: 20_000,
  });
  if (res.status !== 207 && res.status !== 200) {
    res.body.destroy();
    throw failFor(res.status);
  }
  const text = (await readBody(res, MAX_LISTING_BYTES)).toString("utf8");
  return parseMultistatus(text, conn.baseUrl);
}

/** Cheap check that the address and login work: asks about the base folder itself. */
export async function testConnection(conn: DavConnection, policy: NetPolicy, signal?: AbortSignal): Promise<void> {
  const entries = await propfind(conn, "/", 0, policy, signal);
  if (!entries.some((e) => e.isDir)) throw new RemoteError("bad_response", "base address is not a folder");
}

/** Sub-folders of a folder, for the folder picker. */
export async function listFolders(conn: DavConnection, relPath: string, policy: NetPolicy, signal?: AbortSignal): Promise<{ name: string; path: string }[]> {
  const here = normalizeDavPath(relPath) ?? "/";
  const entries = await propfind(conn, here, 1, policy, signal);
  return entries
    .filter((e) => e.isDir && e.path !== here)
    .map((e) => ({ name: e.path.slice(e.path.lastIndexOf("/") + 1), path: e.path }))
    .filter((f) => f.name && !f.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Every audio file under the chosen folders (default: the whole share). Throws if any folder can't be listed. */
export async function* walkAudio(conn: DavConnection, folders: string[], policy: NetPolicy, signal: AbortSignal): AsyncGenerator<RemoteFile> {
  const queue: { path: string; depth: number }[] = (folders.length ? folders : ["/"]).map((p) => ({ path: normalizeDavPath(p) ?? "/", depth: 0 }));
  const visited = new Set<string>();
  let files = 0;
  while (queue.length) {
    if (signal.aborted) return;
    const { path, depth } = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > MAX_FOLDERS) throw new RemoteError("bad_response", "too many folders");
    const entries = await propfind(conn, path, 1, policy, signal);
    for (const e of entries) {
      if (e.path === path) continue;
      const name = e.path.slice(e.path.lastIndexOf("/") + 1);
      if (!name || name.startsWith(".")) continue;
      if (e.isDir) {
        if (depth < MAX_DEPTH) queue.push({ path: e.path, depth: depth + 1 });
      } else if (isAudioName(name)) {
        if (++files > MAX_FILES) throw new RemoteError("bad_response", "too many files");
        yield { path: e.path, location: e.path.replace(/^\//, ""), size: e.size, mtimeMs: e.mtimeMs, etag: e.etag };
      }
    }
  }
}

/** Opens a file (or a byte range of it) for streaming. */
export function openFile(conn: DavConnection, relPath: string, range: string | undefined, policy: NetPolicy, signal?: AbortSignal): Promise<UpstreamResponse> {
  return request(davUrl(conn.baseUrl, relPath), {
    headers: { Authorization: basicAuth(conn), Accept: "*/*", ...(range ? { Range: range } : {}) },
    policy,
    signal,
    crossOriginHeaders: ["Range"],
  });
}
