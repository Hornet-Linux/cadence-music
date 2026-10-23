import { describe, expect, it } from "vitest";
import { dedupeTracks } from "./libraryTracks";

const t = (id: string, title = id) => ({ id, title, artists: [] });

describe("dedupeTracks", () => {
  it("keeps the first copy of each id, in order", () => {
    const out = dedupeTracks([t("a", "from server"), t("b")], [t("a", "from history"), t("c")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out[0].title).toBe("from server");
  });
  it("handles empty input", () => {
    expect(dedupeTracks()).toEqual([]);
    expect(dedupeTracks([], [])).toEqual([]);
  });
});