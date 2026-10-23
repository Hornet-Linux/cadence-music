import { PLUGIN_GROUPS, pluginGroup, type PluginGroup } from "@/features/settings/pluginGroups";
import type { PluginManifest, SidebarContribution } from "@/plugins/types";

export interface NavGroup {
  group: PluginGroup;
  items: SidebarContribution[];
}

/**
 * Plugin pages grouped the same way as Settings > Plugins, sorted by label
 * within each group, filtered by `query`. Empty groups are dropped.
 */
export function groupNavItems(
  items: SidebarContribution[],
  manifestOf: (itemId: string) => Pick<PluginManifest, "capabilities"> | undefined,
  query = "",
): NavGroup[] {
  const q = query.trim().toLowerCase();
  const kept = items.filter((i) => !q || i.label.toLowerCase().includes(q));
  return PLUGIN_GROUPS.map((group) => ({
    group,
    items: kept
      .filter((i) => {
        const m = manifestOf(i.id);
        return (m ? pluginGroup(m) : "Other") === group;
      })
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
  })).filter((g) => g.items.length > 0);
}

const COLLAPSED_KEY = "cadence.nav.collapsed";
const CLOSED_KEY = "cadence.nav.closedGroups";

/** Whether the wide sidebar is folded to icons (remembered per device). */
export function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    /* storage unavailable: just not remembered */
  }
}

/** Sidebar groups the person folded away (remembered per device). */
export function loadClosedGroups(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function saveClosedGroups(v: string[]): void {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: just not remembered */
  }
}
