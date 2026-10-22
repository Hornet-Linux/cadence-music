// @vitest-environment node
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The main-process wiring, run against a stand-in for Electron: who may call, how
// bad input is refused, and how a control-API request travels to the page and back.

const h = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const appEvents = new Map<string, (e: { preventDefault: () => void }) => void>();
  return {
    handlers,
    listeners,
    appEvents,
    registered: new Map<string, () => void>(),
    registerResult: { value: true },
    unregisterAll: vi.fn(),
    appendSwitch: vi.fn(),
    sent: [] as [string, ...unknown[]][],
    secrets: new Map<string, string>(),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\nowhere",
    on: (name: string, fn: (e: { preventDefault: () => void }) => void) => void h.appEvents.set(name, fn),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    commandLine: { appendSwitch: h.appendSwitch },
  },
  globalShortcut: {
    register: (acc: string, cb: () => void) => {
      if (h.registerResult.value) h.registered.set(acc, cb);
      return h.registerResult.value;
    },
    unregisterAll: () => {
      h.registered.clear();
      h.unregisterAll();
    },
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void h.handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void h.listeners.set(ch, fn),
  },
}));

vi.mock("./secrets", () => ({
  getSecret: (k: string) => h.secrets.get(k) ?? null,
  setSecret: (k: string, v: string) => void h.secrets.set(k, v),
  deleteSecret: (k: string) => void h.secrets.delete(k),
}));

vi.mock("./integrationsConfig", async (orig) => {
  const real = await orig<typeof import("./integrationsConfig")>();
  return { ...real, readConfig: () => ({ systemMediaControls: true }), writeConfig: vi.fn() };
});

const webContents = { send: (...a: [string, ...unknown[]]) => void h.sent.push(a) };
const win = { webContents, isDestroyed: () => false };
const mine = { sender: webContents };
const stranger = { sender: {} };

const call = (channel: string, e: unknown, ...args: unknown[]) => h.handlers.get(channel)!(e, ...args);

beforeAll(async () => {
  const { registerIntegrations, applyStartupSwitches } = await import("./integrations");
  applyStartupSwitches();
  registerIntegrations(() => win as never);
});

beforeEach(() => {
  h.sent.length = 0;
  h.registered.clear();
  h.registerResult.value = true;
});

describe("who may call", () => {
  it("refuses every call that does not come from the app's own window", async () => {
    for (const [channel, args] of [
      ["discord:start", ["123456789012345678"]],
      ["shortcuts:set", [[]]],
      ["control:start", [47999]],
      ["slack:set", [{ text: "x", emoji: ":a:", expiration: 0 }]],
      ["system:set-media-controls", [true]],
    ] as [string, unknown[]][]) {
      await expect(Promise.resolve().then(() => call(channel, stranger, ...args)), channel).rejects.toThrow("Not allowed");
    }
  });
});

describe("start-up switches", () => {
  it("turns on Chromium's media features only because the saved setting says so", () => {
    expect(h.appendSwitch).toHaveBeenCalledWith("enable-features", "HardwareMediaKeyHandling,MediaSessionService");
  });
});

describe("Discord", () => {
  it("rejects a malformed application id before anything connects", async () => {
    await expect(Promise.resolve().then(() => call("discord:start", mine, "not-a-number"))).rejects.toThrow(/application ID/);
    await expect(Promise.resolve().then(() => call("discord:activity", mine, { nonsense: true }))).rejects.toThrow("Invalid activity");
  });
});

describe("global shortcuts", () => {
  it("registers valid shortcuts in Electron's spelling and reports the ones it cannot", async () => {
    const results = (await call("shortcuts:set", mine, [
      { id: "next", accelerator: "ctrl+alt+right" },
      { id: "vol", accelerator: "CmdOrCtrl+Alt+Up" },
      { id: "dupe", accelerator: "Alt+Ctrl+Right" },
      { id: "typing", accelerator: "K" },
      { id: "junk", accelerator: "Ctrl+Nope" },
    ])) as { id: string; ok: boolean; error?: string }[];
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ["next", true],
      ["vol", true],
      ["dupe", false],
      ["typing", false],
      ["junk", false],
    ]);
    expect(results[2]!.error).toMatch(/Already used/);
    expect([...h.registered.keys()].sort()).toEqual(["Ctrl+Alt+Right", "CommandOrControl+Alt+Up"].sort());
    expect(h.unregisterAll).toHaveBeenCalled();
  });

  it("tells the page which shortcut was pressed", async () => {
    await call("shortcuts:set", mine, [{ id: "next", accelerator: "Ctrl+Alt+Right" }]);
    h.registered.get("Ctrl+Alt+Right")!();
    expect(h.sent).toContainEqual(["shortcuts:triggered", "next"]);
  });

  it("explains when another app already owns a shortcut", async () => {
    h.registerResult.value = false;
    const [r] = (await call("shortcuts:set", mine, [{ id: "next", accelerator: "Ctrl+Alt+Right" }])) as { ok: boolean; error: string }[];
    expect(r!.ok).toBe(false);
    expect(r!.error).toMatch(/Another app/);
  });

  it("refuses a malformed list", async () => {
    await expect(Promise.resolve().then(() => call("shortcuts:set", mine, "nope"))).rejects.toThrow("Invalid shortcuts");
    await expect(Promise.resolve().then(() => call("shortcuts:set", mine, [{ id: "bad id!", accelerator: "F9" }]))).rejects.toThrow("Invalid shortcut");
  });
});

describe("control API wiring", () => {
  const PORT = 49000 + Math.floor(Math.random() * 500);
  let token = "";

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || "{}") }));
        })
        .on("error", reject);
    });

  afterAll(async () => {
    await call("control:stop", mine);
  });

  it("refuses bad ports", async () => {
    for (const bad of [80, 70000, 1.5, "47000", null]) {
      await expect(Promise.resolve().then(() => call("control:start", mine, bad)), String(bad)).rejects.toThrow(/Port/);
    }
  });

  it("starts on loopback with a fresh secret token that is kept in secure storage", async () => {
    const info = (await call("control:start", mine, PORT)) as { running: boolean; port: number; token: string };
    expect(info.running).toBe(true);
    expect(info.port).toBe(PORT);
    expect(info.token.length).toBeGreaterThanOrEqual(30);
    expect(h.secrets.get("control.token")).toBe(info.token);
    token = info.token;
    expect((await get("/v1/state")).status).toBe(401);
  });

  it("serves the state the page pushed, and the command names", async () => {
    h.listeners.get("control:state")!(mine, { playing: true, track: { title: "Song" } }, ["next", "play", 5, "x".repeat(200)]);
    const state = await get("/v1/state", { authorization: `Bearer ${token}` });
    expect(state.json.state).toEqual({ playing: true, track: { title: "Song" } });
    expect((await get("/v1/commands", { authorization: `Bearer ${token}` })).json.commands).toEqual(["next", "play"]);
  });

  it("ignores state pushed by anything but the app's window", async () => {
    h.listeners.get("control:state")!(stranger, { playing: "hijacked" }, ["evil"]);
    const state = await get("/v1/state", { authorization: `Bearer ${token}` });
    expect((state.json.state as { playing: unknown }).playing).toBe(true);
  });

  it("carries a command to the page and the answer back", async () => {
    const pending = get("/v1/command/volume?value=0.3", { authorization: `Bearer ${token}` });
    await vi.waitFor(() => expect(h.sent.some(([ch]) => ch === "control:command")).toBe(true));
    const [, req] = h.sent.find(([ch]) => ch === "control:command")! as [string, { id: string; name: string; args: Record<string, unknown> }];
    expect(req.name).toBe("volume");
    expect(req.args).toEqual({ value: 0.3 });
    // A reply from a stranger is ignored; the page's reply completes the request.
    h.listeners.get("control:result")!(stranger, { id: req.id, ok: true, result: "forged" });
    h.listeners.get("control:result")!(mine, { id: req.id, ok: true, result: { volume: 0.3 } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, result: { volume: 0.3 } });
  });

  it("turns the page's errors into HTTP errors without inventing details", async () => {
    const pending = get("/v1/command/nope", { authorization: `Bearer ${token}` });
    await vi.waitFor(() => expect(h.sent.some(([ch]) => ch === "control:command")).toBe(true));
    const [, req] = h.sent.find(([ch]) => ch === "control:command")! as [string, { id: string }];
    h.listeners.get("control:result")!(mine, { id: req.id, ok: false, error: "unknown_command" });
    const res = await pending;
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("unknown_command");
  });

  it("makes a new token on request and the old one stops working", async () => {
    const next = (await call("control:regenerate-token", mine)) as { token: string; running: boolean };
    expect(next.running).toBe(true);
    expect(next.token).not.toBe(token);
    expect((await get("/v1/state", { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await get("/v1/state", { authorization: `Bearer ${next.token}` })).status).toBe(200);
  });
});

describe("Slack wiring", () => {
  it("needs a saved token and a sane status", async () => {
    expect(await call("slack:test", mine)).toEqual({ ok: false, error: "No Slack token saved" });
    expect(await call("slack:set", mine, { text: "", emoji: ":a:", expiration: 0 })).toEqual({ ok: false, error: "Invalid status" });
    expect(await call("slack:set", mine, { text: "ok", emoji: ":a:", expiration: 0 })).toEqual({ ok: false, error: "No Slack token saved" });
  });

  it("clears the status before quitting, and does not hold the quit hostage", async () => {
    h.secrets.set("statussync.slack-token", "xoxp-1234567890-abcdefghij");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body?: string }) => {
        calls.push(`${url} ${init.body ?? ""}`);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect(await call("slack:set", mine, { text: "Song", emoji: ":headphones:", expiration: exp })).toMatchObject({ ok: true });
    const prevent = vi.fn();
    h.appEvents.get("before-quit")!({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toContain('"status_text":""');
    vi.unstubAllGlobals();
  });
});