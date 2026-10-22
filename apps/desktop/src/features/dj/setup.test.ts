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
    expect(s).toEqual({ kind: "no-model", command: "ollama pull llama3.1", installed: ["qwen3:8b"] });
    expect(setupMessage(s)).toContain("ollama pull llama3.1");
  });

  it("treats a bare name as :latest", () => {
    expect(djSetup(config, { available: true, models: ["llama3.1:latest"] })).toEqual({ kind: "ready" });
    expect(setupMessage({ kind: "ready" })).toBeNull();
  });
});
