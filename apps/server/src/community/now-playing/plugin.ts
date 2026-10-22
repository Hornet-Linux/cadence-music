import type { FastifyReply } from "fastify";
import { randomToken, sha256 } from "../../util/crypto.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { OVERLAY_CSP, OVERLAY_HTML } from "./overlay.js";
import { NowPlayingHub, parseHeartbeat, type Snapshot } from "./nowPlaying.js";

/**
 * "Now playing" for streamers: the desktop app sends a heartbeat of what you are playing, and
 * overlay links (/overlay/<token>) show it in OBS or any browser. The current song lives in
 * memory only. Links are random secrets, stored hashed, and can be revoked at any time.
 */

const MAX_LINKS_PER_USER = 10;
const MAX_STREAMS_PER_LINK = 4;
const MAX_STREAMS_TOTAL = 200;
const TOKEN_RE = /^np_[A-Za-z0-9_-]{32}$/;
const SSE_PING_MS = 20_000;
/** The link is the secret, so these routes must not write it to the access log (info-level request lines include the URL). */
const QUIET = { logLevel: "warn" } as const;

interface TokenRow {
  id: number;
  user_id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

const sse = (snapshot: Snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`;

export const nowPlayingPlugin: ServerPlugin = {
  id: "cadence.now-playing",
  name: "Now playing overlay",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireUser } = ctx;
    const hub = new NowPlayingHub();

    db.exec(`
      CREATE TABLE IF NOT EXISTS now_playing_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS now_playing_tokens_user ON now_playing_tokens (user_id);
    `);

    ctx.jobs.every("now-playing-upkeep", 15_000, () => hub.tick(Date.now()));

    // ---- Heartbeats from the player ---------------------------------------------
    app.post("/api/now-playing", { preHandler: requireUser }, async (req, reply) => {
      const beat = parseHeartbeat(req.body, Date.now());
      if (!beat) return reply.code(400).send({ error: "invalid_request", message: "Send {state, track, positionSec, durationSec}." });
      hub.update(req.user!.id, beat);
      return reply.code(204).send();
    });

    app.get("/api/now-playing", { preHandler: requireUser }, async (req) => hub.snapshot(req.user!.id, Date.now()));

    // ---- Overlay links ------------------------------------------------------------
    const listLinks = (userId: number) =>
      (
        db
          .prepare("SELECT id, label, created_at, last_used_at FROM now_playing_tokens WHERE user_id = ? ORDER BY id")
          .all(userId) as unknown as TokenRow[]
      ).map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        viewers: hub.countFor(userId, r.id),
      }));

    app.get("/api/now-playing/tokens", { preHandler: requireUser }, async (req) => ({ tokens: listLinks(req.user!.id) }));

    app.post("/api/now-playing/tokens", { preHandler: requireUser }, async (req, reply) => {
      const userId = req.user!.id;
      const count = (db.prepare("SELECT COUNT(*) AS n FROM now_playing_tokens WHERE user_id = ?").get(userId) as { n: number }).n;
      if (count >= MAX_LINKS_PER_USER) {
        return reply.code(409).send({ error: "too_many_links", message: `You can have up to ${MAX_LINKS_PER_USER} overlay links. Revoke one first.` });
      }
      const rawLabel = (req.body as { label?: unknown } | null)?.label;
      const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim().slice(0, 60) : "Overlay";
      const token = `np_${randomToken(24)}`;
      const now = Date.now();
      const result = db
        .prepare("INSERT INTO now_playing_tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)")
        .run(userId, sha256(token), label, now);
      // The only time the link's secret is shown: only its hash is kept.
      return reply.code(201).send({ id: Number(result.lastInsertRowid), label, createdAt: now, token });
    });

    app.delete<{ Params: { id: string } }>("/api/now-playing/tokens/:id", { preHandler: requireUser }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid_request" });
      const userId = req.user!.id;
      const result = db.prepare("DELETE FROM now_playing_tokens WHERE id = ? AND user_id = ?").run(id, userId);
      if (Number(result.changes) === 0) return reply.code(404).send({ error: "not_found" });
      hub.dropToken(userId, id);
      return reply.code(204).send();
    });

    // ---- The public overlay (the secret link is the credential) ------------------
    const touch = db.prepare("UPDATE now_playing_tokens SET last_used_at = ? WHERE id = ?");
    function linkFor(token: string): { id: number; userId: number } | null {
      if (!TOKEN_RE.test(token)) return null;
      const row = db.prepare("SELECT id, user_id FROM now_playing_tokens WHERE token_hash = ?").get(sha256(token)) as
        | { id: number; user_id: number }
        | undefined;
      return row ? { id: row.id, userId: row.user_id } : null;
    }
    const overlayHeaders = (reply: FastifyReply) =>
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Robots-Tag", "noindex")
        .header("X-Content-Type-Options", "nosniff");

    app.get<{ Params: { token: string } }>("/overlay/:token", QUIET, async (req, reply) => {
      const link = linkFor(req.params.token);
      if (!link) return overlayHeaders(reply).code(404).type("text/plain").send("This overlay link is not valid.");
      touch.run(Date.now(), link.id);
      return overlayHeaders(reply)
        .header("Content-Security-Policy", OVERLAY_CSP)
        .header("X-Frame-Options", "SAMEORIGIN")
        .type("text/html; charset=utf-8")
        .send(OVERLAY_HTML);
    });

    app.get<{ Params: { token: string } }>("/overlay/:token/now", QUIET, async (req, reply) => {
      const link = linkFor(req.params.token);
      if (!link) return overlayHeaders(reply).code(404).send({ error: "not_found" });
      return overlayHeaders(reply).send(hub.snapshot(link.userId, Date.now()));
    });

    app.get<{ Params: { token: string } }>("/overlay/:token/events", QUIET, async (req, reply) => {
      const link = linkFor(req.params.token);
      if (!link) return overlayHeaders(reply).code(404).send({ error: "not_found" });
      if (hub.total() >= MAX_STREAMS_TOTAL || hub.countFor(link.userId, link.id) >= MAX_STREAMS_PER_LINK) {
        return overlayHeaders(reply).code(429).send({ error: "too_many_viewers" });
      }
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      raw.write("retry: 3000\n\n");

      let closed = false;
      const subscriber = {
        tokenId: link.id,
        send: (snapshot: Snapshot) => {
          if (!closed) raw.write(sse(snapshot));
        },
        close: () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
          raw.end();
        },
      };
      const ping = setInterval(() => {
        if (!closed) raw.write(": ping\n\n");
      }, SSE_PING_MS);
      ping.unref();
      const unsubscribe = hub.subscribe(link.userId, subscriber);
      raw.on("close", () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
      });
      subscriber.send(hub.snapshot(link.userId, Date.now()));
    });

    app.addHook("onClose", async () => {
      // Close open event streams so the server can shut down promptly.
      for (const row of db.prepare("SELECT id, user_id FROM now_playing_tokens").all() as unknown as { id: number; user_id: number }[]) {
        hub.dropToken(row.user_id, row.id);
      }
    });
  },
};

export default nowPlayingPlugin;