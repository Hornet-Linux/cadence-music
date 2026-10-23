import type { NetPolicy } from "./netguard.js";

/**
 * Operator knobs, read from the server's environment (never from users):
 *  - CADENCE_SOURCES_ALLOW_PRIVATE=1 lets the radio, podcast and archive plugins reach private/LAN addresses
 *    (for feeds or a Radio Browser mirror hosted on your own network). Off by default, because those plugins
 *    fetch addresses people can influence.
 *  - CADENCE_RADIO_DIRECTORY_URL, CADENCE_ITUNES_URL and CADENCE_ARCHIVE_URL point a plugin at a mirror.
 */
export function envPolicy(): NetPolicy {
  return process.env.CADENCE_SOURCES_ALLOW_PRIVATE === "1" ? { allowPrivate: true } : {};
}

export function envUrl(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}
