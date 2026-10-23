import { describe, expect, it } from "vitest";
import { defaultTranslateLanguage, looksEnglish } from "./api";

describe("translate defaults", () => {
  it("follows the browser language and falls back to English", () => {
    expect(defaultTranslateLanguage("fr-CA")).toBe("French");
    expect(defaultTranslateLanguage("zh-TW")).toBe("Chinese (Simplified)");
    expect(defaultTranslateLanguage("tlh")).toBe("English");
    expect(defaultTranslateLanguage(undefined)).toBe("English");
  });

  it("spots English lyrics but not other languages or tiny snippets", () => {
    const en = ["Walking down the quiet street", "Streetlights hum a gentle tune", "Every window glows with gold", "Hold the evening in your hands"];
    expect(looksEnglish(en)).toBe(true);
    expect(looksEnglish(["La vie en rose et le temps qui passe", "Je ne regrette rien de tout cela", "Quand il me prend dans ses bras"])).toBe(false);
    expect(looksEnglish(["la la la"])).toBe(false);
    expect(looksEnglish(["夜に駆ける 沈むように溶けてゆくように 二人だけの空が広がる夜に"])).toBe(false);
  });
});
