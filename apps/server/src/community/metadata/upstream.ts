import { MetadataCache } from "./cache.js";
import { UpstreamError } from "./errors.js";
import { Gate } from "./gate.js";

export type ProviderId = "musicbrainz" | "coverart" | "wikipedia" | "wikidata" | "fanart" | "discogs" | "bandsintown";

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface ProviderSpec {
  base: string;
  /** Minimum gap between requests to this service. */
  gapMs: number;
  ttlMs: number;
}

/** MusicBrainz asks for no more than one request a second; the others get polite gaps. */
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  musicbrainz: { base: "https://musicbrainz.org", gapMs: 1100, ttlMs: 7 * DAY },
  coverart: { base: "https://coverartarchive.org", gapMs: 250, ttlMs: 30 * DAY },
  wikipedia: { base: "https://en.wikipedia.org", gapMs: 150, ttlMs: 7 * DAY },
  wikidata: { base: "https://www.wikidata.org", gapMs: 150, ttlMs: 30 * DAY },
  fanart: { base: "https://webservice.fanart.tv", gapMs: 500, ttlMs: 7 * DAY },
  discogs: { base: "https://api.discogs.com", gapMs: 1100, ttlMs: 7 * DAY },
  bandsintown: { base: "https://rest.bandsintown.com", gapMs: 300, ttlMs: 6 * HOUR },
};

/** A missing artist is remembered for a day so it does not hit the service on every page view. */
export const MISSING_TTL_MS = DAY;
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2_000_000;

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface UpstreamOptions {
  cache: MetadataCache;
  userAgent: string;
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for tests (shorter gaps). */
  gapMs?: Partial<Record<ProviderId, number>>;
  timeoutMs?: number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  ttlMs?: number;
}

export interface Result<T> {
  data: T;
  /** Where the answer came from. */
  from: "cache" | "network" | "stale";
}

/** Cached, rate-limited, timed-out GETs to metadata services, always sent with Cadence's User-Agent. */
export class Upstream {
  private readonly gates = new Map<ProviderId, Gate>();
  private readonly inflight = new Map<string, Promise<Result<unknown>>>();
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(private readonly options: UpstreamOptions) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  private gate(provider: ProviderId): Gate {
    let gate = this.gates.get(provider);
    if (!gate) {
      gate = new Gate({
        gapMs: this.options.gapMs?.[provider] ?? PROVIDERS[provider].gapMs,
        now: this.now,
        sleep: this.options.sleep,
      });
      this.gates.set(provider, gate);
    }
    return gate;
  }

  /** GET a JSON document. `url` must be absolute. Throws UpstreamError. */
  getJson<T>(provider: ProviderId, url: string, opts: GetOptions = {}): Promise<Result<T>> {
    // Credentials travel in headers, never in the URL, so the URL is safe to store as the key.
    const key = `${provider}|${url}`;
    const cached = this.options.cache.get(key);
    if (cached && this.options.cache.isFresh(cached)) {
      if (cached.missing) return Promise.reject(new UpstreamError("not_found", provider));
      return Promise.resolve({ data: cached.value as T, from: "cache" });
    }
    // Several people asking for the same thing at once share one upstream call.
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<Result<T>>;
    const run = this.fetchAndStore<T>(provider, url, key, opts, cached).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async fetchAndStore<T>(
    provider: ProviderId,
    url: string,
    key: string,
    opts: GetOptions,
    stale: ReturnType<MetadataCache["get"]>,
  ): Promise<Result<T>> {
    const ttl = opts.ttlMs ?? PROVIDERS[provider].ttlMs;
    try {
      const data = await this.gate(provider).schedule(() => this.request(provider, url, opts.headers));
      this.options.cache.set(key, data, ttl);
      return { data: data as T, from: "network" };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      if (err.kind === "not_found") {
        this.options.cache.setMissing(key, MISSING_TTL_MS);
        throw err;
      }
      // The service is down or limiting us: an old answer beats an error.
      const recoverable = err.kind === "timeout" || err.kind === "unreachable" || err.kind === "rate_limited" || err.kind === "bad_response";
      if (stale && !stale.missing && recoverable) return { data: stale.value as T, from: "stale" };
      throw err;
    }
  }

  private async request(provider: ProviderId, url: string, headers: Record<string, string> = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { "user-agent": this.options.userAgent, accept: "application/json", ...headers },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      throw new UpstreamError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable", provider);
    }
    // Do not wait on the cancel: the body is not needed and a stuck stream must not stall the queue.
    const drop = async () => {
      void res.body?.cancel().catch(() => undefined);
    };
    if (res.status === 404) {
      await drop();
      throw new UpstreamError("not_found", provider);
    }
    if (res.status === 401 || res.status === 403) {
      await drop();
      throw new UpstreamError("auth", provider);
    }
    if (res.status === 429 || res.status === 503) {
      const retry = Number(res.headers.get("retry-after"));
      await drop();
      throw new UpstreamError("rate_limited", provider, Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) : undefined);
    }
    if (!res.ok) {
      await drop();
      throw new UpstreamError("bad_response", provider);
    }
    try {
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("too large");
      return JSON.parse(text);
    } catch {
      throw new UpstreamError("bad_response", provider);
    }
  }
}
