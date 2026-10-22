import type { Db } from "../../db.js";

/**
 * Per-person settings (sign-ins with a music server) live in the settings table
 * under `plugin:<id>:user:<userId>`. They are not deleted with the person, so
 * this removes the rows whose person no longer exists. Returns how many went.
 */
export function pruneOrphanedUserConfig(db: Db, pluginId: string): number {
  const prefix = `plugin:${pluginId}:user:`;
  const rows = db.prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'").all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as { key: string }[];
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ?");
  const drop = db.prepare("DELETE FROM settings WHERE key = ?");
  let removed = 0;
  for (const { key } of rows) {
    const id = Number(key.slice(prefix.length));
    if (Number.isInteger(id) && !exists.get(id)) {
      drop.run(key);
      removed++;
    }
  }
  return removed;
}