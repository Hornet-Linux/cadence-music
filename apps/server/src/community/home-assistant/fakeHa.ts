import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHa {
  url: string;
  token: string;
  /** Latest state posted per entity id. */
  states: Map<string, { state: string; attributes: Record<string, unknown> }>;
  posts: { entity: string; body: { state: string; attributes: Record<string, unknown> } }[];
  setFailing(status: number | null): void;
  /**
   * Resolves with the first post at index >= `from` that matches. Take `from` (posts.length)
   * before triggering the change, so the wait is event driven rather than timed.
   */
  waitForPost(match: (p: FakeHa["posts"][number]) => boolean, from: number): Promise<FakeHa["posts"][number]>;
  close(): Promise<void>;
}

/** A pretend Home Assistant: GET /api/ and POST /api/states/<entity_id>, both needing the bearer token. */
export async function startFakeHa(token = "ha-long-lived-token", opts: { host?: string; port?: number; publicHost?: string } = {}): Promise<FakeHa> {
  const states: FakeHa["states"] = new Map();
  const posts: FakeHa["posts"] = [];
  let failing: number | null = null;
  const waiters = new Set<() => void>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (failing) {
        res.statusCode = failing;
        return res.end("{}");
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        return res.end('{"message":"401: Unauthorized"}');
      }
      if (req.method === "GET" && req.url === "/api/") return res.end('{"message":"API running."}');
      const m = /^\/api\/states\/([\w.]+)$/.exec(req.url ?? "");
      if (req.method === "POST" && m) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { state: string; attributes: Record<string, unknown> };
        states.set(m[1]!, body);
        posts.push({ entity: m[1]!, body });
        for (const w of [...waiters]) w();
        res.statusCode = 201;
        return res.end(JSON.stringify({ entity_id: m[1], ...body }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  return {
    url: `http://${opts.publicHost ?? opts.host ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`,
    token,
    states,
    posts,
    setFailing: (s) => (failing = s),
    waitForPost: (match, from) =>
      new Promise((resolve) => {
        const check = () => {
          const hit = posts.slice(from).find(match);
          if (!hit) return;
          waiters.delete(check);
          resolve(hit);
        };
        waiters.add(check);
        check();
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
