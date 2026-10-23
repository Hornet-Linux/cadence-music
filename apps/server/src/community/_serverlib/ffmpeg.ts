import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";

/** The ffmpeg executable: FFMPEG_PATH when set, otherwise `ffmpeg` from PATH. */
export function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/** Synchronous check, handy for `{ skip: !hasFfmpeg() }` in tests. */
export function hasFfmpeg(): boolean {
  try {
    const res = spawnSync(ffmpegBinary(), ["-version"], { stdio: "ignore", timeout: 5000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

export interface FfmpegInfo {
  available: boolean;
  version: string | null;
  /** Audio encoders the transcoder can use, e.g. libopus, libmp3lame, aac. */
  encoders: string[];
}

const infoCache = new Map<string, { at: number; info: FfmpegInfo }>();

/** Whether ffmpeg runs, and which encoders it has. Cached (a missing ffmpeg is re-checked after a minute). */
export async function ffmpegInfo(force = false): Promise<FfmpegInfo> {
  const bin = ffmpegBinary();
  const cached = infoCache.get(bin);
  if (!force && cached && (cached.info.available || Date.now() - cached.at < 60_000)) return cached.info;
  let info: FfmpegInfo = { available: false, version: null, encoders: [] };
  const version = await runFfmpeg(["-version"], { timeoutMs: 5000 });
  if (version.code === 0) {
    const first = version.stdout.toString("utf8").split("\n")[0] ?? "";
    const enc = await runFfmpeg(["-encoders"], { timeoutMs: 5000 });
    const encoders = enc.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => /^\s*A\S*\s+(\S+)/.exec(line)?.[1])
      .filter((x): x is string => Boolean(x));
    info = { available: true, version: /version\s+(\S+)/.exec(first)?.[1] ?? first.trim(), encoders };
  }
  infoCache.set(bin, { at: Date.now(), info });
  return info;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Run at the lowest CPU priority so analysis never starves streaming. Default true. */
  lowPriority?: boolean;
  /** Keep at most this much stdout (extra is dropped and `truncated` set). Default 64 MB. */
  stdoutLimit?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  /** Exit code; null if ffmpeg could not start or was killed. */
  code: number | null;
  stdout: Buffer;
  /** The last part of stderr (ffmpeg writes its logs and stats there). */
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

const STDERR_KEEP = 256 * 1024;

/** Start ffmpeg with the polite defaults (no banner, low priority). The caller owns the process. */
export function spawnFfmpeg(args: string[], opts: { lowPriority?: boolean } = {}): ChildProcess {
  const child = spawn(ffmpegBinary(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  if (opts.lowPriority !== false && child.pid) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Not permitted here; run at normal priority.
    }
  }
  return child;
}

/** Run ffmpeg to completion. Never throws: failures come back as `code !== 0` or `error`. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnFfmpeg(args, { lowPriority: opts.lowPriority });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    let error: string | undefined;
    const limit = opts.stdoutLimit ?? 64 * 1024 * 1024;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout!.on("data", (b: Buffer) => {
      if (size + b.length > limit) {
        truncated = true;
        return;
      }
      size += b.length;
      chunks.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on("error", (err) => {
      error = err.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: error ? null : code,
        stdout: Buffer.concat(chunks),
        stderr: stderr.slice(-STDERR_KEEP),
        timedOut,
        truncated,
        error,
      });
    });
  });
}
