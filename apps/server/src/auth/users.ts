import type { PublicUser } from "@uma/shared";
import type { Db } from "../db.js";
import { hashPassword } from "./passwords.js";

export interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  is_admin: number;
  created_at: number;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    isAdmin: row.is_admin === 1,
  };
}

export function findUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function countUsers(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function countPasswordUsers(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL").get() as {
    n: number;
  };
  return row.n;
}

/** True for a SQLite UNIQUE constraint failure (e.g. a username taken a moment ago). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export async function createLocalUser(
  db: Db,
  input: { username: string; password: string; isAdmin?: boolean; displayName?: string },
): Promise<UserRow> {
  const passwordHash = await hashPassword(input.password);
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.displayName ?? null,
      passwordHash,
      input.isAdmin ? 1 : 0,
      Date.now(),
    );
  return findUserById(db, Number(result.lastInsertRowid))!;
}

function uniqueUsername(db: Db, preferred: string, subject: string): string {
  const base = preferred.replace(/[^\w.@-]/g, "").slice(0, 48) || "user";
  if (!findUserByUsername(db, base)) return base;
  const suffixed = `${base}-${subject.replace(/[^\w]/g, "").slice(0, 6) || "oidc"}`;
  if (!findUserByUsername(db, suffixed)) return suffixed;
  for (let i = 2; ; i++) {
    const candidate = `${suffixed}-${i}`;
    if (!findUserByUsername(db, candidate)) return candidate;
  }
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  preferredUsername?: string;
  email?: string;
  name?: string;
  /** undefined leaves admin status unchanged; true/false sets it. */
  isAdmin?: boolean;
}

/** Find the user linked to an OIDC identity, creating it on first sign-in. */
export function upsertOidcUser(db: Db, id: OidcIdentity): UserRow {
  const existing = db
    .prepare("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ?")
    .get(id.issuer, id.subject) as UserRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE users SET display_name = ?, email = ?, is_admin = ? WHERE id = ?`,
    ).run(
      id.name ?? existing.display_name,
      id.email ?? existing.email,
      id.isAdmin === undefined ? existing.is_admin : id.isAdmin ? 1 : 0,
      existing.id,
    );
    return findUserById(db, existing.id)!;
  }

  const preferred = id.preferredUsername || id.email?.split("@")[0] || "user";
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, email, oidc_issuer, oidc_subject, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uniqueUsername(db, preferred, id.subject),
      id.name ?? null,
      id.email ?? null,
      id.issuer,
      id.subject,
      id.isAdmin ? 1 : 0,
      Date.now(),
    );
  return findUserById(db, Number(result.lastInsertRowid))!;
}
