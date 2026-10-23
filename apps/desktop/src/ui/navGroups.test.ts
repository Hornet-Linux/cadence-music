import { beforeEach, describe, expect, it } from "vitest";
import { groupNavItems, loadClosedGroups, loadCollapsed, saveClosedGroups, saveCollapsed } from "./navGroups";

const item = (id: string, label: string) => ({ id, label, render: () => null });
const caps: Record<string, string[]> = {
  radio: ["source.library", "ui.sidebar"],
  eq: ["audio.dsp", "ui.sidebar"],
  stats: ["ui.sidebar"],
  abc: ["ui.sidebar"],
};

describe("groupNavItems", () => {
  it("groups by capability and sorts by label", () => {
    const groups = groupNavItems(
      [item("stats", "Stats"), item("eq", "Equalizer"), item("radio", "Radio"), item("abc", "archive"), item("x", "Unknown")],
      (id) => (caps[id] ? { capabilities: caps[id] as never } : undefined),
    );
    expect(groups.map((g) => g.group)).toEqual(["Sources", "Sound", "Home & pages", "Other"]);
    expect(groups[2].items.map((i) => i.label)).toEqual(["archive", "Stats"]);
  });
  it("filters by label", () => {
    const groups = groupNavItems([item("stats", "Stats"), item("eq", "Equalizer")], (id) => ({ capabilities: caps[id] as never }), "equ");
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["eq"]);
  });
});

describe("nav prefs", () => {
  beforeEach(() => localStorage.clear());
  it("remembers collapse and closed groups", () => {
    expect(loadCollapsed()).toBe(false);
    saveCollapsed(true);
    expect(loadCollapsed()).toBe(true);
    saveClosedGroups(["Sound"]);
    expect(loadClosedGroups()).toEqual(["Sound"]);
  });
});
