import { beforeEach, describe, expect, it } from "vitest";
import { buildDjMessages } from "@/features/dj/prompt";
import { getHostPersona, setHostPersona } from "@/features/dj/hooks";
import type { PluginStorage } from "../../types";
import {
  CUSTOM_ID,
  DEFAULT_ID,
  MAX_STYLE,
  PRESETS,
  cleanText,
  parseState,
  resolvePersonality,
  sanitizeCustom,
  toPersona,
} from "./personalities";
import { activatePersonality, deactivatePersonality, usePersonality } from "./store";

function memoryStorage(initial: Record<string, unknown> = {}): PluginStorage & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: <T,>(key: string) => (key in data ? (data[key] as T) : null),
    set: (key, value) => void (data[key] = JSON.parse(JSON.stringify(value))),
    remove: (key) => void delete data[key],
  };
}

describe("personalities", () => {
  it("ships the five hosts plus the default, each with a distinct style", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["default", "warm", "dry", "late-night", "hype", "minimal"]);
    const styles = PRESETS.filter((p) => p.id !== DEFAULT_ID).map((p) => p.style);
    expect(new Set(styles).size).toBe(styles.length);
    expect(styles.every((s) => s.length > 20)).toBe(true);
  });

  it("changes the DJ prompt: a host's style appears, the default adds nothing", () => {
    const profile = { topArtists: ["A"], genres: [], topTracks: [], recentTracks: [] };
    const dry = PRESETS.find((p) => p.id === "dry")!;
    const prompt = buildDjMessages(profile, { style: toPersona(dry)!.style }).map((m) => m.content).join("\n");
    expect(prompt).toContain("Host style for the intros");
    expect(prompt).toContain("understated humour");
    expect(toPersona(PRESETS[0])).toBeNull();
  });

  it("makes voices differ per host (rate and pitch)", () => {
    const rates = PRESETS.map((p) => p.voice.rate ?? 1.05);
    expect(Math.min(...rates)).toBeLessThan(0.95);
    expect(Math.max(...rates)).toBeGreaterThan(1.1);
  });

  it("cleans free text: collapses whitespace and newlines, bounds the length", () => {
    expect(cleanText("  a \n\n b\tc ", 50)).toBe("a b c");
    expect(cleanText("x".repeat(500), MAX_STYLE)).toHaveLength(MAX_STYLE);
    expect(cleanText(42, 10)).toBe("");
  });

  it("sanitizes a custom host, including garbage input", () => {
    expect(sanitizeCustom({ name: "  DJ\nKay ", style: "grumpy", rate: 99, pitch: -3, voiceHint: "Sam" })).toEqual({
      name: "DJ Kay",
      style: "grumpy",
      rate: 1.5,
      pitch: 0.5,
      voiceHint: "Sam",
    });
    const fromJunk = sanitizeCustom("not an object");
    expect(fromJunk).toEqual({ name: "My host", style: "", rate: 1, pitch: 1, voiceHint: "" });
    expect(sanitizeCustom({ rate: "fast", pitch: NaN }).rate).toBe(1);
  });

  it("parses saved state defensively", () => {
    expect(parseState(null).selected).toBe(DEFAULT_ID);
    expect(parseState("junk").selected).toBe(DEFAULT_ID);
    expect(parseState({ selected: "removed-in-a-later-version" }).selected).toBe(DEFAULT_ID);
    expect(parseState({ selected: "hype" }).selected).toBe("hype");
    expect(parseState({ selected: CUSTOM_ID, custom: { style: "x".repeat(999) } }).custom.style).toHaveLength(MAX_STYLE);
  });

  it("a custom host without instructions or voice changes behaves like the default", () => {
    const custom = parseState({ selected: CUSTOM_ID, custom: { name: "Empty", style: "" } });
    const persona = toPersona(resolvePersonality(custom));
    expect(persona?.style).toBe(""); // voice settings still apply (rate and pitch of 1)
    expect(persona?.voice?.rate).toBe(1);
  });
});

describe("personality persistence", () => {
  beforeEach(() => {
    setHostPersona(null);
    usePersonality.setState(parseState(null));
  });

  it("applies the saved choice when the plugin turns on, and clears it when it turns off", () => {
    activatePersonality(memoryStorage({ state: { selected: "late-night", custom: {} } }));
    expect(usePersonality.getState().selected).toBe("late-night");
    expect(getHostPersona()?.style).toContain("hushed");
    expect(getHostPersona()?.voice?.rate).toBeLessThan(0.95);
    deactivatePersonality();
    expect(getHostPersona()).toBeNull();
  });

  it("saves choices and a custom host, and a fresh start reads them back", () => {
    const storage = memoryStorage();
    activatePersonality(storage);
    usePersonality.getState().select("hype");
    expect(storage.data.state).toMatchObject({ selected: "hype" });

    usePersonality.getState().saveCustom({ name: "Old Bob", style: "gruff but kind", rate: 0.9, pitch: 0.8, voiceHint: "" });
    expect(usePersonality.getState().selected).toBe(CUSTOM_ID);
    expect(getHostPersona()?.style).toBe("gruff but kind");

    // New session.
    deactivatePersonality();
    usePersonality.setState(parseState(null));
    activatePersonality(storage);
    expect(usePersonality.getState().selected).toBe(CUSTOM_ID);
    expect(usePersonality.getState().custom.name).toBe("Old Bob");
    expect(getHostPersona()?.voice?.pitch).toBe(0.8);
  });

  it("survives corrupt or unavailable storage", () => {
    const throwing: PluginStorage = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("denied");
      },
      remove: () => undefined,
    };
    expect(() => activatePersonality(throwing)).not.toThrow();
    expect(usePersonality.getState().selected).toBe(DEFAULT_ID);
    expect(() => usePersonality.getState().select("warm")).not.toThrow();
    expect(getHostPersona()?.style).toContain("friendly");
  });

  it("ignores an unknown host id", () => {
    activatePersonality(memoryStorage());
    usePersonality.getState().select("nope");
    expect(usePersonality.getState().selected).toBe(DEFAULT_ID);
  });
});
