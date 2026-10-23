import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_CONFIG } from "../../../electron/llm";
import { djSetup, setupMessage } from "./setup";

const config = { ...DEFAULT_LLM_CONFIG, model: "llama3.1" };

describe("djSetup", () => {
  it("asks to install Ollama when it can't be reached", () => {
    const s = djSetup(config, { available: false, models: [], error: "fetch failed" });
    expect(s).toEqual({ kind: "no-ollama", detail: "fetch failed" });
    expect(setupMessage(s)).toContain("ollama.com");
  });

  it("asks to pull a missing model", () => {
    const s = djSetup(config, { available: true, models: ["qwen3:8b"] });
    expect(s).toEqual({ kind: "no-model", model: "llama3.1", command: "ollama pull llama3.1", installed: ["qwen3:8b"] });
    expect(setupMessage(s)).toContain("ollama pull llama3.1");
  });

  it("treats a bare name as :latest", () => {
    expect(djSetup(config, { available: true, models: ["llama3.1:latest"] })).toEqual({ kind: "ready" });
    expect(setupMessage({ kind: "ready" })).toBeNull();
  });

  it("doesn't tell OpenAI-style users to run ollama", () => {
    const lmstudio = { kind: "openai-compatible" as const, model: "qwen2.5" };
    const down = djSetup(lmstudio, { available: false, models: [], error: "ECONNREFUSED" });
    expect(down).toEqual({ kind: "unreachable", detail: "ECONNREFUSED" });
    expect(setupMessage(down)).toContain("ECONNREFUSED");

    const missing = djSetup(lmstudio, { available: true, models: ["llama-3"] });
    expect(missing).toMatchObject({ kind: "no-model", model: "qwen2.5", command: undefined });
    expect(setupMessage(missing)).toContain('"qwen2.5"');
  });

  it("never tells a listener to install the server's Ollama", () => {
    const server = { kind: "ollama" as const, model: "llama3.1", scope: "server" as const };
    const down = djSetup(server, { available: false, models: [], error: "x" });
    expect(down).toEqual({ kind: "unreachable", detail: "x", onServer: true });
    expect(setupMessage(down)).toContain("server owner");
    const missing = djSetup(server, { available: true, models: ["qwen3:8b"] });
    expect(missing).toMatchObject({ kind: "no-model", command: undefined, onServer: true });
    expect(setupMessage(missing)).toContain("downloading");
  });

  it("can't call a model missing when the server doesn't list any", () => {
    expect(djSetup({ kind: "openai-compatible", model: "x" }, { available: true, models: [] })).toEqual({ kind: "ready" });
  });
});
