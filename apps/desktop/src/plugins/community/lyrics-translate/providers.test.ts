import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderOption } from "@/features/dj/providers";

const api = vi.fn();
const refreshRemote = vi.fn(async () => undefined);
let option: ProviderOption | undefined;
const status = vi.fn();
const chatJson = vi.fn();

vi.mock("@/plugins/builtins/server/serverStore", () => ({
  useServer: { getState: () => ({ api }) },
}));
vi.mock("@/features/dj/providers", () => ({
  currentOption: () => option,
  providerStatus: (ref: string) => status(ref),
  localConfig: async () => ({ kind: "ollama", baseUrl: "http://x", model: "m" }),
  useProviders: {
    getState: () => ({
      refreshRemote,
      local: [{ id: "ollama", name: "Ollama", kind: "ollama", baseUrl: "http://x", model: "m", share: false }],
    }),
  },
}));

const { chooseProvider, checkProvider, senderFor, NoProvider } = await import("./providers");

const opt = (over: Partial<ProviderOption>): ProviderOption => ({
  ref: "local:ollama",
  name: "Ollama",
  kind: "ollama",
  model: "m",
  scope: "local",
  where: "This device",
  ...over,
});

describe("translation providers", () => {
  beforeEach(() => {
    api.mockReset();
    status.mockReset();
    chatJson.mockReset();
    option = undefined;
    (window as unknown as { host: unknown }).host = { llm: { chatJson } };
    delete (window as unknown as { CadenceNative?: unknown }).CadenceNative;
  });

  it("says plainly when no AI provider exists", async () => {
    await expect(chooseProvider()).rejects.toThrow(/No AI provider is set up/);
    expect(refreshRemote).toHaveBeenCalled();
    option = opt({});
    expect((await chooseProvider()).ref).toBe("local:ollama");
  });

  it("explains an unreachable or unavailable provider", async () => {
    status.mockResolvedValueOnce({ available: false, models: [], error: "connection refused" });
    await expect(checkProvider(opt({}))).rejects.toThrow(/Ollama is not available \(connection refused\)/);
    status.mockRejectedValueOnce(new Error("boom"));
    await expect(checkProvider(opt({}))).rejects.toThrow(NoProvider);
    status.mockResolvedValueOnce({ available: true, models: ["m"] });
    await expect(checkProvider(opt({}))).resolves.toBeUndefined();
  });

  it("refuses another computer's provider with a hint", async () => {
    await expect(checkProvider(opt({ scope: "device", ref: "device:d:p", where: "Studio PC" }))).rejects.toThrow(/Studio PC/);
  });

  it("translates on this device with the local model", async () => {
    chatJson.mockResolvedValue({ translations: ["uno", "dos"] });
    const out = await senderFor(opt({}), "Spanish")(["one", "two"]);
    expect(out).toEqual(["uno", "dos"]);
    const request = chatJson.mock.calls[0]![1] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).toContain("Spanish");
    expect(request.messages[1]!.content).toContain('["one","two"]');
  });

  it("treats a wrong-shaped local reply as a bad answer", async () => {
    chatJson.mockResolvedValue({ translations: ["only one"] });
    await expect(senderFor(opt({}), "Spanish")(["one", "two"])).rejects.toThrow("bad reply");
  });

  it("uses the server route for server providers", async () => {
    api.mockResolvedValue({ translations: ["x"] });
    const out = await senderFor(opt({ scope: "server", ref: "server:s1" }), "French")(["a"]);
    expect(out).toEqual(["x"]);
    const [route, init] = api.mock.calls[0] as [string, RequestInit];
    expect(route).toBe("api/lyrics/translate");
    expect(JSON.parse(String(init.body))).toEqual({ provider: "server:s1", lines: ["a"], target: "French" });
  });

  it("says the server plugin is off when the route is missing", async () => {
    api.mockRejectedValue(Object.assign(new Error("Request failed (404)"), { status: 404 }));
    await expect(senderFor(opt({ scope: "server", ref: "server:s1" }), "French")(["a"])).rejects.toThrow(/Lyrics translation plugin/);
  });

  it("uses the phone's own model when that is the choice", async () => {
    const aiChatJson = vi.fn(async () => '```json\n{"translations":["salut"]}\n```');
    (window as unknown as { CadenceNative: unknown }).CadenceNative = { aiChatJson };
    expect(await senderFor(opt({ scope: "native", ref: "native:ai", kind: "native" }), "French")(["hi"])).toEqual(["salut"]);
  });
});
