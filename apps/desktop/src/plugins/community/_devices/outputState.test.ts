import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "@/player/playerStore";
import { emptyContributions, usePluginHost } from "@/plugins/host";
import type { OutputTarget } from "../../types";
import { chooseOutput, isLocalSilenced, reportOutputLost, silenceLocal, useOutput } from "./outputState";

function target(id: string, overrides: Partial<OutputTarget> = {}): OutputTarget & { select: ReturnType<typeof vi.fn> } {
  return { id, label: id, listDevices: async () => [], select: vi.fn(async () => undefined), ...overrides } as never;
}

function install(...targets: OutputTarget[]) {
  usePluginHost.setState({ contributions: { ...emptyContributions(), outputTargets: targets } });
}

beforeEach(() => {
  silenceLocal(false);
  usePlayer.setState({ muted: false, volume: 0.8 });
  useOutput.setState({ active: null, error: null, busy: false });
});

describe("silenceLocal", () => {
  it("mutes and restores only what it muted", () => {
    silenceLocal(true);
    expect(usePlayer.getState().muted).toBe(true);
    expect(isLocalSilenced()).toBe(true);
    silenceLocal(false);
    expect(usePlayer.getState().muted).toBe(false);
  });

  it("keeps this device quiet when the volume slider is moved", async () => {
    silenceLocal(true);
    usePlayer.getState().setVolume(0.5);
    await Promise.resolve();
    expect(usePlayer.getState().muted).toBe(true);
    expect(usePlayer.getState().volume).toBe(0.5);
    silenceLocal(false);
    expect(usePlayer.getState().muted).toBe(false);
  });
});

describe("chooseOutput", () => {
  it("selects the device on its target and records it", async () => {
    const a = target("a");
    install(a);
    await chooseOutput("a", "dev1", "Kitchen");
    expect(a.select).toHaveBeenCalledWith("dev1");
    expect(useOutput.getState().active).toEqual({ targetId: "a", deviceId: "dev1", deviceName: "Kitchen" });
    expect(useOutput.getState().busy).toBe(false);
  });

  it("releases the previous target when another one is chosen, and when going back to this device", async () => {
    const a = target("a");
    const b = target("b");
    install(a, b);
    await chooseOutput("a", "dev1", "Kitchen");
    await chooseOutput("b", "dev2", "Den");
    expect(a.select).toHaveBeenLastCalledWith(null);
    expect(b.select).toHaveBeenCalledWith("dev2");
    await chooseOutput(null, null);
    expect(b.select).toHaveBeenLastCalledWith(null);
    expect(useOutput.getState().active).toBeNull();
  });

  it("switching devices on the same target does not release it first", async () => {
    const a = target("a");
    install(a);
    await chooseOutput("a", "dev1", "Kitchen");
    await chooseOutput("a", "dev2", "Den");
    expect(a.select.mock.calls.map((c) => c[0])).toEqual(["dev1", "dev2"]);
  });

  it("shows the error and stays on this device when a target refuses", async () => {
    install(target("a", { select: vi.fn(async () => Promise.reject(new Error("The device did not respond."))) }));
    await chooseOutput("a", "dev1", "Kitchen");
    expect(useOutput.getState().active).toBeNull();
    expect(useOutput.getState().error).toBe("The device did not respond.");
  });

  it("reports a lost output without leaving the picker claiming playback is there", async () => {
    install(target("a"));
    await chooseOutput("a", "dev1", "Kitchen");
    reportOutputLost("a", "Lost contact.");
    expect(useOutput.getState().active).toBeNull();
    expect(useOutput.getState().error).toBe("Lost contact.");
    reportOutputLost("other", "ignored for active");
    expect(useOutput.getState().error).toBe("ignored for active");
  });
});
