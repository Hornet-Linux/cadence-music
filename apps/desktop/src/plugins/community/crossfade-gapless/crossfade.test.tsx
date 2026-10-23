import { beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DEFAULT_TUNING, useTuning } from "@/player/tuning";
import plugin, { TransitionPanel, applyToPlayer, fadeLabel, transitionPrefs } from "./index";

function storage() {
  const map = new Map<string, unknown>();
  return {
    map,
    api: {
      get: (k: string) => (map.get(k) as never) ?? null,
      set: (k: string, v: unknown) => void map.set(k, v),
      remove: (k: string) => void map.delete(k),
    },
  };
}

beforeEach(() => {
  useTuning.setState({ ...DEFAULT_TUNING });
});

describe("crossfade & gapless plugin", () => {
  it("clamps the crossfade to 0-12 s in half-second steps", () => {
    transitionPrefs.set({ crossfadeSec: 40 });
    expect(transitionPrefs.get().crossfadeSec).toBe(12);
    transitionPrefs.set({ crossfadeSec: -3 });
    expect(transitionPrefs.get().crossfadeSec).toBe(0);
    transitionPrefs.set({ crossfadeSec: 3.3 });
    expect(transitionPrefs.get().crossfadeSec).toBe(3.5);
  });

  it("formats the length", () => {
    expect(fadeLabel(0)).toBe("Off");
    expect(fadeLabel(6)).toBe("6 s");
    expect(fadeLabel(2.5)).toBe("2.5 s");
  });

  it("pushes saved settings to the player on activate and resets them on deactivate", () => {
    const s = storage();
    s.map.set("settings", { crossfadeSec: 5, gapless: false });
    plugin.activate({ storage: s.api, registerSettingsPanel: () => undefined } as never);
    expect(useTuning.getState().crossfadeSec).toBe(5);
    expect(useTuning.getState().gapless).toBe(false);

    void plugin.deactivate?.();
    expect(useTuning.getState().crossfadeSec).toBe(0);
    expect(useTuning.getState().gapless).toBe(false);
  });

  it("applies changes straight away and saves them", () => {
    const s = storage();
    plugin.activate({ storage: s.api, registerSettingsPanel: () => undefined } as never);
    transitionPrefs.set({ crossfadeSec: 8, gapless: true });
    applyToPlayer();
    expect(useTuning.getState().crossfadeSec).toBe(8);
    expect(useTuning.getState().gapless).toBe(true);
    expect(s.map.get("settings")).toEqual({ crossfadeSec: 8, gapless: true });
  });

  it("uses only settings and storage and renders its panel", () => {
    expect(plugin.manifest.capabilities.sort()).toEqual(["storage", "ui.settings"]);
    const html = renderToString(<TransitionPanel />);
    expect(html).toContain("Overlap between tracks");
    expect(html).toContain("Gapless playback");
    expect(html).toContain("Spotify and Apple Music");
  });
});
