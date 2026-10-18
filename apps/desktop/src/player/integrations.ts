import { usePrefs } from "@/features/preferences/prefsStore";
import type { Track } from "@/shared/types";
import { primaryArtist } from "@/shared/types";
import { usePlayer } from "./playerStore";

// Glue between the player and the rest of the system: OS media keys and the
// Windows media overlay, restoring the last session, pausing on headphone
// changes and keyboard shortcuts. Started once from the app root.

const SESSION_KEY = "player:session";
const MAX_SAVED = 300;

interface SavedSession {
  queue: Track[];
  index: number;
  position: number;
}

function saveSession() {
  const { queue, index, position, current } = usePlayer.getState();
  if (!current) return;
  // Keep the saved queue bounded but centred on the current track.
  const start = Math.max(0, index - 50);
  const slice = queue.slice(start, start + MAX_SAVED);
  const session: SavedSession = { queue: slice, index: index - start, position };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage full or unavailable; nothing to resume next time.
  }
}

function restoreSession() {
  if (usePrefs.getState().startup !== "resume") return;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as SavedSession;
    if (Array.isArray(saved.queue) && saved.queue.length > 0) usePlayer.getState().restore(saved);
  } catch {
    // Corrupt session; start empty.
  }
}

function setupMediaSession() {
  const session = navigator.mediaSession;
  if (!session) return;
  const p = () => usePlayer.getState();
  session.setActionHandler("play", () => !p().isPlaying && p().toggle());
  session.setActionHandler("pause", () => p().isPlaying && p().toggle());
  session.setActionHandler("nexttrack", () => void p().next());
  session.setActionHandler("previoustrack", () => void p().previous());
  session.setActionHandler("seekto", (details) => {
    if (details.seekTime != null) p().seek(details.seekTime);
  });

  let lastId: string | null = null;
  usePlayer.subscribe((state) => {
    if (state.current?.id !== lastId) {
      lastId = state.current?.id ?? null;
      session.metadata = state.current
        ? new MediaMetadata({
            title: state.current.title,
            artist: primaryArtist(state.current),
            album: state.current.album ?? "",
            artwork: state.current.artwork ? [{ src: state.current.artwork, sizes: "300x300" }] : [],
          })
        : null;
    }
    session.playbackState = state.current ? (state.isPlaying ? "playing" : "paused") : "none";
  });
}

function setupDeviceChange() {
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    const player = usePlayer.getState();
    if (usePrefs.getState().pauseOnDeviceChange && player.isPlaying) player.toggle();
  });
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function setupShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target) || e.altKey) return;
    const p = usePlayer.getState();
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === "Space" && !mod) {
      e.preventDefault();
      p.toggle();
    } else if (mod && e.key === "ArrowRight") {
      e.preventDefault();
      void p.next();
    } else if (mod && e.key === "ArrowLeft") {
      e.preventDefault();
      void p.previous();
    } else if (mod && e.key === "ArrowUp") {
      e.preventDefault();
      p.setVolume(p.volume + 0.05);
    } else if (mod && e.key === "ArrowDown") {
      e.preventDefault();
      p.setVolume(p.volume - 0.05);
    }
  });
}

let started = false;

export function startPlayerIntegrations(): void {
  if (started) return;
  started = true;
  restoreSession();
  setupMediaSession();
  setupDeviceChange();
  setupShortcuts();

  // Save the session at most every few seconds, and when the window closes.
  let timer: ReturnType<typeof setTimeout> | null = null;
  usePlayer.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      saveSession();
    }, 3000);
  });
  window.addEventListener("beforeunload", saveSession);
}
