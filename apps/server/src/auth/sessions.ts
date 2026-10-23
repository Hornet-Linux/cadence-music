import type { Db } from "../db.js";
import { randomToken, sha256 } from "../util/crypto.js";
import { findUserById, type UserRow } from "./users.js";

/** Sessions unused for this long expire. */
export const IDLE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
/** How often idle sessions are swept out of the database. */
export const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delete sessions idle past the limit. Returns how many were removed. */
export function purgeExpiredSessions(db: Db, now = Date.now()): number {
  const result = db.prepare("DELETE FROM sessions WHERE last_used_at < ?").run(now - IDLE_LIMIT_MS);
  return Number(result.changes);
}

/** Purge now and then periodically; the timer never keeps the process alive. */
export function startSessionPurge(db: Db, intervalMs = PURGE_INTERVAL_MS): () => void {
  purgeExpiredSessions(db);
  const timer = setInterval(() => purgeExpiredSessions(db), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
/** Avoid a write on every request: only bump last_used_at this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** What a session remembers about the device that signed in, so people can recognise it later. */
export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/** Create a session and return its bearer token. Only a hash is stored. */
export function createSession(db: Db, userId: number, meta: SessionMeta = {}): string {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sha256(token), userId, now, now, meta.userAgent?.slice(0, 300) ?? null, meta.ip?.slice(0, 64) ?? null);
  return token;
}

export function userForToken(db: Db, token: string): UserRow | null {
  const hash = sha256(token);
  const session = db
    .prepare("SELECT user_id, last_used_at FROM sessions WHERE token_hash = ?")
    .get(hash) as { user_id: number; last_used_at: number } | undefined;
  if (!session) return null;

  const now = Date.now();
  if (session.last_used_at < now - IDLE_LIMIT_MS) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  const user = findUserById(db, session.user_id);
  // A switched-off account can't use a session it still holds.
  if (!user || user.disabled_at) return null;
  if (now - session.last_used_at > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(now, hash);
  }
  return user;
}

export function deleteSession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

/** A short, public handle for a session (never the token itself). */
const idOf = (tokenHash: string) => tokenHash.slice(0, 16);

export interface SessionInfo {
  id: string;
  device: string;
  ip: string | null;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}

/** A readable device name from a User-Agent string ("Chrome on Windows"). */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";
  if (/Cadence/i.test(ua) && /Electron/i.test(ua)) return "Cadence desktop app";
  // The Android app is a WebView (marked "; wv)") or native calls through okhttp.
  if (/Android/i.test(ua) && (/; wv\)/i.test(ua) || /Cadence/i.test(ua))) return "Cadence for Android";
  if (/okhttp/i.test(ua)) return "Cadence for Android";
  // An iOS app's WKWebView has no "Safari/" token; native calls come through CFNetwork.
  if (/iPhone|iPad|iPod/i.test(ua) && (/Cadence/i.test(ua) || !/Safari\//i.test(ua))) return `Cadence for ${/iPad/i.test(ua) ? "iPad" : "iPhone"}`;
  if (/CFNetwork|Darwin/i.test(ua)) return "Cadence for iPhone";
  if (/^(curl|Wget|node|undici|python|Go-http-client|axios|PostmanRuntime|HTTPie|okhttp)/i.test(ua)) return "Script or command-line tool";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPad/i.test(ua)
      ? "iPad"
      : /iPhone|iPod/i.test(ua)
        ? "iPhone"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/i.test(ua)
            ? "macOS"
            : /CrOS/i.test(ua)
              ? "ChromeOS"
              : /Linux/i.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg(e|A|iOS)?\//i.test(ua)
    ? "Edge"
    : /OPR\/|Opera/i.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//i.test(ua)
        ? "Firefox"
        : /SamsungBrowser\//i.test(ua)
          ? "Samsung Internet"
          : /Electron\//i.test(ua)
            ? "Desktop app"
            : /Chrome\/|CriOS\//i.test(ua)
              ? "Chrome"
              : /Safari\//i.test(ua)
                ? "Safari"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

/** A person's own sessions, newest activity first. `currentToken` marks the one making the request. */
export function listSessions(db: Db, userId: number, currentToken: string | null): SessionInfo[] {
  const current = currentToken ? sha256(currentToken) : null;
  const rows = db
    .prepare(
      `SELECT token_hash, created_at, last_used_at, user_agent, ip FROM sessions
        WHERE user_id = ? AND last_used_at >= ? ORDER BY last_used_at DESC`,
    )
    .all(userId, Date.now() - IDLE_LIMIT_MS) as {
    token_hash: string;
    created_at: number;
    last_used_at: number;
    user_agent: string | null;
    ip: string | null;
  }[];
  return rows.map((r) => ({
    id: idOf(r.token_hash),
    device: deviceLabel(r.user_agent),
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    current: r.token_hash === current,
  }));
}

/** End one of a person's sessions by its public id. Returns whether one was removed. */
export function deleteSessionById(db: Db, userId: number, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return false;
  const result = db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").run(userId, id);
  return Number(result.changes) > 0;
}

/** End all of a person's sessions except the one in `keepToken`. Returns how many ended. */
export function deleteOtherSessions(db: Db, userId: number, keepToken: string | null): number {
  const result = keepToken
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha256(keepToken))
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
}
