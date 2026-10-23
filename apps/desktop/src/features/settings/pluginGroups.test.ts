import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@/plugins/types";
import { capabilityLabel, groupPlugins, pluginGroup } from "./pluginGroups";

const m = (id: string, name: string, capabilities: PluginManifest["capabilities"], description = ""): PluginManifest => ({
  id,
  name,
  version: "1.0.0",
  apiRange: "^1",
  capabilities,
  description,
});

describe("plugin groups", () => {
  it("picks the strongest capability", () => {
    expect(pluginGroup(m("a", "A", ["ui.sidebar", "source.library"]))).toBe("Sources");
    expect(pluginGroup(m("b", "B", ["storage"]))).toBe("Other");
  });
  it("filters, groups and sorts", () => {
    const rows = [
      { manifest: m("z", "Zeta", ["ui.home.widget"]), enabled: true },
      { manifest: m("a", "Alpha", ["ui.home.widget"], "weather"), enabled: false },
      { manifest: m("l", "Lyr", ["provider.lyrics"]), enabled: true },
    ];
    const all = groupPlugins(rows, "", "all");
    expect(all.map((g) => g.group)).toEqual(["Lyrics & info", "Home & pages"]);
    expect(all[1].rows.map((r) => r.manifest.name)).toEqual(["Alpha", "Zeta"]);
    expect(groupPlugins(rows, "", "on").flatMap((g) => g.rows).length).toBe(2);
    expect(groupPlugins(rows, "WEATHER", "all").flatMap((g) => g.rows)[0].manifest.id).toBe("a");
  });
});

describe("capabilityLabel", () => {
  it("uses plain language", () => {
    expect(capabilityLabel("network.outbound")).toBe("Uses the internet");
    expect(capabilityLabel("ui.sidebar")).toBe("Adds a page");
  });
});
