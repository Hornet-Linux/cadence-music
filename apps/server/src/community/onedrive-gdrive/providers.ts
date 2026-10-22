import { RemoteError, type RemoteFile } from "../../sources/indexer.js";
import { readBody, request, SourceNetError, type NetPolicy, type UpstreamResponse } from "../../sources/net.js";
import { isAudioName } from "../../sources/tags.js";

/*
 * UNTESTED AGAINST THE REAL SERVICES.
 * This file was written from Google's and Microsoft's public API documentation and exercised only against
 * test doubles (fakeCloud.ts) that imitate their documented behaviour. It has never talked to the real
 * Google Drive or OneDrive, because that needs registered OAuth apps and real accounts. Expect to fix small
 * differences (field names, scopes, consent screen requirements) the first time it meets the real thing.
 */

export type ProviderId = "google" | "microsoft";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds the access token lives. */
  expiresIn: number;
}

/** Everything a provider call needs. `token` fetches (and refreshes) the access token. */
export interface Api {
  token: () => Promise<string>;
  /** Forget the cached access token (the service said 401), so the next `token()` refreshes it. */
  invalidate: () => void;
  policy: NetPolicy;
  /** API base address (overridden by tests). */
  base: string;
}

export interface FolderRef {
  id: string;
  name: string;
}

export interface ProviderEndpoints {
  authorize: string;
  token: string;
  api: string;
}

export interface CloudProvider {
  id: ProviderId;
  /** Name shown to people. */
  label: string;
  /** Key for the track cache and signed links. */
  source: "gdrive" | "onedrive";
  scopes: string;
  endpoints: (tenant?: string) => ProviderEndpoints;
  extraAuthorizeParams: Record<string, string>;
  /** Valid ids for folders and files (they end up in URLs, so nothing else is let through). */
  validId: (id: string) => boolean;
  account: (api: Api) => Promise<string | null>;
  listFolders: (api: Api, parentId: string) => Promise<FolderRef[]>;
  walkAudio: (api: Api, roots: FolderRef[], signal: AbortSignal) => AsyncGenerator<RemoteFile>;
  open: (api: Api, fileId: string, range: string | undefined, signal?: AbortSignal) => Promise<UpstreamResponse>;
}

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 20;
const MAX_FOLDERS = 20_000;
const MAX_FILES = 500_000;
const MAX_PAGES = 5_000;

export function classify(status: number): RemoteError {
  if (status === 401) return new RemoteError("needs_reconnect", undefined, status);
  if (status === 403) return new RemoteError("auth_failed", undefined, status);
  if (status === 404 || status === 410) return new RemoteError("not_found", undefined, status);
  return new RemoteError("upstream", undefined, status);
}

/** GET/POST JSON with the access token; one retry with a fresh token if the service says it expired. */
export async function apiJson<T>(api: Api, url: string | URL, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, { headers: { Authorization: `Bearer ${await api.token()}`, Accept: "application/json" }, policy: api.policy, signal, headerTimeoutMs: 20_000 });
    if (res.status === 401 && attempt === 0) {
      res.body.destroy();
      api.invalidate();
      continue;
    }
    if (res.status !== 200) {
      res.body.destroy();
      throw classify(res.status);
    }
    try {
      return JSON.parse((await readBody(res, MAX_JSON_BYTES)).toString("utf8")) as T;
    } catch (e) {
      if (e instanceof SourceNetError) throw e;
      throw new RemoteError("bad_response");
    }
  }
}

/** Streams a file with the access token (retrying once on 401). Redirects drop the token but keep Range. */
async function openAuthorized(api: Api, url: URL, range: string | undefined, signal?: AbortSignal): Promise<UpstreamResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, {
      headers: { Authorization: `Bearer ${await api.token()}`, ...(range ? { Range: range } : {}) },
      policy: api.policy,
      signal,
      crossOriginHeaders: ["Range"],
      maxRedirects: 3,
    });
    if (res.status === 401 && attempt === 0) {
      res.body.destroy();
      api.invalidate();
      continue;
    }
    return res;
  }
}

// ---- Google Drive ---------------------------------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const driveId = (id: string) => id === "root" || /^[A-Za-z0-9_-]{5,200}$/.test(id);

async function* driveChildren(api: Api, parentId: string, signal?: AbortSignal): AsyncGenerator<DriveFile> {
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${api.base}/files`);
    url.searchParams.set("q", `'${parentId}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "name");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await apiJson<{ files?: DriveFile[]; nextPageToken?: string }>(api, url, signal);
    for (const f of body.files ?? []) if (f && typeof f.id === "string" && typeof f.name === "string") yield f;
    pageToken = body.nextPageToken;
    if (!pageToken) return;
  }
}

export const googleProvider: CloudProvider = {
  id: "google",
  label: "Google Drive",
  source: "gdrive",
  scopes: "https://www.googleapis.com/auth/drive.readonly",
  endpoints: () => ({
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    api: "https://www.googleapis.com/drive/v3",
  }),
  // offline access gives a refresh token; consent makes Google return it again on reconnect.
  extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
  validId: driveId,
  async account(api) {
    const url = new URL(`${api.base}/about`);
    url.searchParams.set("fields", "user(emailAddress,displayName)");
    const about = await apiJson<{ user?: { emailAddress?: string; displayName?: string } }>(api, url);
    return about.user?.emailAddress ?? about.user?.displayName ?? null;
  },
  async listFolders(api, parentId) {
    const out: FolderRef[] = [];
    for await (const f of driveChildren(api, parentId)) {
      if (f.mimeType === FOLDER_MIME && !f.name.startsWith(".")) out.push({ id: f.id, name: f.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  },
  async *walkAudio(api, roots, signal) {
    const queue = roots.map((r) => ({ id: r.id, location: r.id === "root" ? "" : r.name, depth: 0 }));
    const visited = new Set<string>();
    let files = 0;
    while (queue.length) {
      if (signal.aborted) return;
      const dir = queue.shift()!;
      if (visited.has(dir.id)) continue;
      visited.add(dir.id);
      if (visited.size > MAX_FOLDERS) throw new RemoteError("bad_response", "too many folders");
      for await (const f of driveChildren(api, dir.id, signal)) {
        const location = dir.location ? `${dir.location}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          if (dir.depth < MAX_DEPTH && !f.name.startsWith(".")) queue.push({ id: f.id, location, depth: dir.depth + 1 });
        } else if (isAudioName(f.name) && !f.name.startsWith(".") && driveId(f.id)) {
          if (++files > MAX_FILES) throw new RemoteError("bad_response", "too many files");
          const t = Date.parse(f.modifiedTime ?? "");
          yield { path: f.id, location, size: Number(f.size) || 0, mtimeMs: Number.isFinite(t) ? t : 0, etag: f.md5Checksum };
        }
      }
    }
  },
  open(api, fileId, range, signal) {
    if (!driveId(fileId)) throw new RemoteError("bad_response", "bad id");
    const url = new URL(`${api.base}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    return openAuthorized(api, url, range, signal);
  },
};

// ---- OneDrive (Microsoft Graph) -------------------------------------------------------------

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  /** Present on items shared from elsewhere; they can't be opened through /me/drive/items. */
  remoteItem?: unknown;
}

const graphId = (id: string) => id === "root" || /^[A-Za-z0-9!._-]{3,300}$/.test(id);

async function* graphChildren(api: Api, parentId: string, signal?: AbortSignal): AsyncGenerator<GraphItem> {
  const first = new URL(`${api.base}/me/drive/${parentId === "root" ? "root" : `items/${encodeURIComponent(parentId)}`}/children`);
  first.searchParams.set("$select", "id,name,size,file,folder,lastModifiedDateTime,eTag,remoteItem");
  first.searchParams.set("$top", "200");
  let next: URL | null = first;
  const origin = new URL(api.base).origin;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body: { value?: GraphItem[]; "@odata.nextLink"?: string } = await apiJson(api, next, signal);
    for (const item of body.value ?? []) if (item && typeof item.id === "string" && typeof item.name === "string") yield item;
    next = null;
    const link = body["@odata.nextLink"];
    if (link) {
      // The next page address comes from the service's reply: only follow it if it stays on the API host.
      let candidate: URL;
      try {
        candidate = new URL(link);
      } catch {
        throw new RemoteError("bad_response");
      }
      if (candidate.origin !== origin) throw new RemoteError("bad_response", "next page on another host");
      next = candidate;
    }
  }
}

export const microsoftProvider: CloudProvider = {
  id: "microsoft",
  label: "OneDrive",
  source: "onedrive",
  scopes: "Files.Read offline_access User.Read",
  endpoints: (tenant = "common") => ({
    authorize: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    api: "https://graph.microsoft.com/v1.0",
  }),
  extraAuthorizeParams: { response_mode: "query" },
  validId: graphId,
  async account(api) {
    const me = await apiJson<{ userPrincipalName?: string; mail?: string; displayName?: string }>(api, `${api.base}/me?$select=userPrincipalName,mail,displayName`);
    return me.mail ?? me.userPrincipalName ?? me.displayName ?? null;
  },
  async listFolders(api, parentId) {
    const out: FolderRef[] = [];
    for await (const item of graphChildren(api, parentId)) {
      if (item.folder && !item.remoteItem && !item.name.startsWith(".")) out.push({ id: item.id, name: item.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  },
  async *walkAudio(api, roots, signal) {
    const queue = roots.map((r) => ({ id: r.id, location: r.id === "root" ? "" : r.name, depth: 0 }));
    const visited = new Set<string>();
    let files = 0;
    while (queue.length) {
      if (signal.aborted) return;
      const dir = queue.shift()!;
      if (visited.has(dir.id)) continue;
      visited.add(dir.id);
      if (visited.size > MAX_FOLDERS) throw new RemoteError("bad_response", "too many folders");
      for await (const item of graphChildren(api, dir.id, signal)) {
        if (item.remoteItem) continue;
        const location = dir.location ? `${dir.location}/${item.name}` : item.name;
        if (item.folder) {
          if (dir.depth < MAX_DEPTH && !item.name.startsWith(".")) queue.push({ id: item.id, location, depth: dir.depth + 1 });
        } else if (item.file && isAudioName(item.name) && !item.name.startsWith(".") && graphId(item.id)) {
          if (++files > MAX_FILES) throw new RemoteError("bad_response", "too many files");
          const t = Date.parse(item.lastModifiedDateTime ?? "");
          yield { path: item.id, location, size: item.size ?? 0, mtimeMs: Number.isFinite(t) ? t : 0, etag: item.eTag };
        }
      }
    }
  },
  open(api, fileId, range, signal) {
    if (!graphId(fileId) || fileId === "root") throw new RemoteError("bad_response", "bad id");
    // /content answers 302 with a short-lived download address on another host; that hop gets no token.
    return openAuthorized(api, new URL(`${api.base}/me/drive/items/${encodeURIComponent(fileId)}/content`), range, signal);
  },
};

export const providers: Record<ProviderId, CloudProvider> = { google: googleProvider, microsoft: microsoftProvider };
