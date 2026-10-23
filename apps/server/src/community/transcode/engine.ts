import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { runFfmpeg, spawnFfmpeg } from "../_serverlib/ffmpeg.js";
import type { Profile } from "./profiles.js";

/** Lets at most `limit` tasks run at once; the rest wait in order. */
export class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export interface Job {
  key: string;
  final: string;
  part: string;
  /** Resolves when the finished file is in place; rejects with a short reason if ffmpeg failed. */
  done: Promise<void>;
}

const exists = (file: string) =>
  fs.promises.stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

export function outputArgs(profile: Profile): string[] {
  return ["-vn", "-map", "0:a:0", "-map_metadata", "-1", ...profile.args];
}

/** Turns a source file into a cached transcode, one ffmpeg per file however many listeners ask. */
export class Transcoder {
  private readonly jobs = new Map<string, Job>();
  private readonly gate: Semaphore;

  constructor(
    readonly dir: string,
    maxConcurrent = 2,
    private readonly onFinished?: () => void,
  ) {
    this.gate = new Semaphore(maxConcurrent);
  }

  finalPath(key: string, profile: Profile): string {
    return path.join(this.dir, `${key}.${profile.ext}`);
  }

  /** Names of cache files that must not be evicted right now. */
  activeNames(): Set<string> {
    const names = new Set<string>();
    for (const job of this.jobs.values()) {
      names.add(path.basename(job.part));
      names.add(path.basename(job.final));
    }
    return names;
  }

  /** The cached file if it exists, otherwise the (possibly already running) job that makes it. */
  async ensure(
    key: string,
    profile: Profile,
    source: string,
  ): Promise<{ cached: true; final: string } | { cached: false; job: Job }> {
    const final = this.finalPath(key, profile);
    if (await exists(final)) return { cached: true, final };
    const running = this.jobs.get(key);
    if (running) return { cached: false, job: running };
    await fs.promises.mkdir(this.dir, { recursive: true });
    const part = `${final}.part`;
    const job: Job = { key, final, part, done: Promise.resolve() };
    job.done = this.gate
      .run(async () => {
        const res = await runFfmpeg(["-y", "-i", source, ...outputArgs(profile), part], { timeoutMs: 15 * 60_000 });
        if (res.code !== 0) {
          await fs.promises.rm(part, { force: true });
          const reason = res.timedOut
            ? "transcode timed out"
            : (res.error ?? (res.stderr.trim().split("\n").pop() || "ffmpeg failed"));
          throw new Error(reason.slice(0, 200));
        }
        await fs.promises.rename(part, final);
      })
      .finally(() => {
        this.jobs.delete(key);
        this.onFinished?.();
      });
    // A failure is reported to whoever awaits `done`; make sure an unobserved one is not fatal.
    job.done.catch(() => undefined);
    this.jobs.set(key, job);
    return { cached: false, job };
  }

  /** Stream the part file while ffmpeg is still writing it, then the rest once it is done. */
  tail(job: Job): Readable {
    let finished = false;
    let failed = false;
    job.done.then(
      () => (finished = true),
      () => {
        finished = true;
        failed = true;
      },
    );
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const source = async function* (): AsyncGenerator<Buffer> {
      let handle: fs.promises.FileHandle | null = null;
      let pos = 0;
      try {
        for (;;) {
          if (!handle) {
            // Prefer the growing part file; once renamed, the final file holds the same bytes.
            handle = await fs.promises.open(job.part, "r").catch(() => null);
            if (!handle && finished && !failed) handle = await fs.promises.open(job.final, "r").catch(() => null);
            if (!handle) {
              if (finished) throw new Error("transcode failed");
              await sleep(50);
              continue;
            }
          }
          const buf = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
          if (bytesRead > 0) {
            pos += bytesRead;
            yield buf.subarray(0, bytesRead);
          } else if (finished) {
            if (failed) throw new Error("transcode failed");
            return;
          } else {
            await sleep(50);
          }
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    };
    return Readable.from(source());
  }

  /** Transcode from `startSec` straight to the listener (not cached, so not seekable). */
  live(source: string, profile: Profile, startSec: number): Readable {
    const child = spawnFfmpeg(["-ss", String(startSec), "-i", source, ...outputArgs(profile), "pipe:1"]);
    child.stderr?.resume();
    const out = child.stdout!;
    out.on("close", () => child.kill("SIGKILL"));
    out.on("error", () => child.kill("SIGKILL"));
    return out;
  }
}
