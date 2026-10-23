import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { Lyrics, LyricsProvider } from "../../types";
import { findLyrics } from "./loader";
import { instrumentalLyrics } from "./lrc";

const track: Track = { id: "1", title: "Song", artists: [{ id: "a", name: "Artist" }] };
const synced: Lyrics = { lines: [{ timeSec: 1, text: "a" }], synced: true, source: "S" };
const plain: Lyrics = { lines: [{ text: "a" }], synced: false, source: "P" };

const provider = (id: string, result: Lyrics | null | Error): LyricsProvider => ({
  id,
  label: id.toUpperCase(),
  getLyrics: vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  }),
});

describe("findLyrics", () => {
  it("stops at the first synced answer", async () => {
    const a = provider("a", synced);
    const b = provider("b", synced);
    const r = await findLyrics([a, b], track);
    expect(r.providerId).toBe("a");
    expect(b.getLyrics).not.toHaveBeenCalled();
  });

  it("keeps plain lyrics but lets a later provider do better", async () => {
    const r = await findLyrics([provider("a", plain), provider("b", synced)], track);
    expect(r).toMatchObject({ providerId: "b", lyrics: synced });
    const only = await findLyrics([provider("a", plain), provider("b", null)], track);
    expect(only).toMatchObject({ providerId: "a", lyrics: plain });
  });

  it("only uses an instrumental marker when nobody has words", async () => {
    const inst = instrumentalLyrics("X");
    expect((await findLyrics([provider("a", inst), provider("b", plain)], track)).providerId).toBe("b");
    expect((await findLyrics([provider("a", inst), provider("b", null)], track)).lyrics).toBe(inst);
  });

  it("reports failing providers and carries on", async () => {
    const r = await findLyrics([provider("a", new Error("boom")), provider("b", synced)], track);
    expect(r.providerId).toBe("b");
    expect(r.errors).toEqual([{ providerId: "a", label: "A", message: "boom" }]);
  });

  it("returns no lyrics and no errors when everyone has nothing", async () => {
    expect(await findLyrics([provider("a", null)], track)).toEqual({ lyrics: null, providerId: null, errors: [] });
  });

  it("can be limited to one provider, and passes the fresh flag", async () => {
    const a = provider("a", synced);
    const b = provider("b", plain);
    const r = await findLyrics([a, b], track, { providerId: "b", fresh: true });
    expect(r.providerId).toBe("b");
    expect(a.getLyrics).not.toHaveBeenCalled();
    expect(b.getLyrics).toHaveBeenCalledWith(track, undefined, { fresh: true });
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findLyrics([provider("a", synced)], track, { signal: controller.signal })).rejects.toThrow();
  });
});
