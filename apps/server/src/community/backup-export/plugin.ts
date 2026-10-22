import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PluginConfigField, ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { instrumentJobs, registerCollector } from "../_ops/registry.js";
import {
  fileStem,
  historyToCsv,
  historyToJson,
  makeZip,
  toM3U,
  toXSPF,
  type ExportPlay,
  type ExportTrack,
  type Locate,
} from "./formats.js";
import {
  createSnapshot,
  isSnapshotName,
  listSnapshots,
  pruneSnapshots,
  restoreInstructions,
  snapshotDir,
  type SnapshotInfo,
} from "./snapshot.js";

export const PLUGIN_ID = "cadence.backup-export";
const MAX_HISTORY_ROWS = 200_000;

interface BackupConfig {
  enabled: boolean;
  everyHours: number;
  keep: number;
}

const DEFAULT_CONFIG: BackupConfig = { enabled: false, everyHours: 24, keep: 7 };

const configFields: PluginConfigField[] = [
  { key: "enabled", label: "Scheduled database snapshots", type: "boolean", help: "Writes a snapshot into the data folder on a schedule." },
  { key: "everyHours", label: "Every (hours)", type: "number" },
  { key: "keep", label: "Scheduled snapshots to keep", type: "number", help: "Older scheduled snapshots are deleted. Manual snapshots are never deleted automatically." },
];

interface PlaylistRow {
  id: string;
  name: string;
  tracks: string;
  updated_at: number;
}

function parseTracks(json: string): ExportTrack[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as ExportTrack[]).map((t) => ({ ...t, artists: Array.isArray(t.artists) ? t.artists : [] })) : [];
  } catch {
    return [];
  }
}

function attachment(reply: FastifyReply, filename: string, type: string): FastifyReply {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return reply
    .header("Content-Type", type)
    .header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .header("Cache-Control", "no-store");
}

export function clampConfig(input: Partial<BackupConfig> | undefined, base: BackupConfig = DEFAULT_CONFIG): BackupConfig {
  const hours = Number(input?.everyHours ?? base.everyHours);
  const keep = Number(input?.keep ?? base.keep);
  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : base.enabled,
    everyHours: Number.isFinite(hours) ? Math.min(24 * 30, Math.max(1, Math.round(hours))) : base.everyHours,
    keep: Number.isFinite(keep) ? Math.min(60, Math.max(1, Math.round(keep))) : base.keep,
  };
}

export const backupExportPlugin: ServerPlugin = {
  id: PLUGIN_ID,
  name: "Backup and export",
  version: "1.0.0",
  description:
    "Export your playlists (M3U, XSPF, JSON) and listening history (CSV, JSON). Admins can take consistent database snapshots, schedule them with retention, and download them.",
  configFields,
  adminRoutes: [
    "GET /api/backup",
    "POST /api/backup/snapshot",
    "GET /api/backup/download/:name",
    "DELETE /api/backup/snapshots/:name",
    "PUT /api/backup/config",
  ],
  userRoutes: [
    "GET /api/export/playlists",
    "GET /api/export/playlists/:id?format=m3u|xspf|json",
    "GET /api/export/playlists.zip?format=m3u|xspf|json",
    "GET /api/export/history?format=csv|json&since=&until=",
  ],
  register(app, ctx) {
    registerBackupExport(app, ctx);
  },
};

export default backupExportPlugin;
function registerBackupExport(app: FastifyInstance, ctx: ServerPluginContext): void {
  const { db, settings, requireUser, requireAdmin, config } = ctx;
  instrumentJobs(ctx.jobs, ctx.log);
  const dir = snapshotDir(config.dataDir);

  // ---- Your own data ---------------------------------------------------------
  /** Library tracks are located by their file path in the music folder; other sources by their own id. */
  const locator = (): Locate => {
    const find = db.prepare("SELECT rel_path FROM tracks WHERE id = ?");
    return (track) => {
      if (track.id.startsWith("server:")) {
        const row = find.get(track.id.slice("server:".length)) as { rel_path: string } | undefined;
        if (row) return row.rel_path.replace(/\\/g, "/");
      }
      return track.id;
    };
  };

  const ownedPlaylists = (userId: number) =>
    db.prepare("SELECT id, name, tracks, updated_at FROM playlists WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId) as unknown as PlaylistRow[];

  const format = (value: string | undefined): "m3u" | "xspf" | "json" => (value === "xspf" || value === "json" ? value : "m3u");
  const render = (kind: "m3u" | "xspf" | "json", name: string, tracks: ExportTrack[], locate: Locate): { body: string; ext: string; type: string } => {
    if (kind === "xspf") return { body: toXSPF(name, tracks, locate), ext: "xspf", type: "application/xspf+xml; charset=utf-8" };
    if (kind === "json") {
      const body = JSON.stringify({ name, tracks: tracks.map((t) => ({ ...t, location: locate(t) })) }, null, 2);
      return { body, ext: "json", type: "application/json; charset=utf-8" };
    }
    return { body: toM3U(name, tracks, locate), ext: "m3u8", type: "audio/x-mpegurl; charset=utf-8" };
  };

  app.get("/api/export/playlists", { preHandler: requireUser }, async (req) => ({
    items: ownedPlaylists(req.user!.id).map((p) => ({ id: p.id, name: p.name, trackCount: parseTracks(p.tracks).length, updatedAt: p.updated_at })),
  }));

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/export/playlists/:id", { preHandler: requireUser }, async (req, reply) => {
    const row = ownedPlaylists(req.user!.id).find((p) => p.id === req.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const out = render(format(req.query.format), row.name, parseTracks(row.tracks), locator());
    return attachment(reply, `${fileStem(row.name)}.${out.ext}`, out.type).send(out.body);
  });

  app.get<{ Querystring: { format?: string } }>("/api/export/playlists.zip", { preHandler: requireUser }, async (req, reply) => {
    const locate = locator();
    const kind = format(req.query.format);
    const used = new Set<string>();
    const entries = ownedPlaylists(req.user!.id).map((p) => {
      const out = render(kind, p.name, parseTracks(p.tracks), locate);
      let stem = fileStem(p.name);
      for (let i = 2; used.has(stem.toLowerCase()); i++) stem = `${fileStem(p.name)} (${i})`;
      used.add(stem.toLowerCase());
      return { name: `${stem}.${out.ext}`, data: Buffer.from(out.body, "utf8") };
    });
    return attachment(reply, "cadence-playlists.zip", "application/zip").send(makeZip(entries));
  });

  app.get<{ Querystring: { format?: string; since?: string; until?: string } }>("/api/export/history", { preHandler: requireUser }, async (req, reply) => {
    const since = Number(req.query.since) || 0;
    const until = Number(req.query.until) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT track_id, source, title, artists, album, duration_sec, played_at FROM plays
          WHERE user_id = ? AND played_at >= ? AND played_at <= ? ORDER BY played_at DESC LIMIT ?`,
      )
      .all(req.user!.id, since, until, MAX_HISTORY_ROWS) as unknown as {
      track_id: string;
      source: string | null;
      title: string;
      artists: string;
      album: string | null;
      duration_sec: number | null;
      played_at: number;
    }[];
    const plays: ExportPlay[] = rows.map((r) => {
      let artists: { name: string }[] = [];
      try {
        artists = (JSON.parse(r.artists) as { name: string }[]).map((a) => ({ name: String(a.name ?? "") }));
      } catch {
        // keep the play, without artists
      }
      return {
        playedAt: r.played_at,
        track: { id: r.track_id, title: r.title, artists, album: r.album ?? undefined, durationSec: r.duration_sec ?? undefined, source: r.source ?? undefined },
      };
    });
    if (req.query.format === "json") return attachment(reply, "cadence-history.json", "application/json; charset=utf-8").send(historyToJson(plays));
    return attachment(reply, "cadence-history.csv", "text/csv; charset=utf-8").send(historyToCsv(plays));
  });
  // ---- Database snapshots (admin) --------------------------------------------
  const readConfig = (): BackupConfig => clampConfig(settings.pluginConfig<Partial<BackupConfig>>(PLUGIN_ID));
  let lastError: string | null = null;
  let lastRunAt: number | null = null;

  function snapshotNow(kind: "manual" | "auto") {
    try {
      const made = createSnapshot(db, dir, kind);
      lastRunAt = made.createdAt;
      lastError = null;
      if (kind === "auto") pruneSnapshots(dir, readConfig().keep);
      return made;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // Check every 10 minutes whether a scheduled snapshot is due (so a restart never skips or doubles one).
  ctx.jobs.every(
    "backup-snapshot",
    10 * 60_000,
    () => {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      const newest = listSnapshots(dir).find((s) => s.kind === "auto");
      if (newest && Date.now() - newest.createdAt < cfg.everyHours * 3_600_000) return;
      snapshotNow("auto");
    },
    { runSoon: true },
  );

  registerCollector(PLUGIN_ID, () => {
    const list = listSnapshots(dir);
    return [
      { name: "cadence_backup_snapshots", help: "Database snapshots in the data folder.", type: "gauge" as const, value: list.length },
      { name: "cadence_backup_last_snapshot_timestamp_seconds", help: "When the newest snapshot was written.", type: "gauge" as const, value: list.length ? Math.floor(list[0].createdAt / 1000) : 0 },
      { name: "cadence_backup_last_failed", help: "1 if the last snapshot attempt failed.", type: "gauge" as const, value: lastError ? 1 : 0 },
    ];
  });

  const describe = (s: SnapshotInfo) => ({ name: s.name, kind: s.kind, size: s.size, createdAt: s.createdAt });

  app.get("/api/backup", { preHandler: requireAdmin }, async () => {
    const dbFile = path.join(config.dataDir, "music.db");
    let dbSize = 0;
    try {
      dbSize = fs.statSync(dbFile).size;
    } catch {
      // in-memory database or not created yet
    }
    return {
      config: readConfig(),
      snapshots: listSnapshots(dir).map(describe),
      folder: dir,
      databaseSize: dbSize,
      lastError,
      lastRunAt,
      restore: restoreInstructions(config.dataDir),
    };
  });

  app.put<{ Body: Partial<BackupConfig> }>("/api/backup/config", { preHandler: requireAdmin }, async (req) => {
    const next = clampConfig(req.body ?? {}, readConfig());
    settings.setPluginConfig(PLUGIN_ID, next);
    return { config: next };
  });

  app.post("/api/backup/snapshot", { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const made = snapshotNow("manual");
      req.log.info({ admin: req.user!.username, snapshot: made.name }, "admin took a database snapshot");
      return reply.code(201).send({ snapshot: describe(made), check: made.check });
    } catch (err) {
      req.log.error({ err }, "snapshot failed");
      return reply.code(500).send({ error: "snapshot_failed", message: err instanceof Error ? err.message : "The snapshot could not be written." });
    }
  });

  app.get<{ Params: { name: string } }>("/api/backup/download/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!isSnapshotName(req.params.name)) return reply.code(404).send({ error: "not_found" });
    const file = path.join(dir, req.params.name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    req.log.info({ admin: req.user!.username, snapshot: req.params.name }, "admin downloaded a database snapshot");
    return attachment(reply, req.params.name, "application/vnd.sqlite3").header("Content-Length", size).send(fs.createReadStream(file));
  });

  app.delete<{ Params: { name: string } }>("/api/backup/snapshots/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!isSnapshotName(req.params.name)) return reply.code(404).send({ error: "not_found" });
    const file = path.join(dir, req.params.name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not_found" });
    fs.rmSync(file, { force: true });
    return reply.code(204).send();
  });
}