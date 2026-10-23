import type { Capability, PluginManifest } from "@/plugins/types";

/** Groups shown in Settings > Plugins, in display order. */
export const PLUGIN_GROUPS = [
  "Sources",
  "Sound",
  "Lyrics & info",
  "Playback & queue",
  "Devices & remotes",
  "Home & pages",
  "Other",
] as const;
export type PluginGroup = (typeof PLUGIN_GROUPS)[number];

/** Strongest capability wins, so a source that also adds a page stays a source. */
const RULES: [Capability, PluginGroup][] = [
  ["source.library", "Sources"],
  ["source.audio", "Sources"],
  ["audio.dsp", "Sound"],
  ["provider.lyrics", "Lyrics & info"],
  ["provider.metadata", "Lyrics & info"],
  ["output.device", "Devices & remotes"],
  ["commands", "Devices & remotes"],
  ["player.queue", "Playback & queue"],
  ["player.control", "Playback & queue"],
  ["track.actions", "Playback & queue"],
  ["ui.sidebar", "Home & pages"],
  ["ui.home.widget", "Home & pages"],
];

export function pluginGroup(m: Pick<PluginManifest, "capabilities">): PluginGroup {
  for (const [cap, group] of RULES) if (m.capabilities.includes(cap)) return group;
  return "Other";
}

export type PluginFilter = "all" | "on" | "off";

export interface PluginRow {
  manifest: PluginManifest;
  enabled: boolean;
}

/**
 * Filters by search text and on/off state, then groups and sorts by name.
 * Empty groups are dropped.
 */
export function groupPlugins(
  rows: PluginRow[],
  query: string,
  filter: PluginFilter,
): { group: PluginGroup; rows: PluginRow[] }[] {
  const q = query.trim().toLowerCase();
  const kept = rows.filter((r) => {
    if (filter === "on" && !r.enabled) return false;
    if (filter === "off" && r.enabled) return false;
    if (!q) return true;
    const m = r.manifest;
    return [m.name, m.description ?? "", m.id, ...m.capabilities].join(" ").toLowerCase().includes(q);
  });
  return PLUGIN_GROUPS.map((group) => ({
    group,
    rows: kept
      .filter((r) => pluginGroup(r.manifest) === group)
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
  })).filter((g) => g.rows.length > 0);
}
