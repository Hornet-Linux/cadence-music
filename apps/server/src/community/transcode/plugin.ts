import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import { verifyStream } from "../../library/streamSigning.js";
import { sha256 } from "../../util/crypto.js";
import { ffmpegInfo } from "../_serverlib/ffmpeg.js";
import { resolveInside } from "../_serverlib/facts.js";
import { cacheKey, cacheUsage, evictCache, touch } from "./cache.js";
import { Transcoder } from "./engine.js";
import { alreadySmall, PROFILES, profileById, type Profile } from "./profiles.js";

interface Config {
  /** Cache size cap in megabytes. */
  maxCacheMb: number;
  /** Profile used for devices that did not pick one; null streams the original file. */
  defaultProfile: string | null;
  /** Songs longer than this start playing while they are still being converted (seeking works once done). */
  liveStartAfterSec: number;
}

const DEFAULTS: Config = { maxCacheMb: 1024, defaultProfile: null, liveStartAfterSec: 20 * 60 };

function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

/** Send a finished file with exact Range support. */
async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  mime: string,
  extra: Record<string, string> = {},
) {
  const size = (await fs.promises.stat(file)).size;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", mime).header("Cache-Control", "private, max-age=3600");
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range === "invalid") return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  if (range) {
    reply
      .code(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
      .header("Content-Length", range.end - range.start + 1);
    return reply.send(fs.createReadStream(file, { start: range.start, end: range.end }));
  }
  reply.header("Content-Length", size);
  return reply.send(fs.createReadStream(file));
}

function ensureTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcode_device_prefs (
      session_hash TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * On-the-fly transcoding for streaming. `GET /api/stream/:id?profile=opus-96` (the usual signed
 * stream URL plus a profile) returns a cached, re-encoded copy with full Range support; without
 * ffmpeg, or when the file is already small enough, the original file is streamed instead.
 */
export const transcodePlugin: ServerPlugin = {
  id: "cadence.transcode",
  name: "Streaming transcode",
  version: "1.0.0",
  register(app, ctx) {
    const { db, secret, requireAdmin, requireUser, settings } = ctx;
    ensureTables(db);
    const musicRoot = path.resolve(ctx.config.musicDir);
    const cacheDir = path.join(path.resolve(ctx.config.dataDir), "transcode-cache");
    const config = (): Config => ({ ...DEFAULTS, ...(settings.pluginConfig<Partial<Config>>("cadence.transcode") ?? {}) });
    const maxBytes = () => Math.max(50, config().maxCacheMb) * 1024 * 1024;

    let evicting = false;
    const evict = async () => {
      if (evicting) return;
      evicting = true;
      try {
        await evictCache(cacheDir, maxBytes(), transcoder.activeNames());
      } finally {
        evicting = false;
      }
    };
    const transcoder = new Transcoder(cacheDir, 2, () => void evict());
    ctx.jobs.every("transcode-cache", 60 * 60_000, evict, { runSoon: true });

    const track = db.prepare("SELECT rel_path, size, mtime_ms, duration_sec FROM tracks WHERE id = ?");

    /** Does this install's ffmpeg have the encoder? */
    const usable = async (p: Profile) => {
      const info = await ffmpegInfo();
      return info.available && info.encoders.includes(p.encoder);
    };

    app.addHook("onRequest", async (req, reply) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || req.routeOptions?.url !== "/api/stream/:id") return;
      const query = req.query as { profile?: string; exp?: string; sig?: string; start?: string };
      if (!query.profile || query.profile === "original") return;
      const { id } = req.params as { id: string };
      if (!verifyStream(secret, id, query.exp, query.sig, Math.floor(Date.now() / 1000))) {
        return reply.code(403).send({ error: "invalid_signature" });
      }
      const profile = profileById(query.profile);
      if (!profile) return reply.code(400).send({ error: "unknown_profile" });

      // From here on, anything that stops us transcoding falls through to the original file.
      if (!(await usable(profile))) {
        reply.header("X-Transcode-Fallback", "ffmpeg-missing");
        return;
      }
      const row = track.get(id) as { rel_path: string; size: number; mtime_ms: number; duration_sec: number | null } | undefined;
      if (!row) return; // the library answers 404
      const source = resolveInside(musicRoot, row.rel_path);
      if (!source) return;
      if (alreadySmall(path.extname(source), row.size, row.duration_sec, profile)) {
        reply.header("X-Transcode-Fallback", "already-small");
        return;
      }

      const startSec = Number(query.start);
      if (Number.isFinite(startSec) && startSec > 0) {
        // A time offset: cut with ffmpeg -ss. Not cached and not byte-seekable.
        reply
          .header("Content-Type", profile.mime)
          .header("Accept-Ranges", "none")
          .header("X-Transcode-Profile", profile.id)
          .header("Cache-Control", "no-store");
        return reply.send(transcoder.live(source, profile, Math.min(startSec, 24 * 3600)));
      }

      const key = cacheKey(id, row.size, row.mtime_ms, profile.id);
      let ready: Awaited<ReturnType<Transcoder["ensure"]>>;
      try {
        ready = await transcoder.ensure(key, profile, source);
      } catch (err) {
        req.log.warn({ err }, "transcode could not start");
        return;
      }
      const headers = { "X-Transcode-Profile": profile.id };
      if (ready.cached) {
        void touch(ready.final);
        return sendFile(req, reply, ready.final, profile.mime, { ...headers, "X-Transcode-Cache": "hit" });
      }

      const wantsLaterPart = req.headers.range ? !/^bytes=0-/.test(req.headers.range.trim()) : false;
      if (!wantsLaterPart && (row.duration_sec ?? 0) > config().liveStartAfterSec) {
        // Long mix: start playing now. The size is not known yet, so no Content-Length or Range.
        reply.header("Content-Type", profile.mime).header("Accept-Ranges", "none").header("X-Transcode-Cache", "live");
        reply.header("X-Transcode-Profile", profile.id).header("Cache-Control", "no-store");
        return reply.send(transcoder.tail(ready.job));
      }
      try {
        await ready.job.done;
      } catch (err) {
        req.log.warn({ err }, "transcode failed; streaming the original");
        reply.header("X-Transcode-Fallback", "transcode-failed");
        return;
      }
      return sendFile(req, reply, ready.job.final, profile.mime, { ...headers, "X-Transcode-Cache": "miss" });
    });

    // Add the device's chosen profile to signed stream URLs, so existing players pick it up unchanged.
    const deviceHash = (req: FastifyRequest) => {
      const header = req.headers.authorization ?? "";
      return header.startsWith("Bearer ") ? sha256(header.slice(7).trim()) : null;
    };
    const devicePref = (req: FastifyRequest): string | null => {
      const hash = deviceHash(req);
      if (!hash) return null;
      const row = db.prepare("SELECT profile FROM transcode_device_prefs WHERE session_hash = ?").get(hash) as
        { profile: string } | undefined;
      return row?.profile ?? null;
    };
    app.addHook("preSerialization", async (req, _reply, payload) => {
      if (req.routeOptions?.url !== "/api/tracks/:id/stream-url") return payload;
      const body = payload as { path?: unknown } | null;
      if (!body || typeof body.path !== "string") return payload;
      const explicit = (req.query as { profile?: string }).profile;
      const wanted = explicit ?? devicePref(req) ?? config().defaultProfile;
      if (wanted && wanted !== "original" && profileById(wanted)) body.path += `&profile=${wanted}`;
      return payload;
    });

    app.get("/api/transcode/status", { preHandler: requireUser }, async (req) => {
      const info = await ffmpegInfo();
      const usage = await cacheUsage(cacheDir);
      const cfg = config();
      return {
        ffmpeg: { available: info.available, version: info.version },
        profiles: PROFILES.map((p) => ({
          id: p.id,
          label: p.label,
          kbps: p.kbps,
          available: info.available && info.encoders.includes(p.encoder),
        })),
        defaultProfile: cfg.defaultProfile,
        devicePreference: devicePref(req),
        cache: { ...usage, maxBytes: maxBytes() },
      };
    });

    app.put<{ Body: { profile?: string | null } | undefined }>(
      "/api/transcode/preference",
      { preHandler: requireUser },
      async (req, reply) => {
        const profile = req.body?.profile;
        const hash = deviceHash(req);
        if (!hash) return reply.code(400).send({ error: "no_session" });
        // null: follow the server default again. "original": this device always wants the untouched file.
        if (profile === null) {
          db.prepare("DELETE FROM transcode_device_prefs WHERE session_hash = ?").run(hash);
          return { profile: null };
        }
        if (typeof profile !== "string" || (profile !== "original" && !profileById(profile)))
          return reply.code(400).send({ error: "unknown_profile" });
        db.prepare(
          `INSERT INTO transcode_device_prefs (session_hash, profile, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (session_hash) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
        ).run(hash, profile, Date.now());
        // Preferences of signed-out devices are of no use any more.
        db.exec("DELETE FROM transcode_device_prefs WHERE session_hash NOT IN (SELECT token_hash FROM sessions)");
        return { profile };
      },
    );

    app.put<{ Body: Partial<Config> | undefined }>(
      "/api/transcode/settings",
      { preHandler: requireAdmin },
      async (req, reply) => {
        const body = req.body ?? {};
        const next = config();
        if (body.maxCacheMb !== undefined) {
          if (!Number.isInteger(body.maxCacheMb) || body.maxCacheMb < 50 || body.maxCacheMb > 1_000_000)
            return reply.code(400).send({ error: "invalid_cache_size" });
          next.maxCacheMb = body.maxCacheMb;
        }
        if (body.liveStartAfterSec !== undefined) {
          if (!Number.isInteger(body.liveStartAfterSec) || body.liveStartAfterSec < 1 || body.liveStartAfterSec > 86_400)
            return reply.code(400).send({ error: "invalid_live_start" });
          next.liveStartAfterSec = body.liveStartAfterSec;
        }
        if (body.defaultProfile !== undefined) {
          if (body.defaultProfile !== null && !profileById(body.defaultProfile))
            return reply.code(400).send({ error: "unknown_profile" });
          next.defaultProfile = body.defaultProfile;
        }
        settings.setPluginConfig("cadence.transcode", next);
        void evict();
        return next;
      },
    );

    app.delete("/api/transcode/cache", { preHandler: requireAdmin }, async () => {
      const result = await evictCache(cacheDir, 0, transcoder.activeNames());
      return result;
    });

    app.get("/api/transcode/settings", { preHandler: requireAdmin }, async () => config());
  },
};

export default transcodePlugin;
