import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { buildWebAppCsp, WEB_APP_CSP } from "./webApp.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-web-"));
const webDir = path.join(dir, "web");
fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(webDir, "index.html"), '<!doctype html><div id="root"></div>');
fs.writeFileSync(path.join(webDir, "assets", "index-abc.js"), "console.log('cadence')");
fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function appWith(web: string | undefined, enabledPlugins: string[] = []) {
  const db = openDb(":memory:");
  for (const id of enabledPlugins) {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(`plugin:${id}:enabled`, "true", Date.now());
  }
  const app = await buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      musicDir: dir,
      scanIntervalMinutes: 0,
      trustProxy: false,
      logLevel: "silent",
      webDir: web,
    },
    db,
    secret: "s".repeat(64),
    logger: false,
    onSetupCode: () => undefined,
  });
  return {
    app,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

test("serves the web player with SPA fallback and caching", async () => {
  const { app, close } = await appWith(webDir);

  const redirect = await app.inject({ method: "GET", url: "/app" });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, "/app/");

  const index = await app.inject({ method: "GET", url: "/app/" });
  assert.equal(index.statusCode, 200);
  assert.match(String(index.headers["content-type"]), /text\/html/);
  assert.match(index.body, /id="root"/);
  assert.equal(index.headers["cache-control"], "no-cache");

  const asset = await app.inject({ method: "GET", url: "/app/assets/index-abc.js" });
  assert.equal(asset.statusCode, 200);
  assert.match(String(asset.headers["content-type"]), /javascript/);
  assert.match(String(asset.headers["cache-control"]), /immutable/);

  // In-app routes and sign-in callbacks load the app.
  const route = await app.inject({ method: "GET", url: "/app/auth/callback?code=x&state=y" });
  assert.match(route.body, /id="root"/);

  assert.equal((await app.inject({ method: "GET", url: "/app/assets/missing.js" })).statusCode, 404);

  // No escaping the web folder.
  for (const url of ["/app/../secret.txt", "/app/%2e%2e/secret.txt", "/app/..%2fsecret.txt"]) {
    const res = await app.inject({ method: "GET", url });
    assert.doesNotMatch(res.body, /do not serve/, url);
  }
  await close();
});

test("sends a strict Content-Security-Policy with every /app file", async () => {
  const { app, close } = await appWith(webDir);
  for (const url of ["/app/", "/app/assets/index-abc.js", "/app/some/route"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.headers["content-security-policy"], WEB_APP_CSP, url);
    assert.equal(res.headers["x-content-type-options"], "nosniff", url);
  }
  const directive = (name: string) =>
    WEB_APP_CSP.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `));
  const script = directive("script-src") ?? "";
  assert.doesNotMatch(script, /'unsafe-inline'|'unsafe-eval'|\*|https:(\s|$)|http:/);
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) {
    assert.ok(directive(d.split(" ")[0]) === d, d);
  }
  await close();
});

test("explains when the web player isn't built", async () => {
  const { app, close } = await appWith(undefined);
  const res = await app.inject({ method: "GET", url: "/app/" });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /web player/);
  await close();
});

// The policy before the streaming plugins existed, word for word.
const ORIGINAL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://sdk.scdn.co https://js-cdn.music.apple.com",
  "style-src 'self' 'unsafe-inline' https://js-cdn.music.apple.com",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
  "frame-src https://sdk.scdn.co https://*.apple.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

async function cspWith(enabled: string[]): Promise<string> {
  const { app, close } = await appWith(webDir, enabled);
  const res = await app.inject({ method: "GET", url: "/app/" });
  await close();
  return String(res.headers["content-security-policy"]);
}

test("the default CSP is unchanged when no streaming plugin is enabled", async () => {
  assert.equal(WEB_APP_CSP, ORIGINAL_CSP);
  assert.equal(buildWebAppCsp(), ORIGINAL_CSP);
  assert.equal(await cspWith([]), ORIGINAL_CSP);
  // Plugins that need no extra sources, and unknown ids, change nothing either.
  assert.equal(await cspWith(["cadence.tidal", "someone.else"]), ORIGINAL_CSP);
});

test("enabling the YouTube plugin adds only the YouTube script and frame sources", async () => {
  const csp = await cspWith(["cadence.youtube-music"]);
  assert.match(csp, /script-src [^;]*https:\/\/www\.youtube\.com/);
  assert.match(csp, /frame-src [^;]*https:\/\/www\.youtube\.com https:\/\/www\.youtube-nocookie\.com/);
  assert.doesNotMatch(csp, /soundcloud|deezer/);
  assert.equal(csp.replaceAll(" https://www.youtube.com", "").replaceAll(" https://www.youtube-nocookie.com", ""), ORIGINAL_CSP);
});

test("enabling SoundCloud adds its script and frame; enabling Deezer adds a frame only", async () => {
  const sc = await cspWith(["cadence.soundcloud"]);
  assert.match(sc, /script-src [^;]*https:\/\/w\.soundcloud\.com/);
  assert.match(sc, /frame-src [^;]*https:\/\/w\.soundcloud\.com/);
  assert.doesNotMatch(sc, /youtube|deezer/);

  const dz = await cspWith(["cadence.deezer"]);
  assert.match(dz, /frame-src [^;]*https:\/\/widget\.deezer\.com/);
  const script = dz.split("; ").find((d) => d.startsWith("script-src "))!;
  assert.doesNotMatch(script, /deezer/, "Deezer's widget needs no script source");
});

test("all sources together never allow wildcards or inline script", async () => {
  const csp = await cspWith(["cadence.youtube-music", "cadence.soundcloud", "cadence.deezer"]);
  const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
  assert.doesNotMatch(script, /'unsafe-inline'|'unsafe-eval'|\*|https:(\s|$)|http:/);
  assert.equal(csp, buildWebAppCsp(["cadence.youtube-music", "cadence.soundcloud", "cadence.deezer"]));
});
