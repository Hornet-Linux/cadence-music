import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

// Each entry upgrades the schema by one version. Never edit a shipped entry;
// append a new one instead.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    email TEXT,
    password_hash TEXT,
    oidc_issuer TEXT,
    oidc_subject TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX users_oidc ON users (oidc_issuer, oidc_subject)
    WHERE oidc_subject IS NOT NULL;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    album_artist TEXT,
    track_no INTEGER,
    duration_sec REAL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX tracks_artist ON tracks (artist);
  CREATE INDEX tracks_album ON tracks (album);
  `,
  // v2: listening history, synced across a user's devices. Tracks come from
  // any source (Spotify, Apple Music, the server, local files), so the play
  // stores the metadata needed to show it again.
  `
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    source TEXT,
    title TEXT NOT NULL,
    artists TEXT NOT NULL,
    album TEXT,
    artwork TEXT,
    duration_sec REAL,
    played_at INTEGER NOT NULL,
    UNIQUE (user_id, track_id, played_at)
  );
  CREATE INDEX plays_user_time ON plays (user_id, played_at DESC);
  CREATE INDEX plays_user_track ON plays (user_id, track_id);
  `,
];

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Open (or create) the database and bring its schema up to date. */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Run `fn` inside a transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
