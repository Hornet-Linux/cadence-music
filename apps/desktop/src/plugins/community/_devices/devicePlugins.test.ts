import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginHost } from "@/plugins/host";
import type { Plugin } from "../../types";
import { rendererApi } from "./deviceApi";
import { friendlyError } from "./errors";
import { ApiError } from "../../builtins/server/serverStore";
import airplay from "../airplay";
import chromecast from "../chromecast";
import dlna from "../dlna";
import homeAssistant from "../home-assistant";
import outputPicker from "../output-picker";
import remoteControl from "../remote-control";
import snapcast from "../snapcast";

const all: Plugin[] = [outputPicker, remoteControl, dlna, chromecast, airplay, snapcast, homeAssistant];

afterEach(async () => {
  for (const p of all) await usePluginHost.getState().setEnabled(p.manifest.id, false);
});

describe("device plugins", () => {
  it("have unique ids, start disabled and request only what they use", () => {
    expect(new Set(all.map((p) => p.manifest.id)).size).toBe(all.length);
    for (const p of all) {
      expect(p.manifest.id).toMatch(/^cadence\./);
      expect(p.manifest.builtin).not.toBe(true);
    }
    expect(airplay.manifest.capabilities).toEqual(["ui.settings"]);
    expect(snapcast.manifest.capabilities).not.toContain("output.device");
  });

  it("DLNA and Chromecast each add one output and a settings panel", async () => {
    for (const p of [dlna, chromecast]) usePluginHost.getState().register(p);
    await usePluginHost.getState().setEnabled(dlna.manifest.id, true);
    await usePluginHost.getState().setEnabled(chromecast.manifest.id, true);
    const { outputTargets, settings } = usePluginHost.getState().contributions;
    expect(outputTargets.map((t) => t.label)).toEqual(["DLNA and Sonos", "Chromecast"]);
    expect(settings.map((s) => s.id)).toEqual(expect.arrayContaining(["dlna", "chromecast"]));
  });

  it("AirPlay offers no output and says plainly that it is not available", async () => {
    usePluginHost.getState().register(airplay);
    await usePluginHost.getState().setEnabled(airplay.manifest.id, true);
    const { outputTargets, settings } = usePluginHost.getState().contributions;
    expect(outputTargets).toHaveLength(0);
    const panel = settings.find((s) => s.id === "airplay")!;
    expect(panel.title).toMatch(/not available/i);
    expect(airplay.manifest.name).toMatch(/not available/i);
  });

  it("Snapcast adds a page but no output (it does not receive Cadence audio)", async () => {
    usePluginHost.getState().register(snapcast);
    await usePluginHost.getState().setEnabled(snapcast.manifest.id, true);
    const { sidebar, outputTargets } = usePluginHost.getState().contributions;
    expect(sidebar.map((s) => s.id)).toContain("snapcast");
    expect(outputTargets).toHaveLength(0);
  });
});

describe("device api", () => {
  it("builds routes per plugin and encodes device ids", async () => {
    const api = vi.fn<(route: string, init?: RequestInit) => Promise<unknown>>(async () => ({}));
    const dlnaApi = rendererApi("dlna", api as never);
    await dlnaApi.list(true);
    await dlnaApi.pause("uuid:a/b");
    await dlnaApi.seek("d", 12);
    await dlnaApi.removeManual("x y");
    expect(api.mock.calls.map((c) => c[0])).toEqual([
      "api/dlna/devices?refresh=1",
      "api/dlna/devices/uuid%3Aa%2Fb/pause",
      "api/dlna/devices/d/seek",
      "api/dlna/devices/manual/x%20y",
    ]);
    expect(JSON.parse(api.mock.calls[2]![1]!.body as string)).toEqual({ positionSec: 12 });
  });

  it("friendlyError drops the HTTP wrapper but keeps the server's own words", () => {
    expect(friendlyError(new ApiError("Request failed (502): The device did not respond.", 502))).toBe("The device did not respond.");
    expect(friendlyError(new ApiError("Request failed (404)", 404))).toBe("The device is no longer available.");
    expect(friendlyError(new Error("boom"))).toBe("boom");
    expect(friendlyError("odd", "fallback")).toBe("fallback");
  });
});
