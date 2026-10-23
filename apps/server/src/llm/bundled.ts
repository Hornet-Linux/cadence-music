import type { FastifyBaseLogger } from "fastify";
import { describeFetchError, endpoint } from "./core/http.js";
import type { FetchFn } from "./core/index.js";
import type { ProviderStore } from "./store.js";

export const BUNDLED_NAME = "Ollama (this server)";
/** How long to wait for the Ollama container to answer after the server starts. */
const WAIT_MS = 5 * 60_000;
const RETRY_MS = 5_000;
/** Downloading a model can take a while on a slow connection. */
const PULL_TIMEOUT_MS = 60 * 60_000;

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
  try {
    const res = await fetchImpl(endpoint(url, "api/pull"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(PULL_TIMEOUT_MS)]),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok || /"error"/.test(text)) {
      log.warn({ model, status: res.status, detail: text.slice(0, 300) }, "Ollama couldn't download the model");
      return "failed";
    }
    log.info({ model }, "The AI DJ's model is ready");
    return "pulled";
  } catch (e) {
    if (signal.aborted) return "aborted";
    log.warn({ model, error: describeFetchError(e) }, "Ollama couldn't download the model");
    return "failed";
  }
}
