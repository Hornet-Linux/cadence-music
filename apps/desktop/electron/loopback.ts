import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Shared helper for browser-based sign-in (RFC 8252): open the system browser,
// then wait for the provider to redirect to a one-shot listener on 127.0.0.1.

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
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

export interface LoopbackOptions {
  /** Fixed port, or 0 for any free port. Some providers require a fixed one. */
  port: number;
  /** Expected `state` parameter on the callback. */
  state: string;
  /** Build the URL to open in the browser from the redirect URI. */
  authorizeUrl: (redirectUri: string) => string;
  timeoutMs?: number;
}

/** Run the browser round trip and resolve with the returned `code`. */
export function loopbackAuthorize(options: LoopbackOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== options.state) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const ok = !error && !!code;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? resultPage("Signed in", "You can close this tab and return to Cadence.")
          : resultPage("Sign-in failed", error ?? "No code was returned."),
      );
      finish();
      if (code && !error) resolve(code);
      else reject(new Error(error === "access_denied" ? "Access denied" : `Sign-in failed (${error})`));
    });

    const timer = setTimeout(() => {
      finish();
      reject(new Error("Sign-in timed out"));
    }, options.timeoutMs ?? 5 * 60_000);

    function finish() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err: NodeJS.ErrnoException) => {
      finish();
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${options.port} is in use; close the other program and try again.`)
          : err,
      );
    });

    server.listen(options.port, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      void shell.openExternal(options.authorizeUrl(`http://127.0.0.1:${port}/callback`));
    });
  });
}
