import type {
  ArtistInfo,
  ConcertInfo,
  CoverInfo,
  DiscogsArtist,
  DiscogsRelease,
  FanartInfo,
  MetadataAdminConfig,
  MetadataStatus,
  RecordingInfo,
  ReleaseGroupInfo,
  WikiSummary,
} from "./types";

/** Why a lookup produced nothing, in terms a widget can show. */
export type MetadataErrorKind = "no_server" | "not_configured" | "not_found" | "busy" | "failed";

export class MetadataError extends Error {
  constructor(
    readonly kind: MetadataErrorKind,
    message: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

export interface ServerRef {
  url: string;
  token: string | null;
}

export interface ClientDeps {
  /** The plugin context fetch (needs network.outbound). */
  fetch: typeof fetch;
  /** The server the person is signed in to, or null. */
  server: () => ServerRef | null;
  now?: () => number;
}

type Params = Record<string, string | number | undefined>;

const OK_TTL_MS = 10 * 60_000;
const NOT_CONFIGURED_TTL_MS = 60_000;

function joinUrl(base: string, route: string, params: Params): string {
  const url = new URL(route.replace(/^\/+/, ""), base.replace(/\/+$/, "") + "/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const abortError = () => new DOMException("Aborted", "AbortError");

/** Resolves with the promise, or rejects early when the signal aborts. The shared request keeps going. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Talks to the Cadence server /api/metadata routes. Answers are remembered for the session
 * (and identical requests in flight are shared), because the server already caches and rate
 * limits: this just keeps a widget from asking twice on every visit to Home.
 */
export function createMetadataClient(deps: ClientDeps) {
  const now = deps.now ?? Date.now;
  const memory = new Map<string, { until: number; promise: Promise<unknown> }>();

  async function request<T>(route: string, params: Params): Promise<T> {
    const server = deps.server();
    if (!server) throw new MetadataError("no_server", "Sign in to your Cadence server to use this.");
    const headers: Record<string, string> = { accept: "application/json" };
    if (server.token) headers.authorization = "Bearer " + server.token;
    let res: Response;
    try {
      res = await deps.fetch(joinUrl(server.url, route, params), { headers });
    } catch {
      throw new MetadataError("failed", "The server could not be reached.");
    }
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        throw new MetadataError("failed", "The server answered oddly.");
      }
    }
    let body: { error?: string; message?: string; provider?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Keep the status-based message.
    }
    if (res.status === 404) throw new MetadataError("not_found", "Nothing found.", body.provider);
    if (res.status === 501 || body.error === "not_configured") {
      throw new MetadataError("not_configured", body.message ?? "This service needs a key from the server admin.", body.provider);
    }
    if (res.status === 503) throw new MetadataError("busy", body.message ?? "Lookups are busy. Try again shortly.", body.provider);
    if (res.status === 401) throw new MetadataError("no_server", "Sign in to your Cadence server to use this.");
    throw new MetadataError("failed", body.message ?? "The lookup failed.", body.provider);
  }

  function get<T>(route: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
    const server = deps.server();
    const key = (server?.url ?? "") + "|" + route + "?" + JSON.stringify(params);
    const hit = memory.get(key);
    if (hit && hit.until > now()) return untilAborted(hit.promise as Promise<T>, signal);
    const promise = request<T>(route, params);
    const entry = { until: now() + OK_TTL_MS, promise };
    memory.set(key, entry);
    promise.catch((err: unknown) => {
      // Failures that may pass (server down, busy) are not remembered; the rest are, briefly or for a while.
      const kind = err instanceof MetadataError ? err.kind : "failed";
      if (kind === "failed" || kind === "busy" || kind === "no_server") memory.delete(key);
      else if (kind === "not_configured") entry.until = now() + NOT_CONFIGURED_TTL_MS;
    });
    return untilAborted(promise, signal);
  }

  const byName = (name: string) => ({ name });
  return {
    status: (signal?: AbortSignal) => get<MetadataStatus>("api/metadata/status", {}, signal),
    artist: (name: string, signal?: AbortSignal) => get<ArtistInfo>("api/metadata/musicbrainz/artist", byName(name), signal),
    recording: (title: string, artist: string, signal?: AbortSignal) =>
      get<RecordingInfo>("api/metadata/musicbrainz/recording", { title, artist }, signal),
    wikipedia: (name: string, signal?: AbortSignal) => get<WikiSummary>("api/metadata/wikipedia/artist", byName(name), signal),
    cover: (album: string, artist: string, signal?: AbortSignal) =>
      get<CoverInfo>("api/metadata/coverart", { album, artist }, signal),
    fanart: (name: string, signal?: AbortSignal) => get<FanartInfo>("api/metadata/fanart/artist", byName(name), signal),
    discogsRelease: (artist: string, title: string, signal?: AbortSignal) =>
      get<{ items: DiscogsRelease[] }>("api/metadata/discogs/release", { artist, title }, signal),
    discogs: (name: string, signal?: AbortSignal) => get<DiscogsArtist>("api/metadata/discogs/artist", byName(name), signal),
    events: (name: string, city: string, country?: string, signal?: AbortSignal) =>
      get<{ items: ConcertInfo[] }>("api/metadata/events/artist", { name, city, country }, signal),
    newReleases: (name: string, days: number, signal?: AbortSignal) =>
      get<{ items: ReleaseGroupInfo[] }>("api/metadata/releases/new", { artist: name, days }, signal),
    /** Admin only: which keys are set. Not remembered, so the settings panel always shows the truth. */
    adminConfig: () => request<MetadataAdminConfig>("api/metadata/config", {}),
    forget: () => memory.clear(),
  };
}

export type MetadataClient = ReturnType<typeof createMetadataClient>;

/** Run `fn` over `items` with at most `limit` at once; results keep the input order. Failures become null. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  isStopped: () => boolean = () => false,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length && !isStopped()) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
