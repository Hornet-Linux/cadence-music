import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse, IntegrationsResponse } from "@uma/shared";
import { buildApp } from "../app.js";
import type { AppleMusicConfig, Config } from "../config.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { createLocalUser } from "../auth/users.js";
import { loadAppleMusicKey, mintAppleMusicToken } from "./appleMusicToken.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const apple: AppleMusicConfig = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("mints a verifiable ES256 MusicKit developer token", () => {
  const now = 1_700_000_000;
  const { token, expiresAt } = mintAppleMusicToken(apple, loadAppleMusicKey(apple), now, 3600);
  const [header, payload, signature] = token.split(".");

  assert.deepEqual(decode(header), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  assert.deepEqual(decode(payload), { iss: "TEAM123456", iat: now, exp: now + 3600 });
  assert.equal(expiresAt, now + 3600);

  const sig = Buffer.from(signature, "base64url");
  assert.equal(sig.length, 64, "JWS ES256 signatures are raw 64-byte r||s");
  assert.equal(
    verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig),
    true,
  );
});

test("rejects keys that are not MusicKit EC keys", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(
    () => loadAppleMusicKey({ ...apple, privateKey: rsa.export({ type: "pkcs8", format: "pem" }).toString() }),
    /not a valid MusicKit/,
  );
  assert.throws(() => loadAppleMusicKey({ ...apple, privateKey: "garbage" }), /not a valid MusicKit/);
});

test("config reads Spotify and Apple Music settings", () => {
  const config = loadConfig({
    SPOTIFY_CLIENT_ID: "0123456789abcdef0123456789abcdef",
    APPLE_MUSIC_TEAM_ID: apple.teamId,
    APPLE_MUSIC_KEY_ID: apple.keyId,
    APPLE_MUSIC_PRIVATE_KEY: apple.privateKey.replace(/\n/g, "\\n"),
  });
  assert.equal(config.spotifyClientId, "0123456789abcdef0123456789abcdef");
  assert.equal(config.appleMusic?.privateKey, apple.privateKey.trim());

  assert.throws(() => loadConfig({ SPOTIFY_CLIENT_ID: "not-an-id" }), /SPOTIFY_CLIENT_ID/);
  assert.throws(() => loadConfig({ APPLE_MUSIC_TEAM_ID: "x" }), /APPLE_MUSIC_KEY_ID/);
});

async function appWith(overrides: Partial<Config>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-int-"));
  const db = openDb(":memory:");
  createLocalUser(db, { username: "u", password: "user-password" });
  const app = await buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      musicDir: dir,
      scanIntervalMinutes: 0,
      trustProxy: false,
      logLevel: "silent",
      ...overrides,
    },
    db,
    secret: "s".repeat(64),
    logger: false,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "u", password: "user-password" },
  });
  const token = (login.json() as AuthResponse).token;
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, headers: { authorization: `Bearer ${token}` }, close };
}

test("integrations endpoint and Apple Music tokens", async () => {
  const { app, headers, close } = await appWith({
    spotifyClientId: "0123456789abcdef0123456789abcdef",
    appleMusic: apple,
  });

  assert.equal((await app.inject({ method: "GET", url: "/api/integrations" })).statusCode, 401);

  const res = await app.inject({ method: "GET", url: "/api/integrations", headers });
  assert.deepEqual(res.json() as IntegrationsResponse, {
    spotify: { clientId: "0123456789abcdef0123456789abcdef" },
    appleMusic: { available: true },
  });

  const first = await app.inject({ method: "GET", url: "/api/integrations/apple-music/token", headers });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: "GET", url: "/api/integrations/apple-music/token", headers });
  assert.equal(second.json().token, first.json().token, "tokens are cached");
  assert.equal(decode(first.json().token.split(".")[1]).iss, "TEAM123456");

  await close();
});

test("Apple Music is unavailable without a key", async () => {
  const { app, headers, close } = await appWith({});
  const res = await app.inject({ method: "GET", url: "/api/integrations", headers });
  assert.deepEqual(res.json(), { spotify: null, appleMusic: { available: false } });
  const token = await app.inject({ method: "GET", url: "/api/integrations/apple-music/token", headers });
  assert.equal(token.statusCode, 404);
  await close();
});
