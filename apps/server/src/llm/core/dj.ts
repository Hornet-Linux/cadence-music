import type { LlmMessage } from "./types.js";

// The AI DJ's prompt, reply schema and reply cleaning. Pure functions, shared
// by the server (which runs the DJ for every device) and by apps that call a
// provider on the device itself.

/** What the DJ knows about the listener. Kept small so it fits a local model's context. */
export interface TasteProfile {
  topArtists: string[];
  genres: string[];
  /** "Artist – Title" lines. */
  topTracks: string[];
  recentTracks: string[];
}

export interface DjPick {
  artist: string;
  title: string;
  /** Spoken before the track; one or two sentences. */
  intro: string;
}

export interface DjReply {
  picks: DjPick[];
}

export interface DjRequest {
  /** Free text from the listener, e.g. "chill, rainy afternoon". */
  mood?: string;
  /** Set when "Switch it up" is pressed: move away from the last set. */
  switchUp?: boolean;
  /** "Artist – Title" lines already played or queued this session. */
  avoid?: string[];
  count?: number;
  now?: Date;
}

export const DJ_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          intro: { type: "string" },
        },
        required: ["artist", "title", "intro"],
      },
    },
  },
  required: ["picks"],
} as const;

export function timeOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "late night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

const list = (label: string, items: string[]) => (items.length ? `${label}:\n- ${items.join("\n- ")}` : "");

const SYSTEM = `You are an upbeat radio DJ inside a music app, picking songs for one listener.
Rules:
- Only pick real, released songs that are on Spotify. Use the exact artist name and song title.
- Mix familiar favourites with songs they probably haven't heard by similar artists. About a third should be new to them.
- Order the picks so the energy flows naturally; no artist twice in a row.
- Each intro is one or two short spoken sentences, casual and warm. Mention why the song fits. No emoji, no hashtags.
- Never repeat a song from the "Don't play" list.
Reply with JSON only.`;

export function buildDjMessages(profile: TasteProfile, req: DjRequest = {}): LlmMessage[] {
  const count = req.count ?? 8;
  const user = [
    list("Favourite artists", profile.topArtists),
    list("Genres they like", profile.genres),
    list("Songs on repeat lately", profile.topTracks),
    list("Recently played", profile.recentTracks),
    list("Don't play", req.avoid ?? []),
    `It's ${timeOfDay(req.now ?? new Date())}.`,
    req.mood ? `The listener asked for: ${req.mood}` : "",
    req.switchUp ? "They pressed \"Switch it up\": take the set in a clearly different direction from the last songs." : "",
    `Pick ${count} songs.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export const MAX_PICKS = 25;
export const MAX_NAME_CHARS = 200;
export const MAX_INTRO_CHARS = 400;

/** Replace control characters (newlines and tabs included) with spaces, collapse runs, trim, truncate. */
function tidy(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max).trim();
}

/**
 * Drop malformed entries the model may return despite the schema, and bound
 * what is left (count, lengths, no control characters) so a misbehaving model
 * or device can't send an app something huge.
 */
export function cleanReply(reply: unknown): DjPick[] {
  const picks = (reply as Partial<DjReply> | null)?.picks;
  if (!Array.isArray(picks)) return [];
  const out: DjPick[] = [];
  for (const p of picks as (Partial<DjPick> | null)[]) {
    if (out.length >= MAX_PICKS) break;
    if (!p || typeof p.artist !== "string" || typeof p.title !== "string") continue;
    const artist = tidy(p.artist, MAX_NAME_CHARS);
    const title = tidy(p.title, MAX_NAME_CHARS);
    if (!artist || !title) continue;
    out.push({ artist, title, intro: typeof p.intro === "string" ? tidy(p.intro, MAX_INTRO_CHARS) : "" });
  }
  return out;
}
