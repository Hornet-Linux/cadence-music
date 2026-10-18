import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthResponse } from "@uma/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite injects these during the build.
process.env.APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

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
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the user's real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
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

// ---- Secrets (encrypted with the OS keychain via safeStorage) ---------------
const SECRET_KEY_RE = /^[\w.:-]{1,100}$/;
const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");

function readSecrets(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(secretsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSecrets(all: Record<string, string>) {
  fs.writeFileSync(secretsFile(), JSON.stringify(all), { mode: 0o600 });
}

ipcMain.handle("secrets:get", (_e, key: unknown) => {
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) return null;
  const encrypted = readSecrets()[key];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
});

ipcMain.handle("secrets:set", (_e, key: unknown, value: unknown) => {
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key) || typeof value !== "string") {
    throw new Error("Invalid secret");
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is unavailable");
  const all = readSecrets();
  all[key] = safeStorage.encryptString(value).toString("base64");
  writeSecrets(all);
});

ipcMain.handle("secrets:delete", (_e, key: unknown) => {
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) return;
  const all = readSecrets();
  delete all[key];
  writeSecrets(all);
});

// ---- OIDC sign-in ----------------------------------------------------------
// Native-app flow (RFC 8252): open the system browser at the server, which
// redirects to the identity provider (e.g. Authentik) and back to a one-shot
// loopback listener here. PKCE binds the returned code to this process.

function apiUrl(base: string, route: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(route.replace(/^\/+/, ""), root);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function resultPage(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui;background:#0b0b0f;color:#f4f4f8;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h1 style="font-size:1.3rem">${escapeHtml(title)}</h1>
<p style="color:#9a9ab0">${escapeHtml(message)}</p></div></body>`;
}

let oidcInProgress = false;

async function oidcLogin(serverUrl: string): Promise<AuthResponse> {
  const base = new URL(serverUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  if (oidcInProgress) throw new Error("A sign-in is already in progress");
  oidcInProgress = true;

  const appState = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback" || url.searchParams.get("state") !== appState) {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const returned = url.searchParams.get("code");
        const ok = !error && !!returned;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          ok
            ? resultPage("Signed in", "You can close this tab and return to Unnamed Music App.")
            : resultPage("Sign-in failed", error ?? "No code was returned."),
        );
        finish();
        if (ok) resolve(returned!);
        else reject(new Error(error === "access_denied" ? "Access denied" : `Sign-in failed (${error})`));
      });

      const timer = setTimeout(() => {
        finish();
        reject(new Error("Sign-in timed out"));
      }, 5 * 60_000);

      function finish() {
        clearTimeout(timer);
        server.close();
      }

      server.on("error", (err) => {
        finish();
        reject(err);
      });

      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const start = apiUrl(base.toString(), "api/auth/oidc/start");
        start.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
        start.searchParams.set("state", appState);
        start.searchParams.set("code_challenge", challenge);
        void shell.openExternal(start.toString());
      });
    });

    const res = await fetch(apiUrl(base.toString(), "api/auth/exchange"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
    return (await res.json()) as AuthResponse;
  } finally {
    oidcInProgress = false;
  }
}

ipcMain.handle("auth:oidc-login", (_e, serverUrl: unknown) => {
  if (typeof serverUrl !== "string") throw new Error("Invalid server URL");
  return oidcLogin(serverUrl);
});

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
  win = null;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
