import { describe, expect, it } from "vitest";
import { search } from "./types";

describe("search", () => {
  it("builds a query string, skipping empty values and writing true as 1", () => {
    expect(search({ q: "daft punk", limit: 100, offset: 0, favourites: true, albumId: undefined, artistId: "" })).toBe("?q=daft+punk&limit=100&offset=0&favourites=1");
    expect(search({ favourites: false })).toBe("");
  });
});