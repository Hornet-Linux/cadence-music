import { create } from "zustand";
import type { Track } from "@/shared/types";
import { useServer } from "../server/serverStore";
import { getMusicKit, type MusicKitInstance } from "./musickit";

const MAX_TRACKS = 2000;
export const APPLE_CATALOG_PREFIX = "apple:song:";
export const APPLE_LIBRARY_PREFIX = "apple:library:";

interface LibrarySong {
  id: string;
  attributes?: {
    name: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    artwork?: { url: string };
    playParams?: { id: string; catalogId?: string };
  };
}

interface LibraryPage {
  data: LibrarySong[];
  next?: string;
  meta?: { total?: number };
}

/**
 * - unavailable: no server connection, or the server has no MusicKit key.
 * - signed-out / connecting / signed-in: the Apple Music account itself.
 */
type Status = "unavailable" | "signed-out" | "connecting" | "signed-in";

interface AppleMusicState {
  status: Status;
  tracks: Track[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Re-evaluate availability after the server connection changes. */
  sync: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  loadLibrary: () => Promise<void>;
  /** The configured MusicKit instance (only when available). */
  musicKit: () => Promise<MusicKitInstance>;
  setError: (error: string | null) => void;
}

function toTrack(song: LibrarySong): Track | null {
  const a = song.attributes;
  if (!a) return null;
  const catalogId = a.playParams?.catalogId;
  return {
    id: catalogId ? `${APPLE_CATALOG_PREFIX}${catalogId}` : `${APPLE_LIBRARY_PREFIX}${song.id}`,
    title: a.name,
    artists: [{ id: a.artistName ?? "unknown", name: a.artistName ?? "Unknown artist" }],
    album: a.albumName,
    durationSec: a.durationInMillis ? a.durationInMillis / 1000 : undefined,
    artwork: a.artwork?.url.replace("{w}", "300").replace("{h}", "300"),
    source: "apple-music",
  };
}

function cleanError(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

export const useAppleMusic = create<AppleMusicState>((set, get) => {
  const developerToken = async () => (await useServer.getState().appleMusicToken()).token;

  return {
    status: "unavailable",
    tracks: [],
    total: 0,
    loading: false,
    error: null,

    musicKit: () => getMusicKit(developerToken),

    async sync() {
      const available = useServer.getState().integrations?.appleMusic.available ?? false;
      if (!available) {
        set({ status: "unavailable", tracks: [], total: 0 });
        return;
      }
      if (get().status !== "unavailable") return;
      try {
        const music = await get().musicKit();
        set({ status: music.isAuthorized ? "signed-in" : "signed-out", error: null });
        if (music.isAuthorized) await get().loadLibrary();
      } catch (err) {
        set({ status: "signed-out", error: cleanError(err) });
      }
    },

    async connect() {
      set({ status: "connecting", error: null });
      try {
        const music = await get().musicKit();
        await music.authorize();
        set({ status: music.isAuthorized ? "signed-in" : "signed-out" });
        if (music.isAuthorized) await get().loadLibrary();
      } catch (err) {
        set({ status: "signed-out", error: cleanError(err) });
      }
    },

    async disconnect() {
      try {
        await (await get().musicKit()).unauthorize();
      } catch {
        // Signed out locally either way.
      }
      set({ status: "signed-out", tracks: [], total: 0, error: null });
    },

    async loadLibrary() {
      if (get().status !== "signed-in") return;
      set({ loading: true });
      try {
        const music = await get().musicKit();
        const tracks: Track[] = [];
        let total = 0;
        for (let offset = 0; offset < MAX_TRACKS; offset += 100) {
          const { data: page } = await music.api.music<LibraryPage>("/v1/me/library/songs", {
            limit: 100,
            offset,
          });
          total = page.meta?.total ?? total;
          for (const song of page.data) {
            const track = toTrack(song);
            if (track) tracks.push(track);
          }
          set({ tracks: [...tracks], total: Math.max(total, tracks.length) });
          if (!page.next || page.data.length === 0) break;
        }
        set({ tracks, total: Math.max(total, tracks.length), error: null });
      } catch (err) {
        set({ error: cleanError(err) });
      } finally {
        set({ loading: false });
      }
    },

    setError(error) {
      set({ error });
    },
  };
});
