import type { FastifyBaseLogger } from "fastify";
import { describeFetchError, endpoint } from "./core/http.js";
import type { FetchFn } from "./core/index.js";
import type { ProviderStore } from "./store.js";

export const BUNDLED_NAME = "Ollama (this server)";
/** How long to wait for the Ollama container to answer after the server starts. */
const WAIT_MS = 5 * 60_000;
const RETRY_MS = 5_000;
/** Downloading a model can take a while on a slow connection. */
const PULL_TIMEOUT_MS = 2 * 60 * 60_000;
const PULL_ATTEMPTS = 3;

const sameModel = (a: string, b: string) => {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return norm(a) === norm(b);
};

/**
 * Make sure the server's own Ollama (OLLAMA_URL) is a server provider. It is
 * created once; after that the admin panel owns it (rename, change the model,
 * turn it off). It is created again only if someone deletes it.
 */
export function ensureBundledProvider(store: ProviderStore, ollama: { url: string; model: string }): string {
  const existing = store.list().find((p) => p.kind === "ollama" && p.baseUrl.replace(/\/+$/, "") === ollama.url);
  if (existing) return existing.id;
  const hasDefault = store.list().some((p) => p.enabled && p.isDefault);
  return store.create({ name: BUNDLED_NAME, kind: "ollama", baseUrl: ollama.url, model: ollama.model, isDefault: !hasDefault }).id;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Wait for Ollama to come up, then download the provider's model if it isn't
 * there yet. Runs in the background; failures are logged, never thrown.
 */
export async function pullModelInBackground(
  url: string,
  model: string,
  log: FastifyBaseLogger,
  signal: AbortSignal,
  fetchImpl: FetchFn = (...args) => fetch(...args),
  opts: { waitMs?: number; retryMs?: number } = {},
): Promise<"present" | "pulled" | "unreachable" | "failed" | "aborted"> {
  const deadline = Date.now() + (opts.waitMs ?? WAIT_MS);
  let models: string[] | null = null;
  let lastError = "";
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const res = await fetchImpl(endpoint(url, "api/tags"), { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      if (res.ok) {
        const body = (await res.json()) as { models?: { name: string }[] };
        models = (body.models ?? []).map((m) => m.name);
        break;
      }
      lastError = `Ollama returned ${res.status}`;
    } catch (e) {
      lastError = describeFetchError(e);
    }
    await sleep(opts.retryMs ?? RETRY_MS, signal);
  }
  if (signal.aborted) return "aborted";
  if (!models) {
    log.warn({ url, error: lastError }, "The server's Ollama didn't answer; the AI DJ won't work until it does");
    return "unreachable";
  }
  if (models.some((m) => sameModel(m, model))) return "present";

  log.info({ model }, "Downloading the AI DJ's model into the server's Ollama (this can take a few minutes)");
  // Ollama resumes a partial download, so a dropped connection just tries again.
  for (let attempt = 1; attempt <= PULL_ATTEMPTS && !signal.aborted; attempt++) {
    const error = await pull(url, model, log, signal, fetchImpl);
    if (error === null) {
      log.info({ model }, "The AI DJ's model is ready");
      return "pulled";
    }
    if (signal.aborted) return "aborted";
    log.warn({ model, attempt, error }, "Ollama couldn't download the model");
    if (attempt < PULL_ATTEMPTS) await sleep((opts.retryMs ?? RETRY_MS) * 6, signal);
  }
  return signal.aborted ? "aborted" : "failed";
}

/**
 * One streamed pull. Streaming matters: a non-streamed pull sends no response
 * until the whole model is downloaded, and fetch gives up waiting for the
 * headers after five minutes. Returns null on success, else the error.
 */
async function pull(url: string, model: string, log: FastifyBaseLogger, signal: AbortSignal, fetchImpl: FetchFn): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint(url, "api/pull"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(PULL_TIMEOUT_MS)]),
    });
  } catch (e) {
    return describeFetchError(e);
  }
  if (!res.ok || !res.body) return `Ollama returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: { status?: string; error?: string } = {};
  let logged = -10;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { status?: string; error?: string; total?: number; completed?: number };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        last = event;
        if (event.error) return event.error.slice(0, 300);
        // Log roughly every 10% of the largest layer, so the owner can follow it in the logs.
        if (event.total && event.completed !== undefined) {
          const pct = Math.floor((event.completed / event.total) * 100);
          if (pct >= logged + 10) {
            logged = pct;
            log.info({ model, percent: pct }, "Downloading the AI DJ's model");
          }
        }
      }
    }
  } catch (e) {
    return describeFetchError(e);
  }
  if (buffer.trim()) {
    try {
      last = JSON.parse(buffer);
    } catch {
      // ignore a partial last line
    }
  }
  if (last.error) return last.error.slice(0, 300);
  return last.status === "success" ? null : `the download ended early (${last.status ?? "no status"})`;
}
