import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import { openDb, type Db } from "../../db.js";
import { libraryPlugin } from "../../library/plugin.js";
import type { ServerPlugin } from "../../plugins/types.js";

export interface Kit {
  app: FastifyInstance;
  db: Db;
  dir: string;
  musicDir: string;
  dataDir: string;
  admin: { authorization: string };
  member: { authorization: string };
  /** Rescan the music folder and wait for it. */
  rescan: () => Promise<void>;
  /** Write a file under the music folder (creating folders). */
  put: (rel: string, data: Buffer | string) => void;
  close: () => Promise<void>;
}

/** A real server (in memory database, temp folders) with the library plus the plugins under test. */
export async function makeKit(plugins: ServerPlugin[], files: Record<string, Buffer | string> = {}): Promise<Kit> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-kit-"));
  const musicDir = path.join(dir, "music");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const put = (rel: string, data: Buffer | string) => {
    const abs = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  for (const [rel, data] of Object.entries(files)) put(rel, data);

  const db = openDb(":memory:");
  await createLocalUser(db, { username: "owner", password: "owner-password", isAdmin: true });
  await createLocalUser(db, { username: "member", password: "member-password" });
  const app = await buildApp({
    config: { host: "127.0.0.1", port: 0, dataDir, musicDir, scanIntervalMinutes: 0, trustProxy: false, logLevel: "silent" },
    db,
    secret: "s".repeat(64),
    logger: false,
    plugins: [libraryPlugin, ...plugins],
  });
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  const admin = await login("owner", "owner-password");
  const member = await login("member", "member-password");
  await app.ready();
  const rescan = async () => {
    await app.inject({ method: "POST", url: "/api/library/scan?wait=1", headers: admin });
  };
  await rescan();
  return {
    app,
    db,
    dir,
    musicDir,
    dataDir,
    admin,
    member,
    rescan,
    put,
    close: async () => {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
