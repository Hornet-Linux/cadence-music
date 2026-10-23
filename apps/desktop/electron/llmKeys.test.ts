import { describe, expect, it } from "vitest";
import { resolveConfig, saveKey } from "./llmKeys";

function store() {
  const m = new Map<string, string>();
  return { m, get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k) };
}

const openai = { kind: "openai-compatible" as const, baseUrl: "https://api.openai.com/v1", model: "gpt" };

describe("saved provider keys", () => {
  it("are attached only for the address they were saved for", async () => {
    const s = store();
    await saveKey(s, "p1", openai.baseUrl, "sk-1");
    expect((await resolveConfig(s, { ...openai, providerId: "p1" })).apiKey).toBe("sk-1");
    await expect(resolveConfig(s, { ...openai, baseUrl: "https://evil.example/v1", providerId: "p1" })).rejects.toThrow(
      /saved API key is for https:\/\/api.openai.com/,
    );
  });

  it("are never added without a provider id, and a typed key is used as given", async () => {
    const s = store();
    await saveKey(s, "p1", openai.baseUrl, "sk-1");
    expect((await resolveConfig(s, openai)).apiKey).toBeUndefined();
    expect((await resolveConfig(s, { ...openai, apiKey: "sk-typed", providerId: "p1" })).apiKey).toBe("sk-typed");
  });

  it("binds a key saved before binding existed to the address it is first used with", async () => {
    const s = store();
    s.set("dj.key.old", "sk-old");
    expect((await resolveConfig(s, { ...openai, providerId: "old" })).apiKey).toBe("sk-old");
    expect(JSON.parse(s.m.get("dj.key.old")!)).toEqual({ origin: "https://api.openai.com", key: "sk-old" });
    await expect(resolveConfig(s, { ...openai, baseUrl: "http://10.0.0.1:1234/v1", providerId: "old" })).rejects.toThrow();
  });

  it("rejects bad ids and removes keys with null", async () => {
    const s = store();
    await expect(saveKey(s, "../x", openai.baseUrl, "k")).rejects.toThrow();
    await saveKey(s, "p1", openai.baseUrl, "k");
    await saveKey(s, "p1", "", null);
    expect(s.m.size).toBe(0);
  });
});
