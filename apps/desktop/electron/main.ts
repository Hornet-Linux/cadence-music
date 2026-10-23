import electron, { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTrustedSender } from "./ipcGuard";
import { createLlmProvider, parseJsonRequest } from "./llm";
import { DJ_KEY_PREFIX, hasKey, resolveConfig, saveKey } from "./llmKeys";
import { applyStartupSwitches, registerIntegrations } from "./integrations";
import { oidcLogin } from "./oidc";
import { deleteSecret, getSecret, setSecret } from "./secrets";
import { spotifyAccessToken, spotifyLogin, spotifyLogout, spotifyStatus } from "./spotify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite injects these during the build.
process.env.APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

// Streaming SDKs start playback from code, not from a click in their own frame.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Optional system media controls, switched on by the Media keys plugin (applies after a restart).
applyStartupSwitches();

// castlabs Electron (ECS) adds `components` to install the Widevine CDM that
// Spotify and Apple Music need. Stock Electron has no such module.
type Components = {
  whenReady: (required?: string[]) => Promise<unknown>;
  status: () => Record<string, unknown>;
  updatesEnabled: boolean;
  WIDEVINE_CDM_ID: string;
};
const components = (electron as unknown as { components?: Components }).components;

async function widevineReady(): Promise<void> {
  if (!components) {
    console.warn("Not a castlabs Electron build: DRM playback is unavailable");
    return;
  }
  if (!components.updatesEnabled) {
    // A disabled updater never installs the CDM; turn it back on.
    components.updatesEnabled = true;
  }
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000));
  try {
    // Require Widevine explicitly so a failed install rejects with details
    // instead of resolving with nothing installed.
    const result = await Promise.race([components.whenReady([components.WIDEVINE_CDM_ID]), timeout]);
    if (result === "timeout") console.warn("Widevine CDM is still installing; continuing");
    else console.log("Widevine CDM ready", JSON.stringify(components.status()));
  } catch (err) {
    const errors = (err as { errors?: unknown }).errors;
    console.error("Widevine CDM failed to install", JSON.stringify(errors ?? String(err)));
  }
}

// Apple's MusicKit signs in through a popup that must stay inside the app so
// it can post the result back to the page.
const IN_APP_POPUP_HOSTS = [/(^|\.)apple\.com$/i];

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0b0b0f",
    // macOS keeps its native traffic-light buttons, inset into our own title
    // bar; elsewhere the window is frameless and the app draws its controls.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } }
      : { frame: false, titleBarStyle: "hidden" as const }),
    webPreferences: {
      // The preload is an ES module, which Electron only supports outside the
      // renderer sandbox. contextIsolation still keeps Node out of the page.
      preload: path.join(__dirname, "preload.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return { action: "deny" };
    }
    if (url.startsWith("https://") && IN_APP_POPUP_HOSTS.some((re) => re.test(host))) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    // Everything else opens in the user's real browser.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

// ---- IPC: only the app's own page may call the main process -----------------
// A link, a sign-in redirect or an iframe in the window must not be able to
// read secrets or make the main process (which has no CORS) fetch for it.
const GUARD = { devServerUrl: VITE_DEV_SERVER_URL, rendererDir: RENDERER_DIST };
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!win && isTrustedSender(e.senderFrame, win.webContents.mainFrame, GUARD);
}
function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    if (!trusted(e)) throw new Error("Not allowed");
    return fn(e, ...args);
  });
}
function on(channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void) {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (trusted(e)) fn(e, ...args);
  });
}

/** Saved AI provider keys: written and used here, never readable by the page. */
const djKeys = { get: getSecret, set: setSecret, delete: deleteSecret };
const pageSecret = (key: unknown): key is string => typeof key === "string" && !key.startsWith(DJ_KEY_PREFIX);

// ---- Window controls -------------------------------------------------------
on("window:minimize", () => win?.minimize());
on("window:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
on("window:close", () => win?.close());

// ---- Secrets ---------------------------------------------------------------
handle("secrets:get", (_e, key: unknown) => (pageSecret(key) ? getSecret(key) : null));
handle("secrets:set", (_e, key: unknown, value: unknown) => {
  if (!pageSecret(key) || typeof value !== "string") throw new Error("Invalid secret");
  setSecret(key, value);
});
handle("secrets:delete", (_e, key: unknown) => {
  if (pageSecret(key)) deleteSecret(key);
});

// ---- Server sign-in (OIDC) -------------------------------------------------
handle("auth:oidc-login", (_e, serverUrl: unknown) => {
  if (typeof serverUrl !== "string") throw new Error("Invalid server URL");
  return oidcLogin(serverUrl);
});

// ---- Spotify ---------------------------------------------------------------
handle("spotify:status", () => spotifyStatus());
handle("spotify:login", (_e, clientId: unknown) => {
  if (typeof clientId !== "string") throw new Error("Invalid client ID");
  return spotifyLogin(clientId.trim());
});
handle("spotify:token", () => spotifyAccessToken());
handle("spotify:logout", () => spotifyLogout());

// ---- LLM (AI DJ) -----------------------------------------------------------
handle("llm:status", async (_e, config: unknown) => createLlmProvider(await resolveConfig(djKeys, config)).status());
handle("llm:chat-json", async (_e, config: unknown, req: unknown) => {
  return createLlmProvider(await resolveConfig(djKeys, config)).chatJson(parseJsonRequest(req));
});
handle("llm:save-key", (_e, providerId: unknown, baseUrl: unknown, key: unknown) => saveKey(djKeys, providerId, baseUrl, key));
handle("llm:has-key", (_e, providerId: unknown) => hasKey(djKeys, providerId));

// ---- Desktop integrations (Discord, shortcuts, control API, Slack) ----------
registerIntegrations(() => win);

// ---- Widevine self-check ---------------------------------------------------
// `--widevine-probe` installs the CDM, checks the key system in a hidden
// window, prints one JSON line and exits. Used by CI (without a debugger
// attached) and handy for support: run the app with this flag to check DRM.
const WIDEVINE_PROBE = process.argv.includes("--widevine-probe");

async function runWidevineProbe() {
  const result: Record<string, unknown> = { castlabs: !!components, platform: process.platform };
  try {
    if (components) {
      try {
        await components.whenReady([components.WIDEVINE_CDM_ID]);
        result.install = "ok";
      } catch (err) {
        result.install = (err as { errors?: unknown }).errors ?? String(err);
      }
      result.status = components.status();
    }
    // EME only exists in secure contexts; the app's own file:// page is one.
    const probe = new BrowserWindow({ show: false });
    await probe.loadFile(path.join(RENDERER_DIST, "index.html"));
    result.keySystem = await probe.webContents.executeJavaScript(`(async () => {
      try {
        if (!navigator.requestMediaKeySystemAccess) return "EME unavailable (insecure context?)";
        await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ initDataTypes: ["cenc"],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]);
        return true;
      } catch (e) {
        return String(e);
      }
    })()`);
  } catch (err) {
    result.error = String(err);
  } finally {
    console.log(`WIDEVINE_PROBE ${JSON.stringify(result)}`);
    app.exit(0);
  }
}

// ---- App lifecycle ---------------------------------------------------------
// One Cadence per profile: a second launch focuses the running window instead of
// opening another (two copies would fight over the control-API port, Discord and the media keys).
const gotInstanceLock = WIDEVINE_PROBE || app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(async () => {
  if (!gotInstanceLock) return;
  if (WIDEVINE_PROBE) {
    await runWidevineProbe();
    return;
  }
  await widevineReady();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
  win = null;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
