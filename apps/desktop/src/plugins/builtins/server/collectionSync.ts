import type { LikesResponse, PlaylistResponse, PlaylistsResponse } from "@uma/shared";
import { useCollection, type CollectionRemote, type Playlist } from "@/features/collection/collectionStore";
import type { Track } from "@/shared/types";
import { useServer } from "./serverStore";

// Syncs liked songs and playlists with the server while signed in: uploads what
// was made on this device while signed out, then mirrors the server's copy.
// Signing out removes the server's items from this device.

const toPlaylist = (p: PlaylistResponse): Playlist => ({
  id: p.id,
  name: p.name,
  tracks: p.tracks as Track[],
  updatedAt: p.updatedAt,
});

const remote: CollectionRemote = {
  async like(track, likedAt) {
    await useServer.getState().api("api/me/likes", { method: "POST", body: JSON.stringify({ track, likedAt }) });
  },
  async unlike(trackId) {
    await useServer.getState().api(`api/me/likes?trackId=${encodeURIComponent(trackId)}`, { method: "DELETE" });
  },
  async createPlaylist(name, tracks) {
    const created = await useServer
      .getState()
      .api<PlaylistResponse>("api/me/playlists", { method: "POST", body: JSON.stringify({ name, tracks }) });
    return toPlaylist(created);
  },
  async updatePlaylist(id, patch) {
    await useServer
      .getState()
      .api(`api/me/playlists/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async deletePlaylist(id) {
    await useServer.getState().api(`api/me/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};

let syncing = false;

async function sync() {
  if (syncing || !useServer.getState().user) return;
  syncing = true;
  const collection = useCollection.getState();
  try {
    // Upload anything made on this device while signed out.
    for (const like of collection.likes.filter((l) => !l.synced)) {
      await remote.like(like.track, like.likedAt);
    }
    const uploaded = new Set<string>();
    for (const playlist of collection.playlists.filter((p) => !p.synced)) {
      await remote.createPlaylist(playlist.name, playlist.tracks);
      uploaded.add(playlist.id);
    }
    if (uploaded.size > 0) {
      useCollection.setState((s) => ({ playlists: s.playlists.filter((p) => !uploaded.has(p.id)) }));
    }

    const api = useServer.getState().api;
    const [likes, playlists] = await Promise.all([
      api<LikesResponse>("api/me/likes"),
      api<PlaylistsResponse>("api/me/playlists"),
    ]);
    useCollection.getState().applyRemote({
      likes: likes.items.map((i) => ({ track: i.track as Track, likedAt: i.likedAt })),
      playlists: playlists.items.map(toPlaylist),
    });
    useCollection.getState().setRemote(remote);
  } catch {
    // Older server without collection support, or offline: stay local for now.
  } finally {
    syncing = false;
  }
}

let started = false;

export function startCollectionSync(): void {
  if (started) return;
  started = true;

  let signedInAs: number | null = null;
  const onServerChange = () => {
    const id = useServer.getState().user?.id ?? null;
    if (id === signedInAs) return;
    const wasSignedIn = signedInAs !== null;
    signedInAs = id;
    useCollection.getState().setRemote(null);
    if (wasSignedIn) useCollection.getState().dropSynced();
    if (id !== null) void sync();
  };
  useServer.subscribe(onServerChange);
  onServerChange();

  // Pick up changes made on other devices.
  window.addEventListener("focus", () => void sync());
  setInterval(() => void sync(), 5 * 60_000);
}
