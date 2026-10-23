import type { Db } from "../../db.js";
import { transaction } from "../../db.js";
import { placeholders } from "../_serverlib/decorate.js";
import { suggestForLibrary, TAG_FIELDS, type TagField, type TagTrack } from "./rules.js";

export type SuggestionStatus = "pending" | "accepted" | "rejected" | "reverted";

export interface StoredSuggestion {
  id: number;
  trackId: string;
  relPath: string;
  trackTitle: string;
  trackArtist: string | null;
  field: TagField;
  oldValue: string | null;
  newValue: string;
  rule: string;
  reason: string;
  status: SuggestionStatus;
  createdAt: number;
  decidedAt: number | null;
}

export function ensureTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      rule TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      UNIQUE (track_id, field, new_value)
    );
    CREATE INDEX IF NOT EXISTS tag_suggestions_status ON tag_suggestions (status, id);
    CREATE TABLE IF NOT EXISTS tag_overlay (
      track_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      original TEXT,
      suggestion_id INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (track_id, field)
    );
  `);
}

interface TrackRow {
  id: string;
  rel_path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
}

/** The library as the API serves it: file tags with accepted overlays on top. */
export function loadEffectiveTracks(db: Db): TagTrack[] {
  const rows = db
    .prepare("SELECT id, rel_path, title, artist, album, album_artist, track_no FROM tracks")
    .all() as unknown as TrackRow[];
  const overlays = new Map<string, Map<string, string>>();
  for (const o of db.prepare("SELECT track_id, field, value FROM tag_overlay").all() as unknown as {
    track_id: string;
    field: string;
    value: string;
  }[]) {
    const m = overlays.get(o.track_id) ?? new Map();
    m.set(o.field, o.value);
    overlays.set(o.track_id, m);
  }
  return rows.map((r) => {
    const o = overlays.get(r.id);
    return {
      id: r.id,
      relPath: r.rel_path,
      title: o?.get("title") ?? r.title,
      artist: o?.get("artist") ?? r.artist,
      album: o?.get("album") ?? r.album,
      albumArtist: o?.get("albumArtist") ?? r.album_artist,
      trackNo: o?.has("trackNo") ? Number(o.get("trackNo")) : r.track_no,
    };
  });
}

/**
 * Recompute suggestions. Pending ones are replaced by a fresh set; suggestions the admin already
 * decided on (accepted or rejected) are never proposed again.
 */
export function generateSuggestions(db: Db, now = Date.now()): { pending: number; created: number } {
  const suggestions = suggestForLibrary(loadEffectiveTracks(db));
  return transaction(db, () => {
    db.exec("DELETE FROM tag_suggestions WHERE status = 'pending'");
    db.exec("DELETE FROM tag_suggestions WHERE track_id NOT IN (SELECT id FROM tracks)");
    db.exec("DELETE FROM tag_overlay WHERE track_id NOT IN (SELECT id FROM tracks)");
    const insert = db.prepare(
      `INSERT OR IGNORE INTO tag_suggestions (track_id, field, old_value, new_value, rule, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    let created = 0;
    for (const s of suggestions) {
      const res = insert.run(s.trackId, s.field, s.oldValue, s.newValue, s.rule, s.reason, now);
      created += Number(res.changes);
    }
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM tag_suggestions WHERE status = 'pending'").get() as { n: number }).n;
    return { pending, created };
  });
}

interface Row {
  id: number;
  track_id: string;
  rel_path: string | null;
  t_title: string | null;
  t_artist: string | null;
  field: string;
  old_value: string | null;
  new_value: string;
  rule: string;
  reason: string;
  status: SuggestionStatus;
  created_at: number;
  decided_at: number | null;
}

const toStored = (r: Row): StoredSuggestion => ({
  id: r.id,
  trackId: r.track_id,
  relPath: r.rel_path ?? "",
  trackTitle: r.t_title ?? "",
  trackArtist: r.t_artist,
  field: r.field as TagField,
  oldValue: r.old_value,
  newValue: r.new_value,
  rule: r.rule,
  reason: r.reason,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const SELECT = `SELECT s.id, s.track_id, t.rel_path, t.title AS t_title, t.artist AS t_artist, s.field, s.old_value, s.new_value,
                       s.rule, s.reason, s.status, s.created_at, s.decided_at
                  FROM tag_suggestions s LEFT JOIN tracks t ON t.id = s.track_id`;

export function listSuggestions(
  db: Db,
  q: { status?: string; rule?: string; limit: number; offset: number },
): { items: StoredSuggestion[]; total: number } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.status && q.status !== "all") {
    where.push("s.status = ?");
    args.push(q.status);
  }
  if (q.rule) {
    where.push("(',' || s.rule || ',') LIKE ?");
    args.push(`%,${q.rule},%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`${SELECT} ${clause} ORDER BY t.rel_path, s.field LIMIT ? OFFSET ?`)
    .all(...args, q.limit, q.offset) as unknown as Row[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM tag_suggestions s ${clause}`).get(...args) as { n: number }).n;
  return { items: rows.map(toStored), total };
}

export function getSuggestion(db: Db, id: number): StoredSuggestion | null {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as unknown as Row | undefined;
  return row ? toStored(row) : null;
}

export function counts(db: Db): { byStatus: Record<string, number>; pendingByRule: Record<string, number>; overlays: number } {
  const byStatus: Record<string, number> = { pending: 0, accepted: 0, rejected: 0, reverted: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM tag_suggestions GROUP BY status").all() as unknown as {
    status: string;
    n: number;
  }[]) {
    byStatus[r.status] = r.n;
  }
  const pendingByRule: Record<string, number> = {};
  for (const r of db
    .prepare("SELECT rule, COUNT(*) AS n FROM tag_suggestions WHERE status = 'pending' GROUP BY rule")
    .all() as unknown as { rule: string; n: number }[]) {
    for (const rule of r.rule.split(",")) pendingByRule[rule] = (pendingByRule[rule] ?? 0) + r.n;
  }
  const overlays = (db.prepare("SELECT COUNT(*) AS n FROM tag_overlay").get() as { n: number }).n;
  return { byStatus, pendingByRule, overlays };
}

/** Validate a value for a field; returns the cleaned value or null. */
export function validValue(field: TagField, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value || value.length > 300) return null;
  if (field === "trackNo") {
    if (!/^\d{1,3}$/.test(value)) return null;
    const n = Number(value);
    return n >= 1 && n <= 999 ? String(n) : null;
  }
  return value;
}

/** Accept pending suggestions: the value becomes an overlay the library API serves. Returns how many were accepted. */
export function acceptSuggestions(db: Db, ids: number[], overrides: Map<number, string> = new Map(), now = Date.now()): number {
  if (ids.length === 0) return 0;
  return transaction(db, () => {
    const rows = db
      .prepare(
        `SELECT id, track_id, field, old_value, new_value FROM tag_suggestions WHERE status = 'pending' AND id IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as { id: number; track_id: string; field: string; old_value: string | null; new_value: string }[];
    const putOverlay = db.prepare(
      `INSERT INTO tag_overlay (track_id, field, value, original, suggestion_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (track_id, field) DO UPDATE SET value = excluded.value, suggestion_id = excluded.suggestion_id, updated_at = excluded.updated_at`,
    );
    const mark = db.prepare("UPDATE tag_suggestions SET status = 'accepted', decided_at = ?, new_value = ? WHERE id = ?");
    // Superseded: another pending suggestion for the same field of the same track.
    const drop = db.prepare("DELETE FROM tag_suggestions WHERE status = 'pending' AND track_id = ? AND field = ? AND id != ?");
    let accepted = 0;
    for (const r of rows) {
      if (!(TAG_FIELDS as string[]).includes(r.field)) continue;
      const value = overrides.get(r.id) ?? r.new_value;
      putOverlay.run(r.track_id, r.field, value, r.old_value, r.id, now);
      try {
        mark.run(now, value, r.id);
      } catch {
        // An edited value can collide with an older decision for the same track and field; keep that one.
        db.prepare("DELETE FROM tag_suggestions WHERE id = ?").run(r.id);
      }
      drop.run(r.track_id, r.field, r.id);
      accepted++;
    }
    return accepted;
  });
}

export function rejectSuggestions(db: Db, ids: number[], now = Date.now()): number {
  if (ids.length === 0) return 0;
  const res = db
    .prepare(
      `UPDATE tag_suggestions SET status = 'rejected', decided_at = ? WHERE status = 'pending' AND id IN (${placeholders(ids.length)})`,
    )
    .run(now, ...ids);
  return Number(res.changes);
}

/** Undo an accepted suggestion: the overlay goes away and the file tag shows again. */
export function revertSuggestion(db: Db, id: number, now = Date.now()): boolean {
  return transaction(db, () => {
    const row = db.prepare("SELECT track_id, field FROM tag_suggestions WHERE id = ? AND status = 'accepted'").get(id) as
      { track_id: string; field: string } | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM tag_overlay WHERE track_id = ? AND field = ? AND suggestion_id = ?").run(row.track_id, row.field, id);
    db.prepare("UPDATE tag_suggestions SET status = 'reverted', decided_at = ? WHERE id = ?").run(now, id);
    return true;
  });
}

/** Overlays for a set of tracks, keyed by track id. */
export function overlaysFor(db: Db, ids: string[]): Map<string, Map<TagField, string>> {
  const out = new Map<string, Map<TagField, string>>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .prepare(`SELECT track_id, field, value FROM tag_overlay WHERE track_id IN (${placeholders(chunk.length)})`)
      .all(...chunk) as unknown as { track_id: string; field: TagField; value: string }[];
    for (const r of rows) {
      const m = out.get(r.track_id) ?? new Map();
      m.set(r.field, r.value);
      out.set(r.track_id, m);
    }
  }
  return out;
}
