import { create } from "zustand";
import type { Track } from "@/shared/types";
import { spotifyFetch } from "./api";
import { resetSpotifyPlayer } from "./player";
import { useServer } from "../server/serverStore";

const CLIENT_ID_KEY = "spotify:clientId";
/** Liked songs to import (50 per request). */
const MAX_TRACKS = 2000;

interface SpotifyImage {
  url: string;
  width: number | null;
}

interface SavedTrackItem {
  track: {
    uri: string;
    name: string;
    duration_ms: number;
    is_local?: boolean;
    artists: { id: string; name: string }[];
    album: { name: string; images: SpotifyImage[] };
  } | null;
}

interface Paging<T> {
  items: T[];
  next: string | null;
  total: number;
}

interface Profile {
  display_name: string | null;
  email?: string;
  product?: string;
}

type Status = "unknown" | "signed-out" | "connecting" | "signed-in";

interface SpotifyState {
  status: Status;
  clientId: string;
  redirectUri: string;
  profile: { name: string; premium: boolean } | null;
  tracks: Track[];
  total: number;
  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  setClientId: (clientId: string) => void;
  /** Share the app ID between this device and the Cadence account, both ways. */
  syncWithAccount: () => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  loadLibrary: () => Promise<void>;
  setError: (error: string | null) => void;
}

function pickArtwork(images: SpotifyImage[]): string | undefined {
  // Images are ordered largest first; prefer one around 300px.
  return (images.find((i) => (i.width ?? 0) <= 320) ?? images[0])?.url;
}

function toTrack(item: SavedTrackItem): Track | null {
  const t = item.track;
  if (!t || t.is_local || !t.uri.startsWith("spotify:track:")) return null;
  return {
    id: t.uri,
    title: t.name,
    artists: t.artists.map((a) => ({ id: a.id, name: a.name })),
    album: t.album.name,
    artwork: pickArtwork(t.album.images),
    durationSec: t.duration_ms / 1000,
    source: "spotify",
  };
}

function cleanError(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

function savedClientId(): string {
  try {
    return localStorage.getItem(CLIENT_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

export const useSpotify = create<SpotifyState>((set, get) => {
  let initialized = false;

  async function afterSignIn() {
    try {
      const me = await spotifyFetch<Profile>("me");
      set({
        status: "signed-in",
        profile: { name: me.display_name ?? me.email ?? "Spotify user", premium: me.product === "premium" },
        error: null,
      });
    } catch (err) {
      set({ status: "signed-in", error: cleanError(err) });
    }
    await get().loadLibrary();
  }

  // Save the app ID to the Cadence account so the person's other devices
  // (desktop, web) find it filled in. Spotify tokens stay on each device.
  async function saveToAccount(clientId: string) {
    const server = useServer.getState();
    if (!server.token || server.integrations?.spotify?.clientId === clientId) return;
    if (server.integrations?.spotify?.source === "server") return;
    try {
      await server.api<void>("api/me/integrations/spotify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      useServer.setState((st) => ({
        integrations: st.integrations
          ? { ...st.integrations, spotify: { clientId, source: "account" } }
          : st.integrations,
      }));
    } catch {
      // Older servers don't store it; this device still remembers it.
    }
  }

  return {
    status: "unknown",
    clientId: "",
    redirectUri: "http://127.0.0.1:43821/callback",
    profile: null,
    tracks: [],
    total: 0,
    loading: false,
    error: null,

    async init() {
      if (initialized) return;
      initialized = true;
      const status = await window.host?.spotify.status().catch(() => null);
      set({
        clientId: status?.clientId ?? savedClientId(),
        redirectUri: status?.redirectUri ?? get().redirectUri,
        status: status?.connected ? "signed-in" : "signed-out",
      });
      if (status?.connected) await afterSignIn();
    },

    setClientId(clientId) {
      set({ clientId });
    },

    syncWithAccount() {
      const integrations = useServer.getState().integrations;
      const saved = integrations?.spotify?.clientId;
      const local = get().clientId.trim();
      if (saved && !local) set({ clientId: saved });
      // Connected here before accounts kept the ID (or on another server): upload it.
      else if (integrations && !saved && local && get().status === "signed-in") void saveToAccount(local);
    },

    async login() {
      const clientId = get().clientId.trim();
      if (!window.host?.spotify) return;
      set({ status: "connecting", error: null });
      try {
        await window.host.spotify.login(clientId);
        try {
          localStorage.setItem(CLIENT_ID_KEY, clientId);
        } catch {
          // Optional convenience only.
        }
        void saveToAccount(clientId);
        await afterSignIn();
      } catch (err) {
        set({ status: "signed-out", error: cleanError(err) });
      }
    },

    async logout() {
      resetSpotifyPlayer();
      await window.host?.spotify.logout().catch(() => undefined);
      set({ status: "signed-out", profile: null, tracks: [], total: 0, error: null });
    },

    async loadLibrary() {
      if (get().status !== "signed-in") return;
      set({ loading: true });
      try {
        const tracks: Track[] = [];
        let next: string | null = "me/tracks?limit=50";
        let total = 0;
        while (next && tracks.length < MAX_TRACKS) {
          const page: Paging<SavedTrackItem> = await spotifyFetch<Paging<SavedTrackItem>>(next);
          total = page.total;
          for (const item of page.items) {
            const track = toTrack(item);
            if (track) tracks.push(track);
          }
          next = page.next;
          // Show progress on large libraries.
          set({ tracks: [...tracks], total });
        }
        set({ tracks, total, error: null });
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
