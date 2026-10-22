import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db.js";
import { open, seal } from "../../llm/secretBox.js";
import type { PlayEvent } from "../../plugins/runtime.js";
import type { Settings } from "../../settings.js";
import { ScrobbleQueue, type QueueCounts, type QueueRow } from "./queue.js";
import {
  DeliveryError,
  LASTFM_BATCH,
  LASTFM_MAX_AGE_SEC,
  LISTENBRAINZ_BATCH,
  LISTENBRAINZ_DEFAULT_HOST,
  SERVICE_IDS,
  lastfmCheckSession,
  lastfmFlavor,
  lastfmGetSession,
  lastfmGetToken,
  lastfmScrobble,
  listenBrainzSubmit,
  listenBrainzValidate,
  malojaScrobble,
  malojaTest,
  parseServiceUrl,
  type FetchFn,
  type LastfmKeys,
  type Scrobble,
  type ServiceId,
} from "./services.js";

export const PLUGIN_ID = "cadence.scrobblers";
const SECRET_PURPOSE = "scrobbler-credentials";

/** A play this short is never a scrobble (the services' own rule). */
export const MIN_TRACK_SEC = 30;
const MAX_TEXT = 250;
const PENDING_TOKEN_MS = 55 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const DEFAULT_RETRY_DAYS = 7;
const MAX_RETRY_DAYS = 30;

/**
 * Libre.fm accepts the Last.fm signing scheme with any key, so it works with no setup. These are public
 * identifiers (Libre.fm does not check them), not secrets; an owner can still set their own.
 */
const LIBREFM_DEFAULT_KEYS: LastfmKeys = { apiKey: "cadence-music-player", apiSecret: "cadence-music-player" };

const LABELS: Record<ServiceId, string> = {
  lastfm: "Last.fm",
  librefm: "Libre.fm",
  listenbrainz: "ListenBrainz",
  maloja: "Maloja",
};

/** Minimum spacing between requests to one service. */
const GAP_MS: Record<ServiceId, number> = { lastfm: 250, librefm: 500, listenbrainz: 200, maloja: 100 };

// ---------------------------------------------------------------------------
// Stored configuration
// ---------------------------------------------------------------------------

/** What the owner saved: app keys for Last.fm/Libre.fm, and policy. Secrets are sealed. */
export interface AdminConfig {
  lastfm?: { apiKey: string; apiSecretEnc: string };
  librefm?: { apiKey: string; apiSecretEnc: string };
  /** Whether people may point ListenBrainz/Maloja at their own addresses. Off by default. */
  allowCustomHosts?: boolean;
  retryDays?: number;
}

interface ServiceState {
  enabled: boolean;
  username?: string;
  /** The sign-in stopped working; deliveries wait until the person reconnects. */
  needsReauth?: boolean;
  lastError?: { message: string; at: number };
  lastSuccessAt?: number;
  sent?: number;
  // Last.fm / Libre.fm
  sessionKeyEnc?: string;
  pending?: { tokenEnc: string; at: number };
  // ListenBrainz
  tokenEnc?: string;
  host?: string;
  // Maloja
  url?: string;
  apiKeyEnc?: string;
}

export type UserConfig = Partial<Record<ServiceId, ServiceState>>;

export class ScrobblerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceStatus {
  id: ServiceId;
  label: string;
  /** Can this person connect it? (Last.fm needs the owner's app keys.) */
  available: boolean;
  unavailableReason?: string;
  connected: boolean;
  enabled: boolean;
  username?: string;
  needsReauth: boolean;
  /** Last.fm/Libre.fm: waiting for the person to approve, then finish. */
  awaitingApproval: boolean;
  /** Address in use (ListenBrainz, Maloja). */
  host?: string;
  lastError?: { message: string; at: number };
  lastSuccessAt?: number;
  sent: number;
  queue: QueueCounts;
}

export interface StatusResponse {
  services: ServiceStatus[];
  customHostsAllowed: boolean;
  retryDays: number;
  problems: ReturnType<ScrobbleQueue["recentProblems"]>;
}

// ---------------------------------------------------------------------------
// Turning a recorded play into a scrobble
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const tidy = (s: unknown): string => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "");

/**
 * The server only hears about finished plays, so the "half the track or four minutes" rule is already met.
 * What is left is cleaning the text and refusing what the services refuse: no artist or title, a track
 * shorter than 30 seconds, or a start time in the future.
 */
export function toScrobble(event: PlayEvent, nowMs: number): Scrobble | null {
  const title = tidy(event.track.title);
  const artists = (event.track.artists ?? []).map((a) => tidy(a?.name)).filter(Boolean);
  if (!title || artists.length === 0) return null;
  const duration = event.track.durationSec;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration < MIN_TRACK_SEC) return null;
  if (!Number.isFinite(event.playedAt) || event.playedAt <= 0 || event.playedAt > nowMs + 60_000) return null;
  const album = tidy(event.track.album);
  return {
    artist: artists[0]!,
    artists: artists.slice(0, 10),
    title,
    album: album || undefined,
    durationSec: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
    playedAt: Math.floor(event.playedAt / 1000),
    trackId: tidy(event.track.id) || undefined,
    source: tidy(event.track.source) || undefined,
  };
}

/** Wait before try number `attempts + 1`: 30s, 1m, 2m ... capped at 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts));
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface EngineOptions {
  db: Db;
  settings: Settings;
  secret: string;
  log: FastifyBaseLogger;
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wait this long after a play before sending it, so quick plays go out together. 0 sends on the next tick; null never auto-sends. */
  autoFlushDelayMs?: number | null;
}

export class Scrobbler {
  readonly queue: ScrobbleQueue;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly lastCall = new Map<ServiceId, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly o: EngineOptions) {
    this.queue = new ScrobbleQueue(o.db);
    this.fetchFn = o.fetchFn ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---- configuration ----

  adminConfig(): AdminConfig {
    return this.o.settings.pluginConfig<AdminConfig>(PLUGIN_ID) ?? {};
  }

  saveAdminConfig(input: {
    lastfm?: { apiKey?: string; apiSecret?: string } | null;
    librefm?: { apiKey?: string; apiSecret?: string } | null;
    allowCustomHosts?: boolean;
    retryDays?: number;
  }): void {
    const next: AdminConfig = { ...this.adminConfig() };
    for (const id of ["lastfm", "librefm"] as const) {
      const given = input[id];
      if (given === undefined) continue;
      if (given === null) {
        delete next[id];
        continue;
      }
      const apiKey = typeof given.apiKey === "string" ? given.apiKey.trim() : next[id]?.apiKey ?? "";
      if (!/^[\w-]{8,64}$/.test(apiKey)) throw new ScrobblerError(400, "invalid_request", `Enter the ${LABELS[id]} API key.`);
      let enc = next[id]?.apiSecretEnc;
      if (typeof given.apiSecret === "string" && given.apiSecret.trim()) {
        const secret = given.apiSecret.trim();
        if (!/^[\w-]{8,64}$/.test(secret)) throw new ScrobblerError(400, "invalid_request", `That ${LABELS[id]} shared secret doesn't look right.`);
        enc = seal(secret, this.o.secret, SECRET_PURPOSE);
      }
      if (!enc) throw new ScrobblerError(400, "invalid_request", `Enter the ${LABELS[id]} shared secret.`);
      next[id] = { apiKey, apiSecretEnc: enc };
    }
    if (typeof input.allowCustomHosts === "boolean") next.allowCustomHosts = input.allowCustomHosts;
    if (input.retryDays !== undefined) {
      const days = Math.floor(Number(input.retryDays));
      if (!Number.isFinite(days) || days < 1 || days > MAX_RETRY_DAYS) {
        throw new ScrobblerError(400, "invalid_request", `Retry days must be between 1 and ${MAX_RETRY_DAYS}.`);
      }
      next.retryDays = days;
    }
    this.o.settings.setPluginConfig(PLUGIN_ID, next);
  }

  retryDays(): number {
    const d = this.adminConfig().retryDays;
    return typeof d === "number" && d >= 1 ? Math.min(MAX_RETRY_DAYS, d) : DEFAULT_RETRY_DAYS;
  }

  customHostsAllowed(): boolean {
    return this.adminConfig().allowCustomHosts === true;
  }

  /** App keys for Last.fm / Libre.fm, or null when the owner has not set them (Libre.fm falls back to public defaults). */
  keysFor(id: "lastfm" | "librefm"): LastfmKeys | null {
    const saved = this.adminConfig()[id];
    if (saved) {
      const apiSecret = open(saved.apiSecretEnc, this.o.secret, SECRET_PURPOSE);
      return apiSecret ? { apiKey: saved.apiKey, apiSecret } : null;
    }
    return id === "librefm" ? LIBREFM_DEFAULT_KEYS : null;
  }

  userConfig(userId: number): UserConfig {
    return this.o.settings.pluginUserConfig<UserConfig>(PLUGIN_ID, userId) ?? {};
  }

  /** Change one service's saved state. Reads fresh each time, so concurrent updates don't clobber each other. */
  private patch(userId: number, id: ServiceId, change: (s: ServiceState | undefined) => ServiceState | null): void {
    const cfg = { ...this.userConfig(userId) };
    const next = change(cfg[id]);
    if (next) cfg[id] = next;
    else delete cfg[id];
    this.o.settings.setPluginUserConfig(PLUGIN_ID, userId, Object.keys(cfg).length ? cfg : null);
  }

  private connected(state: ServiceState | undefined, id: ServiceId): state is ServiceState {
    if (!state) return false;
    if (id === "lastfm" || id === "librefm") return !!state.sessionKeyEnc;
    if (id === "listenbrainz") return !!state.tokenEnc;
    return !!state.url && !!state.apiKeyEnc;
  }

  private unseal(value: string | undefined): string | null {
    return value ? open(value, this.o.secret, SECRET_PURPOSE) : null;
  }

  // ---- status ----

  status(userId: number): StatusResponse {
    const now = this.now();
    const cfg = this.userConfig(userId);
    const services = SERVICE_IDS.map((id): ServiceStatus => {
      const state = cfg[id];
      const isConnected: boolean = this.connected(state, id);
      const needsKeys = id === "lastfm" || id === "librefm";
      const available = needsKeys ? this.keysFor(id) !== null : id === "maloja" ? this.customHostsAllowed() || isConnected : true;
      let unavailableReason: string | undefined;
      if (!available) {
        unavailableReason =
          id === "maloja"
            ? "The server owner has not allowed custom addresses."
            : `The server owner has not added ${LABELS[id]} API keys yet.`;
      }
      return {
        id,
        label: LABELS[id],
        available,
        unavailableReason,
        connected: isConnected,
        enabled: isConnected && state?.enabled !== false,
        username: state?.username || undefined,
        needsReauth: isConnected && state?.needsReauth === true,
        awaitingApproval: !isConnected && !!state?.pending && now - state.pending.at < PENDING_TOKEN_MS,
        host: id === "listenbrainz" ? (isConnected ? state?.host ?? LISTENBRAINZ_DEFAULT_HOST : undefined) : id === "maloja" ? state?.url : undefined,
        lastError: state?.lastError,
        lastSuccessAt: state?.lastSuccessAt,
        sent: state?.sent ?? 0,
        queue: this.queue.counts(userId, id, now),
      };
    });
    return {
      services,
      customHostsAllowed: this.customHostsAllowed(),
      retryDays: this.retryDays(),
      problems: this.queue.recentProblems(userId),
    };
  }

  // ---- connecting ----

  private requireKeys(id: "lastfm" | "librefm"): LastfmKeys {
    const keys = this.keysFor(id);
    if (!keys) throw new ScrobblerError(409, "not_configured", `${LABELS[id]} isn't set up on this server. Ask the server owner to add its API keys.`);
    return keys;
  }

  private wrap<T>(run: () => Promise<T>): Promise<T> {
    return run().catch((err) => {
      if (err instanceof DeliveryError) {
        if (err.kind === "auth") throw new ScrobblerError(400, "rejected", err.message);
        throw new ScrobblerError(502, "service_error", err.message);
      }
      throw err;
    });
  }

  /** Last.fm / Libre.fm step 1: get a token and the page where the person approves it. */
  async connectLastfmLike(userId: number, id: "lastfm" | "librefm", callbackUrl?: string): Promise<{ approveUrl: string }> {
    const keys = this.requireKeys(id);
    return this.wrap(async () => {
      const { token, approveUrl } = await lastfmGetToken(this.fetchFn, lastfmFlavor(id), keys, callbackUrl);
      const sealed = seal(token, this.o.secret, SECRET_PURPOSE);
      this.patch(userId, id, (s) => ({ ...(s ?? { enabled: true }), pending: { tokenEnc: sealed, at: this.now() } }));
      return { approveUrl };
    });
  }

  /** Step 2: after the person approved, trade the token for a session. */
  async finishLastfmLike(userId: number, id: "lastfm" | "librefm"): Promise<{ username: string }> {
    const keys = this.requireKeys(id);
    const pending = this.userConfig(userId)[id]?.pending;
    const token = pending && this.now() - pending.at < PENDING_TOKEN_MS ? this.unseal(pending.tokenEnc) : null;
    if (!token) throw new ScrobblerError(409, "no_pending", `Start again: ask to connect ${LABELS[id]} first.`);
    return this.wrap(async () => {
      let session: { sessionKey: string; username: string };
      try {
        session = await lastfmGetSession(this.fetchFn, lastfmFlavor(id), keys, token);
      } catch (err) {
        // 14 = token not yet approved; 15 = expired. Either way the person has to try again or approve first.
        if (err instanceof DeliveryError && err.kind === "auth") {
          throw new ScrobblerError(409, "not_approved", `${LABELS[id]} hasn't been approved yet. Approve access on ${LABELS[id]}, then finish.`);
        }
        throw err;
      }
      this.patch(userId, id, (s) => ({
        enabled: s?.enabled ?? true,
        username: session.username,
        sessionKeyEnc: seal(session.sessionKey, this.o.secret, SECRET_PURPOSE),
        sent: s?.sent,
        lastSuccessAt: s?.lastSuccessAt,
      }));
      this.scheduleFlush(userId);
      return { username: session.username };
    });
  }

  private hostFor(raw: unknown): string {
    try {
      return parseServiceUrl(raw);
    } catch (err) {
      throw new ScrobblerError(400, "invalid_request", err instanceof Error ? err.message : "Invalid address.");
    }
  }

  private requireCustomHost(): void {
    if (!this.customHostsAllowed()) {
      throw new ScrobblerError(403, "custom_hosts_disabled", "The server owner has not allowed custom addresses.");
    }
  }

  async connectListenBrainz(userId: number, token: unknown, host?: unknown): Promise<{ username: string }> {
    const clean = typeof token === "string" ? token.trim() : "";
    if (!/^[\w-]{8,100}$/.test(clean)) throw new ScrobblerError(400, "invalid_request", "Paste your ListenBrainz user token.");
    let base = LISTENBRAINZ_DEFAULT_HOST;
    if (typeof host === "string" && host.trim()) {
      const parsed = this.hostFor(host);
      if (parsed !== LISTENBRAINZ_DEFAULT_HOST) {
        this.requireCustomHost();
        base = parsed;
      }
    }
    return this.wrap(async () => {
      const username = await listenBrainzValidate(this.fetchFn, base, clean);
      this.patch(userId, "listenbrainz", (s) => ({
        enabled: s?.enabled ?? true,
        username,
        tokenEnc: seal(clean, this.o.secret, SECRET_PURPOSE),
        host: base === LISTENBRAINZ_DEFAULT_HOST ? undefined : base,
        sent: s?.sent,
        lastSuccessAt: s?.lastSuccessAt,
      }));
      this.scheduleFlush(userId);
      return { username };
    });
  }

  async connectMaloja(userId: number, url: unknown, apiKey: unknown): Promise<{ keyChecked: boolean }> {
    this.requireCustomHost();
    const base = this.hostFor(url);
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key || key.length > 200 || /\s/.test(key)) throw new ScrobblerError(400, "invalid_request", "Enter your Maloja API key.");
    return this.wrap(async () => {
      const { keyChecked } = await malojaTest(this.fetchFn, base, key);
      this.patch(userId, "maloja", (s) => ({
        enabled: s?.enabled ?? true,
        url: base,
        apiKeyEnc: seal(key, this.o.secret, SECRET_PURPOSE),
        sent: s?.sent,
        lastSuccessAt: s?.lastSuccessAt,
      }));
      this.scheduleFlush(userId);
      return { keyChecked };
    });
  }

  /** Forget a service's sign-in and drop what was waiting for it. */
  disconnect(userId: number, id: ServiceId): void {
    this.patch(userId, id, () => null);
    this.queue.clear(userId, id);
  }

  setEnabled(userId: number, id: ServiceId, enabled: boolean): void {
    const state = this.userConfig(userId)[id];
    if (!this.connected(state, id)) throw new ScrobblerError(409, "not_connected", `${LABELS[id]} isn't connected.`);
    this.patch(userId, id, (s) => ({ ...s!, enabled }));
    if (enabled) this.scheduleFlush(userId);
  }

  /** Check a connection against the live service, and clear a stale "needs sign-in" flag if it works. */
  async test(userId: number, id: ServiceId): Promise<{ ok: true; message: string; username?: string }> {
    const state = this.userConfig(userId)[id];
    if (!this.connected(state, id)) throw new ScrobblerError(409, "not_connected", `${LABELS[id]} isn't connected.`);
    return this.wrap(async () => {
      let username: string | undefined;
      let message = "Connection works.";
      try {
        if (id === "lastfm" || id === "librefm") {
          const sk = this.unseal(state.sessionKeyEnc);
          const keys = this.requireKeys(id);
          if (!sk) throw new DeliveryError("auth", "The saved sign-in is damaged. Connect again.");
          username = (await lastfmCheckSession(this.fetchFn, lastfmFlavor(id), keys, sk)) || state.username;
        } else if (id === "listenbrainz") {
          const token = this.unseal(state.tokenEnc);
          if (!token) throw new DeliveryError("auth", "The saved token is damaged. Connect again.");
          username = await listenBrainzValidate(this.fetchFn, state.host ?? LISTENBRAINZ_DEFAULT_HOST, token);
        } else {
          const key = this.unseal(state.apiKeyEnc);
          if (!key) throw new DeliveryError("auth", "The saved key is damaged. Connect again.");
          const { keyChecked } = await malojaTest(this.fetchFn, state.url!, key);
          if (!keyChecked) message = "Maloja is reachable; its version can't confirm the API key.";
        }
      } catch (err) {
        if (err instanceof DeliveryError) {
          this.patch(userId, id, (s) =>
            s ? { ...s, lastError: { message: err.message, at: this.now() }, needsReauth: err.kind === "auth" ? true : s.needsReauth } : null,
          );
        }
        throw err;
      }
      this.patch(userId, id, (s) => (s ? { ...s, needsReauth: false, lastError: undefined, username: username || s.username } : null));
      this.scheduleFlush(userId);
      return { ok: true as const, message, username };
    });
  }

  // ---- receiving plays ----

  /** Queue a finished play for each service the person connected. Returns how many deliveries were queued. */
  onPlay(event: PlayEvent): number {
    const now = this.now();
    const scrobble = toScrobble(event, now);
    if (!scrobble) return 0;
    const cfg = this.userConfig(event.userId);
    let queued = 0;
    for (const id of SERVICE_IDS) {
      const state = cfg[id];
      if (!this.connected(state, id) || state.enabled === false) continue;
      if ((id === "lastfm" || id === "librefm") && (!this.keysFor(id) || now / 1000 - scrobble.playedAt > LASTFM_MAX_AGE_SEC)) continue;
      if (this.queue.enqueue(event.userId, id, scrobble, now)) queued++;
    }
    if (queued > 0) this.scheduleFlush(event.userId);
    return queued;
  }

  private scheduleFlush(userId: number): void {
    const delay = this.o.autoFlushDelayMs;
    if (delay === null || delay === undefined || this.stopped || this.timers.has(userId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      this.flush(userId).catch((err) => this.o.log.warn({ err }, "scrobble flush failed"));
    }, delay);
    timer.unref();
    this.timers.set(userId, timer);
  }

  // ---- delivering ----

  /** Send everything that is due (for one person, or everyone). Runs one at a time. */
  flush(userId?: number): Promise<{ sent: number; retried: number; dropped: number }> {
    const run = this.chain.then(() => this.doFlush(userId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  retryNow(userId: number, id?: ServiceId): Promise<{ sent: number; retried: number; dropped: number }> {
    this.queue.retryNow(userId, this.now(), id);
    return this.flush(userId);
  }

  private async doFlush(userId?: number): Promise<{ sent: number; retried: number; dropped: number }> {
    const totals = { sent: 0, retried: 0, dropped: 0 };
    const now = this.now();
    this.queue.expire(now - this.retryDays() * 86_400_000, now);
    this.queue.prune(now);
    const rows = userId === undefined ? this.queue.due(now, 400) : this.queue.dueFor(userId, now, 400);
    const groups = new Map<string, QueueRow[]>();
    for (const row of rows) {
      const key = `${row.userId}:${row.service}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    for (const group of groups.values()) {
      if (this.stopped) break;
      await this.deliverGroup(group, totals);
    }
    return totals;
  }

  private async deliverGroup(rows: QueueRow[], totals: { sent: number; retried: number; dropped: number }): Promise<void> {
    const { userId, service } = rows[0]!;
    const state = this.userConfig(userId)[service];
    if (!this.connected(state, service) || state.enabled === false || state.needsReauth) return;
    const send = this.senderFor(userId, service, state);
    if (!send) return;
    const size = service === "lastfm" || service === "librefm" ? LASTFM_BATCH : service === "listenbrainz" ? LISTENBRAINZ_BATCH : 1;

    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const outcome = await this.attempt(userId, service, send, chunk, totals);
      if (outcome === "stop") return;
    }
  }

  /** Try a chunk. Returns "stop" when the rest of this service's queue should wait. */
  private async attempt(
    userId: number,
    service: ServiceId,
    send: (items: Scrobble[]) => Promise<void>,
    chunk: QueueRow[],
    totals: { sent: number; retried: number; dropped: number },
  ): Promise<"ok" | "stop"> {
    await this.pace(service);
    try {
      await send(chunk.map((r) => r.scrobble));
      const now = this.now();
      this.queue.markSent(chunk.map((r) => r.id), now);
      totals.sent += chunk.length;
      this.patch(userId, service, (s) => (s ? { ...s, sent: (s.sent ?? 0) + chunk.length, lastSuccessAt: now, lastError: undefined } : null));
      return "ok";
    } catch (err) {
      const failure = err instanceof DeliveryError ? err : new DeliveryError("retry", "Unexpected error while sending.");
      if (!(err instanceof DeliveryError)) this.o.log.warn({ err, service }, "unexpected scrobble error");
      const now = this.now();
      this.patch(userId, service, (s) =>
        s ? { ...s, lastError: { message: failure.message, at: now }, needsReauth: failure.kind === "auth" ? true : s.needsReauth } : null,
      );
      const ids = chunk.map((r) => r.id);
      if (failure.kind === "auth") {
        // Keep the plays; they go out once the person reconnects (or expire).
        this.queue.markRetry(ids, now + BACKOFF_MAX_MS, failure.message);
        totals.retried += chunk.length;
        return "stop";
      }
      if (failure.kind === "drop") {
        if (chunk.length > 1) {
          // One bad play can sink a batch; send them one at a time to find it.
          for (const row of chunk) {
            const single = await this.attempt(userId, service, send, [row], totals);
            if (single === "stop") return "stop";
          }
          return "ok";
        }
        this.queue.markDropped(ids, now, failure.message);
        totals.dropped += 1;
        return "ok";
      }
      const attempts = Math.max(...chunk.map((r) => r.attempts));
      this.queue.markRetry(ids, now + (failure.retryAfterMs ?? backoffMs(attempts)), failure.message);
      totals.retried += chunk.length;
      return "stop";
    }
  }

  private async pace(service: ServiceId): Promise<void> {
    const last = this.lastCall.get(service);
    const wait = last === undefined ? 0 : GAP_MS[service] - (this.now() - last);
    if (wait > 0) await this.sleep(wait);
    this.lastCall.set(service, this.now());
  }

  /** A function that delivers a batch for one person and service, or null if they can't be sent right now. */
  private senderFor(userId: number, service: ServiceId, state: ServiceState): ((items: Scrobble[]) => Promise<void>) | null {
    const skip = (message: string) => {
      this.patch(userId, service, (s) => (s ? { ...s, lastError: { message, at: this.now() } } : null));
      return null;
    };
    if (service === "lastfm" || service === "librefm") {
      const keys = this.keysFor(service);
      const sk = this.unseal(state.sessionKeyEnc);
      if (!keys) return skip(`${LABELS[service]} API keys were removed by the server owner.`);
      if (!sk) return skip("The saved sign-in is damaged. Connect again.");
      return (items) => lastfmScrobble(this.fetchFn, lastfmFlavor(service), keys, sk, items);
    }
    if (service === "listenbrainz") {
      const token = this.unseal(state.tokenEnc);
      if (!token) return skip("The saved token is damaged. Connect again.");
      const host = state.host ?? LISTENBRAINZ_DEFAULT_HOST;
      if (host !== LISTENBRAINZ_DEFAULT_HOST && !this.customHostsAllowed()) return skip("Custom addresses are turned off by the server owner.");
      return (items) => listenBrainzSubmit(this.fetchFn, host, token, items);
    }
    const key = this.unseal(state.apiKeyEnc);
    if (!key || !state.url) return skip("The saved key is damaged. Connect again.");
    if (!this.customHostsAllowed()) return skip("Custom addresses are turned off by the server owner.");
    const url = state.url;
    return (items) => malojaScrobble(this.fetchFn, url, key, items[0]!);
  }
}
