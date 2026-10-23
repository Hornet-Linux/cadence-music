import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthResponse } from "@uma/shared";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import type { Config } from "../../config.js";
import { openDb } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";

/** Test helpers: a scripted stand-in for a streaming service's HTTP API, and a ready app. */

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: URLSearchParams | null;
}

export type Handler = (call: RecordedCall) => Response | object | undefined | Promise<Response | object | undefined>;

export class FakeUpstream {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Handler[] = [];

  /** Handlers are tried newest first; the first to answer wins. */
  on(handler: Handler): this {
    this.handlers.unshift(handler);
    return this;
  }

  /** Answer calls whose `METHOD host+path` starts with `prefix`. */
  route(prefix: string, answer: (call: RecordedCall) => Response | object | Promise<Response | object>): this {
    return this.on((call) => (`${call.method} ${call.url.host}${call.url.pathname}`.startsWith(prefix) ? answer(call) : undefined));
  }

  count(prefix: string): number {
    return this.calls.filter((c) => `${c.method} ${c.url.host}${c.url.pathname}`.startsWith(prefix)).length;
  }

  readonly fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : null;
    const call: RecordedCall = { method: (init?.method ?? "GET").toUpperCase(), url, headers, body: raw ? new URLSearchParams(raw) : null };
    this.calls.push(call);
    for (const h of this.handlers) {
      const out = await h(call);
      if (out === undefined) continue;
      return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const SECRET = "s".repeat(64);

/** An app with the plugin registered, an admin and two ordinary people signed in. */
export async function setupApp(plugin: ServerPlugin, config: Partial<Config> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uma-stream-"));
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const cfg: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    musicDir: dir,
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
    publicUrl: "https://cadence.example",
    ...config,
  };
  const app = await buildApp({ config: cfg, db, secret: SECRET, logger: false, plugins: [plugin] });
  const signIn = async (username: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as AuthResponse).token}` };
  };
  return { app, db, admin: await signIn("admin"), alice: await signIn("alice"), bob: await signIn("bob") };
}

export type TestApp = Awaited<ReturnType<typeof setupApp>>;
