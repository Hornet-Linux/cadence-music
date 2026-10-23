import type { FastifyRequest } from "fastify";
import type { Db } from "../db.js";

/** What an admin did, kept so the owner can see who changed what and when. Never holds passwords or keys. */
export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** Entries kept; older ones are dropped as new ones arrive. */
const KEEP = 5000;

export function recordAudit(
  db: Db,
  actor: { id: number; username: string },
  action: string,
  target?: string | null,
  detail?: string | null,
  now = Date.now(),
): void {
  db.prepare("INSERT INTO admin_audit (at, actor_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    now,
    actor.id,
    actor.username,
    action,
    target ?? null,
    detail ? detail.slice(0, 300) : null,
  );
  db.prepare("DELETE FROM admin_audit WHERE id <= (SELECT MAX(id) FROM admin_audit) - ?").run(KEEP);
}

/**
 * Something that happened without an admin doing it, such as a sign-in
 * lockout, for the same activity log. Never holds passwords.
 */
export function recordSecurityEvent(db: Db, action: string, target: string, detail: string, now = Date.now()): void {
  try {
    db.prepare("INSERT INTO admin_audit (at, actor_id, actor, action, target, detail) VALUES (?, NULL, ?, ?, ?, ?)").run(
      now,
      "(sign-in)",
      action,
      target.slice(0, 120),
      detail.slice(0, 300),
    );
    db.prepare("DELETE FROM admin_audit WHERE id <= (SELECT MAX(id) FROM admin_audit) - ?").run(KEEP);
  } catch {
    // The activity log is best effort; sign-in must keep working without it.
  }
}

export function listAudit(db: Db, limit: number, before?: number): { items: AuditEntry[]; next: number | null } {
  const rows = db
    .prepare(
      `SELECT id, at, actor, action, target, detail FROM admin_audit
        WHERE id < ? ORDER BY id DESC LIMIT ?`,
    )
    .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as AuditEntry[];
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
}

/** Handlers set this to describe what happened; otherwise the audit hook logs the route. */
export interface AuditNote {
  action: string;
  target?: string | null;
  detail?: string | null;
}
const notes = new WeakMap<FastifyRequest, AuditNote>();
export const noteAudit = (req: FastifyRequest, note: AuditNote): void => void notes.set(req, note);
export const takeAuditNote = (req: FastifyRequest): AuditNote | undefined => notes.get(req);

/** Routes outside /api/admin that are still admin actions. */
const EXTRA_ADMIN_ROUTES = new Set(["POST /api/library/scan"]);

const KNOWN: Record<string, string> = {
  "PUT /api/admin/signup": "signup.update",
  "PUT /api/admin/jellyfin": "jellyfin.update",
  "POST /api/admin/llm/providers": "ai.provider.add",
  "PUT /api/admin/llm/providers/:id": "ai.provider.update",
  "DELETE /api/admin/llm/providers/:id": "ai.provider.remove",
  "POST /api/library/scan": "library.scan",
};

/**
 * The audit action for a request that is not handled by a route with its own note, or null if it is not an admin write.
 * `adminRoutes` holds "METHOD /url" for every route guarded by requireAdmin (plugins add their own, e.g. webhooks and backups).
 */
export function genericAuditAction(method: string, routeUrl: string, status: number, adminRoutes: ReadonlySet<string> = new Set()): string | null {
  if (status >= 400) return null;
  const key = `${method} ${routeUrl}`;
  const isAdmin = routeUrl.startsWith("/api/admin/") || EXTRA_ADMIN_ROUTES.has(key) || adminRoutes.has(key);
  if (!isAdmin || method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  // "Test connection" and "check for updates" change nothing.
  if (routeUrl.endsWith("/test") || routeUrl.endsWith("/update-check")) return null;
  return KNOWN[key] ?? `${method.toLowerCase()} ${routeUrl.replace(/^\/api\//, "")}`;
}
