import { beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DEFAULT_TUNING, useTuning } from "@/player/tuning";
import type { CommandContribution } from "@/plugins/types";
import plugin, { SpeedPanel, setSpeed, useSpeed } from "./index";
import { SPEED_PRESETS, clampRate, describePitch, formatRate, matchSpeedPreset, pitchShiftSemitones, stepRate } from "./speed";

beforeEach(() => {
  useTuning.setState({ ...DEFAULT_TUNING });
  useSpeed.setState({ rate: 1, preservePitch: true });
});

describe("speed maths", () => {
  it("clamps to 0.5x-2x on a 0.05 grid", () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(9)).toBe(2);
    expect(clampRate(1.234)).toBe(1.25);
    expect(clampRate(NaN)).toBe(1);
  });

  it("steps up and down and stops at the ends", () => {
    expect(stepRate(1, 1)).toBe(1.1);
    expect(stepRate(1, -1)).toBe(0.9);
    expect(stepRate(0.9, -1)).toBe(0.85);
    expect(stepRate(2, 1)).toBe(2);
    expect(stepRate(0.5, -1)).toBe(0.5);
  });

  it("describes the pitch shift in semitones", () => {
    expect(pitchShiftSemitones(2)).toBeCloseTo(12);
    expect(pitchShiftSemitones(0.5)).toBeCloseTo(-12);
    expect(describePitch(1.25, false)).toBe("Pitch up 3.9 semitones");
    expect(describePitch(0.85, false)).toBe("Pitch down 2.8 semitones");
    expect(describePitch(1.5, true)).toBe("Pitch stays the same");
  });

  it("recognises presets and formats rates", () => {
    expect(matchSpeedPreset(1.25, false)).toBe("nightcore");
    expect(matchSpeedPreset(1.25, true)).toBeNull();
    expect(formatRate(1.5)).toBe("1.5x");
    expect(formatRate(0.85)).toBe("0.85x");
    expect(SPEED_PRESETS.every((p) => p.rate >= 0.5 && p.rate <= 2)).toBe(true);
  });
});

describe("speed & pitch plugin", () => {
  it("drives the player's tuning", () => {
    setSpeed({ rate: 1.25, preservePitch: false });
    expect(useTuning.getState().rate).toBe(1.25);
    expect(useTuning.getState().preservePitch).toBe(false);
    setSpeed({ rate: 5 });
    expect(useTuning.getState().rate).toBe(2);
  });

  it("registers commands that step the speed, and resets on deactivate", () => {
    const commands = new Map<string, CommandContribution>();
    plugin.activate({
      registerSettingsPanel: () => undefined,
      registerCommand: (c: CommandContribution) => void commands.set(c.id, c),
    } as never);
    expect([...commands.keys()].sort()).toEqual(["reset-speed", "slow-down", "speed-up"]);
    commands.get("speed-up")!.run();
    expect(useTuning.getState().rate).toBe(1.1);
    commands.get("slow-down")!.run();
    commands.get("slow-down")!.run();
    expect(useTuning.getState().rate).toBe(0.9);
    commands.get("reset-speed")!.run();
    expect(useTuning.getState().rate).toBe(1);

    setSpeed({ rate: 1.5 });
    void plugin.deactivate?.();
    expect(useTuning.getState().rate).toBe(1);
    expect(useTuning.getState().preservePitch).toBe(true);
  });

  it("keeps the chosen speed when activate runs again (another plugin toggled)", () => {
    setSpeed({ rate: 1.3 });
    plugin.activate({ registerSettingsPanel: () => undefined, registerCommand: () => undefined } as never);
    expect(useTuning.getState().rate).toBe(1.3);
  });

  it("does not save anything and renders its panel", () => {
    expect(plugin.manifest.capabilities).not.toContain("storage");
    const html = renderToString(<SpeedPanel />);
    expect(html).toContain("Nightcore");
    expect(html).toContain("Keep the pitch");
    expect(html).toContain("this session only");
  });
});
