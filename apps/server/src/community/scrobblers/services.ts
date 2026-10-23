import { createHash } from "node:crypto";
import { SERVER_VERSION } from "../../version.js";

/**
 * Clients for the scrobbling services, using only their official public APIs:
 * Last.fm and Libre.fm (the Last.fm 2.0 API), ListenBrainz, and Maloja.
 * Every function takes the fetch to use, so tests run with a mock.
 */

export type FetchFn = typeof fetch;
export type ServiceId = "lastfm" | "librefm" | "listenbrainz" | "maloja";
export const SERVICE_IDS: readonly ServiceId[] = ["lastfm", "librefm", "listenbrainz", "maloja"];
export const isServiceId = (value: unknown): value is ServiceId =>
  typeof value === "string" && (SERVICE_IDS as readonly string[]).includes(value);

/** One finished play, ready to send. Times are epoch seconds. */
export interface Scrobble {
  artist: string;
  /** Every credited artist (the first is `artist`). */
  artists: string[];
  title: string;
  album?: string;
  durationSec?: number;
  playedAt: number;
  /** The source's own id for the track, e.g. "spotify:track:abc". */
  trackId?: string;
  source?: string;
}

/**
 * Why a delivery failed:
 *  - retry: try again later (network trouble, rate limit, service outage)
 *  - auth: the sign-in no longer works; stop until the person reconnects
 *  - drop: the service refused this play for good
 */
export type FailureKind = "retry" | "auth" | "drop";

export class DeliveryError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export const USER_AGENT = `Cadence-Server/${SERVER_VERSION} (+https://github.com/Hornet-Linux/cadence-music)`;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 64 * 1024;
/** Last.fm and Libre.fm refuse scrobbles older than this. */
export const LASTFM_MAX_AGE_SEC = 14 * 24 * 3600;

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

/** One request with a timeout, no redirects and a capped body. Network failures become retryable errors. */
async function http(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new DeliveryError("retry", timedOut ? "The service did not answer in time." : "Could not reach the service.");
  }
  if (res.status >= 300 && res.status < 400) {
    throw new DeliveryError("drop", "The address redirects somewhere else. Use its final address.");
  }
  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Seconds from a Retry-After header (seconds or a date), in milliseconds; undefined if absent. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after") ?? headers.get("x-ratelimit-reset-in");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(24 * 3600_000, Math.max(0, seconds) * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(24 * 3600_000, Math.max(0, date - now)) : undefined;
}

// eslint-disable-next-line no-control-regex
const clean = (s: string, max = 300) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------
// Addresses people type in (self-hosted ListenBrainz, Maloja)
// ---------------------------------------------------------------------------

/** Cloud metadata endpoints are never a scrobble target, even when custom addresses are allowed. */
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]"]);

/**
 * Parse an address for a self-hosted service. Only http(s), no credentials, query or fragment.
 * Returns the address without a trailing slash.
 */
export function parseServiceUrl(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2048 || /\s/.test(text)) throw new Error("Enter the web address of the service.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That is not a valid address. Use a form like https://maloja.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password.");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) {
    throw new Error("The address must not contain a query string or fragment.");
  }
  if (!url.hostname || BLOCKED_HOSTS.has(url.hostname.toLowerCase())) throw new Error("That address cannot be used.");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Last.fm and Libre.fm (Last.fm 2.0 API)
// ---------------------------------------------------------------------------

export interface LastfmFlavor {
  id: "lastfm" | "librefm";
  label: string;
  /** The API root, e.g. https://ws.audioscrobbler.com/2.0/ */
  root: string;
  /** Where the person approves access. */
  authUrl: string;
}

export const LASTFM: LastfmFlavor = {
  id: "lastfm",
  label: "Last.fm",
  root: "https://ws.audioscrobbler.com/2.0/",
  authUrl: "https://www.last.fm/api/auth/",
};
export const LIBREFM: LastfmFlavor = {
  id: "librefm",
  label: "Libre.fm",
  root: "https://libre.fm/2.0/",
  authUrl: "https://libre.fm/api/auth/",
};
export const lastfmFlavor = (id: "lastfm" | "librefm"): LastfmFlavor => (id === "lastfm" ? LASTFM : LIBREFM);

export interface LastfmKeys {
  apiKey: string;
  apiSecret: string;
}

/**
 * Last.fm request signature: md5 of every parameter (except `format` and `callback`) as
 * name+value, sorted by name, followed by the shared secret.
 */
export function lastfmSignature(params: Record<string, string>, secret: string): string {
  const body = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHash("md5").update(body + secret, "utf8").digest("hex");
}

/** Last.fm error codes, by what to do about them. */
const LASTFM_AUTH_CODES = new Set([4, 9, 10, 14, 15, 26]);
const LASTFM_RETRY_CODES = new Set([8, 11, 16, 29]);

function lastfmError(flavor: LastfmFlavor, res: HttpResult): DeliveryError | null {
  const body = res.json as { error?: number; message?: string } | null;
  if (body && typeof body.error === "number") {
    const message = clean(`${flavor.label}: ${body.message ?? `error ${body.error}`}`);
    if (LASTFM_AUTH_CODES.has(body.error)) return new DeliveryError("auth", message);
    if (LASTFM_RETRY_CODES.has(body.error)) return new DeliveryError("retry", message, retryAfterMs(res.headers));
    return new DeliveryError("drop", message);
  }
  if (res.status === 429) return new DeliveryError("retry", `${flavor.label} is rate limiting requests.`, retryAfterMs(res.headers) ?? 60_000);
  if (res.status >= 500) return new DeliveryError("retry", `${flavor.label} had a problem (HTTP ${res.status}).`);
  if (res.status === 401 || res.status === 403) return new DeliveryError("auth", `${flavor.label} refused the sign-in.`);
  if (res.status >= 400) return new DeliveryError("drop", `${flavor.label} refused the request (HTTP ${res.status}).`);
  if (!res.json || typeof res.json !== "object") return new DeliveryError("retry", `${flavor.label} sent an unexpected answer.`);
  return null;
}

async function lastfmCall(
  fetchFn: FetchFn,
  flavor: LastfmFlavor,
  keys: LastfmKeys,
  method: string,
  params: Record<string, string>,
  verb: "GET" | "POST",
): Promise<Record<string, unknown>> {
  const all: Record<string, string> = { ...params, method, api_key: keys.apiKey };
  all.api_sig = lastfmSignature(all, keys.apiSecret);
  all.format = "json";
  const body = new URLSearchParams(all).toString();
  const res =
    verb === "GET"
      ? await http(fetchFn, `${flavor.root}?${body}`)
      : await http(fetchFn, flavor.root, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const failure = lastfmError(flavor, res);
  if (failure) throw failure;
  return res.json as Record<string, unknown>;
}

/** Step 1 of connecting: a request token, plus the page where the person approves it. */
export async function lastfmGetToken(
  fetchFn: FetchFn,
  flavor: LastfmFlavor,
  keys: LastfmKeys,
  callbackUrl?: string,
): Promise<{ token: string; approveUrl: string }> {
  const out = await lastfmCall(fetchFn, flavor, keys, "auth.getToken", {}, "GET");
  const token = typeof out.token === "string" ? out.token : "";
  if (!token) throw new DeliveryError("retry", `${flavor.label} did not give a sign-in token.`);
  const url = new URL(flavor.authUrl);
  url.searchParams.set("api_key", keys.apiKey);
  url.searchParams.set("token", token);
  if (callbackUrl) url.searchParams.set("cb", callbackUrl);
  return { token, approveUrl: url.toString() };
}

/** Step 2: once the person has approved, trade the token for a long-lived session key. */
export async function lastfmGetSession(
  fetchFn: FetchFn,
  flavor: LastfmFlavor,
  keys: LastfmKeys,
  token: string,
): Promise<{ sessionKey: string; username: string }> {
  const out = (await lastfmCall(fetchFn, flavor, keys, "auth.getSession", { token }, "GET")) as {
    session?: { key?: string; name?: string };
  };
  const key = out.session?.key;
  if (typeof key !== "string" || !key) throw new DeliveryError("drop", `${flavor.label} did not give a session.`);
  return { sessionKey: key, username: clean(out.session?.name ?? "") };
}

/** Check a stored session still works. Returns the user name. */
export async function lastfmCheckSession(fetchFn: FetchFn, flavor: LastfmFlavor, keys: LastfmKeys, sessionKey: string): Promise<string> {
  try {
    const out = (await lastfmCall(fetchFn, flavor, keys, "user.getInfo", { sk: sessionKey }, "POST")) as { user?: { name?: string } };
    return clean(out.user?.name ?? "");
  } catch (err) {
    // Libre.fm's server may not implement user.getInfo; a refused sign-in is the only thing that matters.
    if (err instanceof DeliveryError && err.kind === "drop" && flavor.id === "librefm") return "";
    throw err;
  }
}

export const LASTFM_BATCH = 50;

/** Send up to 50 plays with track.scrobble. */
export async function lastfmScrobble(
  fetchFn: FetchFn,
  flavor: LastfmFlavor,
  keys: LastfmKeys,
  sessionKey: string,
  items: Scrobble[],
): Promise<void> {
  const params: Record<string, string> = { sk: sessionKey };
  items.slice(0, LASTFM_BATCH).forEach((s, i) => {
    params[`artist[${i}]`] = s.artist;
    params[`track[${i}]`] = s.title;
    params[`timestamp[${i}]`] = String(s.playedAt);
    if (s.album) params[`album[${i}]`] = s.album;
    if (s.durationSec && s.durationSec >= 30) params[`duration[${i}]`] = String(Math.round(s.durationSec));
  });
  await lastfmCall(fetchFn, flavor, keys, "track.scrobble", params, "POST");
}

// ---------------------------------------------------------------------------
// ListenBrainz
// ---------------------------------------------------------------------------

export const LISTENBRAINZ_DEFAULT_HOST = "https://api.listenbrainz.org";
export const LISTENBRAINZ_BATCH = 100;

function lbBase(host: string): string {
  return host.replace(/\/+$/, "").replace(/\/1$/, "");
}

function lbFailure(res: HttpResult): DeliveryError | null {
  if (res.status >= 200 && res.status < 300) return null;
  if (res.status === 401 || res.status === 403) return new DeliveryError("auth", "ListenBrainz refused the token.");
  if (res.status === 429) return new DeliveryError("retry", "ListenBrainz is rate limiting requests.", retryAfterMs(res.headers) ?? 60_000);
  if (res.status >= 500 || res.status === 408) return new DeliveryError("retry", `ListenBrainz had a problem (HTTP ${res.status}).`);
  return new DeliveryError("drop", `ListenBrainz refused the request (HTTP ${res.status}).`);
}

/** The ListenBrainz `payload` entry for one play. */
export function listenBrainzListen(s: Scrobble): Record<string, unknown> {
  const additional: Record<string, unknown> = {
    media_player: "Cadence",
    submission_client: "Cadence",
    submission_client_version: SERVER_VERSION,
  };
  if (s.durationSec && s.durationSec > 0) additional.duration = Math.round(s.durationSec);
  if (s.artists.length > 1) additional.artist_names = s.artists;
  const spotify = s.trackId?.match(/^spotify:track:([A-Za-z0-9]{10,30})$/);
  if (spotify) {
    additional.music_service = "spotify.com";
    additional.origin_url = `https://open.spotify.com/track/${spotify[1]}`;
  }
  return {
    listened_at: s.playedAt,
    track_metadata: {
      artist_name: s.artists.join(", ") || s.artist,
      track_name: s.title,
      ...(s.album ? { release_name: s.album } : {}),
      additional_info: additional,
    },
  };
}

export async function listenBrainzSubmit(fetchFn: FetchFn, host: string, token: string, items: Scrobble[]): Promise<void> {
  const batch = items.slice(0, LISTENBRAINZ_BATCH);
  const res = await http(fetchFn, `${lbBase(host)}/1/submit-listens`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ listen_type: batch.length === 1 ? "single" : "import", payload: batch.map(listenBrainzListen) }),
  });
  const failure = lbFailure(res);
  if (failure) throw failure;
}

/** Check a token. Returns the ListenBrainz user name. */
export async function listenBrainzValidate(fetchFn: FetchFn, host: string, token: string): Promise<string> {
  const res = await http(fetchFn, `${lbBase(host)}/1/validate-token`, { headers: { Authorization: `Token ${token}` } });
  const failure = lbFailure(res);
  if (failure) throw failure;
  const body = res.json as { valid?: boolean; user_name?: string } | null;
  if (!body || body.valid !== true) throw new DeliveryError("auth", "ListenBrainz does not recognise that token.");
  return clean(body.user_name ?? "");
}

// ---------------------------------------------------------------------------
// Maloja
// ---------------------------------------------------------------------------

function malojaFailure(res: HttpResult): DeliveryError | null {
  if (res.status >= 200 && res.status < 300) return null;
  if (res.status === 401 || res.status === 403) return new DeliveryError("auth", "Maloja refused the API key.");
  if (res.status === 429) return new DeliveryError("retry", "Maloja is rate limiting requests.", retryAfterMs(res.headers) ?? 60_000);
  if (res.status >= 500 || res.status === 408) return new DeliveryError("retry", `Maloja had a problem (HTTP ${res.status}).`);
  return new DeliveryError("drop", `Maloja refused the request (HTTP ${res.status}).`);
}

export async function malojaScrobble(fetchFn: FetchFn, url: string, apiKey: string, s: Scrobble): Promise<void> {
  const res = await http(fetchFn, `${url}/apis/mlj_1/newscrobble`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artists: s.artists.length ? s.artists : [s.artist],
      title: s.title,
      ...(s.album ? { album: s.album } : {}),
      ...(s.durationSec && s.durationSec > 0 ? { duration: Math.round(s.durationSec) } : {}),
      time: s.playedAt,
      key: apiKey,
    }),
  });
  const failure = malojaFailure(res);
  if (failure) throw failure;
}

/** Check the address and API key. Older Maloja versions without the test route only prove the address works. */
export async function malojaTest(fetchFn: FetchFn, url: string, apiKey: string): Promise<{ keyChecked: boolean }> {
  const res = await http(fetchFn, `${url}/apis/mlj_1/test?key=${encodeURIComponent(apiKey)}`);
  if (res.status === 404) {
    const info = await http(fetchFn, `${url}/apis/mlj_1/serverinfo`);
    const failure = malojaFailure(info);
    if (failure) throw failure;
    return { keyChecked: false };
  }
  const failure = malojaFailure(res);
  if (failure) throw failure;
  return { keyChecked: true };
}
