import { describe, expect, it } from "vitest";
import { cardText, FORMATS } from "./trackCard";

describe("cardText", () => {
  it("combines artists and builds a file name", () => {
    const t = cardText({ id: "1", title: "Halo", artists: [{ id: "a", name: "Artist One" }, { id: "b", name: "Two" }], album: " Album " });
    expect(t).toEqual({ title: "Halo", artist: "Artist One, Two", album: "Album", fileName: "artist-one-two-halo.png" });
  });
  it("copes with missing details", () => {
    const t = cardText({ id: "1", title: " ", artists: [] });
    expect(t.title).toBe("Untitled");
    expect(t.artist).toBe("Unknown artist");
    expect(t.album).toBeNull();
  });
  it("offers a portrait and a square format", () => {
    expect(FORMATS.portrait.height).toBeGreaterThan(FORMATS.portrait.width);
    expect(FORMATS.square.height).toBe(FORMATS.square.width);
  });
});