import type { Db } from "../../db.js";
import { open, seal } from "../../llm/secretBox.js";
import { fetchText, NetError, request, type NetResponse, type RequestOptions } from "../_sourcekit/http.js";
import type { NetPolicy } from "../_sourcekit/netguard.js";

const PURPOSE = "audiobookshelf-tokens";

export type AbsErrorKind = "unauthorized" | "not_found" | "unreachable" | "timeout" | "redirect" | "bad_response" | "upstream";

/** A failed Audiobookshelf call. The message is for logs; clients only see fixed phrases chosen by the route. */
export class AbsError extends Error {
  constructor(
    readonly kind: AbsErrorKind,
    readonly status?: number,
  ) {
    super(status ? `Audiobookshelf ${kind} (HTTP ${status})` : `Audiobookshelf ${kind}`);
  }
}

/** Audiobookshelf ids are uuids or `li_...` style tokens. Anything else never goes into a URL. */
export const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/**
 * The address is set by the server owner only (like Jellyfin's), never by ordinary users, so it may be on the
 * local network. Credentials, query strings and fragments are refused. Returns it without a trailing slash.
 */
export function parseAbsUrl(raw: string): string {
  const text = raw.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) throw new Error("Enter the address of your Audiobookshelf server");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That isn't a valid address. Use a form like http://audiobookshelf:13378");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) throw new Error("The address must not contain a query string or fragment");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

export interface Connection {
  userId: number;
  absUserId: string;
  userName: string;
  serverUrl: string;
  token: string;
  refreshToken: string | null;
  /** Sealed token, to tell a re-signed-in person's new token from the one that failed. */
  tokenEnc: string;
}

interface Row {
  abs_user_id: string;
  user_name: string;
  server_url: string;
  token_enc: string;
  refresh_enc: string | null;
}

/** Each person's Audiobookshelf sign-in. Tokens are encrypted at rest with a key derived from the server secret. */
export class ConnectionStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS audiobooks_connections (
      user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      abs_user_id TEXT NOT NULL, user_name TEXT NOT NULL, server_url TEXT NOT NULL,
      token_enc TEXT NOT NULL, refresh_enc TEXT, created_at INTEGER NOT NULL
    );`);
  }

  get(userId: number): Connection | null {
    const row = this.db.prepare("SELECT * FROM audiobooks_connections WHERE user_id = ?").get(userId) as Row | undefined;
    if (!row) return null;
    const token = open(row.token_enc, this.secret, PURPOSE);
    if (!token) {
      this.delete(userId);
      return null;
    }
    const refresh = row.refresh_enc ? open(row.refresh_enc, this.secret, PURPOSE) : null;
    return { userId, absUserId: row.abs_user_id, userName: row.user_name, serverUrl: row.server_url, token, refreshToken: refresh, tokenEnc: row.token_enc };
  }

  save(c: Omit<Connection, "tokenEnc">): void {
    this.db
      .prepare(
        `INSERT INTO audiobooks_connections (user_id, abs_user_id, user_name, server_url, token_enc, refresh_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET abs_user_id = excluded.abs_user_id, user_name = excluded.user_name, server_url = excluded.server_url,
           token_enc = excluded.token_enc, refresh_enc = excluded.refresh_enc, created_at = excluded.created_at`,
      )
      .run(c.userId, c.absUserId, c.userName, c.serverUrl, seal(c.token, this.secret, PURPOSE), c.refreshToken ? seal(c.refreshToken, this.secret, PURPOSE) : null, Date.now());
  }

  delete(userId: number): void {
    this.db.prepare("DELETE FROM audiobooks_connections WHERE user_id = ?").run(userId);
  }

  deleteIfToken(userId: number, tokenEnc: string): void {
    this.db.prepare("DELETE FROM audiobooks_connections WHERE user_id = ? AND token_enc = ?").run(userId, tokenEnc);
  }
}

export interface AbsCall {
  base: string;
  token?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function toError(e: unknown): AbsError {
  if (e instanceof AbsError) return e;
  if (e instanceof NetError) return new AbsError(e.kind === "timeout" ? "timeout" : e.kind === "redirect" ? "redirect" : e.kind === "bad_response" ? "bad_response" : "unreachable");
  return new AbsError("unreachable");
}

/** The only place Audiobookshelf is called from. Redirects stay on the same origin (the token goes with them). */
export class AbsClient {
  constructor(private readonly policy: NetPolicy) {}

  private opts(c: AbsCall, method: RequestOptions["method"], extra: RequestOptions = {}): RequestOptions {
    const origin = new URL(c.base).origin;
    return {
      allowPrivate: true,
      ...this.policy,
      method,
      headers: {
        Accept: "application/json",
        ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
        ...(c.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...c.headers,
      },
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
      maxRedirects: 3,
      allowRedirect: (_from, to) => to.origin === origin,
      signal: c.signal,
      ...extra,
    };
  }

  private url(c: AbsCall, path: string): string {
    const u = new URL(c.base + path);
    if (u.origin !== new URL(c.base).origin) throw new AbsError("bad_response");
    for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async json<T = unknown>(c: AbsCall, method: RequestOptions["method"], path: string): Promise<T> {
    try {
      const r = await fetchText(this.url(c, path), { ...this.opts(c, method), headerTimeoutMs: 15_000, totalTimeoutMs: 20_000, maxBytes: 8_000_000 });
      if (r.status === 401 || r.status === 403) throw new AbsError("unauthorized", r.status);
      if (r.status === 404) throw new AbsError("not_found", 404);
      if (r.status >= 400) throw new AbsError("upstream", r.status);
      if (r.status === 204 || !r.text.trim()) return undefined as T;
      try {
        return JSON.parse(r.text) as T;
      } catch {
        // Some endpoints answer a plain "OK".
        if (/^\s*OK\s*$/i.test(r.text)) return undefined as T;
        throw new AbsError("bad_response", r.status);
      }
    } catch (e) {
      throw toError(e);
    }
  }

  /** A streamed call (audio, cover art). The caller owns the body. */
  async stream(c: AbsCall, path: string, headerTimeoutMs: number): Promise<NetResponse> {
    try {
      return await request(this.url(c, path), this.opts(c, "GET", { idleTimeoutMs: 0, headerTimeoutMs, headers: { Accept: "*/*", ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}), ...c.headers } }));
    } catch (e) {
      throw toError(e);
    }
  }
}

