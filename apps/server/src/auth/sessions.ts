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

/** Create a session and return its bearer token. Only a hash is stored. */
export function createSession(db: Db, userId: number): string {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)",
  ).run(sha256(token), userId, now, now);
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
  if (now - session.last_used_at > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(now, hash);
  }
  return findUserById(db, session.user_id) ?? null;
}

export function deleteSession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}
