import { describe, expect, it } from "vitest";
import { addItem, embedSrc, parseBandcampInput, parseEmbedAddress, parsePageLink, sanitizeItems, titleFromSlug, type BandcampItem } from "./parse";

const SNIPPET = `<iframe style="border: 0; width: 400px; height: 120px;" src="https://bandcamp.com/EmbeddedPlayer/album=3985379049/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/" seamless><a href="https://nightowls.bandcamp.com/album/after-dark">After Dark by Night &amp; Owls</a></iframe>`;

describe("official embed addresses", () => {
  it("reads the album or track id from Bandcamp's own player address", () => {
    expect(parseEmbedAddress("https://bandcamp.com/EmbeddedPlayer/album=3985379049/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/")).toEqual({ type: "album", id: "3985379049" });
    expect(parseEmbedAddress("https://bandcamp.com/EmbeddedPlayer/track=42/size=small/")).toEqual({ type: "track", id: "42" });
    expect(parseEmbedAddress("https://bandcamp.com/EmbeddedPlayer/album=1/t=3/minimal=true/")).toEqual({ type: "album", id: "1" });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "http://bandcamp.com/EmbeddedPlayer/album=1/",
      "https://evil.example/EmbeddedPlayer/album=1/",
      "https://bandcamp.com.evil.example/EmbeddedPlayer/album=1/",
      "https://user:pw@bandcamp.com/EmbeddedPlayer/album=1/",
      "https://bandcamp.com:8443/EmbeddedPlayer/album=1/",
      "https://bandcamp.com/EmbeddedPlayer/album=1/?x=1",
      "https://bandcamp.com/EmbeddedPlayer/album=1/#f",
      "https://bandcamp.com/EmbeddedPlayer/",
      "https://bandcamp.com/EmbeddedPlayer/size=large/",
      "https://bandcamp.com/EmbeddedPlayer/album=1/track=2/",
      "https://bandcamp.com/EmbeddedPlayer/album=abc/",
      "https://bandcamp.com/EmbeddedPlayer/album=1/onload=alert(1)/",
      "https://bandcamp.com/EmbeddedPlayer/album=1/../../x/",
      "https://bandcamp.com/other/album=1/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(parseEmbedAddress(bad), bad).toBeNull();
    }
  });

  it("rebuilds the player address instead of reusing the pasted one", () => {
    const src = embedSrc("album", "3985379049");
    expect(src).toBe("https://bandcamp.com/EmbeddedPlayer/album=3985379049/size=large/bgcol=1b1b22/linkcol=a3a3b2/tracklist=false/artwork=small/transparent=true/");
    expect(parseEmbedAddress(src)).toEqual({ type: "album", id: "3985379049" });
  });
});

describe("page links", () => {
  it("accepts album and track pages and drops tracking junk", () => {
    expect(parsePageLink("https://nightowls.bandcamp.com/album/after-dark?from=search&utm=x#t")).toEqual({
      url: "https://nightowls.bandcamp.com/album/after-dark",
      artist: "nightowls",
      title: "After dark",
      type: "album",
    });
    expect(parsePageLink("https://solo.bandcamp.com/track/it-s-fine")?.type).toBe("track");
  });

  it("refuses other hosts, other shapes and unsafe schemes", () => {
    for (const bad of [
      "http://nightowls.bandcamp.com/album/x",
      "https://bandcamp.com/album/x",
      "https://nightowls.bandcamp.com/",
      "https://nightowls.bandcamp.com/music",
      "https://nightowls.bandcamp.com/album/x/extra",
      "https://nightowls.bandcamp.com.evil.example/album/x",
      "https://evil.example/nightowls.bandcamp.com/album/x",
      "https://user@nightowls.bandcamp.com/album/x",
      "javascript:alert(1)",
    ]) {
      expect(parsePageLink(bad), bad).toBeNull();
    }
  });

  it("turns slugs into readable titles", () => {
    expect(titleFromSlug("after-dark")).toBe("After dark");
    expect(titleFromSlug("caf%C3%A9-del-mar")).toBe("Café del mar");
    expect(titleFromSlug("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("pasted input", () => {
  it("turns an embed snippet into a player with the title from its link", () => {
    const r = parseBandcampInput(SNIPPET);
    expect(r).toEqual({
      ok: true,
      item: { kind: "embed", type: "album", id: "3985379049", title: "After Dark by Night & Owls", pageUrl: "https://nightowls.bandcamp.com/album/after-dark" },
    });
  });

  it("takes a bare player address too", () => {
    const r = parseBandcampInput("https://bandcamp.com/EmbeddedPlayer/track=77/size=large/");
    expect(r).toMatchObject({ ok: true, item: { kind: "embed", type: "track", id: "77" } });
  });

  it("turns a page link into a link-out, never a player", () => {
    expect(parseBandcampInput("  https://nightowls.bandcamp.com/album/after-dark?utm=1  ")).toEqual({
      ok: true,
      item: { kind: "link", url: "https://nightowls.bandcamp.com/album/after-dark", title: "After dark", artist: "nightowls" },
    });
  });

  it("explains what it can't use", () => {
    expect(parseBandcampInput("")).toMatchObject({ ok: false });
    expect(parseBandcampInput("https://example.com/album/x")).toMatchObject({ ok: false });
    expect(parseBandcampInput('<iframe src="https://evil.example/EmbeddedPlayer/album=1/"></iframe>')).toMatchObject({ ok: false, reason: expect.stringContaining("official") });
    expect(parseBandcampInput('<iframe src="javascript:alert(1)"></iframe>')).toMatchObject({ ok: false });
    expect(parseBandcampInput("x".repeat(5000))).toMatchObject({ ok: false });
  });

  it("never lets markup from the snippet through as anything but text", () => {
    const r = parseBandcampInput(`<iframe src="https://bandcamp.com/EmbeddedPlayer/album=5/"><a href="https://a.bandcamp.com/album/x"><img src=x onerror=alert(1)>Evil</a></iframe>`);
    expect(r).toMatchObject({ ok: true, item: { title: "Evil" } });
  });
});

describe("the saved list", () => {
  const album: BandcampItem = { kind: "embed", type: "album", id: "1", title: "A", pageUrl: "https://a.bandcamp.com/album/a" };
  const link: BandcampItem = { kind: "link", url: "https://a.bandcamp.com/album/a", title: "A", artist: "a" };

  it("does not add the same thing twice and lets a player replace a link to the same page", () => {
    expect(addItem([link], link)).toEqual([link]);
    expect(addItem([link], album)).toEqual([album]);
    expect(addItem([album], { ...link, url: "https://b.bandcamp.com/album/b" })).toHaveLength(2);
  });

  it("drops anything malformed when reading back", () => {
    const stored = [
      album,
      link,
      { kind: "embed", type: "album", id: "not-a-number", title: "x" },
      { kind: "embed", type: "playlist", id: "1", title: "x" },
      { kind: "link", url: "https://evil.example/album/x", title: "x", artist: "a" },
      { kind: "link", url: "javascript:alert(1)", title: "x", artist: "a" },
      "junk",
      null,
    ];
    expect(sanitizeItems(stored)).toEqual([album, link]);
    expect(sanitizeItems("nope")).toEqual([]);
    expect(sanitizeItems(undefined)).toEqual([]);
  });
});
