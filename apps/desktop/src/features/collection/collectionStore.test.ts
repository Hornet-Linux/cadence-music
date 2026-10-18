import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { useCollection, type CollectionRemote } from "./collectionStore";

const track = (id: string): Track => ({ id, title: `Song ${id}`, artists: [{ id: "a", name: "Artist" }], source: "spotify" });

function fakeRemote(): CollectionRemote & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    like: vi.fn(async (t: Track) => void calls.push(`like ${t.id}`)),
    unlike: vi.fn(async (id: string) => void calls.push(`unlike ${id}`)),
    createPlaylist: vi.fn(async (name: string, tracks: Track[]) => {
      calls.push(`create ${name}`);
      return { id: "srv-1", name, tracks, updatedAt: 1 };
    }),
    updatePlaylist: vi.fn(async (id: string) => void calls.push(`update ${id}`)),
    deletePlaylist: vi.fn(async (id: string) => void calls.push(`delete ${id}`)),
  };
}

describe("collection store", () => {
  beforeEach(() => {
    localStorage.clear();
    useCollection.setState({ likes: [], playlists: [], remote: null });
  });

  it("toggles likes, newest first, and remembers them", () => {
    const { toggleLike } = useCollection.getState();
    toggleLike(track("1"));
    toggleLike(track("2"));
    expect(useCollection.getState().likes.map((l) => l.track.id)).toEqual(["2", "1"]);
    toggleLike(track("1"));
    expect(useCollection.getState().likes.map((l) => l.track.id)).toEqual(["2"]);
    expect(localStorage.getItem("collection:v1")).toContain('"2"');
  });

  it("creates and edits playlists locally without a remote", async () => {
    const s = useCollection.getState();
    const id = await s.createPlaylist("Mix", [track("1")]);
    expect(id).toMatch(/^local-/);
    s.addToPlaylist(id, [track("2"), track("3")]);
    s.removeFromPlaylist(id, 0);
    s.renamePlaylist(id, "Better mix");
    const playlist = useCollection.getState().playlists[0];
    expect(playlist.name).toBe("Better mix");
    expect(playlist.tracks.map((t) => t.id)).toEqual(["2", "3"]);
    expect(playlist.synced).toBeFalsy();
  });

  it("sends changes to the remote and uses its playlist ids", async () => {
    const remote = fakeRemote();
    useCollection.getState().setRemote(remote);
    useCollection.getState().toggleLike(track("1"));
    const id = await useCollection.getState().createPlaylist("Mix");
    expect(id).toBe("srv-1");
    useCollection.getState().addToPlaylist(id, [track("9")]);
    useCollection.getState().deletePlaylist(id);
    expect(remote.calls).toEqual(["like 1", "create Mix", "update srv-1", "delete srv-1"]);
  });

  it("merges the remote copy, keeps unsynced local items and drops synced ones on sign-out", () => {
    useCollection.getState().toggleLike(track("local"));
    useCollection.getState().applyRemote({
      likes: [{ track: track("remote"), likedAt: Date.now() + 1000 }],
      playlists: [{ id: "srv", name: "Server list", tracks: [], updatedAt: 1 }],
    });
    expect(useCollection.getState().likes.map((l) => l.track.id)).toEqual(["remote", "local"]);
    useCollection.getState().dropSynced();
    expect(useCollection.getState().likes.map((l) => l.track.id)).toEqual(["local"]);
    expect(useCollection.getState().playlists).toEqual([]);
  });
});
