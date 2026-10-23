import { createHmac, timingSafeEqual } from "node:crypto";

/** What every delivery carries, whatever the template. */
export interface Envelope {
  id: string;
  event: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export const TEMPLATES = ["generic", "n8n", "homeassistant", "discord"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  generic: "Generic JSON (id, event, createdAt, data)",
  n8n: "n8n Webhook node (envelope plus flat fields)",
  homeassistant: "Home Assistant webhook trigger (flat fields)",
  discord: "Discord-compatible webhook (embed message)",
};

interface PlayData {
  user?: { id?: number; username?: string };
  track?: { id?: string; title?: string; artists?: string[]; album?: string; durationSec?: number; source?: string };
  playedAt?: string;
}

/** Flat key/value form of an event, handy for automations that dislike nesting. */
export function flatten(envelope: Envelope): Record<string, unknown> {
  const base: Record<string, unknown> = { event: envelope.event, id: envelope.id, created_at: envelope.createdAt };
  if (envelope.event === "play.recorded") {
    const d = envelope.data as PlayData;
    return {
      ...base,
      user: d.user?.username ?? null,
      title: d.track?.title ?? null,
      artist: d.track?.artists?.join(", ") ?? null,
      album: d.track?.album ?? null,
      duration_sec: d.track?.durationSec ?? null,
      source: d.track?.source ?? null,
      played_at: d.playedAt ?? null,
    };
  }
  return { ...base, ...envelope.data };
}

/** One readable sentence for chat-style receivers. */
export function describe(envelope: Envelope): { title: string; text: string } {
  if (envelope.event === "play.recorded") {
    const d = envelope.data as PlayData;
    const who = d.user?.username ?? "Someone";
    const artist = d.track?.artists?.join(", ");
    return {
      title: "Now playing",
      text: `${who} played ${d.track?.title ?? "a track"}${artist ? ` by ${artist}` : ""}${d.track?.album ? ` (${d.track.album})` : ""}`,
    };
  }
  if (envelope.event === "library.changed") {
    const d = envelope.data as { tracks?: number; delta?: number };
    return { title: "Library updated", text: `The library now has ${d.tracks ?? "?"} tracks${d.delta ? ` (${d.delta > 0 ? "+" : ""}${d.delta})` : ""}.` };
  }
  if (envelope.event === "webhook.test") return { title: "Test delivery", text: "This is a test delivery from your Cadence server." };
  return { title: envelope.event, text: JSON.stringify(envelope.data).slice(0, 500) };
}

/** The request body for a destination, as a JSON string. */
export function renderBody(template: TemplateId, envelope: Envelope): string {
  switch (template) {
    case "n8n":
      return JSON.stringify({ ...flatten(envelope), data: envelope.data });
    case "homeassistant":
      return JSON.stringify(flatten(envelope));
    case "discord": {
      const { title, text } = describe(envelope);
      return JSON.stringify({
        username: "Cadence",
        content: text.slice(0, 1900),
        embeds: [{ title, description: text.slice(0, 4000), color: 0x6b7a8f, timestamp: envelope.createdAt, footer: { text: envelope.event } }],
      });
    }
    default:
      return JSON.stringify(envelope);
  }
}

/** HMAC-SHA256 over `<timestamp>.<body>`, hex. The timestamp stops a captured request being replayed later. */
export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `sha256=${sign(secret, timestamp, body)}`;
}

/** What a receiver does: check the header against the raw body, and that the timestamp is recent. */
export function verifySignature(
  secret: string,
  header: string | undefined,
  timestampHeader: string | undefined,
  body: string,
  options: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  if (!header || !timestampHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) return false;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > (options.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(signatureHeader(secret, timestamp, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
