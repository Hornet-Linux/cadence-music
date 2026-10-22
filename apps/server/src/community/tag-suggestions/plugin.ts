import type { ServerPlugin } from "../../plugins/types.js";
import { decorateTracks } from "../_serverlib/decorate.js";
import {
  acceptSuggestions,
  counts,
  ensureTables,
  generateSuggestions,
  getSuggestion,
  listSuggestions,
  overlaysFor,
  rejectSuggestions,
  revertSuggestion,
  validValue,
} from "./store.js";

const clampInt = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Non-destructive auto-tagger. It proposes fixes; when an admin accepts one, the new value is
 * stored in the server database as an overlay that `/api/tracks` serves instead of the file tag.
 * The audio files (often a read-only mount) are never modified.
 */
export const tagSuggestionsPlugin: ServerPlugin = {
  id: "cadence.tag-suggestions",
  name: "Tag suggestions",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireAdmin } = ctx;
    ensureTables(db);

    decorateTracks(app, (tracks) => {
      const overlays = overlaysFor(db, tracks.map((t) => t.id));
      for (const t of tracks) {
        const o = overlays.get(t.id);
        if (!o) continue;
        for (const [field, value] of o) t[field] = field === "trackNo" ? Number(value) : value;
        t.tagOverrides = [...o.keys()];
      }
    });

    // Refresh the proposals after each library scan has had time to settle.
    ctx.jobs.every("tag-suggestions", 6 * 60 * 60_000, () => void generateSuggestions(db), { runSoon: true });

    app.get<{ Querystring: { status?: string; rule?: string; limit?: string; offset?: string } }>(
      "/api/tag-suggestions",
      { preHandler: requireAdmin },
      async (req) => ({
        ...listSuggestions(db, {
          status: req.query.status ?? "pending",
          rule: req.query.rule,
          limit: clampInt(req.query.limit, 100, 1, 500),
          offset: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        }),
        ...counts(db),
      }),
    );

    app.post("/api/tag-suggestions/scan", { preHandler: requireAdmin }, async () => generateSuggestions(db));

    app.post<{ Params: { id: string }; Body: { value?: string } | undefined }>(
      "/api/tag-suggestions/:id/accept",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const id = Number(req.params.id);
        const s = Number.isInteger(id) ? getSuggestion(db, id) : null;
        if (!s || s.status !== "pending") return reply.code(404).send({ error: "not_found" });
        const edited = req.body?.value;
        const value = edited === undefined ? s.newValue : validValue(s.field, edited);
        if (value === null) return reply.code(400).send({ error: "invalid_value" });
        acceptSuggestions(db, [id], new Map([[id, value]]));
        return { accepted: 1 };
      },
    );

    app.post<{ Params: { id: string } }>("/api/tag-suggestions/:id/reject", { preHandler: requireAdmin }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || rejectSuggestions(db, [id]) === 0) return reply.code(404).send({ error: "not_found" });
      return { rejected: 1 };
    });

    app.post<{ Params: { id: string } }>("/api/tag-suggestions/:id/revert", { preHandler: requireAdmin }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !revertSuggestion(db, id)) return reply.code(404).send({ error: "not_found" });
      return { reverted: 1 };
    });

    // Bulk: accept or reject a list of ids, or every pending suggestion of one rule.
    for (const action of ["accept", "reject"] as const) {
      app.post<{ Body: { ids?: number[]; rule?: string; all?: boolean } | undefined }>(
        `/api/tag-suggestions/${action}`,
        { preHandler: requireAdmin },
        async (req, reply) => {
          const body = req.body ?? {};
          let ids: number[];
          if (Array.isArray(body.ids)) ids = body.ids.filter((n) => Number.isInteger(n)).slice(0, 5000);
          else if (typeof body.rule === "string" || body.all === true) {
            ids = listSuggestions(db, { status: "pending", rule: body.rule, limit: 5000, offset: 0 }).items.map((s) => s.id);
          } else return reply.code(400).send({ error: "nothing_selected" });
          return action === "accept" ? { accepted: acceptSuggestions(db, ids) } : { rejected: rejectSuggestions(db, ids) };
        },
      );
    }
  },
};

export default tagSuggestionsPlugin;