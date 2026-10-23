import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteLink, type LinkDeps, type LinkStatus } from "./remoteLink";
import type { RemoteDevice } from "./types";

const enc = new TextEncoder();

/** A controllable event stream standing in for the relay's response body. */
class FakeStream {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  body = new ReadableStream<Uint8Array>({ start: (c) => (this.controller = c) });
  send(event: string, data: unknown) {
    this.controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }
  end() {
    this.controller.close();
  }
}

const device = (id: string, name = id): RemoteDevice => ({ id, name, kind: "web", online: true, lastSeen: 0, state: null });

function setup(overrides: Partial<LinkDeps> = {}) {
  const statuses: LinkStatus[] = [];
  const devices: RemoteDevice[][] = [];
  const commands: unknown[] = [];
  const urls: string[] = [];
  const streams: FakeStream[] = [];
  let nextResponse: (signal?: AbortSignal | null) => Response | Promise<Response> = (signal) => {
    const s = new FakeStream();
    streams.push(s);
    signal?.addEventListener("abort", () => s.controller.error(new DOMException("aborted", "AbortError")));
    return new Response(s.body, { status: 200 });
  };
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    return nextResponse(init?.signal);
  }) as unknown as typeof fetch;
  let id = "dev-aaaa";
  const link = new RemoteLink({
    fetchFn,
    getAuth: () => ({ url: "http://server", token: "tok" }),
    getDeviceId: () => id,
    renewDeviceId: () => (id = "dev-bbbb"),
    getName: () => "My phone",
    kind: "phone",
    onStatus: (s) => statuses.push(s),
    onDevices: (d) => devices.push(d),
    onDeviceState: () => undefined,
    onCommand: (c) => commands.push(c),
    baseDelayMs: 5,
    maxDelayMs: 20,
    random: () => 0.5,
    ...overrides,
  });
  return { link, statuses, devices, commands, urls, streams, fetchFn, setResponse: (f: typeof nextResponse) => (nextResponse = f) };
}

const until = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let active: RemoteLink | null = null;
afterEach(() => active?.stop());

describe("RemoteLink", () => {
  it("connects with the device name, id and token, and reports devices and commands", async () => {
    const t = setup();
    active = t.link;
    t.link.start();
    await until(() => t.streams.length === 1);
    expect(t.urls[0]).toContain("http://server/api/remote-control/stream?");
    expect(t.urls[0]).toContain("deviceId=dev-aaaa");
    expect(t.urls[0]).toContain("name=My+phone");
    expect(t.urls[0]).toContain("kind=phone");
    expect((t.fetchFn as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1].headers).toMatchObject({ authorization: "Bearer tok" });
    t.streams[0]!.send("hello", { deviceId: "dev-aaaa", devices: [device("dev-aaaa"), device("dev-cccc")] });
    await until(() => t.statuses.includes("online"));
    expect(t.devices[0]).toHaveLength(2);
    t.streams[0]!.send("command", { command: { type: "pause" }, from: "dev-cccc" });
    await until(() => t.commands.length === 1);
    expect(t.commands[0]).toEqual({ type: "pause" });
  });

  it("reconnects with a growing delay when the stream drops, and is online again after hello", async () => {
    const t = setup();
    active = t.link;
    t.link.start();
    await until(() => t.streams.length === 1);
    t.streams[0]!.send("hello", { devices: [] });
    await until(() => t.statuses.at(-1) === "online");
    t.streams[0]!.end();
    await until(() => t.streams.length === 2);
    expect(t.statuses).toContain("reconnecting");
    t.streams[1]!.send("hello", { devices: [device("dev-aaaa")] });
    await until(() => t.statuses.at(-1) === "online");
  });

  it("keeps retrying after network errors without throwing", async () => {
    const t = setup();
    active = t.link;
    let calls = 0;
    t.setResponse(() => {
      calls++;
      if (calls < 3) throw new TypeError("network down");
      const s = new FakeStream();
      t.streams.push(s);
      return new Response(s.body);
    });
    t.link.start();
    await until(() => t.streams.length === 1);
    expect(calls).toBe(3);
  });

  it("treats a quiet connection as dead and reconnects", async () => {
    const t = setup({ idleTimeoutMs: 40 });
    active = t.link;
    t.link.start();
    await until(() => t.streams.length === 1);
    t.streams[0]!.send("hello", { devices: [] });
    await until(() => t.streams.length === 2, 2000);
  });

  it("reports signed-out on 401 instead of hammering the server", async () => {
    const t = setup();
    active = t.link;
    t.setResponse(() => new Response("{}", { status: 401 }));
    t.link.start();
    await until(() => t.statuses.includes("signed-out"));
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh device id when another player replaced this one", async () => {
    const t = setup();
    active = t.link;
    t.link.start();
    await until(() => t.streams.length === 1);
    t.streams[0]!.send("hello", { devices: [] });
    t.streams[0]!.send("replaced", {});
    t.streams[0]!.end();
    await until(() => t.streams.length === 2);
    expect(t.urls[1]).toContain("deviceId=dev-bbbb");
  });

  it("stops cleanly and does not reconnect afterwards", async () => {
    const t = setup();
    t.link.start();
    await until(() => t.streams.length === 1);
    t.link.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(t.streams).toHaveLength(1);
    expect(t.statuses.at(-1)).toBe("off");
  });
});
