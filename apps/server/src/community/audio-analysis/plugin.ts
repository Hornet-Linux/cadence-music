import path from "node:path";
import type { Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { analysisCounts, analysisRunner } from "../_serverlib/analysis.js";
import { decorateTracks, placeholders } from "../_serverlib/decorate.js";
import { ffmpegInfo, runFfmpeg } from "../_serverlib/ffmpeg.js";
import { analyzeSamples, compatibleCamelot, SAMPLE_RATE, type AudioFeatures } from "./dsp.js";

export interface AudioInfo {
  bpm: number | null;
  bpmConfidence: number | null;
  energy: number | null;
  /** For example "A minor". */
  key: string | null;
  /** Camelot wheel code, for example "8A". */
  camelot: string | null;
  keyConfidence: number | null;
}

interface Config {
  auto: boolean;
  pauseMs: number;
}

const DEFAULTS: Config = { auto: true, pauseMs: 2000 };
/** Analyse one minute from the middle of the song: fast, and usually more typical than the intro. */
const CLIP_SECONDS = 60;

export function ensureTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_audio (
      track_id TEXT PRIMARY KEY,
      bpm REAL,
      bpm_confidence REAL,
      energy REAL,
      key_name TEXT,
      camelot TEXT,
      key_confidence REAL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      error TEXT,
      analysed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS track_audio_bpm ON track_audio (bpm);
  `);
}

/** Decode a minute of the file to mono 22.05 kHz PCM with ffmpeg and estimate tempo, energy and key. */
export async function analyzeFile(file: string, durationSec: number | null, signal?: AbortSignal): Promise<AudioFeatures> {
  const start = durationSec && durationSec > CLIP_SECONDS + 20 ? Math.min(45, (durationSec - CLIP_SECONDS) / 2) : 0;
  const res = await runFfmpeg(
    ["-v", "error", "-threads", "1", ...(start > 0 ? ["-ss", String(start)] : []), "-i", file, "-vn", "-t", String(CLIP_SECONDS), "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { timeoutMs: 5 * 60_000, signal, stdoutLimit: SAMPLE_RATE * 2 * (CLIP_SECONDS + 5) },
  );
  if (signal?.aborted) throw new Error("stopped");
  if (res.error) throw new Error(res.error);
  if (res.stdout.length < SAMPLE_RATE * 2 * 5) throw new Error(res.stderr.trim().split("\n").pop()?.slice(0, 200) || "no audio could be decoded");
  const pcm = res.stdout;
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return analyzeSamples(samples);
}

interface Row {
  track_id: string;
  bpm: number | null;
  bpm_confidence: number | null;
  energy: number | null;
  key_name: string | null;
  camelot: string | null;
  key_confidence: number | null;
}

const toInfo = (r: Row): AudioInfo => ({
  bpm: r.bpm,
  bpmConfidence: r.bpm_confidence,
  energy: r.energy,
  key: r.key_name,
  camelot: r.camelot,
  keyConfidence: r.key_confidence,
});

export function audioFor(db: Db, ids: string[]): Map<string, AudioInfo> {
  const out = new Map<string, AudioInfo>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db
      .prepare(`SELECT * FROM track_audio WHERE error IS NULL AND track_id IN (${placeholders(chunk.length)})`)
      .all(...chunk) as unknown as Row[];
    for (const r of rows) out.set(r.track_id, toInfo(r));
  }
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Tempo, energy and key estimates (decoded and measured with ffmpeg plus a small built-in analyser),
 * stored per track in the server database. The AI DJ and smart playlists read them.
 */
export const audioAnalysisPlugin: ServerPlugin = {
  id: "cadence.audio-analysis",
  name: "Audio analysis (BPM, energy, key)",
  version: "1.0.0",
  register(app, ctx) {
    const { db, requireAdmin, requireUser, settings } = ctx;
    ensureTable(db);
    const musicRoot = path.resolve(ctx.config.musicDir);
    const config = (): Config => ({ ...DEFAULTS, ...(settings.pluginConfig<Partial<Config>>("cadence.audio-analysis") ?? {}) });
    const durations = db.prepare("SELECT duration_sec FROM tracks WHERE id = ?");
    const put = db.prepare(
      `INSERT INTO track_audio (track_id, bpm, bpm_confidence, energy, key_name, camelot, key_confidence, size, mtime_ms, error, analysed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (track_id) DO UPDATE SET bpm = excluded.bpm, bpm_confidence = excluded.bpm_confidence, energy = excluded.energy,
         key_name = excluded.key_name, camelot = excluded.camelot, key_confidence = excluded.key_confidence,
         size = excluded.size, mtime_ms = excluded.mtime_ms, error = excluded.error, analysed_at = excluded.analysed_at`,
    );

    // The duration lets the analyser skip the intro; analysisRunner passes only the path, so look it up by path.
    const byPath = new Map<string, string>();
    const runner = analysisRunner<AudioFeatures>({
      db,
      table: "track_audio",
      musicRoot,
      log: ctx.log,
      name: "audio-analysis",
      pauseMs: () => Math.min(config().pauseMs, 60_000),
      analyze: async (abs, signal) => {
        const id = byPath.get(abs);
        const d = id ? (durations.get(id) as { duration_sec: number | null } | undefined)?.duration_sec ?? null : null;
        return analyzeFile(abs, d, signal);
      },
      store: (t, f, error) =>
        put.run(t.id, f?.bpm ?? null, f?.bpmConfidence ?? null, f?.energy ?? null, f?.key ?? null, f?.camelot ?? null, f?.keyConfidence ?? null, t.size, t.mtime_ms, error, Date.now()),
    });
    // Remember which id each absolute path belongs to for the duration lookup above.
    const index = () => {
      byPath.clear();
      for (const r of db.prepare("SELECT id, rel_path FROM tracks").all() as unknown as { id: string; rel_path: string }[]) {
        byPath.set(path.resolve(musicRoot, r.rel_path), r.id);
      }
    };
    const start = () => {
      index();
      return runner.start();
    };

    ctx.jobs.every(
      "audio-analysis",
      10 * 60_000,
      async () => {
        if (!config().auto) return;
        if (!(await ffmpegInfo()).available) return;
        if (runner.pending() > 0) await start();
      },
      { runSoon: true },
    );
    app.addHook("onClose", async () => runner.stop());

    decorateTracks(app, (tracks) => {
      const found = audioFor(db, tracks.map((t) => t.id));
      for (const t of tracks) {
        const a = found.get(t.id);
        if (a) Object.assign(t, { bpm: a.bpm, energy: a.energy, key: a.key, camelot: a.camelot });
      }
    });

    app.get("/api/audio-analysis/status", { preHandler: requireUser }, async () => ({
      ffmpeg: (await ffmpegInfo()).available,
      config: config(),
      run: runner.status(),
      ...analysisCounts(db, "track_audio", runner.pending()),
    }));

    app.post("/api/audio-analysis/start", { preHandler: requireAdmin }, async (_req, reply) => {
      if (!(await ffmpegInfo()).available) return reply.code(409).send({ error: "ffmpeg_missing", message: "Audio analysis needs ffmpeg on the server." });
      start().catch((err) => ctx.log.warn({ err }, "audio analysis run failed"));
      return reply.code(202).send({ started: true });
    });

    app.post("/api/audio-analysis/stop", { preHandler: requireAdmin }, async () => {
      await runner.stop();
      return { stopped: true };
    });

    app.put<{ Body: Partial<Config> | undefined }>("/api/audio-analysis/settings", { preHandler: requireAdmin }, async (req, reply) => {
      const body = req.body ?? {};
      const next = config();
      if (body.auto !== undefined) {
        if (typeof body.auto !== "boolean") return reply.code(400).send({ error: "invalid_auto" });
        next.auto = body.auto;
      }
      if (body.pauseMs !== undefined) {
        if (!Number.isInteger(body.pauseMs) || body.pauseMs < 0 || body.pauseMs > 60_000) return reply.code(400).send({ error: "invalid_pause" });
        next.pauseMs = body.pauseMs;
      }
      settings.setPluginConfig("cadence.audio-analysis", next);
      return next;
    });

    app.get<{ Querystring: { ids?: string } }>("/api/audio-analysis", { preHandler: requireUser }, async (req) => {
      const ids = (req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
      return { items: Object.fromEntries(audioFor(db, ids)) };
    });

    // Find tracks by tempo, key or energy (what a DJ set or a smart playlist needs).
    app.get<{ Querystring: Record<string, string | undefined> }>("/api/audio-analysis/tracks", { preHandler: requireUser }, async (req) => {
      const q = req.query;
      const where = ["a.error IS NULL"];
      const args: (string | number)[] = [];
      const range = (col: string, min: number | null, max: number | null) => {
        if (min !== null) {
          where.push(`${col} >= ?`);
          args.push(min);
        }
        if (max !== null) {
          where.push(`${col} <= ?`);
          args.push(max);
        }
      };
      range("a.bpm", num(q.bpmMin), num(q.bpmMax));
      range("a.energy", num(q.energyMin), num(q.energyMax));
      const camelot = (q.camelot ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^\d{1,2}[AB]$/.test(s));
      if (camelot.length > 0) {
        where.push(`a.camelot IN (${placeholders(camelot.length)})`);
        args.push(...camelot);
      }
      const limit = Math.min(500, Math.max(1, num(q.limit) ?? 100));
      const rows = db
        .prepare(
          `SELECT t.id, t.title, t.artist, t.album, t.duration_sec, a.* FROM track_audio a JOIN tracks t ON t.id = a.track_id
            WHERE ${where.join(" AND ")} ORDER BY a.bpm LIMIT ?`,
        )
        .all(...args, limit) as unknown as (Row & { id: string; title: string; artist: string | null; album: string | null; duration_sec: number | null })[];
      return {
        items: rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, durationSec: r.duration_sec, ...toInfo(r) })),
      };
    });

    // Tracks that mix well after this one: neighbouring key on the Camelot wheel and a close tempo.
    app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/audio-analysis/compatible/:id", { preHandler: requireUser }, async (req, reply) => {
      const base = audioFor(db, [req.params.id]).get(req.params.id);
      if (!base) return reply.code(404).send({ error: "not_analysed" });
      const codes = base.camelot ? compatibleCamelot(base.camelot) : [];
      const where = ["a.error IS NULL", "a.track_id != ?"];
      const args: (string | number)[] = [req.params.id];
      if (codes.length > 0) {
        where.push(`a.camelot IN (${placeholders(codes.length)})`);
        args.push(...codes);
      }
      if (base.bpm !== null) {
        where.push("a.bpm BETWEEN ? AND ?");
        args.push(base.bpm * 0.94, base.bpm * 1.06);
      }
      const limit = Math.min(100, Math.max(1, num(req.query.limit) ?? 20));
      const rows = db
        .prepare(
          `SELECT t.id, t.title, t.artist, t.album, t.duration_sec, a.* FROM track_audio a JOIN tracks t ON t.id = a.track_id
            WHERE ${where.join(" AND ")} ORDER BY ABS(a.bpm - ?) LIMIT ?`,
        )
        .all(...args, base.bpm ?? 0, limit) as unknown as (Row & { id: string; title: string; artist: string | null; album: string | null; duration_sec: number | null })[];
      return { base, items: rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, durationSec: r.duration_sec, ...toInfo(r) })) };
    });

    app.get<{ Params: { id: string } }>("/api/audio-analysis/:id", { preHandler: requireUser }, async (req, reply) => {
      return audioFor(db, [req.params.id]).get(req.params.id) ?? reply.code(404).send({ error: "not_analysed" });
    });
  },
};

export default audioAnalysisPlugin;