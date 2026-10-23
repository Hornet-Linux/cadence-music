import type { FastifyRequest } from "fastify";
import { RateLimiter } from "../../auth/rateLimit.js";
import type { ServerPlugin, ServerPluginContext } from "../../plugins/types.js";
import { randomToken, safeEqual, sha256 } from "../../util/crypto.js";
import { DeviceHub, deviceHub } from "../_devices/deviceHub.js";
import { parseAddress } from "../_devices/net.js";
import { commandFromBody, pickDevice } from "./commands.js";
import { buildHaState, checkConnection, ENTITY_RE, pushState, type HaTarget } from "./haState.js";
import { open, seal } from "./secretBox.js";

export const HOME_ASSISTANT_PLUGIN_ID = "cadence.home-assistant";
const KEY_PREFIX = `plugin:${HOME_ASSISTANT_PLUGIN_ID}:user:`;
const COMMAND_TOKEN_PREFIX = "cadha_";

interface UserConfig {
  url?: string;
  tokenSealed?: string;
  entityId?: string;
  commandTokenHash?: string;
  commandTokenAt?: number;
}

export interface HomeAssistantOptions {
  hub?: DeviceHub;
  /** Minimum gap between pushes that only refresh the position. */
  refreshMs?: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "user";

/**
 * Home Assistant integration. Cadence pushes the now-playing state to an entity with the official REST API
 * (POST /api/states/<entity_id>), and accepts commands from Home Assistant on a per-user, token-protected
 * endpoint. It relies on the remote-control relay to know the player state and to reach a player.
 */
export function createHomeAssistantPlugin(options: HomeAssistantOptions = {}): ServerPlugin {
  const hub = options.hub ?? deviceHub;
  return {
    id: HOME_ASSISTANT_PLUGIN_ID,
    name: "Home Assistant",
    version: "1.0.0",
    description:
      "Pushes what is playing to a Home Assistant entity through its official REST API and accepts commands (play, pause, skip, volume) from Home Assistant on a token-protected endpoint. Each person sets up their own link.",
    configFields: [],
    configNote:
      "Nothing to set here. Each person adds their Home Assistant address and access token in the player under Settings > Plugins > Home Assistant; tokens are stored encrypted.",
    register(app, ctx) {
      const users = new UserStore(ctx);
      registerConfigRoutes(app, ctx, users, hub);
      registerCommandRoutes(app, ctx, users, hub);
      startPushing(app, ctx, users, hub, options.refreshMs ?? 60_000);
    },
  };
}

type App = Parameters<ServerPlugin["register"]>[0];

class UserStore {
  constructor(private readonly ctx: ServerPluginContext) {}

  get(userId: number): UserConfig {
    return this.ctx.settings.pluginUserConfig<UserConfig>(HOME_ASSISTANT_PLUGIN_ID, userId) ?? {};
  }

  set(userId: number, cfg: UserConfig): void {
    const empty = !cfg.url && !cfg.tokenSealed && !cfg.commandTokenHash;
    this.ctx.settings.setPluginUserConfig(HOME_ASSISTANT_PLUGIN_ID, userId, empty ? null : cfg);
  }

  target(userId: number, username: string): HaTarget | null {
    const cfg = this.get(userId);
    const token = cfg.tokenSealed ? open(this.ctx.secret, cfg.tokenSealed) : null;
    if (!cfg.url || !token) return null;
    return { url: cfg.url, token, entityId: cfg.entityId ?? `media_player.cadence_${slug(username)}` };
  }

  /** The user whose command token this is, if any. */
  userForCommandToken(token: string): number | null {
    if (!token.startsWith(COMMAND_TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const rows = this.ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${KEY_PREFIX}%`) as { key: string; value: string }[];
    for (const row of rows) {
      try {
        const cfg = JSON.parse(row.value) as UserConfig;
        if (cfg.commandTokenHash && safeEqual(cfg.commandTokenHash, hash)) return Number(row.key.slice(KEY_PREFIX.length));
      } catch {
        // skip unreadable rows
      }
    }
    return null;
  }
}

function registerConfigRoutes(app: App, ctx: ServerPluginContext, users: UserStore, hub: DeviceHub): void {
  const view = (userId: number, username: string) => {
    const cfg = users.get(userId);
    return {
      url: cfg.url ?? null,
      entityId: cfg.entityId ?? `media_player.cadence_${slug(username)}`,
      hasToken: Boolean(cfg.tokenSealed),
      hasCommandToken: Boolean(cfg.commandTokenHash),
      commandTokenCreatedAt: cfg.commandTokenAt ?? null,
      relayActive: hub.active,
    };
  };

  app.get("/api/home-assistant/config", { preHandler: ctx.requireUser }, async (req) => view(req.user!.id, req.user!.username));

  app.put<{ Body: { url?: string; token?: string; entityId?: string } }>(
    "/api/home-assistant/config",
    { preHandler: ctx.requireUser },
    async (req, reply) => {
      const user = req.user!;
      const cfg = users.get(user.id);
      const { url, token, entityId } = req.body ?? {};
      if (url !== undefined) {
        const parsed = typeof url === "string" ? parseAddress(url, 8123) : null;
        if (!parsed) return reply.code(400).send({ error: "invalid_url", message: "Use an address such as http://homeassistant.local:8123." });
        cfg.url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
      }
      if (token !== undefined) {
        if (typeof token !== "string" || token.length > 4096) return reply.code(400).send({ error: "invalid_token" });
        if (token.trim()) cfg.tokenSealed = seal(ctx.secret, token.trim());
      }
      if (entityId !== undefined) {
        if (entityId && !ENTITY_RE.test(entityId)) {
          return reply.code(400).send({ error: "invalid_entity", message: "An entity id looks like media_player.cadence." });
        }
        cfg.entityId = entityId || undefined;
      }
      users.set(user.id, cfg);
      return view(user.id, user.username);
    },
  );

  app.delete("/api/home-assistant/config", { preHandler: ctx.requireUser }, async (req) => {
    const cfg = users.get(req.user!.id);
    // Keep the command token: it is a separate credential with its own button.
    users.set(req.user!.id, { commandTokenHash: cfg.commandTokenHash, commandTokenAt: cfg.commandTokenAt });
    return view(req.user!.id, req.user!.username);
  });

  app.post("/api/home-assistant/test", { preHandler: ctx.requireUser }, async (req, reply) => {
    const target = users.target(req.user!.id, req.user!.username);
    if (!target) return reply.code(409).send({ error: "not_configured", message: "Enter the Home Assistant URL and a token first." });
    const conn = await checkConnection(target);
    if (!conn.ok) return reply.code(502).send({ error: "home_assistant_error", message: conn.message });
    const active = hub.activeDevice(req.user!.id);
    const sent = await pushState(target, buildHaState(active, `Cadence (${req.user!.username})`));
    if (!sent.ok) return reply.code(502).send({ error: "home_assistant_error", message: sent.message });
    return { ok: true, entityId: target.entityId, message: `Connected. ${target.entityId} was updated.` };
  });

  app.post("/api/home-assistant/command-token", { preHandler: ctx.requireUser }, async (req) => {
    const cfg = users.get(req.user!.id);
    const token = `${COMMAND_TOKEN_PREFIX}${randomToken(32)}`;
    cfg.commandTokenHash = sha256(token);
    cfg.commandTokenAt = Date.now();
    users.set(req.user!.id, cfg);
    // The token is shown once; only its hash is kept.
    return { token, createdAt: cfg.commandTokenAt };
  });

  app.delete("/api/home-assistant/command-token", { preHandler: ctx.requireUser }, async (req) => {
    const cfg = users.get(req.user!.id);
    delete cfg.commandTokenHash;
    delete cfg.commandTokenAt;
    users.set(req.user!.id, cfg);
    return view(req.user!.id, req.user!.username);
  });
}

function registerCommandRoutes(app: App, ctx: ServerPluginContext, users: UserStore, hub: DeviceHub): void {
  const failures = new RateLimiter({ max: 20, windowMs: 60_000 });

  /** Authenticate the Home Assistant side by its per-user command token (not a login session). */
  const commandUser = (req: FastifyRequest): number | "limited" | null => {
    if (failures.isLimited(req.ip)) return "limited";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const userId = token ? users.userForCommandToken(token) : null;
    if (userId === null) failures.hit(req.ip);
    return userId;
  };

  app.post<{ Body: Record<string, unknown> }>("/api/home-assistant/command", async (req, reply) => {
    const userId = commandUser(req);
    if (userId === "limited") return reply.code(429).send({ error: "too_many_attempts" });
    if (userId === null) return reply.code(401).send({ error: "unauthorized" });
    if (!hub.active) {
      return reply.code(503).send({ error: "relay_off", message: "Turn on the Remote control plugin so Cadence can reach your players." });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const device = pickDevice(hub.list(userId), body["device"], hub.activeDevice(userId));
    if (!device) {
      return reply.code(409).send({ error: "no_player", message: "No Cadence player is open. Open Cadence on a device first." });
    }
    const command = commandFromBody(body, device);
    if (!command) return reply.code(400).send({ error: "invalid_command" });
    const result = hub.deliver(userId, device.id, command, null);
    if (result !== "delivered") return reply.code(409).send({ error: "device_offline", message: `${device.name} is offline.` });
    return { ok: true, device: device.name };
  });

  /** For a Home Assistant REST sensor that prefers to poll. */
  app.get("/api/home-assistant/now-playing", async (req, reply) => {
    const userId = commandUser(req);
    if (userId === "limited") return reply.code(429).send({ error: "too_many_attempts" });
    if (userId === null) return reply.code(401).send({ error: "unauthorized" });
    const row = ctx.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
    return buildHaState(hub.activeDevice(userId), `Cadence (${row?.username ?? "user"})`);
  });
}

function startPushing(app: App, ctx: ServerPluginContext, users: UserStore, hub: DeviceHub, refreshMs: number): void {
  interface Last {
    sig: string;
    at: number;
    position: number;
    playing: boolean;
    retryAt: number;
    inFlight: boolean;
    dirty: boolean;
  }
  const last = new Map<number, Last>();

  async function push(userId: number): Promise<void> {
    const row = ctx.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
    if (!row) return;
    const target = users.target(userId, row.username);
    if (!target) return;
    const device = hub.activeDevice(userId);
    const s = device?.state;
    const sig = [device?.id, device?.online, s?.track?.id, s?.isPlaying, s ? Math.round(s.volume * 20) : ""].join("|");
    const now = Date.now();
    let prev = last.get(userId);
    if (!prev) last.set(userId, (prev = { sig: "", at: 0, position: 0, playing: false, retryAt: 0, inFlight: false, dirty: false }));
    if (now < prev.retryAt) return;
    if (prev.inFlight) {
      prev.dirty = true;
      return;
    }
    // A seek shows up as the position leaving the path it was already on.
    const expected = prev.playing ? prev.position + (now - prev.at) / 1000 : prev.position;
    const jumped = s ? Math.abs(s.position - expected) > 5 : false;
    if (prev.sig === sig && !jumped && now - prev.at < refreshMs) return;
    prev.inFlight = true;
    try {
      const result = await pushState(target, buildHaState(device, `Cadence (${row.username})`));
      if (result.ok) {
        Object.assign(prev, { sig, at: now, position: s?.position ?? 0, playing: s?.isPlaying === true, retryAt: 0 });
      } else {
        ctx.log.warn({ status: result.status }, "Home Assistant state push failed");
        prev.retryAt = now + 60_000;
      }
    } finally {
      prev.inFlight = false;
      if (prev.dirty) {
        prev.dirty = false;
        void push(userId);
      }
    }
  }

  const trigger = (userId: number) => void push(userId).catch((err) => ctx.log.warn({ err }, "Home Assistant push failed"));
  const stops = [hub.onState((e) => trigger(e.userId)), hub.onPresence((userId) => trigger(userId))];
  app.addHook("onClose", async () => stops.forEach((stop) => stop()));
}

export default createHomeAssistantPlugin();
