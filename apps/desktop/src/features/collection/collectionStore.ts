import { create } from "zustand";
import type { Track } from "@/shared/types";

// Liked songs and playlists, kept on this device. A sync plugin (the server
// plugin today) can attach a `CollectionRemote`; changes are then also sent to
// it, and items it pulls in are marked `synced`. Items made while no remote is
// attached stay local until a sync uploads them.

const KEY = "collection:v1";
const MAX_PLAYLIST_TRACKS = 5000;

export interface Like {
  track: Track;
  likedAt: number;
  /** True once the item is known to exist on the remote. */
  synced?: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  updatedAt: number;
  synced?: boolean;
}

/** What a sync plugin provides; every call may reject (offline etc.). */
export interface CollectionRemote {
  like: (track: Track, likedAt: number) => Promise<void>;
  unlike: (trackId: string) => Promise<void>;
  createPlaylist: (name: string, tracks: Track[]) => Promise<Playlist>;
  updatePlaylist: (id: string, patch: { name: string; tracks: Track[] }) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
}

/** Strip a track down to what the collection needs to show and play it again. */
export function snapshot(track: Track): Track {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    artwork: track.artwork,
    durationSec: track.durationSec,
    source: track.source,
  };
}

interface Saved {
  likes: Like[];
  playlists: Playlist[];
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
    return {
      likes: Array.isArray(saved.likes) ? saved.likes : [],
      playlists: Array.isArray(saved.playlists) ? saved.playlists : [],
    };
  } catch {
    return { likes: [], playlists: [] };
  }
}

function save(state: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ likes: state.likes, playlists: state.playlists }));
  } catch {
    // Storage full; the server copy (if any) is still there.
  }
}

const localId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ignore = () => undefined;

interface CollectionState extends Saved {
  remote: CollectionRemote | null;

  toggleLike: (track: Track) => void;
  /** Returns the new playlist's id. */
  createPlaylist: (name: string, tracks?: Track[]) => Promise<string>;
  renamePlaylist: (id: string, name: string) => void;
  addToPlaylist: (id: string, tracks: Track[]) => void;
  removeFromPlaylist: (id: string, index: number) => void;
  deletePlaylist: (id: string) => void;

  // For sync plugins.
  setRemote: (remote: CollectionRemote | null) => void;
  /** Replace synced items with the remote's copy, keeping unsynced local ones. */
  applyRemote: (remote: Saved) => void;
  /** Forget everything that came from the remote (e.g. after signing out). */
  dropSynced: () => void;
}

export const useCollection = create<CollectionState>((set, get) => {
  const update = (patch: Partial<Saved>) => {
    set(patch);
    save(get());
  };

  const pushPlaylist = (playlist: Playlist) => {
    const remote = get().remote;
    if (remote && playlist.synced) {
      void remote.updatePlaylist(playlist.id, { name: playlist.name, tracks: playlist.tracks }).catch(ignore);
    }
  };

  const changePlaylist = (id: string, change: (p: Playlist) => Playlist) => {
    let changed: Playlist | null = null;
    const playlists = get().playlists.map((p) => {
      if (p.id !== id) return p;
      changed = { ...change(p), updatedAt: Date.now() };
      return changed;
    });
    update({ playlists });
    if (changed) pushPlaylist(changed);
  };

  return {
    ...load(),
    remote: null,

    toggleLike(track) {
      const { likes, remote } = get();
      if (likes.some((l) => l.track.id === track.id)) {
        update({ likes: likes.filter((l) => l.track.id !== track.id) });
        if (remote) void remote.unlike(track.id).catch(ignore);
        return;
      }
      const like: Like = { track: snapshot(track), likedAt: Date.now(), synced: !!remote };
      update({ likes: [like, ...likes] });
      if (remote) {
        // If the upload fails, keep it as local so the next sync retries it.
        void remote.like(like.track, like.likedAt).catch(() =>
          update({ likes: get().likes.map((l) => (l.track.id === track.id ? { ...l, synced: false } : l)) }),
        );
      }
    },

    async createPlaylist(name, tracks = []) {
      const clean = tracks.slice(0, MAX_PLAYLIST_TRACKS).map(snapshot);
      const remote = get().remote;
      let playlist: Playlist = { id: localId(), name, tracks: clean, updatedAt: Date.now() };
      if (remote) {
        try {
          playlist = { ...(await remote.createPlaylist(name, clean)), synced: true };
        } catch {
          // Keep it locally; the next sync uploads it.
        }
      }
      update({ playlists: [playlist, ...get().playlists] });
      return playlist.id;
    },

    renamePlaylist(id, name) {
      changePlaylist(id, (p) => ({ ...p, name }));
    },

    addToPlaylist(id, tracks) {
      changePlaylist(id, (p) => ({ ...p, tracks: [...p.tracks, ...tracks.map(snapshot)].slice(0, MAX_PLAYLIST_TRACKS) }));
    },

    removeFromPlaylist(id, index) {
      changePlaylist(id, (p) => ({ ...p, tracks: p.tracks.filter((_, i) => i !== index) }));
    },

    deletePlaylist(id) {
      const playlist = get().playlists.find((p) => p.id === id);
      update({ playlists: get().playlists.filter((p) => p.id !== id) });
      const remote = get().remote;
      if (remote && playlist?.synced) void remote.deletePlaylist(id).catch(ignore);
    },

    setRemote(remote) {
      set({ remote });
    },

    applyRemote(remote) {
      const { likes, playlists } = get();
      const remoteLikeIds = new Set(remote.likes.map((l) => l.track.id));
      update({
        likes: [
          ...remote.likes.map((l) => ({ ...l, synced: true })),
          ...likes.filter((l) => !l.synced && !remoteLikeIds.has(l.track.id)),
        ].sort((a, b) => b.likedAt - a.likedAt),
        playlists: [
          ...remote.playlists.map((p) => ({ ...p, synced: true })),
          ...playlists.filter((p) => !p.synced),
        ],
      });
    },

    dropSynced() {
      update({
        likes: get().likes.filter((l) => !l.synced),
        playlists: get().playlists.filter((p) => !p.synced),
      });
    },
  };
});

/** Whether a track is in Liked Songs (re-renders only when that changes). */
export function useIsLiked(trackId: string | undefined): boolean {
  return useCollection((s) => !!trackId && s.likes.some((l) => l.track.id === trackId));
}
