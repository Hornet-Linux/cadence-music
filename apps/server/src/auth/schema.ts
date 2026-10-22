import type { Db } from "../db.js";

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Account and admin additions: a way to switch a person off without deleting them,
 * what device each session belongs to, and the admin audit log. Written to be safe
 * to run on every start (it only adds what is missing), so it never collides with
 * the numbered migrations in db.ts.
 */
export function ensureAccountSchema(db: Db): void {
  if (!hasColumn(db, "users", "disabled_at")) db.exec("ALTER TABLE users ADD COLUMN disabled_at INTEGER");
  if (!hasColumn(db, "sessions", "user_agent")) db.exec("ALTER TABLE sessions ADD COLUMN user_agent TEXT");
  if (!hasColumn(db, "sessions", "ip")) db.exec("ALTER TABLE sessions ADD COLUMN ip TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor_id INTEGER,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at DESC);
  `);
}
