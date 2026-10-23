import { describe, expect, it } from "vitest";
import type { CommandContribution } from "../../types";
import {
  DEFAULT_MEDIA_KEYS_SETTINGS,
  OWN_COMMANDS,
  effectiveBindings,
  planRegistration,
  positionState,
  shortcutWarning,
  withOverride,
} from "./bindings";

const cmd = (id: string, title: string, shortcut?: string): CommandContribution => ({ id, title, shortcut, run: () => undefined });

const commands = [
  cmd("cadence.media-keys.next", "Next track", "Ctrl+Alt+Right"),
  cmd("cadence.media-keys.play-pause", "Play or pause", "Ctrl+Alt+Space"),
  cmd("other.palette", "Open palette", "Ctrl+K"),
  cmd("other.sleep", "Sleep timer"),
];

describe("effective bindings", () => {
  it("uses suggestions for this plugin's commands only", () => {
    const b = effectiveBindings(commands, DEFAULT_MEDIA_KEYS_SETTINGS);
    expect(b.map((x) => [x.id, x.accelerator, x.source])).toEqual([
      ["cadence.media-keys.next", "Ctrl+Alt+Right", "default"],
      ["cadence.media-keys.play-pause", "Ctrl+Alt+Space", "default"],
      ["other.palette", null, "none"],
      ["other.sleep", null, "none"],
    ]);
    expect(b[2]!.suggestion).toBe("Ctrl+K");
  });

  it("honours what the person chose, including 'no shortcut' and other plugins' commands", () => {
    const b = effectiveBindings(commands, {
      overrides: { "cadence.media-keys.next": null, "other.sleep": "ctrl+alt+s", "cadence.media-keys.play-pause": "F9" },
    });
    expect(b.find((x) => x.id === "cadence.media-keys.next")).toMatchObject({ accelerator: null, source: "none" });
    expect(b.find((x) => x.id === "other.sleep")).toMatchObject({ accelerator: "Ctrl+Alt+S", source: "user" });
    expect(b.find((x) => x.id === "cadence.media-keys.play-pause")).toMatchObject({ accelerator: "F9", source: "user" });
  });

  it("ignores duplicate command ids", () => {
    expect(effectiveBindings([commands[0]!, commands[0]!], DEFAULT_MEDIA_KEYS_SETTINGS)).toHaveLength(1);
  });

  it("ships a distinct, valid suggested shortcut for each of its own commands", () => {
    const b = effectiveBindings(
      OWN_COMMANDS.map((c) => cmd(`cadence.media-keys.${c.name}`, c.title, c.shortcut)),
      DEFAULT_MEDIA_KEYS_SETTINGS,
    );
    const plan = planRegistration(b, "win32");
    expect(plan.send).toHaveLength(OWN_COMMANDS.length);
    expect(plan.conflicts).toEqual([]);
    expect(plan.problems).toEqual({});
  });
});

describe("registration plan and conflicts", () => {
  it("lets the first command keep a contested shortcut and explains why the other waits", () => {
    const b = effectiveBindings(commands, { overrides: { "other.sleep": "Ctrl+Alt+Right" } });
    const plan = planRegistration(b, "win32");
    expect(plan.conflicts).toEqual([{ accelerator: "Ctrl+Alt+Right", ids: ["cadence.media-keys.next", "other.sleep"] }]);
    expect(plan.send.map((s) => s.id)).toEqual(["cadence.media-keys.next", "cadence.media-keys.play-pause"]);
    expect(plan.problems["other.sleep"]).toBe('Same keys as "Next track"');
  });

  it("rejects shortcuts that would steal typing, and says why", () => {
    const b = effectiveBindings(commands, { overrides: { "other.sleep": "S", "other.palette": "Shift+K" } });
    const plan = planRegistration(b, "win32");
    expect(plan.send.map((s) => s.id)).not.toContain("other.sleep");
    expect(plan.problems["other.sleep"]).toMatch(/Ctrl, Alt or Cmd/);
    expect(plan.problems["other.palette"]).toMatch(/Shift alone/);
  });

  it("flags shortcuts other apps commonly use", () => {
    expect(shortcutWarning("Ctrl+C", "win32")).toMatch(/Other apps/);
    expect(shortcutWarning("Ctrl+Alt+Right", "win32")).toBeNull();
  });
});

describe("overrides", () => {
  it("sets, clears and resets", () => {
    let s = withOverride(DEFAULT_MEDIA_KEYS_SETTINGS, "a", "F8");
    expect(s.overrides).toEqual({ a: "F8" });
    s = withOverride(s, "a", null);
    expect(s.overrides).toEqual({ a: null });
    s = withOverride(s, "a", undefined);
    expect(s.overrides).toEqual({});
  });
});

describe("positionState", () => {
  it("is valid only with a real duration and keeps the position in range", () => {
    expect(positionState(0, 5, true)).toBeNull();
    expect(positionState(Number.NaN, 5, true)).toBeNull();
    expect(positionState(100, 130, true)).toEqual({ duration: 100, position: 100, playbackRate: 1 });
    expect(positionState(100, -3, false)).toMatchObject({ position: 0, playbackRate: 0.0001 });
  });
});