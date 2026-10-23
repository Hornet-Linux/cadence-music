import path from "node:path";
import type { Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { analysisCounts, analysisRunner } from "../_serverlib/analysis.js";
import { decorateTracks, placeholders } from "../_serverlib/decorate.js";
import { ffmpegInfo } from "../_serverlib/ffmpeg.js";
import { analyzeLoudness, replayGainDb, TARGET_LUFS } from "./analyze.js";

export interface LoudnessInfo {
  loudnessLufs: number | null;
  truePeakDb: number | null;
  loudnessRange: number | null;
  /** Gain in dB that brings the track to -18 LUFS without clipping (ReplayGain 2.0 style). */
  replayGainDb: number | null;
}

interface Config {
  /** Start analysing on its own (otherwise only when an admin presses Start). */
  auto: boolean;
  /** Rest between tracks, so a big library never hogs the CPU. */
  pauseMs: number;
}

const DEFAULTS: Config = { auto: true, pauseMs: 1500 };

export function ensureTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_loudness (
      track_id TEXT PRIMARY KEY,
      lufs REAL,
      lra REAL,
      true_peak_db REAL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      error TEXT,
      analysed_at INTEGER NOT NULL
    );
  `);
}

export function loudnessFor(db: Db, ids: string[]): Map<string, LoudnessInfo> {
  const out = new Map<string, LoudnessInfo>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .prepare(
        `SELECT track_id, lufs, lra, true_peak_db FROM track_loudness WHERE error IS NULL AND track_id IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk) as unknown as { track_id: string; lufs: number | null; lra: number | null; true_peak_db: number | null }[];
    for (const r of rows) {
      out.set(r.track_id, {
        loudnessLufs: r.lufs,
        truePeakDb: r.true_peak_db,
        loudnessRange: r.lra,
        replayGainDb: replayGainDb({ lufs: r.lufs, truePeakDb: r.true_peak_db }),
      });
    }
  }
  return out;
}

/** Loudness analysis (EBU R128 via ffmpeg) for every track, stored in the server database, never in the files. */
export const loudnessPlugin: ServerPlugin = {
  id: "cadence.loudness",
  name: "Loudness analysis",
  version: "1.0.0",
  description:
    "Measures the loudness (EBU R128 via ffmpeg) of every track and keeps it in the server database, never in the files. The player uses it to even out volume between songs. Needs ffmpeg.",
  configFields: [
    { key: "auto", label: "Analyse new tracks automatically", type: "boolean", default: true, help: "Otherwise analysis only runs when you press Start in the player." },
    { key: "pauseMs", label: "Rest between tracks (milliseconds)", type: "number", default: 1500, help: "A longer rest keeps a big library from hogging the CPU." },
  ],
  register(app, ctx) {
    const { db, requireAdmin, requireUser, settings } = ctx;
    ensureTable(db);
    const musicRoot = path.resolve(ctx.config.musicDir);
    const config = (): Config => ({ ...DEFAULTS, ...(settings.pluginConfig<Partial<Config>>("cadence.loudness") ?? {}) });

    const put = db.prepare(
      `INSERT INTO track_loudness (track_id, lufs, lra, true_peak_db, size, mtime_ms, error, analysed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (track_id) DO UPDATE SET lufs = excluded.lufs, lra = excluded.lra, true_peak_db = excluded.true_peak_db,
         size = excluded.size, mtime_ms = excluded.mtime_ms, error = excluded.error, analysed_at = excluded.analysed_at`,
    );
    const runner = analysisRunner({
      db,
      table: "track_loudness",
      musicRoot,
      log: ctx.log,
      name: "loudness",
      pauseMs: () => Math.min(config().pauseMs, 60_000),
      analyze: analyzeLoudness,
      store: (t, l, error) =>
        put.run(t.id, l?.lufs ?? null, l?.lra ?? null, l?.truePeakDb ?? null, t.size, t.mtime_ms, error, Date.now()),
    });
    // The job keeps going until the library is done; the next tick resumes anything added since.
    ctx.jobs.every(
      "loudness",
      5 * 60_000,
      async () => {
        if (!config().auto) return;
        if (!(await ffmpegInfo()).available) return;
        if (runner.pending() > 0) await runner.start();
      },
      { runSoon: true },
    );
    app.addHook("onClose", async () => runner.stop());

    decorateTracks(app, (tracks) => {
      const found = loudnessFor(
        db,
        tracks.map((t) => t.id),
      );
      for (const t of tracks) {
        const info = found.get(t.id);
        if (info) Object.assign(t, info);
      }
    });

    const overall = () => analysisCounts(db, "track_loudness", runner.pending());

    app.get("/api/loudness/status", { preHandler: requireUser }, async () => {
      const info = await ffmpegInfo();
      return {
        ffmpeg: info.available,
        targetLufs: TARGET_LUFS,
        config: config(),
        run: runner.status(),
        ...overall(),
      };
    });

    app.post("/api/loudness/start", { preHandler: requireAdmin }, async (_req, reply) => {
      if (!(await ffmpegInfo()).available)
        return reply.code(409).send({ error: "ffmpeg_missing", message: "Loudness analysis needs ffmpeg on the server." });
      runner.start().catch((err) => ctx.log.warn({ err }, "loudness run failed"));
      return reply.code(202).send({ started: true });
    });

    app.post("/api/loudness/stop", { preHandler: requireAdmin }, async () => {
      await runner.stop();
      return { stopped: true };
    });

    app.put<{ Body: Partial<Config> | undefined }>("/api/loudness/settings", { preHandler: requireAdmin }, async (req, reply) => {
      const body = req.body ?? {};
      const next = config();
      if (body.auto !== undefined) {
        if (typeof body.auto !== "boolean") return reply.code(400).send({ error: "invalid_auto" });
        next.auto = body.auto;
      }
      if (body.pauseMs !== undefined) {
        if (!Number.isInteger(body.pauseMs) || body.pauseMs < 0 || body.pauseMs > 60_000)
          return reply.code(400).send({ error: "invalid_pause" });
        next.pauseMs = body.pauseMs;
      }
      settings.setPluginConfig("cadence.loudness", next);
      return next;
    });

    app.get<{ Querystring: { ids?: string } }>("/api/loudness", { preHandler: requireUser }, async (req) => {
      const ids = (req.query.ids ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 500);
      return { items: Object.fromEntries(loudnessFor(db, ids)) };
    });

    app.get<{ Params: { id: string } }>("/api/loudness/:id", { preHandler: requireUser }, async (req, reply) => {
      const info = loudnessFor(db, [req.params.id]).get(req.params.id);
      return info ?? reply.code(404).send({ error: "not_analysed" });
    });
  },
};

export default loudnessPlugin;
