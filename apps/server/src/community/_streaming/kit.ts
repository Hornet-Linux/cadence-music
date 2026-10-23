import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import { open, seal } from "../../llm/secretBox.js";
import type { PluginConfigField, ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { publicMessage, testUpstream, UpstreamError, type FetchFn } from "./http.js";
import { newPkce, newState } from "./pkce.js";
import type { StreamStatus } from "./types.js";

export type Cfg = Record<string, string | undefined>;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch seconds. Absent for tokens that do not expire (Deezer's offline_access). */
  expiresAt?: number;
}

/** How a service signs a person in. */
export interface OAuthDef {
  /** Send a PKCE challenge (every service here that documents PKCE requires it). */
  pkce: boolean;
  authorizeUrl(cfg: Cfg, p: { redirectUri: string; state: string; challenge?: string }): string;
  exchange(cfg: Cfg, p: { code: string; redirectUri: string; verifier?: string }, fetchFn?: FetchFn): Promise<TokenSet>;
  /** Absent for services without refresh tokens. */
  refresh?(cfg: Cfg, refreshToken: string, fetchFn?: FetchFn): Promise<TokenSet>;
}

export interface FieldDef {
  key: string;
  label: string;
  /** Shown to the admin, never sent back to any app once saved. */
  secret?: boolean;
  optional?: boolean;
  hint?: string;
}

export interface ServiceDef {
  /** URL slug, e.g. "deezer". */
  slug: string;
  /** Plugin id, e.g. "cadence.deezer". */
  id: string;
  /** Name for people, e.g. "Deezer". */
  name: string;
  fields: FieldDef[];
  /** Has the owner entered everything needed? */
  isConfigured(cfg: Cfg | undefined): boolean;
  oauth?: OAuthDef;
  features: StreamStatus["features"];
}

/**
 * The admin-page metadata every streaming plugin shares, derived from its credential fields.
 * Secrets are stored encrypted by the kit's own save route, so the generic form only shows whether they are set.
 */
export function streamingMeta(def: ServiceDef, description: string): Pick<ServerPlugin, "description" | "configFields" | "configNote"> {
  const configFields: PluginConfigField[] = def.fields.map((f) => ({
    key: f.key,
    label: f.label + (f.optional ? " (optional)" : ""),
    type: f.secret ? "secret" : "text",
    help: f.hint,
    ...(f.secret ? { sealed: true } : {}),
  }));
  return {
    description,
    configFields,
    configNote: `Secrets are stored encrypted: enter or replace them in the player under Settings > Plugins, where each person also connects their own account. Without these credentials the plugin stays idle and makes no calls to ${def.name}.`,
  };
}

/** Why a signed-in call cannot be made. Becomes a 409 (never a 401, which would sign the person out of Cadence). */
export class StreamAuthError extends Error {
  constructor(readonly reason: "not_connected" | "expired") {
    super(reason);
  }
}

interface Pending {
  userId: number;
  verifier?: string;
  redirectUri: string;
  expiresAt: number;
}

interface StoredTokens {
  access: string;
  refresh?: string;
  expiresAt?: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const REFRESH_MARGIN_SEC = 60;
const FIELD_MAX = 600;
const hasControlOrSpace = (s: string) => Array.from(s).some((ch) => ch.codePointAt(0)! <= 0x20 || ch.codePointAt(0) === 0x7f);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(body)}</p></body></html>`;

/**
 * Shared plumbing for the streaming-service server plugins: admin-entered credentials kept
 * encrypted in the plugin's settings, per-person OAuth (with PKCE where the service wants it),
 * token refresh, and fixed error answers. Each service plugin adds its own search/library routes.
 */
export class StreamingKit {
  private readonly pending = new Map<string, Pending>();
  private readonly loginErrors = new Map<number, string>();
  private readonly refreshing = new Map<number, Promise<string>>();
  private readonly appTokens = new Map<string, { token: string; expiresAt: number; inflight?: Promise<string> }>();
  private readonly searchLimiter = new RateLimiter({ max: 60, windowMs: 60_000 });

  constructor(
    readonly def: ServiceDef,
    readonly app: FastifyInstance,
    readonly ctx: ServerPluginContext,
    readonly fetchFn?: FetchFn,
  ) {
    const target = testUpstream();
    if (target) {
      ctx.log.warn(
        { target },
        `${def.id}: CADENCE_STREAMING_TEST_UPSTREAM is active: this plugin sends its API calls, including OAuth token exchange, to a test host instead of the real service. Never use this in production.`,
      );
    }
  }

  get base(): string {
    return `/api/streaming/${this.def.slug}`;
  }

  private get purpose(): string {
    return `streaming:${this.def.slug}`;
  }

  // ---- owner configuration ------------------------------------------------

  /** The saved configuration with secrets opened, or undefined if none/unreadable. */
  config(): Cfg | undefined {
    const saved = this.ctx.settings.pluginConfig<Record<string, string>>(this.def.id);
    if (!saved) return undefined;
    const out: Cfg = {};
    for (const f of this.def.fields) {
      const raw = saved[f.key];
      if (typeof raw !== "string" || raw === "") continue;
      if (f.secret) {
        const plain = open(raw, this.ctx.secret, this.purpose);
        if (plain) out[f.key] = plain;
      } else out[f.key] = raw;
    }
    return out;
  }

  configured(): boolean {
    return this.def.isConfigured(this.config());
  }

  /** `patch[key]`: a string sets it, null clears it, an empty string on a secret keeps it. */
  saveConfig(patch: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const saved = { ...(this.ctx.settings.pluginConfig<Record<string, string>>(this.def.id) ?? {}) };
    for (const f of this.def.fields) {
      if (!(f.key in patch)) continue;
      const v = patch[f.key];
      if (v === null) {
        delete saved[f.key];
        continue;
      }
      if (typeof v !== "string") return { ok: false, error: `invalid_${f.key}` };
      const t = v.trim();
      if (t === "" && f.secret) continue;
      if (t === "") {
        delete saved[f.key];
        continue;
      }
      if (t.length > FIELD_MAX || hasControlOrSpace(t)) return { ok: false, error: `invalid_${f.key}` };
      saved[f.key] = f.secret ? seal(t, this.ctx.secret, this.purpose) : t;
    }
    this.ctx.settings.setPluginConfig(this.def.id, Object.keys(saved).length ? saved : null);
    // New credentials mean cached app tokens may belong to a different app.
    this.appTokens.clear();
    return { ok: true };
  }

  redirectUri(req: FastifyRequest): string {
    const origin = this.ctx.config.publicUrl ?? `${req.protocol}://${req.headers.host ?? "localhost"}`;
    return `${origin}${this.base}/callback`;
  }

  // ---- tokens -------------------------------------------------------------

  private readTokens(userId: number): StoredTokens | null {
    const s = this.ctx.settings.pluginUserConfig<StoredTokens>(this.def.id, userId);
    if (!s?.access) return null;
    const access = open(s.access, this.ctx.secret, `${this.purpose}:user`);
    if (!access) return null;
    const refresh = s.refresh ? (open(s.refresh, this.ctx.secret, `${this.purpose}:user`) ?? undefined) : undefined;
    return { access, refresh, expiresAt: s.expiresAt };
  }

  private writeTokens(userId: number, t: TokenSet): void {
    this.ctx.settings.setPluginUserConfig(this.def.id, userId, {
      access: seal(t.accessToken, this.ctx.secret, `${this.purpose}:user`),
      refresh: t.refreshToken ? seal(t.refreshToken, this.ctx.secret, `${this.purpose}:user`) : undefined,
      expiresAt: t.expiresAt,
    });
  }

  connected(userId: number): boolean {
    return this.readTokens(userId) !== null;
  }

  disconnect(userId: number): void {
    this.ctx.settings.setPluginUserConfig(this.def.id, userId, null);
  }

  /**
   * A usable access token for this person, refreshed when it is about to expire.
   * Refresh tokens can be single-use, so concurrent callers share one refresh.
   */
  async userToken(userId: number, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
    const tokens = this.readTokens(userId);
    if (!tokens) throw new StreamAuthError("not_connected");
    if (tokens.expiresAt === undefined || tokens.expiresAt - nowSec > REFRESH_MARGIN_SEC) return tokens.access;

    const running = this.refreshing.get(userId);
    if (running) return running;
    const job = (async () => {
      const cfg = this.config();
      const oauth = this.def.oauth;
      if (!cfg || !oauth?.refresh || !tokens.refresh) {
        this.disconnect(userId);
        throw new StreamAuthError("expired");
      }
      try {
        const fresh = await oauth.refresh(cfg, tokens.refresh, this.fetchFn);
        // Keep the old refresh token if the service did not rotate it.
        this.writeTokens(userId, { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refresh });
        return fresh.accessToken;
      } catch (e) {
        // A refused refresh means the grant is gone; a network blip leaves the tokens alone.
        if (e instanceof UpstreamError && (e.kind === "unauthorized" || e.kind === "forbidden" || e.status === 400)) {
          this.disconnect(userId);
          throw new StreamAuthError("expired");
        }
        throw e;
      }
    })().finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, job);
    return job;
  }

  /** A server-wide token (client credentials), cached until shortly before it expires. */
  async appToken(key: string, mint: () => Promise<{ token: string; expiresInSec: number }>, nowMs = Date.now()): Promise<string> {
    const hit = this.appTokens.get(key);
    if (hit?.inflight) return hit.inflight;
    if (hit && hit.expiresAt - nowMs > REFRESH_MARGIN_SEC * 1000) return hit.token;
    const inflight = mint()
      .then((r) => {
        this.appTokens.set(key, { token: r.token, expiresAt: nowMs + r.expiresInSec * 1000 });
        return r.token;
      })
      .catch((e) => {
        this.appTokens.delete(key);
        throw e;
      });
    this.appTokens.set(key, { token: "", expiresAt: 0, inflight });
    return inflight;
  }

  /** Forget a cached app token the service refused. */
  dropAppToken(key: string): void {
    this.appTokens.delete(key);
  }

  // ---- answers --------------------------------------------------------------

  notConfigured(reply: FastifyReply) {
    return reply.code(409).send({ error: `${this.def.slug}_not_configured`, message: `${this.def.name} isn't set up on this server` });
  }

  /** Run `fn`, turning failures into the right (fixed-text) answers. */
  async guard(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<unknown>, opts: { userCall?: boolean } = {}) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StreamAuthError) {
        const expired = e.reason === "expired";
        return reply.code(409).send({
          error: `${this.def.slug}_${expired ? "session_expired" : "not_connected"}`,
          message: expired ? `Your ${this.def.name} sign-in expired. Connect again.` : `Connect ${this.def.name} first`,
        });
      }
      if (e instanceof UpstreamError) {
        if (opts.userCall && e.kind === "unauthorized" && req.user) {
          this.disconnect(req.user.id);
          return reply.code(409).send({
            error: `${this.def.slug}_session_expired`,
            message: `Your ${this.def.name} sign-in expired. Connect again.`,
          });
        }
        if (e.kind === "not_found") return reply.code(404).send({ error: "not_found" });
        req.log.warn({ kind: e.kind, status: e.status }, `${this.def.name} call failed`);
        return reply.code(502).send({ error: `${this.def.slug}_failed`, message: publicMessage(this.def.name, e) });
      }
      req.log.error({ err: e }, `${this.def.name} handler failed`);
      return reply.code(500).send({ error: "internal_error" });
    }
  }

  /** Limit proxied lookups per person so one client cannot burn the owner's API quota. */
  limited(req: FastifyRequest, reply: FastifyReply): boolean {
    const key = String(req.user!.id);
    if (this.searchLimiter.isLimited(key)) {
      void reply.code(429).send({ error: "rate_limited", message: "Too many searches. Wait a moment." });
      return true;
    }
    this.searchLimiter.hit(key);
    return false;
  }

  // ---- routes every service shares -----------------------------------------

  registerCommon(): void {
    const { app, def } = this;
    const { requireUser, requireAdmin } = this.ctx;
    const base = this.base;

    app.get(`${base}/status`, { preHandler: requireUser }, async (req): Promise<StreamStatus> => ({
      service: def.slug,
      name: def.name,
      configured: this.configured(),
      connected: def.oauth ? this.connected(req.user!.id) : true,
      hasLogin: !!def.oauth,
      loginError: this.loginErrors.get(req.user!.id),
      features: def.features,
    }));

    app.get(`${base}/config`, { preHandler: requireAdmin }, async (req) => {
      const cfg = this.config() ?? {};
      return {
        configured: this.configured(),
        redirectUri: def.oauth ? this.redirectUri(req) : undefined,
        fields: def.fields.map((f) => ({
          key: f.key,
          label: f.label,
          hint: f.hint,
          secret: !!f.secret,
          optional: !!f.optional,
          set: !!cfg[f.key],
          // Secrets are write-only: they are never sent back.
          value: f.secret ? undefined : cfg[f.key],
        })),
      };
    });

    app.put<{ Body: Record<string, unknown> }>(`${base}/config`, { preHandler: requireAdmin }, async (req, reply) => {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const result = this.saveConfig(body);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      return reply.code(204).send();
    });

    const oauth = def.oauth;
    if (!oauth) return;

    app.post(`${base}/connect/start`, { preHandler: requireUser }, async (req, reply) => {
      const cfg = this.config();
      if (!cfg || !def.isConfigured(cfg)) return this.notConfigured(reply);
      this.purgePending();
      const userId = req.user!.id;
      this.loginErrors.delete(userId);
      for (const [s, p] of this.pending) if (p.userId === userId) this.pending.delete(s);
      const state = newState();
      const pkce = oauth.pkce ? newPkce() : undefined;
      const redirectUri = this.redirectUri(req);
      this.pending.set(state, { userId, verifier: pkce?.verifier, redirectUri, expiresAt: Date.now() + PENDING_TTL_MS });
      return { url: oauth.authorizeUrl(cfg, { redirectUri, state, challenge: pkce?.challenge }) };
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(`${base}/callback`, async (req, reply) => {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").type("text/html; charset=utf-8");
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      const { code, state, error } = req.query;
      const entry = typeof state === "string" ? this.pending.get(state) : undefined;
      if (typeof state === "string") this.pending.delete(state);
      if (!entry || entry.expiresAt < Date.now()) {
        return reply.code(400).send(page("Sign-in link expired", `Start the ${def.name} connection again from Cadence.`));
      }
      if (error || typeof code !== "string" || !code) {
        this.loginErrors.set(entry.userId, `${def.name} did not allow the connection.`);
        return reply.code(400).send(page(`${def.name} was not connected`, "You can close this window and try again from Cadence."));
      }
      const cfg = this.config();
      if (!cfg || !def.isConfigured(cfg)) return reply.code(409).send(page("Not set up", `${def.name} isn't configured on this server.`));
      try {
        const tokens = await oauth.exchange(cfg, { code, redirectUri: entry.redirectUri, verifier: entry.verifier }, this.fetchFn);
        this.writeTokens(entry.userId, tokens);
        this.loginErrors.delete(entry.userId);
      } catch (e) {
        req.log.warn({ kind: e instanceof UpstreamError ? e.kind : "error", status: e instanceof UpstreamError ? e.status : undefined }, `${def.name} sign-in failed`);
        this.loginErrors.set(entry.userId, `${def.name} sign-in failed. Check the app credentials and redirect address.`);
        return reply.code(502).send(page(`${def.name} was not connected`, "The sign-in could not be completed. You can close this window."));
      }
      return reply.send(page(`${def.name} connected`, "You can close this window and return to Cadence."));
    });

    app.delete(`${base}/connection`, { preHandler: requireUser }, async (req, reply) => {
      this.disconnect(req.user!.id);
      return reply.code(204).send();
    });
  }

  private purgePending(): void {
    const now = Date.now();
    for (const [s, p] of this.pending) if (p.expiresAt < now) this.pending.delete(s);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}

export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function textParam(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Service ids are numeric or short slugs; anything else never goes into an upstream URL. */
export function idParam(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}
