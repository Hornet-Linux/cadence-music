import type { HostPersona, VoicePrefs } from "@/features/dj/hooks";

// DJ hosts: each one changes how the model words the intros and how they are
// spoken. A custom host is written by the listener. The choice is saved and
// applied to the DJ while the plugin is on.

export interface Personality {
  id: string;
  name: string;
  blurb: string;
  /** Tells the model how to word the intros. */
  style: string;
  voice: VoicePrefs;
  /** Read aloud by "Hear it". */
  sample: string;
}

export const DEFAULT_ID = "default";
export const CUSTOM_ID = "custom";

export const MAX_NAME = 40;
export const MAX_STYLE = 300;
export const MAX_VOICE_HINT = 60;

export const PRESETS: Personality[] = [
  {
    id: DEFAULT_ID,
    name: "Upbeat DJ",
    blurb: "The standard Cadence DJ: casual and warm.",
    style: "",
    voice: {},
    sample: "Up next, a track that fits tonight just right.",
  },
  {
    id: "warm",
    name: "Warm radio host",
    blurb: "Friendly and welcoming, like your favourite evening show.",
    style:
      "a warm, friendly radio host: relaxed and welcoming, speaking to one listener as if they were an old friend, with one personal touch about why the song fits",
    voice: { rate: 1, pitch: 1 },
    sample: "Here's one I think you'll like. Settle in, it's a good one.",
  },
  {
    id: "dry",
    name: "Dry & witty",
    blurb: "Understated humour. Never gushes.",
    style:
      "dry and witty: understated humour and one clever, light remark per intro; never gushing, no exclamation marks, no clichés about music being magical",
    voice: { rate: 1, pitch: 0.9 },
    sample: "Next, a song that peaked, then kept going anyway. Admirable.",
  },
  {
    id: "late-night",
    name: "Calm late-night",
    blurb: "Hushed and unhurried, for the small hours.",
    style:
      "a calm, hushed late-night host: slow, soothing, short sentences, low energy, nothing that would startle someone half asleep",
    voice: { rate: 0.88, pitch: 0.9 },
    sample: "It's late. Here's something gentle to keep you company.",
  },
  {
    id: "hype",
    name: "Hype",
    blurb: "Loud, fast and excited.",
    style:
      "a high-energy hype host: punchy, excited, short bursts; exclamation marks are welcome; make the listener want to turn it up",
    voice: { rate: 1.15, pitch: 1.1 },
    sample: "Turn it up! This next one is absolutely massive!",
  },
  {
    id: "minimal",
    name: "Just the facts",
    blurb: "Artist, title and one fact. Nothing else.",
    style:
      "minimal: state the artist and title and one concrete fact (year, album or genre); no opinions, no filler, no adjectives, under 15 words",
    voice: { rate: 1.1, pitch: 1 },
    sample: "Next: Heroes, by David Bowie. From 1977.",
  },
];

export interface CustomPersonality {
  name: string;
  style: string;
  rate: number;
  pitch: number;
  voiceHint: string;
}

export const EMPTY_CUSTOM: CustomPersonality = { name: "My host", style: "", rate: 1, pitch: 1, voiceHint: "" };

export interface PersonalityState {
  selected: string;
  custom: CustomPersonality;
}

export const INITIAL_STATE: PersonalityState = { selected: DEFAULT_ID, custom: EMPTY_CUSTOM };

/** Collapse whitespace (including newlines: the text goes into a prompt line) and bound the length. */
export function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

export function sanitizeCustom(input: unknown): CustomPersonality {
  const v = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof CustomPersonality, unknown>>;
  return {
    name: cleanText(v.name, MAX_NAME) || EMPTY_CUSTOM.name,
    style: cleanText(v.style, MAX_STYLE),
    rate: clamp(v.rate, 0.6, 1.5, 1),
    pitch: clamp(v.pitch, 0.5, 1.5, 1),
    voiceHint: cleanText(v.voiceHint, MAX_VOICE_HINT),
  };
}

/** Read what was saved, tolerating anything (old versions, hand edits, a corrupt value). */
export function parseState(raw: unknown): PersonalityState {
  const v = (raw && typeof raw === "object" ? raw : {}) as { selected?: unknown; custom?: unknown };
  const custom = sanitizeCustom(v.custom);
  const known = typeof v.selected === "string" && (v.selected === CUSTOM_ID || PRESETS.some((p) => p.id === v.selected));
  return { selected: known ? (v.selected as string) : DEFAULT_ID, custom };
}

/** The personality that is in effect. A custom host with no instructions behaves like the default. */
export function resolvePersonality(state: PersonalityState): Personality {
  if (state.selected === CUSTOM_ID) {
    const c = state.custom;
    return {
      id: CUSTOM_ID,
      name: c.name,
      blurb: "Written by you.",
      style: c.style,
      voice: { rate: c.rate, pitch: c.pitch, ...(c.voiceHint ? { voiceHint: c.voiceHint } : {}) },
      sample: `This is ${c.name}, on the air. Here's your next song.`,
    };
  }
  return PRESETS.find((p) => p.id === state.selected) ?? PRESETS[0];
}

/** What the DJ is told. The default (and a custom host with no instructions) changes nothing. */
export function toPersona(p: Personality): HostPersona | null {
  if (!p.style && Object.keys(p.voice).length === 0) return null;
  return { style: p.style, voice: p.voice };
}
