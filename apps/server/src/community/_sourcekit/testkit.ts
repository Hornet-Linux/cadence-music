import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { createLocalUser } from "../../auth/users.js";
import type { Config } from "../../config.js";
import { openDb, type Db } from "../../db.js";
import type { ServerPlugin } from "../../plugins/types.js";
import type { NetPolicy } from "./netguard.js";

/** Helpers for the source plugins' tests: a server with three people, and tiny fake upstreams on loopback. */

export const SECRET = "s".repeat(64);

export interface Auth {
  [header: string]: string;
  authorization: string;
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  admin: Auth;
  alice: Auth;
  bob: Auth;
  /** Loopback ports of fake upstreams the plugin under test may reach. */
  fakePorts: Set<number>;
  /** An address policy that lets the plugin reach only the registered fakes. */
  policy: NetPolicy;
  close: () => Promise<void>;
}

/** Policy for tests: loopback is blocked except for the fake upstreams started with `fake()`. */
export function makePolicy(ports: Set<number>): NetPolicy {
  return { allow: (host, port) => (host === "127.0.0.1" || host === "localhost") && ports.has(port) };
}

export async function harness(make: (policy: NetPolicy) => ServerPlugin | ServerPlugin[]): Promise<Harness> {
  const db = openDb(":memory:");
  await createLocalUser(db, { username: "admin", password: "admin-password", isAdmin: true });
  await createLocalUser(db, { username: "alice", password: "alice-password" });
  await createLocalUser(db, { username: "bob", password: "bob-password" });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: ".",
    musicDir: ".",
    scanIntervalMinutes: 0,
    trustProxy: false,
    logLevel: "silent",
  };
  const fakePorts = new Set<number>();
  const policy = makePolicy(fakePorts);
  const made = make(policy);
  const app = await buildApp({ config, db, secret: SECRET, logger: false, plugins: Array.isArray(made) ? made : [made] });
  const signIn = async (username: string): Promise<Auth> => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: `${username}-password` } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  return {
    app,
    db,
    admin: await signIn("admin"),
    alice: await signIn("alice"),
    bob: await signIn("bob"),
    fakePorts,
    policy,
    close: () => app.close(),
  };
}

export interface Fake {
  url: string;
  port: number;
  /** Requests the fake received (path with query, headers). */
  seen: { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }[];
  close: () => Promise<void>;
}

/** A tiny HTTP server for the plugin to talk to. */
export async function fake(h: Harness | null, handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  h?.fakePorts.add(port);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A raw TCP server that answers every connection with the given bytes (for non-HTTP status lines like ICY). */
export async function rawFake(h: Harness | null, respond: (socket: net.Socket) => void): Promise<Fake> {
  const sockets = new Set<net.Socket>();
  const seen: Fake["seen"] = [];
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    s.once("data", (d) => {
      const head = d.toString("latin1");
      const first = head.split("\r\n")[0].split(" ");
      seen.push({ url: first[1] ?? "", method: first[0] ?? "", headers: Object.fromEntries(head.split("\r\n").slice(1).filter(Boolean).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; })), body: "" });
      respond(s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  h?.fakePorts.add(port);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Reads a real HTTP answer from the app by listening on a port (for streaming tests that need a live socket). */
export async function listen(app: FastifyInstance): Promise<{ base: string; close: () => Promise<void> }> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: async () => undefined };
}