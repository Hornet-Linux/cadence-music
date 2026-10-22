import { randomUUID } from "node:crypto";
import { app, globalShortcut, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { acceleratorProblem, comparableAccelerator, normalizeAccelerator } from "./accelerator";
import { ControlError, ControlServer, generateToken, type ControlStatus } from "./controlServer";
import { APPLICATION_ID_RE, DiscordPresence, parseActivity, type DiscordStatus } from "./discordIpc";
import { featuresFor, readConfig, writeConfig, type IntegrationsConfig } from "./integrationsConfig";
import {
  SLACK_TOKEN_KEY,
  clearSlackStatus,
  parseSlackStatus,
  setSlackStatus,
  testSlackToken,
  type SlackResult,
} from "./slack";
import { deleteSecret, getSecret, setSecret } from "./secrets";

// Desktop integrations: Discord presence, global shortcuts, a local control API
// and Slack status. Everything here starts only when the matching plugin asks
// over IPC, and only requests from the app's own window are honoured.

export interface ShortcutResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ControlInfo extends ControlStatus {
  token: string | null;
}

export interface ControlRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const CONTROL_TOKEN_KEY = "control.token";
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_BINDINGS = 64;
const MAX_STATE_JSON = 32 * 1024;

/** Call before the app is ready: some Chromium features can only be switched on at launch. */
export function applyStartupSwitches(): void {
  const features = featuresFor(readConfig(app.getPath("userData")));
  if (features.length > 0) app.commandLine.appendSwitch("enable-features", features.join(","));
}

export function registerIntegrations(getWindow: () => BrowserWindow | null): void {
  const win = () => getWindow();
  const trusted = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const w = win();
    return !!w && !w.isDestroyed() && e.sender === w.webContents;
  };
  const guard = <T>(e: IpcMainInvokeEvent, fn: () => T): T => {
    if (!trusted(e)) throw new Error("Not allowed");
    return fn();
  };
  const emit = (channel: string, ...args: unknown[]) => {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  // ---- Discord ----------------------------------------------------------------
  const discord = new DiscordPresence();
  discord.onStatus((s: DiscordStatus) => emit("discord:status", s));
  ipcMain.handle("discord:start", (e, appId: unknown) =>
    guard(e, () => {
      if (typeof appId !== "string" || !APPLICATION_ID_RE.test(appId.trim())) {
        throw new Error("That is not a Discord application ID (a 17 to 20 digit number)");
      }
      discord.start(appId.trim());
      return discord.getStatus();
    }),
  );
  ipcMain.handle("discord:activity", (e, activity: unknown) =>
    guard(e, () => {
      if (activity === null) discord.setActivity(null);
      else {
        const parsed = parseActivity(activity);
        if (!parsed) throw new Error("Invalid activity");
        discord.setActivity(parsed);
      }
    }),
  );
  ipcMain.handle("discord:stop", (e) => guard(e, () => discord.stop()));
  ipcMain.handle("discord:status", (e) => guard(e, () => discord.getStatus()));

  // ---- Global shortcuts ---------------------------------------------------------
  ipcMain.handle("shortcuts:set", (e, bindings: unknown): ShortcutResult[] =>
    guard(e, () => {
      globalShortcut.unregisterAll();
      if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS) throw new Error("Invalid shortcuts");
      const taken = new Map<string, string>();
      const results: ShortcutResult[] = [];
      for (const raw of bindings) {
        const b = (raw ?? {}) as { id?: unknown; accelerator?: unknown };
        if (typeof b.id !== "string" || !/^[\w.:-]{1,100}$/.test(b.id) || typeof b.accelerator !== "string") {
          throw new Error("Invalid shortcut");
        }
        const id = b.id;
        const problem = acceleratorProblem(b.accelerator);
        const normalized = normalizeAccelerator(b.accelerator);
        const key = comparableAccelerator(b.accelerator, process.platform);
        if (problem || !normalized || !key) {
          results.push({ id, ok: false, error: problem ?? "That is not a valid shortcut" });
          continue;
        }
        const clash = taken.get(key);
        if (clash) {
          results.push({ id, ok: false, error: "Already used by another Cadence command" });
          continue;
        }
        let registered = false;
        try {
          registered = globalShortcut.register(normalized.replace("CmdOrCtrl", "CommandOrControl"), () => emit("shortcuts:triggered", id));
        } catch {
          registered = false;
        }
        if (registered) {
          taken.set(key, id);
          results.push({ id, ok: true });
        } else {
          results.push({ id, ok: false, error: "Another app is using this shortcut, or the system blocked it" });
        }
      }
      return results;
    }),
  );
  ipcMain.handle("shortcuts:clear", (e) => guard(e, () => globalShortcut.unregisterAll()));

  // ---- System media controls (applies after a restart) ----------------------------
  ipcMain.handle("system:media-controls", (e) => guard(e, () => readConfig(app.getPath("userData")).systemMediaControls));
  ipcMain.handle("system:set-media-controls", (e, on: unknown) =>
    guard(e, () => {
      if (typeof on !== "boolean") throw new Error("Invalid value");
      const dir = app.getPath("userData");
      const before = readConfig(dir);
      const next: IntegrationsConfig = { ...before, systemMediaControls: on };
      writeConfig(dir, next);
      return { restartRequired: before.systemMediaControls !== on };
    }),
  );
  ipcMain.handle("system:relaunch", (e) =>
    guard(e, () => {
      app.relaunch();
      app.exit(0);
    }),
  );

  // ---- Local control API ------------------------------------------------------------
  let control: ControlServer | null = null;
  let controlError: string | undefined;
  let controlToken: string | null = null;
  let latestState: unknown = null;
  let commandNames: string[] = [];
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const loadToken = (): string => {
    if (controlToken) return controlToken;
    let token = getSecret(CONTROL_TOKEN_KEY);
    if (!token) {
      token = generateToken();
      try {
        setSecret(CONTROL_TOKEN_KEY, token);
      } catch {
        // No secure storage: the token lasts until the app closes.
      }
    }
    controlToken = token;
    return token;
  };
  const controlInfo = (): ControlInfo => ({
    running: !!control && control.port != null,
    port: control?.port ?? null,
    error: controlError,
    clients: control?.clients ?? 0,
    token: control ? controlToken : null,
  });
  const runInApp = (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const w = win();
    if (!w || w.isDestroyed()) return Promise.reject(new ControlError("app_not_ready", 503));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ControlError("timed_out", 504));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      w.webContents.send("control:command", { id, name, args } satisfies ControlRequest);
    });
  };
  const stopControl = async () => {
    const c = control;
    control = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ControlError("stopped", 503));
    }
    pending.clear();
    await c?.stop();
  };
  const startControl = async (port: number) => {
    await stopControl();
    controlError = undefined;
    const server = new ControlServer({
      port,
      token: loadToken(),
      handlers: { run: runInApp, state: () => latestState, commands: () => commandNames },
    });
    try {
      await server.start();
      control = server;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      controlError = code === "EADDRINUSE" ? `Port ${port} is already in use` : "Could not start the control server";
    }
    return controlInfo();
  };

  ipcMain.handle("control:start", (e, port: unknown) =>
    guard(e, async () => {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be 1024 to 65535");
      if (control && control.port === port) return controlInfo();
      return startControl(port);
    }),
  );
  ipcMain.handle("control:stop", (e) => guard(e, () => stopControl()));
  ipcMain.handle("control:status", (e) => guard(e, () => controlInfo()));
  ipcMain.handle("control:regenerate-token", (e) =>
    guard(e, async () => {
      const token = generateToken();
      try {
        setSecret(CONTROL_TOKEN_KEY, token);
      } catch {
        // Held in memory only.
      }
      controlToken = token;
      const port = control?.port;
      if (port) return startControl(port);
      return controlInfo();
    }),
  );
  ipcMain.on("control:state", (e, state: unknown, commands: unknown) => {
    if (!trusted(e)) return;
    try {
      if (JSON.stringify(state ?? null).length <= MAX_STATE_JSON) latestState = state ?? null;
    } catch {
      return;
    }
    if (Array.isArray(commands)) {
      commandNames = commands.filter((c): c is string => typeof c === "string" && c.length <= 80).slice(0, 500);
    }
    control?.broadcastState();
  });
  ipcMain.on("control:result", (e, reply: unknown) => {
    if (!trusted(e) || !reply || typeof reply !== "object") return;
    const r = reply as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (typeof r.id !== "string") return;
    const entry = pending.get(r.id);
    if (!entry) return;
    pending.delete(r.id);
    clearTimeout(entry.timer);
    if (r.ok === true) entry.resolve(r.result ?? null);
    else {
      const message = typeof r.error === "string" ? r.error.slice(0, 100) : "failed";
      entry.reject(new ControlError(message, message === "unknown_command" ? 404 : 400));
    }
  });

  // ---- Slack status ------------------------------------------------------------------
  let slackActive = false;
  const withToken = async (fn: (token: string) => Promise<SlackResult>): Promise<SlackResult> => {
    const token = getSecret(SLACK_TOKEN_KEY);
    if (!token) return { ok: false, error: "No Slack token saved" };
    return fn(token);
  };
  ipcMain.handle("slack:test", (e) => guard(e, () => withToken((t) => testSlackToken(t))));
  ipcMain.handle("slack:set", (e, status: unknown) =>
    guard(e, async () => {
      const parsed = parseSlackStatus(status);
      if (!parsed) return { ok: false, error: "Invalid status" } satisfies SlackResult;
      const result = await withToken((t) => setSlackStatus(t, parsed));
      if (result.ok) slackActive = true;
      return result;
    }),
  );
  ipcMain.handle("slack:clear", (e) =>
    guard(e, async () => {
      const result = await withToken((t) => clearSlackStatus(t));
      if (result.ok) slackActive = false;
      return result;
    }),
  );
  ipcMain.handle("slack:forget", (e) =>
    guard(e, async () => {
      // Clear first (best effort), then delete the token.
      if (slackActive) await withToken((t) => clearSlackStatus(t));
      slackActive = false;
      deleteSecret(SLACK_TOKEN_KEY);
    }),
  );

  // ---- Shutdown ------------------------------------------------------------------------
  let quitting = false;
  app.on("before-quit", (event) => {
    discord.stop();
    globalShortcut.unregisterAll();
    void stopControl();
    if (slackActive && !quitting) {
      // Clear the Slack status before exiting, but never hang the quit on it.
      event.preventDefault();
      quitting = true;
      const done = () => {
        slackActive = false;
        app.quit();
      };
      void Promise.race([withToken((t) => clearSlackStatus(t)), new Promise((r) => setTimeout(r, 3_000))]).finally(done);
    }
  });
}