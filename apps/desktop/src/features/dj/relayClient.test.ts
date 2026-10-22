import { describe, expect, it, vi } from "vitest";
import type { LlmRelayJob } from "@uma/shared";

vi.mock("@/plugins/builtins/server/serverStore", () => ({
  apiUrl: (base: string, route: string) => `${base}/${route}`,
  useServer: { getState: () => ({ url: "", token: null, user: null }), subscribe: () => () => undefined },
}));

const { buildRegistration, classifyConnect, parseEvents, runJob } = await import("./relayClient");

const provider = (over: Partial<import("./providers").LocalProvider> = {}) => ({
  id: "ollama",
  name: "Ollama",
  kind: "ollama" as const,
  baseUrl: "http://localhost:11434",
  model: "llama3.2:3b",
  share: true,
  ...over,
});

describe("buildRegistration", () => {
  it("offers only shared providers, without URLs or keys", () => {
    const reg = buildRegistration([provider(), provider({ id: "private", share: false })]);
    expect(reg?.providers).toEqual([{ id: "ollama", name: "Ollama", kind: "ollama", model: "llama3.2:3b" }]);
    expect(JSON.stringify(reg)).not.toContain("localhost");
    expect(reg?.deviceId).toMatch(/^d-/);
  });

  it("registers nothing when nothing is shared", () => {
    expect(buildRegistration([provider({ share: false })])).toBeNull();
  });
});

describe("parseEvents", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const job = JSON.stringify({ jobId: "j1" });
    const { events, rest } = parseEvents(`event: ready\ndata: {}\n\n: keep-alive\n\nevent: job\ndata: ${job}\n\nevent: jo`);
    expect(events).toEqual([
      { event: "ready", data: "{}" },
      { event: "job", data: job },
    ]);
    expect(rest).toBe("event: jo");
  });

  it("handles CRLF line endings", () => {
    expect(parseEvents("event: job\r\ndata: {}\r\n\r\n").events).toEqual([{ event: "job", data: "{}" }]);
  });
});

describe("runJob", () => {
  const job = (over: Partial<LlmRelayJob> = {}): LlmRelayJob => ({ jobId: "j", providerId: "ollama", op: "chat-json", request: { messages: [], schema: {} }, ...over });

  it("runs a chat against the local provider and returns the data", async () => {
    const llm = { status: vi.fn(), chatJson: vi.fn().mockResolvedValue({ picks: [] }) };
    expect(await runJob(job(), [provider()], llm)).toEqual({ ok: true, data: { picks: [] } });
    expect(llm.chatJson.mock.calls[0][0]).toMatchObject({ kind: "ollama", baseUrl: "http://localhost:11434" });
  });

  it("answers status jobs", async () => {
    const llm = { status: vi.fn().mockResolvedValue({ available: true, models: ["m"] }), chatJson: vi.fn() };
    expect(await runJob(job({ op: "status" }), [provider()], llm)).toEqual({ ok: true, data: { available: true, models: ["m"] } });
  });

  it("refuses providers that aren't shared, and reports provider failures", async () => {
    const llm = { status: vi.fn(), chatJson: vi.fn().mockRejectedValue(new Error("Ollama isn't running")) };
    expect(await runJob(job(), [provider({ share: false })], llm)).toMatchObject({ ok: false });
    expect(await runJob(job({ providerId: "other" }), [provider()], llm)).toMatchObject({ ok: false });
    expect(await runJob(job(), [provider()], llm)).toEqual({ ok: false, error: "Ollama isn't running" });
  });
});

describe("classifyConnect", () => {
  it("stops retrying, with a reason, when the device limit is reached", () => {
    const v = classifyConnect(429);
    expect(v).toMatchObject({ stop: true, state: "limit" });
    expect(v.message).toMatch(/maximum number of devices/);
  });

  it("stops quietly when signed out and explains an old server", () => {
    expect(classifyConnect(401)).toEqual({ stop: true, state: "off", message: null });
    expect(classifyConnect(403).stop).toBe(true);
    expect(classifyConnect(404)).toMatchObject({ stop: true, state: "unsupported" });
  });

  it("keeps retrying server hiccups and treats 200 as connected", () => {
    expect(classifyConnect(500)).toEqual({ stop: false, state: "reconnecting", message: null });
    expect(classifyConnect(503).stop).toBe(false);
    expect(classifyConnect(200)).toEqual({ stop: false, state: "connected", message: null });
  });
});
