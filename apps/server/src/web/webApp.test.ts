import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { WEB_APP_CSP } from "./webApp.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-web-"));
const webDir = path.join(dir, "web");
fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(webDir, "index.html"), '<!doctype html><div id="root"></div>');
fs.writeFileSync(path.join(webDir, "assets", "index-abc.js"), "console.log('cadence')");
fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function appWith(web: string | undefined) {
  const db = openDb(":memory:");
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
