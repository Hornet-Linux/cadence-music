import electron, { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmProvider, parseLlmConfig, type LlmJsonRequest } from "./llm";
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

// ---- Window controls -------------------------------------------------------
ipcMain.on("window:minimize", () => win?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window:close", () => win?.close());

// ---- Secrets ---------------------------------------------------------------
ipcMain.handle("secrets:get", (_e, key: unknown) => (typeof key === "string" ? getSecret(key) : null));
ipcMain.handle("secrets:set", (_e, key: unknown, value: unknown) => {
  if (typeof key !== "string" || typeof value !== "string") throw new Error("Invalid secret");
  setSecret(key, value);
});
ipcMain.handle("secrets:delete", (_e, key: unknown) => {
  if (typeof key === "string") deleteSecret(key);
});

// ---- Server sign-in (OIDC) -------------------------------------------------
ipcMain.handle("auth:oidc-login", (_e, serverUrl: unknown) => {
  if (typeof serverUrl !== "string") throw new Error("Invalid server URL");
  return oidcLogin(serverUrl);
});

// ---- Spotify ---------------------------------------------------------------
ipcMain.handle("spotify:status", () => spotifyStatus());
ipcMain.handle("spotify:login", (_e, clientId: unknown) => {
  if (typeof clientId !== "string") throw new Error("Invalid client ID");
  return spotifyLogin(clientId.trim());
});
ipcMain.handle("spotify:token", () => spotifyAccessToken());
ipcMain.handle("spotify:logout", () => spotifyLogout());

// ---- LLM (AI DJ) -----------------------------------------------------------
ipcMain.handle("llm:status", (_e, config: unknown) => createLlmProvider(parseLlmConfig(config)).status());
ipcMain.handle("llm:chat-json", (_e, config: unknown, req: unknown) => {
  const r = req as LlmJsonRequest | null;
  if (!r || !Array.isArray(r.messages) || typeof r.schema !== "object") throw new Error("Invalid LLM request");
  return createLlmProvider(parseLlmConfig(config)).chatJson(r);
});

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
app.whenReady().then(async () => {
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
