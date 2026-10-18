import { create } from "zustand";

export type AccentId = "artwork" | "violet" | "rose" | "ember" | "lime" | "ocean";

export interface Accent {
  id: AccentId;
  label: string;
  /** Gradient start/end; "artwork" is computed from the playing track. */
  from: string;
  to: string;
}

export const ACCENTS: Accent[] = [
  { id: "artwork", label: "From artwork", from: "#9b7bff", to: "#55e0d8" },
  { id: "violet", label: "Violet", from: "#8b6bff", to: "#55e0d8" },
  { id: "rose", label: "Rose", from: "#ff4f8b", to: "#ffb36b" },
  { id: "ember", label: "Ember", from: "#ff6a3d", to: "#ffd25e" },
  { id: "lime", label: "Lime", from: "#3ddc97", to: "#c6f35b" },
  { id: "ocean", label: "Ocean", from: "#3b82f6", to: "#22d3ee" },
];

export interface Preferences {
  /** What double-clicking a song does. */
  doubleClick: "play" | "queue";
  /** Restore the last queue on start-up, or start empty. */
  startup: "resume" | "empty";
  /** Pause when the audio output device changes (e.g. headphones unplugged). */
  pauseOnDeviceChange: boolean;
  accent: AccentId;
  /** Tint the background with colours from the current artwork. */
  ambientBackground: boolean;
  reduceMotion: boolean;
}

const KEY = "preferences";

const DEFAULTS: Preferences = {
  doubleClick: "play",
  startup: "resume",
  pauseOnDeviceChange: true,
  accent: "artwork",
  ambientBackground: true,
  reduceMotion: false,
};

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return DEFAULTS;
  }
}

interface PrefsState extends Preferences {
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  set(key, value) {
    set({ [key]: value } as Pick<Preferences, typeof key>);
    const state = get();
    const prefs = Object.fromEntries(
      (Object.keys(DEFAULTS) as (keyof Preferences)[]).map((k) => [k, state[k]]),
    );
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // Preferences last for this session only.
    }
  },
}));
