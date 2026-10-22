import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderInfo } from "@uma/shared";

const api = vi.fn();
vi.mock("@/plugins/builtins/server/serverStore", () => ({
  useServer: { getState: () => ({ user: { id: 1 }, api }) },
}));

const secrets = new Map<string, string>();
const llm = { status: vi.fn(), chatJson: vi.fn() };
(globalThis as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
  host: {
    llm,
    secrets: {
      get: async (k: string) => secrets.get(k) ?? null,
      set: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
  },
});

const { currentOption, effectiveOption, providerOptions, providerStatus, requestPicks, useProviders } = await import("./providers");

const profile = { topArtists: ["Daft Punk"], genres: [], topTracks: [], recentTracks: [] };
const server = (id: string, isDefault = false): LlmProviderInfo => ({
  ref: `server:${id}`,
  name: id,
  kind: "openai-compatible",
  model: "m",
  scope: "server",
  isDefault,
});

describe("provider choice", () => {
  beforeEach(() => {
    localStorage.clear();
    secrets.clear();
    api.mockReset();
    llm.status.mockReset();
    llm.chatJson.mockReset();
    useProviders.setState({ local: [{ id: "ollama", name: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434", model: "llama3.2:3b", share: false }], selected: "", remote: [] });
  });

  it("prefers the listener's pick, then the server default, then a provider on this device", () => {
    const options = providerOptions(useProviders.getState().local, [server("a"), server("b", true)]);
    expect(effectiveOption("server:a", options)?.ref).toBe("server:a");
    expect(effectiveOption("", options)?.ref).toBe("server:b");
    expect(effectiveOption("server:gone", options)?.ref).toBe("server:b");
    expect(effectiveOption("", providerOptions(useProviders.getState().local, []))?.ref).toBe("local:ollama");
  });

  it("lists other computers' providers with where they run", () => {
    const options = providerOptions([], [{ ref: "device:d1:ollama", name: "Ollama", kind: "ollama", model: "m", scope: "device", deviceName: "Mac" }]);
    expect(options).toEqual([expect.objectContaining({ scope: "device", where: "Mac" })]);
  });
});

describe("requestPicks", () => {
  beforeEach(() => {
    localStorage.clear();
    secrets.clear();
    api.mockReset();
    llm.chatJson.mockReset();
    useProviders.setState({ local: [{ id: "lm", name: "LM Studio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "qwen", share: false }], selected: "", remote: [] });
  });

  it("calls a provider on this device directly, with its key from secure storage", async () => {
    secrets.set("dj.key.lm", "sk-local");
    llm.chatJson.mockResolvedValue({ picks: [{ artist: " Justice ", title: "D.A.N.C.E.", intro: "Hi" }, { artist: "", title: "x" }] });
    const picks = await requestPicks("local:lm", profile, { count: 5, mood: "rainy" });
    expect(picks).toEqual([{ artist: "Justice", title: "D.A.N.C.E.", intro: "Hi" }]);
    const [config, req] = llm.chatJson.mock.calls[0];
    expect(config).toEqual({ kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "qwen", apiKey: "sk-local" });
    expect(req.messages.map((m: { content: string }) => m.content).join("\n")).toMatch(/rainy/);
    expect(api).not.toHaveBeenCalled();
  });

  it("sends server and other-device providers through the server and never a key", async () => {
    api.mockResolvedValue({ picks: [{ artist: "A", title: "T", intro: "" }] });
    expect(await requestPicks("server:s1", profile, { count: 4, avoid: ["X – Y"], switchUp: true })).toEqual([{ artist: "A", title: "T", intro: "" }]);
    const [route, init] = api.mock.calls[0];
    expect(route).toBe("api/dj/picks");
    expect(JSON.parse(init.body)).toEqual({ provider: "server:s1", profile, avoid: ["X – Y"], switchUp: true, count: 4 });
    expect(llm.chatJson).not.toHaveBeenCalled();
  });

  it("explains when the chosen provider was removed", async () => {
    await expect(requestPicks("local:gone", profile, { count: 3 })).rejects.toThrow(/removed/);
  });

  it("checks server providers through the server and local ones through the bridge", async () => {
    api.mockResolvedValue({ available: true, models: ["m"] });
    expect(await providerStatus("server:s1")).toEqual({ available: true, models: ["m"] });
    expect(api.mock.calls[0][0]).toBe("api/llm/status");
    llm.status.mockResolvedValue({ available: false, models: [], error: "down" });
    expect((await providerStatus("local:lm")).error).toBe("down");
  });
});

describe("local provider storage", () => {
  beforeEach(() => {
    localStorage.clear();
    secrets.clear();
  });

  it("keeps API keys out of localStorage", async () => {
    useProviders.setState({ local: [], selected: "", remote: [] });
    const id = await useProviders.getState().addLocal(
      { name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", share: true },
      "sk-secret",
    );
    expect(secrets.get(`dj.key.${id}`)).toBe("sk-secret");
    expect(JSON.stringify({ ...localStorage })).not.toContain("sk-secret");

    await useProviders.getState().removeLocal(id);
    expect(secrets.has(`dj.key.${id}`)).toBe(false);
    expect(currentOption()).toBeUndefined();
  });
});
