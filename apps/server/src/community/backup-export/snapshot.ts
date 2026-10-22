import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../../db.js";

export type SnapshotKind = "manual" | "auto";

export interface SnapshotInfo {
  name: string;
  kind: SnapshotKind;
  size: number;
  createdAt: number;
}

export interface SnapshotCheck {
  ok: boolean;
  integrity: string;
  schemaVersion: number;
  users: number;
  tracks: number;
  plays: number;
}

const NAME_RE = /^cadence-(manual|auto)-\d{8}-\d{6}(?:-\d+)?\.sqlite$/;

export const isSnapshotName = (name: string) => NAME_RE.test(name);

export function snapshotDir(dataDir: string): string {
  return path.join(dataDir, "backups");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `cadence-manual-20260102-030405.sqlite` (UTC). A counter is added if the second is taken. */
export function snapshotName(kind: SnapshotKind, when: Date, taken: (name: string) => boolean): string {
  const stamp = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`;
  let name = `cadence-${kind}-${stamp}.sqlite`;
  for (let i = 2; taken(name); i++) name = `cadence-${kind}-${stamp}-${i}.sqlite`;
  return name;
}

/**
 * Open a snapshot read-only and check it: SQLite's own integrity check plus a few row counts.
 * A snapshot that fails this must not be trusted as a backup.
 */
export function checkSnapshot(file: string): SnapshotCheck {
  const snap = new DatabaseSync(file, { readOnly: true } as never);
  try {
    const integrity = (snap.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const schemaVersion = (snap.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const count = (table: string) => {
      try {
        return (snap.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };
    return { ok: integrity === "ok", integrity, schemaVersion, users: count("users"), tracks: count("tracks"), plays: count("plays") };
  } finally {
    snap.close();
  }
}

/**
 * Write a consistent copy of the live database. `VACUUM INTO` takes one read transaction, so the copy is a
 * single point in time even while the server keeps writing, and it is compact (no WAL file to carry along).
 */
export function createSnapshot(db: Db, dir: string, kind: SnapshotKind, now = new Date()): SnapshotInfo & { check: SnapshotCheck } {
  fs.mkdirSync(dir, { recursive: true });
  const name = snapshotName(kind, now, (n) => fs.existsSync(path.join(dir, n)));
  const file = path.join(dir, name);
  const partial = `${file}.partial`;
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    const check = checkSnapshot(partial);
    if (!check.ok) throw new Error(`The snapshot failed SQLite's integrity check: ${check.integrity}`);
    fs.renameSync(partial, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Not supported on every file system.
    }
    return { name, kind, size: fs.statSync(file).size, createdAt: now.getTime(), check };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

export function listSnapshots(dir: string): SnapshotInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const stat = fs.statSync(path.join(dir, name));
    out.push({ name, kind: m[1] as SnapshotKind, size: stat.size, createdAt: stat.mtimeMs });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/** Keep the newest `keep` scheduled snapshots and delete the rest. Manual snapshots are never removed here. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  const autos = listSnapshots(dir).filter((s) => s.kind === "auto");
  const removed: string[] = [];
  for (const old of autos.slice(Math.max(1, keep))) {
    fs.rmSync(path.join(dir, old.name), { force: true });
    removed.push(old.name);
  }
  return removed;
}

export function restoreInstructions(dataDir: string): string {
  const db = path.join(dataDir, "music.db");
  return [
    "Restoring is a manual step on purpose, so a mistake in a web page can never replace your live database.",
    "",
    "1. Stop the server (Docker: docker compose stop server).",
    `2. In the data folder (${dataDir}) move music.db, music.db-wal and music.db-shm somewhere safe. Keep them until the restored server works.`,
    `3. Copy the snapshot you downloaded to ${db} (rename it to music.db).`,
    "4. Make sure the server user owns the file (Docker image: chown 1000:1000 music.db, the node user).",
    "5. Start the server. It upgrades an older database by itself. Check the Backup page and sign in.",
    "",
    "Also keep a copy of secret.key from the data folder (or your SERVER_SECRET). Saved API keys, webhook secrets and AI provider keys are encrypted with it and cannot be read without it.",
    "A snapshot contains accounts, password hashes and sessions. Store it as carefully as the server itself.",
  ].join("\n");
}