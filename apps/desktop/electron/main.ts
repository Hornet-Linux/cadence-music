import electron, { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
type Components = { whenReady: () => Promise<unknown>; status: () => unknown };
const components = (electron as unknown as { components?: Components }).components;

async function widevineReady(): Promise<void> {
  if (!components) {
    console.warn("Not a castlabs Electron build: DRM playback is unavailable");
    return;
  }
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000));
  try {
    const result = await Promise.race([components.whenReady(), timeout]);
    if (result === "timeout") console.warn("Widevine CDM is still installing; continuing");
    else console.log("Widevine components ready", components.status());
  } catch (err) {
    console.error("Widevine CDM failed to install", err);
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
    frame: false,
    titleBarStyle: "hidden",
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

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
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
