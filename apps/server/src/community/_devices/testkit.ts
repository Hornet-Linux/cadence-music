import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { openDb, type Db } from "../../db.js";
import { createLocalUser } from "../../auth/users.js";
import { libraryPlugin } from "../../library/plugin.js";
import type { Config } from "../../config.js";
import type { ServerPlugin } from "../../plugins/types.js";

export const TEST_SECRET = "s".repeat(64);

/** A minimal valid 8 kHz mono 8-bit PCM WAV file. */
export function wav(samples: number): Buffer {
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  admin: string;
  alice: string;
  bob: string;
  trackId: string;
  cleanup: () => Promise<void>;
}

/** An app with the library, the given plugins, one admin and two ordinary users, and one scanned track. */
export async function startTestServer(plugins: ServerPlugin[]): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-devices-"));
  fs.writeFileSync(path.join(dir, "song.wav"), wav(16000));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
  };
  const app = await buildApp({ config, db, secret: TEST_SECRET, logger: false, plugins: [libraryPlugin, ...plugins] });
  await app.ready();
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return (res.json() as AuthResponse).token;
  };
  const admin = await login("admin", "admin-password");
  // The scan runs on ready; wait for the track to appear.
  let trackId = "";
  for (let i = 0; i < 50 && !trackId; i++) {
    const list = await app.inject({ method: "GET", url: "/api/tracks", headers: { authorization: `Bearer ${admin}` } });
    trackId = (list.json() as { items: { id: string }[] }).items[0]?.id ?? "";
    if (!trackId) await new Promise((r) => setTimeout(r, 50));
  }
  return {
    app,
    db,
    admin,
    alice: await login("alice", "alice-password"),
    bob: await login("bob", "bob-password"),
    trackId,
    cleanup: async () => {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
