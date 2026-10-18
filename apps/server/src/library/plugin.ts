import fs from "node:fs";
import path from "node:path";
import type {
  LibraryStatusResponse,
  ScanResult,
  ServerTrack,
  StreamUrlResponse,
  TrackListResponse,
} from "@uma/shared";
import type { ServerPlugin } from "../plugins/types.js";
import { contentTypeFor, scanLibrary } from "./scanner.js";
import { streamPath, verifyStream } from "./streamSigning.js";

const STREAM_TTL_SEC = 6 * 60 * 60;
const MAX_PAGE = 5000;

interface TrackRow {
  id: string;
  rel_path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  duration_sec: number | null;
}

function toTrack(row: TrackRow): ServerTrack {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist,
    trackNo: row.track_no,
    durationSec: row.duration_sec,
  };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The music library: scanning MUSIC_DIR, listing tracks and streaming them. */
export const libraryPlugin: ServerPlugin = {
  id: "core.library",
  name: "Music library",
  version: "1.0.0",
  register(app, ctx) {
    const { db, config, secret, requireUser, requireAdmin } = ctx;
    const musicRoot = path.resolve(config.musicDir);
    let currentScan: Promise<ScanResult> | null = null;
    let lastScanAt: number | null = null;

    function runScan(): Promise<ScanResult> {
      if (!currentScan) {
        const started = Date.now();
        currentScan = scanLibrary(db, musicRoot)
          .then((result) => {
            lastScanAt = Date.now();
            ctx.log.info({ ...result, ms: lastScanAt - started }, "Library scan finished");
            return result;
          })
          .finally(() => {
            currentScan = null;
          });
      }
      return currentScan;
    }

    let timer: NodeJS.Timeout | null = null;
    app.addHook("onReady", async () => {
      runScan().catch((err) => ctx.log.error({ err }, "Library scan failed"));
      if (config.scanIntervalMinutes > 0) {
        timer = setInterval(
          () => runScan().catch((err) => ctx.log.error({ err }, "Library scan failed")),
          config.scanIntervalMinutes * 60_000,
        );
        timer.unref();
      }
    });
    app.addHook("onClose", async () => {
      if (timer) clearInterval(timer);
      await currentScan?.catch(() => undefined);
    });

    app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
      "/api/tracks",
      { preHandler: requireUser },
      async (req): Promise<TrackListResponse> => {
        const limit = clampInt(req.query.limit, 500, 1, MAX_PAGE);
        const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const q = req.query.q?.trim();
        const where = q ? "WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?" : "";
        const like = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
        const order =
          "ORDER BY COALESCE(album_artist, artist, '') COLLATE NOCASE, album COLLATE NOCASE, track_no, title COLLATE NOCASE";
        const rows = db
          .prepare(`SELECT * FROM tracks ${where} ${order} LIMIT ? OFFSET ?`)
          .all(...like, limit, offset) as unknown as TrackRow[];
        const total = (
          db.prepare(`SELECT COUNT(*) AS n FROM tracks ${where}`).get(...like) as { n: number }
        ).n;
        return { items: rows.map(toTrack), total };
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/tracks/:id",
      { preHandler: requireUser },
      async (req, reply) => {
        const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(req.params.id) as
          | TrackRow
          | undefined;
        if (!row) return reply.code(404).send({ error: "not_found" });
        return toTrack(row);
      },
    );

    app.get<{ Params: { id: string } }>(
      "/api/tracks/:id/stream-url",
      { preHandler: requireUser },
      async (req, reply) => {
        const exists = db.prepare("SELECT 1 FROM tracks WHERE id = ?").get(req.params.id);
        if (!exists) return reply.code(404).send({ error: "not_found" });
        const result: StreamUrlResponse = streamPath(
          secret,
          req.params.id,
          STREAM_TTL_SEC,
          Math.floor(Date.now() / 1000),
        );
        return result;
      },
    );

    app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
      "/api/stream/:id",
      async (req, reply) => {
        const { id } = req.params;
        if (!verifyStream(secret, id, req.query.exp, req.query.sig, Math.floor(Date.now() / 1000))) {
          return reply.code(403).send({ error: "invalid_signature" });
        }
        const row = db.prepare("SELECT rel_path FROM tracks WHERE id = ?").get(id) as
          | { rel_path: string }
          | undefined;
        if (!row) return reply.code(404).send({ error: "not_found" });

        const abs = path.resolve(musicRoot, row.rel_path);
        if (!abs.startsWith(musicRoot + path.sep)) return reply.code(404).send({ error: "not_found" });

        let size: number;
        try {
          size = (await fs.promises.stat(abs)).size;
        } catch {
          return reply.code(404).send({ error: "not_found" });
        }

        reply
          .header("Accept-Ranges", "bytes")
          .header("Content-Type", contentTypeFor(abs))
          .header("Cache-Control", "private, max-age=3600");

        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          let start = -1;
          let end = -1;
          if (m && (m[1] !== "" || m[2] !== "")) {
            if (m[1] === "") {
              const suffix = Number(m[2]);
              start = Math.max(0, size - suffix);
              end = size - 1;
            } else {
              start = Number(m[1]);
              end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
            }
          }
          if (start < 0 || start > end || start >= size) {
            return reply.code(416).header("Content-Range", `bytes */${size}`).send();
          }
          reply
            .code(206)
            .header("Content-Range", `bytes ${start}-${end}/${size}`)
            .header("Content-Length", end - start + 1);
          return reply.send(fs.createReadStream(abs, { start, end }));
        }

        reply.header("Content-Length", size);
        return reply.send(fs.createReadStream(abs));
      },
    );

    app.get("/api/library/status", { preHandler: requireUser }, async (): Promise<LibraryStatusResponse> => {
      const trackCount = (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
      return { scanning: currentScan !== null, lastScanAt, trackCount };
    });

    app.post<{ Querystring: { wait?: string } }>(
      "/api/library/scan",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const scan = runScan();
        if (req.query.wait === "1") return scan;
        scan.catch((err) => ctx.log.error({ err }, "Library scan failed"));
        return reply.code(202).send({ started: true });
      },
    );
  },
};
