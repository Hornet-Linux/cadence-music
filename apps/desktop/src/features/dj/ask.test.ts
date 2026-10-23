import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "@/plugins/builtins/server/serverStore";
import { askJson, askText, CHAT_DISABLED_MESSAGE, describeAiError, NO_PROVIDER_MESSAGE, NoProviderError, parseSse, requireProvider } from "./ask";
import { useProviders } from "./providers";

const sse = (events: [string, unknown][]) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });

describe("parseSse", () => {
  it("splits complete events and keeps the unfinished tail", () => {
    const { events, rest } = parseSse('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te');
    expect(events).toEqual([{ event: "delta", data: '{"text":"a"}' }]);
    expect(rest).toBe('event: delta\ndata: {"te');
  });
  it("handles CRLF and comments", () => {
    const { events } = parseSse(": keep-alive\n\nevent: done\r\ndata: {}\r\n\r\n");
    expect(events).toEqual([{ event: "done", data: "{}" }]);
  });
});

describe("describeAiError", () => {
  it("turns server codes into advice", () => {
    expect(describeAiError(new NoProviderError())).toBe(NO_PROVIDER_MESSAGE);
    expect(describeAiError(new ApiError("Request failed (429)", 429, "rate_limited"))).toMatch(/Try again shortly/);
    expect(describeAiError(new ApiError("Request failed (429)", 429, "busy"))).toMatch(/still answering/);
    expect(describeAiError(new ApiError("Request failed (409)", 409, "no_provider"))).toBe(NO_PROVIDER_MESSAGE);
    expect(describeAiError(new ApiError("Request failed (502): The AI provider couldn't be reached.", 502, "llm_failed"))).toBe(
      "The AI provider couldn't be reached.",
    );
    expect(describeAiError(new ApiError("Request failed (403): AI chat is turned off", 403, "chat_disabled"))).toBe(CHAT_DISABLED_MESSAGE);
    expect(CHAT_DISABLED_MESSAGE).toMatch(/Ask the server owner to enable AI chat in the admin panel/);
    expect(describeAiError(new Error("boom"))).toBe("boom");
    expect(describeAiError(new DOMException("x", "AbortError"))).toBe("Stopped.");
  });
});

describe("server-backed asking", () => {
  beforeEach(() => {
    useServer.setState({ url: "http://server.test", token: "tok" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("streams text from /api/llm/chat and reports each piece", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        ["delta", { text: "Hel" }],
        ["delta", { text: "lo" }],
        ["done", {}],
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pieces: string[] = [];
    const text = await askText("server:1", { messages: [{ role: "user", content: "hi" }], onDelta: (d) => pieces.push(d) });
    expect(text).toBe("Hello");
    expect(pieces).toEqual(["Hel", "lo"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server.test/api/llm/chat");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: "server:1", stream: true });
  });

  it("throws the server's error event, and an ApiError for a refused request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([["error", { message: "The AI provider failed." }]])));
    await expect(askText("server:1", { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("The AI provider failed.");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })));
    await expect(askText("server:1", { messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 429, code: "rate_limited" });

    vi.stubGlobal("fetch", vi.fn(async () => sse([["done", {}]])));
    await expect(askText("server:1", { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/empty reply/);
  });

  it("tells the person to ask the server owner when the server has AI chat switched off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "chat_disabled", message: "off" }), { status: 403 })));
    const err = await askText("server:1", { messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: "chat_disabled" });
    expect(describeAiError(err)).toBe(CHAT_DISABLED_MESSAGE);

    useServer.setState({ api: (async () => Promise.reject(new ApiError("Request failed (403)", 403, "chat_disabled"))) as never });
    const jsonErr = await askJson("server:1", { messages: [{ role: "user", content: "hi" }], schema: {} }).catch((e) => e);
    expect(describeAiError(jsonErr)).toBe(CHAT_DISABLED_MESSAGE);
  });

  it("asks for JSON through the same route", async () => {
    const api = vi.fn(async () => ({ data: { ok: 1 } }));
    useServer.setState({ api: api as never });
    expect(await askJson("server:1", { messages: [{ role: "user", content: "hi" }], schema: { type: "object" } })).toEqual({ ok: 1 });
    const init = (api.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: "server:1", schema: { type: "object" } });
  });
});

describe("local providers and the empty state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers in one piece on the desktop app (no text streaming over its bridge)", async () => {
    const chatJson = vi.fn(async () => ({ reply: " Whole answer " }));
    vi.stubGlobal("host", { llm: { chatJson, status: vi.fn() } });
    window.host = { llm: { chatJson } } as never;
    useProviders.setState({ local: [{ id: "x", name: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434", model: "m", share: false }] });
    const pieces: string[] = [];
    expect(await askText("local:x", { messages: [{ role: "user", content: "hi" }], onDelta: (d) => pieces.push(d) })).toBe("Whole answer");
    expect(pieces).toEqual(["Whole answer"]);
    const req = (chatJson.mock.calls[0] as unknown as [unknown, { messages: { role: string }[] }])[1];
    expect(req.messages[0].role).toBe("system");
  });

  it("says a provider was removed instead of crashing", async () => {
    useProviders.setState({ local: [] });
    await expect(askJson("local:gone", { messages: [], schema: {} })).rejects.toThrow(/was removed/);
  });

  it("requireProvider raises NoProviderError when nothing is configured", async () => {
    useProviders.setState({ local: [], remote: [], native: null, selected: "" });
    useServer.setState({ user: null });
    await expect(requireProvider()).rejects.toBeInstanceOf(NoProviderError);
  });
});
