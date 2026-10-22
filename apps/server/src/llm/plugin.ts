import type {
  AdminLlmProviderInput,
  DjPicksRequest,
  DjPicksResponse,
  LlmDeviceRegistration,
  LlmProviderInfo,
  LlmProvidersResponse,
  LlmRelayResult,
  LlmStatusResponse,
} from "@uma/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerPlugin } from "../plugins/types.js";
import {
  buildDjMessages,
  cleanReply,
  createProvider,
  DJ_SCHEMA,
  LlmError,
  PRESETS,
  PROVIDER_KINDS,
  parseProviderConfig,
  type FetchFn,
  type LlmProvider,
  type LlmStatus,
  type ProviderKind,
} from "./core/index.js";
import { MAX_DEVICES_PER_USER, RelayHub } from "./relay.js";
import { ProviderStore } from "./store.js";

const DEVICE_ID_RE = /^[\w-]{8,64}$/;
const MAX_LIST = 60;
const MAX_LINE = 200;
/** AI DJ requests per person: a few sets an hour is plenty and bounds API spend. */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 20;
const HEARTBEAT_MS = 20_000;

const strings = (value: unknown, max = MAX_LIST): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, MAX_LINE)).filter(Boolean).slice(0, max)
    : [];

const MAX_NAME = 60;
const MAX_MODEL = 200;
const MAX_API_KEY = 512;
const MAX_ERROR = 300;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** An error message from a person's own device (or an admin's view): length-limited, one line. */
export function deviceMessage(text: string): string {
  return text.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_ERROR) || "The AI provider failed.";
}

const GENERIC_FAILURE = "The AI provider failed. Ask the server owner to check it.";

/** What a non-admin may learn about a failed server provider: a fixed phrase, never upstream text. */
export function publicMessage(e: unknown): string {
  const status = e instanceof LlmError ? e.status : undefined;
  const text = e instanceof Error ? e.message : "";
  if (status === 401 || status === 403 || /rejected the API key/i.test(text)) {
    return "The AI provider rejected its API key. Ask the server owner to check it.";
  }
  if (/wasn't found on that server|isn't installed/i.test(text)) {
    return "The AI provider doesn't have the configured model. Ask the server owner to check it.";
  }
  if (/timed out|took too long/i.test(text)) {
    return "The AI provider took too long to answer. Ask the server owner to check it.";
  }
  if (/^Couldn't reach/i.test(text)) return "The AI provider couldn't be reached. Ask the server owner to check it.";
  return GENERIC_FAILURE;
}

/** Same idea for the `error` field of a status check. */
export function publicStatusError(text: string): string {
  if (/rejected the API key/i.test(text)) return "The AI provider rejected its API key.";
  return "The AI provider isn't available.";
}

/** A status reply from a device is untrusted data: keep only what the type promises, bounded. */
export function cleanStatus(value: unknown): LlmStatus {
  const v = (value ?? {}) as Partial<LlmStatus>;
  const models = Array.isArray(v.models)
    ? v.models.filter((m): m is string => typeof m === "string").slice(0, 200).map((m) => m.slice(0, MAX_MODEL))
    : [];
  return {
    available: v.available === true,
    models,
    ...(typeof v.error === "string" ? { error: deviceMessage(v.error) } : {}),
  };
}

/** A base URL with credentials, a query string or a fragment is never what an admin means. */
function plainBaseUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return true; // parseProviderConfig reports the type error
  try {
    const u = new URL(raw.trim());
    return !u.username && !u.password && !u.search && !u.hash && !raw.includes("?") && !raw.includes("#");
  } catch {
    return true; // parseProviderConfig reports the bad URL
  }
}

function parseAdminInput(body: unknown): AdminLlmProviderInput | string {
  const b = (body ?? {}) as Partial<AdminLlmProviderInput>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > MAX_NAME) return "invalid_name";
  if (!b.model || typeof b.model !== "string" || !b.model.trim() || b.model.trim().length > MAX_MODEL) return "invalid_model";
  if (b.apiKey !== undefined && (typeof b.apiKey !== "string" || b.apiKey.length > MAX_API_KEY)) return "invalid_key";
  if (!plainBaseUrl(b.baseUrl)) return "invalid_provider";
  try {
    const cfg = parseProviderConfig({ kind: b.kind, baseUrl: b.baseUrl, model: b.model });
    return {
      name,
      kind: cfg.kind,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: b.apiKey?.trim(),
      enabled: b.enabled,
      isDefault: b.isDefault,
    };
  } catch (e) {
    return e instanceof LlmError ? "invalid_provider" : "invalid_request";
  }
}

function parseRegistration(body: unknown): LlmDeviceRegistration | null {
  const b = (body ?? {}) as Partial<LlmDeviceRegistration>;
  if (typeof b.deviceId !== "string" || !DEVICE_ID_RE.test(b.deviceId)) return null;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name || !Array.isArray(b.providers)) return null;
  const providers: LlmDeviceRegistration["providers"] = [];
  for (const p of b.providers.slice(0, 10)) {
    if (!p || typeof p.id !== "string" || !/^[\w-]{1,40}$/.test(p.id)) continue;
    if (typeof p.name !== "string" || typeof p.model !== "string") continue;
    if (!PROVIDER_KINDS.includes(p.kind as ProviderKind)) continue;
    providers.push({ id: p.id, name: p.name.trim().slice(0, 60), kind: p.kind, model: p.model.trim().slice(0, 100) });
  }
  return { deviceId: b.deviceId, name, providers };
}

export interface LlmPluginOptions {
  /** Lets tests stand in for the network when the server calls a provider. */
  fetchFn?: FetchFn;
}

/**
 * The AI DJ's brain lives on the server so every app (desktop, web, iOS,
 * Android) can use it. The server calls providers the owner configured, and
 * can reach a provider on a person's own computer through a relay. Keys saved
 * here are never sent to a client.
 */
export function createLlmPlugin(options: LlmPluginOptions = {}): ServerPlugin {
  return {
    id: "core.llm",
    name: "LLM providers and AI DJ",
    version: "1.0.0",
    register(app, ctx) {
      const { requireUser, requireAdmin } = ctx;
      const store = new ProviderStore(ctx.db, ctx.secret);
      const hub = new RelayHub();
      const cache = new Map<string, { updatedAt: number; provider: LlmProvider }>();
      const recent = new Map<number, number[]>();
      const busy = new Set<number>();

      function serverProvider(id: string): LlmProvider | null {
        const cfg = store.config(id);
        if (!cfg) {
          cache.delete(id);
          return null;
        }
        const hit = cache.get(id);
        if (hit && hit.updatedAt === cfg.updatedAt) return hit.provider;
        const provider = createProvider(cfg, options.fetchFn);
        cache.set(id, { updatedAt: cfg.updatedAt, provider });
        return provider;
      }

      /** `server:<id>` or `device:<deviceId>:<providerId>`; devices must belong to `userId`. */
      function resolve(ref: string, userId: number): LlmProvider | null {
        const [scope, a, b] = ref.split(":");
        if (scope === "server" && a) return serverProvider(a);
        if (scope === "device" && a && b) {
          const device = hub.devicesFor(userId).find((d) => d.deviceId === a);
          return device?.providers.some((p) => p.id === b) ? hub.provider(userId, a, b) : null;
        }
        return null;
      }

      function defaultRef(): string | undefined {
        const all = store.list().filter((p) => p.enabled);
        const pick = all.find((p) => p.isDefault) ?? all[0];
        return pick ? `server:${pick.id}` : undefined;
      }

      /**
       * Errors from a server provider can carry text from the upstream response
       * or network details of the server's own network, so only admins see them.
       * Everyone else gets a fixed phrase. Errors from a person's own device
       * are theirs to read (length-limited, no control characters).
       */
      function fail(req: FastifyRequest, reply: FastifyReply, e: unknown, ref: string | undefined) {
        const detail = e instanceof Error ? e.message : String(e);
        const device = ref?.startsWith("device:") === true;
        if (!device) req.log.warn({ detail: detail.slice(0, 500), provider: ref }, "AI provider call failed");
        const message = device ? deviceMessage(detail) : req.user?.is_admin === 1 ? deviceMessage(detail) : publicMessage(e);
        return reply.code(502).send({ error: "llm_failed", message });
      }

      /** Strip the detail from a status result about a server provider for non-admins. */
      function publicStatus(req: FastifyRequest, raw: unknown, ref: string): LlmStatus {
        const status = cleanStatus(raw);
        if (ref.startsWith("device:") || req.user?.is_admin === 1) return status;
        if (status.error) req.log.warn({ detail: status.error, provider: ref }, "AI provider status failed");
        return status.error ? { ...status, error: publicStatusError(status.error) } : status;
      }

      // ---- what people can choose from ----------------------------------------

      app.get("/api/llm/presets", { preHandler: requireUser }, async () => ({ items: PRESETS }));

      app.get("/api/llm/providers", { preHandler: requireUser }, async (req): Promise<LlmProvidersResponse> => {
        const def = defaultRef();
        const items: LlmProviderInfo[] = store
          .list()
          .filter((p) => p.enabled)
          .map((p) => ({
            ref: `server:${p.id}`,
            name: p.name,
            kind: p.kind,
            model: p.model,
            scope: "server" as const,
            isDefault: `server:${p.id}` === def,
          }));
        for (const d of hub.devicesFor(req.user!.id)) {
          for (const p of d.providers) {
            items.push({
              ref: `device:${d.deviceId}:${p.id}`,
              name: p.name,
              kind: p.kind,
              model: p.model,
              scope: "device",
              deviceName: d.name,
            });
          }
        }
        return { items };
      });

      app.post<{ Body: { provider?: string } }>("/api/llm/status", { preHandler: requireUser }, async (req, reply) => {
        const ref = req.body?.provider ?? defaultRef();
        const provider = ref ? resolve(ref, req.user!.id) : null;
        if (!provider || !ref) return reply.code(404).send({ error: "provider_not_found" });
        try {
          return publicStatus(req, await provider.status(), ref) satisfies LlmStatusResponse;
        } catch (e) {
          return fail(req, reply, e, ref);
        }
      });

      // ---- the DJ -----------------------------------------------------------------

      app.post<{ Body: DjPicksRequest }>("/api/dj/picks", { preHandler: requireUser }, async (req, reply) => {
        const userId = req.user!.id;
        const ref = typeof req.body?.provider === "string" ? req.body.provider : defaultRef();
        if (!ref) return reply.code(409).send({ error: "no_provider", message: "No AI provider is set up on this server" });
        const provider = resolve(ref, userId);
        if (!provider) return reply.code(404).send({ error: "provider_not_found" });

        const p = req.body?.profile;
        if (!p || typeof p !== "object") return reply.code(400).send({ error: "invalid_profile" });
        const messages = buildDjMessages(
          {
            topArtists: strings(p.topArtists),
            genres: strings(p.genres),
            topTracks: strings(p.topTracks),
            recentTracks: strings(p.recentTracks),
          },
          {
            mood: typeof req.body.mood === "string" ? req.body.mood.trim().slice(0, 200) : undefined,
            switchUp: req.body.switchUp === true,
            avoid: strings(req.body.avoid, 80),
            count: Math.min(20, Math.max(1, Math.trunc(Number(req.body.count)) || 8)),
          },
        );

        const now = Date.now();
        const times = (recent.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
        if (times.length >= RATE_MAX) return reply.code(429).send({ error: "rate_limited" });
        if (busy.has(userId)) return reply.code(429).send({ error: "busy" });
        recent.set(userId, [...times, now]);

        busy.add(userId);
        try {
          const picks = cleanReply(await provider.chatJson({ messages, schema: DJ_SCHEMA as unknown as Record<string, unknown> }));
          return { picks } satisfies DjPicksResponse;
        } catch (e) {
          return fail(req, reply, e, ref);
        } finally {
          busy.delete(userId);
        }
      });

      // ---- admin: server providers --------------------------------------------

      app.get("/api/admin/llm/providers", { preHandler: requireAdmin }, async () => ({ items: store.list() }));

      app.post("/api/admin/llm/providers", { preHandler: requireAdmin }, async (req, reply) => {
        const input = parseAdminInput(req.body);
        if (typeof input === "string") return reply.code(400).send({ error: input });
        const created = store.create(input);
        req.log.info({ admin: req.user!.username, provider: created.id }, "admin added an LLM provider");
        return reply.code(201).send(created);
      });

      app.put<{ Params: { id: string } }>("/api/admin/llm/providers/:id", { preHandler: requireAdmin }, async (req, reply) => {
        const input = parseAdminInput(req.body);
        if (typeof input === "string") return reply.code(400).send({ error: input });
        const updated = store.update(req.params.id, input);
        if (!updated) return reply.code(404).send({ error: "not_found" });
        cache.delete(req.params.id);
        return updated;
      });

      app.delete<{ Params: { id: string } }>("/api/admin/llm/providers/:id", { preHandler: requireAdmin }, async (req, reply) => {
        if (!store.remove(req.params.id)) return reply.code(404).send({ error: "not_found" });
        cache.delete(req.params.id);
        return reply.code(204).send();
      });

      // Try settings before saving them. With `id` and no key, the saved key is used.
      app.post<{ Body: { id?: string; kind?: string; baseUrl?: string; model?: string; apiKey?: string } }>(
        "/api/admin/llm/test",
        { preHandler: requireAdmin },
        async (req, reply) => {
          try {
            const b = req.body ?? {};
            if (!plainBaseUrl(b.baseUrl) || (b.apiKey !== undefined && (typeof b.apiKey !== "string" || b.apiKey.length > MAX_API_KEY))) {
              return reply.code(400).send({ error: "invalid_provider", message: "Invalid URL or key" });
            }
            const apiKey = b.apiKey || (b.id ? store.apiKey(b.id) : undefined);
            const config = parseProviderConfig({ kind: b.kind, baseUrl: b.baseUrl, model: b.model ?? "", apiKey });
            return await createProvider(config, options.fetchFn).status();
          } catch (e) {
            return reply.code(400).send({ error: "invalid_provider", message: e instanceof Error ? e.message : String(e) });
          }
        },
      );

      // ---- a person's own computers -------------------------------------------

      // The app keeps this request open. The response is a server-sent event
      // stream carrying jobs for the providers it offered.
      app.post("/api/llm/devices/connect", { preHandler: requireUser }, async (req, reply) => {
        const registration = parseRegistration(req.body);
        if (!registration) return reply.code(400).send({ error: "invalid_registration" });
        if (!hub.canAttach(req.user!.id, registration.deviceId)) {
          return reply.code(429).send({ error: "too_many_devices", message: `At most ${MAX_DEVICES_PER_USER} devices can be connected at once` });
        }
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*",
        });
        // Writing to a stream that has closed (or is closing) must never throw.
        const write = (chunk: string): boolean => {
          if (raw.destroyed || raw.writableEnded) return false;
          try {
            raw.write(chunk);
            return true;
          } catch {
            return false;
          }
        };
        write("event: ready\ndata: {}\n\n");
        const detach = hub.attach(
          req.user!.id,
          registration,
          (job) => {
            if (!write(`event: job\ndata: ${JSON.stringify(job)}\n\n`)) throw new Error("stream closed");
          },
          () => {
            cleanup();
            if (!raw.writableEnded) raw.end();
          },
        );
        if (!detach) {
          raw.end();
          return;
        }
        const beat = setInterval(() => {
          if (!write(": keep-alive\n\n")) cleanup();
        }, HEARTBEAT_MS);
        // Runs on every way out (client closed, socket error, replaced, failed heartbeat); safe to call twice.
        let cleaned = false;
        function cleanup() {
          if (cleaned) return;
          cleaned = true;
          clearInterval(beat);
          raw.off("close", cleanup);
          raw.off("error", cleanup);
          detach?.();
        }
        raw.on("close", cleanup);
        raw.on("error", cleanup);
      });

      app.post<{ Params: { jobId: string }; Body: LlmRelayResult }>(
        "/api/llm/devices/jobs/:jobId",
        { preHandler: requireUser },
        async (req, reply) => {
          const body = req.body;
          const ok = body && typeof body === "object" && typeof body.ok === "boolean";
          if (!ok || !hub.complete(req.user!.id, req.params.jobId, body)) {
            return reply.code(404).send({ error: "unknown_job" });
          }
          return reply.code(204).send();
        },
      );
    },
  };
}

export const llmPlugin: ServerPlugin = createLlmPlugin();
