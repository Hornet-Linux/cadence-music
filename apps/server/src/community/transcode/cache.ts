import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function cacheKey(trackId: string, size: number, mtimeMs: number, profileId: string): string {
  return createHash("sha1").update(`${trackId}|${size}|${mtimeMs}|${profileId}`).digest("hex");
}

export interface EvictResult {
  removed: number;
  freedBytes: number;
  remainingBytes: number;
  remainingFiles: number;
}

/**
 * Keep the cache folder under `maxBytes` by deleting the least recently used files first
 * (hits touch a file's modified time). Files being written (`.part`) are kept unless they are
 * stale leftovers from a crash, and `protect` names files that are in use right now.
 */
export async function evictCache(
  dir: string,
  maxBytes: number,
  protect: Set<string> = new Set(),
  now = Date.now(),
): Promise<EvictResult> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return { removed: 0, freedBytes: 0, remainingBytes: 0, remainingFiles: 0 };
  }
  const files: { name: string; size: number; mtimeMs: number }[] = [];
  let removed = 0;
  let freed = 0;
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (!stat.isFile()) continue;
      if (name.endsWith(".part")) {
        // A crashed or killed job leaves a partial file behind.
        if (!protect.has(name) && now - stat.mtimeMs > 60 * 60_000) {
          await fs.promises.rm(path.join(dir, name), { force: true });
          removed++;
          freed += stat.size;
        }
        continue;
      }
      files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished meanwhile.
    }
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const kept: typeof files = [];
  for (const f of files) {
    if (total > maxBytes && !protect.has(f.name)) {
      try {
        await fs.promises.rm(path.join(dir, f.name), { force: true });
        total -= f.size;
        freed += f.size;
        removed++;
        continue;
      } catch {
        // Could not delete; count it as still there.
      }
    }
    kept.push(f);
  }
  return { removed, freedBytes: freed, remainingBytes: total, remainingFiles: kept.length };
}

export async function cacheUsage(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (name.endsWith(".part")) continue;
      try {
        const stat = await fs.promises.stat(path.join(dir, name));
        if (stat.isFile()) {
          files++;
          bytes += stat.size;
        }
      } catch {
        // Gone.
      }
    }
  } catch {
    // No cache folder yet.
  }
  return { files, bytes };
}

/** Mark a cache file as recently used. */
export async function touch(file: string): Promise<void> {
  const now = new Date();
  await fs.promises.utimes(file, now, now).catch(() => undefined);
}
