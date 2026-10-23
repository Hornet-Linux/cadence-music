// Types and checks shared by the main process and the Discord plugin in the page.
// Pure on purpose: nothing here may import Node or Electron modules.

export const APPLICATION_ID_RE = /^\d{17,20}$/;

/** What the renderer asks us to show. Everything is optional except `details`. */
export interface PresenceActivity {
  details: string;
  state?: string;
  largeImage?: string;
  largeText?: string;
  /** Epoch milliseconds the track "started" (now minus its position). */
  startMs?: number;
  /** Epoch milliseconds the track will end. */
  endMs?: number;
}

export const clampText = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  // Discord needs between 2 and 128 characters.
  const clipped = t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
  return clipped.length < 2 ? `${clipped}\u00a0` : clipped;
};

/** Only a public https address can be fetched by Discord's servers. */
export function isPublicImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.startsWith("[")) return false; // IPv6 literals: never needed for album art
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return false;
    }
  }
  return host.includes(".");
}

export type DiscordState = "off" | "connecting" | "connected" | "waiting";

export interface DiscordStatus {
  state: DiscordState;
  /** The Discord user once connected. */
  user?: string;
  /** A short reason shown in settings, e.g. "Discord is not running". */
  error?: string;
}

