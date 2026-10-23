import { SourceNetError } from "./net.js";
import { HEAD_BYTES, readTags } from "./tags.js";
import { trackIdFor, type CachedTrack, type IndexRun, type SourceStore } from "./store.js";

/** A failed call to a remote service. `code` is safe to show; the message is for logs. */
export class RemoteError extends Error {
  constructor(
    readonly code: "auth_failed" | "not_found" | "bad_response" | "upstream" | "needs_reconnect" | "not_configured",
    message?: string,
    readonly status?: number,
  ) {
    super(message ?? code);
    this.name = "RemoteError";
  }
}

/** One audio file on the remote side. */
export interface RemoteFile {
  /** What the driver needs to open it again (WebDAV path, S3 key, Drive file id). */
  path: string;
  /** A readable path for search and display. */
  location?: string;
  size: number;
  /** Modification time in epoch milliseconds, 0 when unknown. */
  mtimeMs: number;
  etag?: string;
}

export interface IndexDriver {
  /** Every audio file under the chosen folders. Must throw if the listing could not be completed. */
  list(signal: AbortSignal): AsyncIterable<RemoteFile>;
  /** The first `bytes` bytes of a file. Throws on network trouble (the file is retried next run). */
  readHead(file: RemoteFile, bytes: number, signal: AbortSignal): Promise<Buffer>;
}

export interface IndexOptions {
  /** Files whose tags are read at the same time. */
  concurrency?: number;
  /** Rows are saved (and progress published) after this many files, so an interrupted run keeps its work. */
  batchSize?: number;
  headBytes?: number;
  signal?: AbortSignal;
}

function unchanged(prev: { size: number; mtimeMs: number; etag: string | null }, f: RemoteFile): boolean {
  if (prev.size !== f.size) return false;
  if (prev.mtimeMs && f.mtimeMs && prev.mtimeMs !== f.mtimeMs) return false;
  if (prev.etag && f.etag && prev.etag !== f.etag) return false;
  return true;
}

export function describeFailure(e: unknown): string {
  if (e instanceof RemoteError) return e.code;
  if (e instanceof SourceNetError) return e.kind;
  return "failed";
}

/**
 * Brings one person's cache in line with the remote side.
 *  1. List everything. If the listing fails, stop: nothing is removed (an outage must not empty a library).
 *  2. Read tags only for new or changed files, saving every batch. Stopping midway loses nothing: the next
 *     run sees the saved files as unchanged and carries on with the rest (this is the resume).
 *  3. Only after a complete listing, drop cached files that are no longer there (this is the removal).
 */
export async function runIndex(store: SourceStore, userId: number, driver: IndexDriver, opts: IndexOptions = {}): Promise<IndexRun> {
  const batchSize = opts.batchSize ?? 25;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const headBytes = opts.headBytes ?? HEAD_BYTES;
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  const run: IndexRun = { status: "running", startedAt: Date.now(), finishedAt: null, found: 0, indexed: 0, removed: 0, failed: 0, error: null };
  store.saveRun(userId, run);
  const finish = (status: IndexRun["status"], error: string | null = null): IndexRun => {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    store.saveRun(userId, run);
    return run;
  };

  const known = store.known(userId);
  const seen = new Set<string>();
  const todo: { id: string; file: RemoteFile }[] = [];
  try {
    for await (const file of driver.list(ac.signal)) {
      const id = trackIdFor(store.source, userId, file.path);
      if (seen.has(id)) continue;
      seen.add(id);
      const prev = known.get(id);
      if (!prev || !unchanged(prev, file)) todo.push({ id, file });
      run.found = seen.size;
    }
  } catch (e) {
    return finish(ac.signal.aborted ? "interrupted" : "failed", ac.signal.aborted ? null : describeFailure(e));
  }
  if (ac.signal.aborted) return finish("interrupted");
  store.saveRun(userId, run);

  let next = 0;
  let pending: CachedTrack[] = [];
  const flush = () => {
    store.upsert(userId, pending);
    run.indexed += pending.length;
    pending = [];
    store.saveRun(userId, run);
  };
  const worker = async () => {
    while (!ac.signal.aborted) {
      const item = todo[next++];
      if (!item) return;
      const { id, file } = item;
      try {
        const head = await driver.readHead(file, headBytes, ac.signal);
        const tags = await readTags(head, file.location ?? file.path, file.size);
        pending.push({
          id,
          path: file.path,
          location: file.location ?? null,
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          albumArtist: tags.albumArtist,
          trackNo: tags.trackNo,
          durationSec: tags.durationSec,
          size: file.size,
          mtimeMs: file.mtimeMs,
          etag: file.etag ?? null,
          fromTags: tags.fromTags,
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        // A file that can't be read right now is left out and tried again next run. A file the remote
        // side says is gone is just skipped. Either way the rest of the library still gets indexed.
        if (e instanceof RemoteError && e.code === "not_found") seen.delete(id);
        else run.failed++;
        // A file that was already cached keeps its old row; one never indexed is simply absent for now.
      }
      if (pending.length >= batchSize) flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  if (pending.length) flush();
  if (ac.signal.aborted) return finish("interrupted");

  const gone = [...known.keys()].filter((id) => !seen.has(id));
  store.remove(userId, gone);
  run.removed = gone.length;
  return finish("done");
}
