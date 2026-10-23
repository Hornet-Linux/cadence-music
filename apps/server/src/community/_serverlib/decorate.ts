import type { FastifyInstance } from "fastify";

export type TrackRecord = Record<string, unknown> & { id: string };

/**
 * Add fields to the library's track responses (`GET /api/tracks` and `GET /api/tracks/:id`)
 * without editing the library plugin. Decorators run on the fresh response objects, so they
 * never affect the database.
 */
export function decorateTracks(app: FastifyInstance, decorate: (tracks: TrackRecord[]) => void): void {
  app.addHook("preSerialization", async (req, _reply, payload) => {
    const route = req.routeOptions?.url;
    if (route === "/api/tracks") {
      const items = (payload as { items?: unknown } | null)?.items;
      if (Array.isArray(items)) decorate(items as TrackRecord[]);
    } else if (route === "/api/tracks/:id") {
      const one = payload as { id?: unknown } | null;
      if (one && typeof one.id === "string") decorate([one as TrackRecord]);
    }
    return payload;
  });
}

/** SQL `IN (?, ?, ...)` placeholders. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** Does a table exist? (Other plugins' tables only exist once their plugin has run.) */
export function tableExists(db: { prepare: (sql: string) => { get: (...a: string[]) => unknown } }, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
