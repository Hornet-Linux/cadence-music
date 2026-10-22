import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import type { Config } from "../../config.js";
import { openDb, type Db } from "../../db.js";
import { createLocalUser } from "../../auth/users.js";
import type { ServerPlugin } from "../../plugins/types.js";

/** Test helper: a real app with only the given plugins, an admin and a listener signed in. Not used at run time. */
export interface TestApp {
  app: FastifyInstance;
  db: Db;
  dir: string;
  adminToken: string;
  userToken: string;
  adminId: number;
  userId: number;
  auth: (token: string) => { authorization: string };
  cleanup: () => Promise<void>;
}

export async function makeApp(plugins: ServerPlugin[], overrides: Partial<Config> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-ops-"));
  const db = openDb(":memory:");
  const admin = await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  const user = await createLocalUser(db, { username: "listener", password: "listener-password" });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    ...overrides,
  };
  const app = await buildApp({ config, db, secret: "s".repeat(64), logger: false, plugins });
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return (res.json() as { token: string }).token;
  };
  const adminToken = await login("admin", "admin-password");
  const userToken = await login("listener", "listener-password");
  return {
    app,
    db,
    dir,
    adminToken,
    userToken,
    adminId: admin.id,
    userId: user.id,
    auth: (token) => ({ authorization: `Bearer ${token}` }),
    cleanup: async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` returns something truthy (or fail after `timeoutMs`). */
export async function waitFor<T>(check: () => T | false | null | undefined | Promise<T | false | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(15);
  }
}