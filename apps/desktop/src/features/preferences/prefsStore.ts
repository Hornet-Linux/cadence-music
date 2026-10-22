import { create } from "zustand";

export type AccentId = "artwork" | "violet" | "rose" | "ember" | "lime" | "ocean";

export interface Accent {
  id: AccentId;
  label: string;
  /** Gradient start/end; "artwork" is computed from the playing track. */
  from: string;
  to: string;
}

// Muted, light-toned accents (all pass AA as text on the dark surfaces, and
// dark text passes AA on top of them). "to" is only a very gentle shift.
export const ACCENTS: Accent[] = [
  { id: "artwork", label: "From artwork", from: "#9aa4e0", to: "#a6aee4" },
  { id: "violet", label: "Periwinkle", from: "#9aa4e0", to: "#a6aee4" },
  { id: "rose", label: "Rose", from: "#d99aae", to: "#dfa8b9" },
  { id: "ember", label: "Amber", from: "#d9ae78", to: "#dfb98a" },
  { id: "lime", label: "Sage", from: "#9cc4a2", to: "#a9cbae" },
  { id: "ocean", label: "Teal", from: "#86bfc4", to: "#97c8cc" },
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
  accent: "violet",
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
