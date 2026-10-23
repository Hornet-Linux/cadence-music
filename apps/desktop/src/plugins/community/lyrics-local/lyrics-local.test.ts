import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
let user: unknown = { id: 1 };
vi.mock("@/plugins/builtins/server/serverStore", () => ({
  SERVER_TRACK_PREFIX: "server:",
  useServer: { getState: () => ({ user, api }) },
}));

const { default: plugin } = await import("./index");
import type { LyricsProvider, PluginContext } from "../../types";

function provider(): LyricsProvider {
  let registered: LyricsProvider | undefined;
  plugin.activate({ registerLyricsProvider: (p: LyricsProvider) => (registered = p) } as unknown as PluginContext);
  return registered!;
}

const serverTrack = { id: "server:abc123", title: "T", artists: [] };

describe("library lyrics provider", () => {
  beforeEach(() => {
    api.mockReset();
    user = { id: 1 };
  });

  it("only looks up tracks from the server library", async () => {
    expect(await provider().getLyrics({ id: "spotify:1", title: "T", artists: [] })).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("does nothing when signed out", async () => {
    user = null;
    expect(await provider().getLyrics(serverTrack)).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("turns an .lrc file into synced lyrics with a source line", async () => {
    api.mockResolvedValue({ lrc: "[00:01.00]hi\n[00:03.00]there", from: "lrc-file" });
    const lyrics = await provider().getLyrics(serverTrack);
    expect(api).toHaveBeenCalledWith("api/lyrics/local/abc123");
    expect(lyrics).toMatchObject({ synced: true, source: "a .lrc file in your library", lines: [{ timeSec: 1, text: "hi" }, { timeSec: 3, text: "there" }] });
  });

  it("handles plain embedded lyrics", async () => {
    api.mockResolvedValue({ plain: "one\ntwo", from: "embedded" });
    expect(await provider().getLyrics(serverTrack)).toMatchObject({ synced: false, source: "the song file tags" });
  });

  it("treats 404 as no lyrics but surfaces other errors", async () => {
    api.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 404 }));
    expect(await provider().getLyrics(serverTrack)).toBeNull();
    api.mockRejectedValueOnce(Object.assign(new Error("down"), { status: 500 }));
    await expect(provider().getLyrics(serverTrack)).rejects.toThrow("down");
  });
});
