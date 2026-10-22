import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { ServerPlugin } from "./types.js";

/**
 * Community plugins live in `src/community/<name>/plugin.ts` (compiled to `dist/community/<name>/plugin.js`)
 * and default-export a ServerPlugin (or an array). They are found automatically, so adding one never
 * touches a shared file. The admin turns each one on; changes apply after a restart.
 */
export async function loadCommunityPlugins(log: FastifyBaseLogger, dir?: string): Promise<ServerPlugin[]> {
  const root = dir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "community");
  if (!fs.existsSync(root)) return [];
  const found: ServerPlugin[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "plugin.js");
    if (!fs.existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: ServerPlugin | ServerPlugin[] };
      const exported = mod.default;
      if (!exported) continue;
      found.push(...(Array.isArray(exported) ? exported : [exported]));
    } catch (err) {
      log.error({ err, plugin: entry.name }, "could not load community plugin");
    }
  }
  return found;
}
