import { describe, expect, it } from "vitest";
import { filterMoreItems } from "./Sidebar";

const item = (id: string, label: string) => ({ id, label, render: () => null });

describe("filterMoreItems", () => {
  it("sorts alphabetically ignoring case and filters by label", () => {
    const items = [item("y", "YouTube"), item("a", "archive"), item("b", "Backup")];
    expect(filterMoreItems(items, "").map((i) => i.id)).toEqual(["a", "b", "y"]);
    expect(filterMoreItems(items, "tub").map((i) => i.id)).toEqual(["y"]);
  });
});
