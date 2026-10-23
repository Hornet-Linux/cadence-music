import { describe, expect, it } from "vitest";
import { usePluginHost } from "@/plugins/host";
import type { Plugin } from "../../types";
import lrclib from "../lyrics-lrclib";
import local from "../lyrics-local";
import translate from "../lyrics-translate";
import view from "./index";
import { useLyricsTranslators } from "./api";

const all: Plugin[] = [local, lrclib, translate, view]; // the order the folders are found in

describe("lyrics plugins in the host", () => {
  it("declare only what they use and start disabled", () => {
    for (const p of all) {
      expect(p.manifest.id).toMatch(/^cadence\.lyrics-/);
      expect(p.manifest.builtin).toBeFalsy();
    }
    expect(lrclib.manifest.capabilities).toEqual(["provider.lyrics", "network.outbound", "storage"]);
    expect(translate.manifest.capabilities).toEqual(["storage"]);
  });

  it("activate and contribute a provider, a page and a translator", async () => {
    const host = usePluginHost.getState();
    for (const p of all) host.register(p);
    for (const p of all) await usePluginHost.getState().setEnabled(p.manifest.id, true);
    const c = usePluginHost.getState().contributions;
    expect(c.lyricsProviders.map((p) => p.id)).toEqual(["library-files", "lrclib"]);
    expect(c.sidebar.map((s) => s.id)).toContain("lyrics");
    expect(c.commands.map((s) => s.id)).toContain("lyrics.karaoke");
    expect(useLyricsTranslators.getState().translators.map((t) => t.id)).toEqual(["cadence.lyrics-translate"]);

    await usePluginHost.getState().setEnabled("cadence.lyrics-translate", false);
    expect(useLyricsTranslators.getState().translators).toEqual([]);
    await usePluginHost.getState().setEnabled("cadence.lyrics-view", false);
    expect(usePluginHost.getState().contributions.sidebar.map((s) => s.id)).not.toContain("lyrics");
  });
});
