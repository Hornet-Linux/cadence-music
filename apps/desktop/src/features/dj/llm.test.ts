import { describe, expect, it, vi } from "vitest";
import { createLlmProvider, DEFAULT_LLM_CONFIG, parseLlmConfig } from "../../../electron/llm";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("Ollama provider (via the shared core)", () => {
  it("lists installed models", async () => {
    const f = fakeFetch(200, { models: [{ name: "llama3.2:3b" }, { name: "qwen3:8b" }] });
    const status = await createLlmProvider(DEFAULT_LLM_CONFIG, f).status();
    expect(status).toEqual({ available: true, models: ["llama3.2:3b", "qwen3:8b"] });
    expect(f.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
  });

  it("reports unavailable when Ollama isn't running", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const status = await createLlmProvider(DEFAULT_LLM_CONFIG, f).status();
    expect(status.available).toBe(false);
    expect(status.error).toBe("fetch failed");
  });

  it("sends the schema as format and parses the JSON reply", async () => {
    const f = fakeFetch(200, { message: { content: '{"picks":[{"artist":"A","title":"B"}]}' } });
    const schema = { type: "object" };
    const out = await createLlmProvider(DEFAULT_LLM_CONFIG, f).chatJson({
      messages: [{ role: "user", content: "hi" }],
      schema,
    });
    expect(out).toEqual({ picks: [{ artist: "A", title: "B" }] });
    const sent = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toMatchObject({ model: "llama3.2:3b", format: schema, stream: false });
  });

  it("explains a missing model", async () => {
    const f = fakeFetch(404, '{"error":"model \\"llama3.2:3b\\" not found"}');
    await expect(
      createLlmProvider(DEFAULT_LLM_CONFIG, f).chatJson({ messages: [], schema: {} }),
    ).rejects.toThrow("ollama pull llama3.2:3b");
  });

  it("rejects non-JSON replies", async () => {
    const f = fakeFetch(200, { message: { content: "sure! here you go" } });
    await expect(
      createLlmProvider(DEFAULT_LLM_CONFIG, f).chatJson({ messages: [], schema: {} }),
    ).rejects.toThrow("valid JSON");
  });
});

describe("parseLlmConfig", () => {
  it("accepts a valid config", () => {
    expect(parseLlmConfig(DEFAULT_LLM_CONFIG)).toEqual(DEFAULT_LLM_CONFIG);
  });
  it("rejects bad input", () => {
    expect(() => parseLlmConfig(null)).toThrow();
    expect(() => parseLlmConfig({ ...DEFAULT_LLM_CONFIG, baseUrl: "file:///etc" })).toThrow();
  });
});
