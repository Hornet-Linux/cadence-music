import { describe, expect, it } from "vitest";
import { orderWidgets } from "./HomeView";

describe("orderWidgets", () => {
  it("sorts by weight then title", () => {
    const w = (id: string, title: string, weight?: number) => ({ id, title, weight, render: () => null });
    expect(orderWidgets([w("a", "Zed"), w("b", "Alpha"), w("c", "Mid", 5)]).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});
