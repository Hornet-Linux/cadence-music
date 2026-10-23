/**
 * Pure helpers for the scrobbler settings panel: types mirroring the server's
 * /api/scrobblers answers, plus the wording and validation the panel uses.
 */

export type ServiceId = "lastfm" | "librefm" | "listenbrainz" | "maloja";

export interface QueueCounts {
  pending: number;
  sentToday: number;
  dropped: number;
  nextAttemptAt: number | null;
}

export interface ServiceStatus {
  id: ServiceId;
  label: string;
  available: boolean;
  unavailableReason?: string;
  connected: boolean;
  enabled: boolean;
  username?: string;
  needsReauth: boolean;
  awaitingApproval: boolean;
  host?: string;
  lastError?: { message: string; at: number };
  lastSuccessAt?: number;
  sent: number;
  queue: QueueCounts;
}

export interface QueueProblem {
  service: ServiceId;
  artist: string;
  title: string;
  playedAt: number;
  state: "pending" | "sent" | "dropped";
  error: string | null;
}

export interface StatusResponse {
  services: ServiceStatus[];
  customHostsAllowed: boolean;
  retryDays: number;
  problems: QueueProblem[];
  isAdmin: boolean;
}

export interface AdminConfig {
  lastfm: { apiKey: string; hasSecret: boolean } | null;
  librefm: { apiKey: string; hasSecret: boolean } | null;
  allowCustomHosts: boolean;
  retryDays: number;
}

/** How a service card should look: a short phrase and a tone for its dot. */
export type Tone = "ok" | "warn" | "off" | "error";

export interface Summary {
  label: string;
  tone: Tone;
}

export function summarize(s: ServiceStatus): Summary {
  if (!s.connected) {
    if (s.awaitingApproval)
      return { label: "Waiting for your approval", tone: "warn" };
    if (!s.available)
      return { label: "Not set up on this server", tone: "off" };
    return { label: "Not connected", tone: "off" };
  }
  if (s.needsReauth) return { label: "Sign-in needs renewing", tone: "error" };
  if (!s.enabled) return { label: "Paused", tone: "off" };
  if (s.queue.pending > 0 && s.lastError)
    return { label: `Retrying, ${s.queue.pending} waiting`, tone: "warn" };
  return {
    label: s.username ? `Connected as ${s.username}` : "Connected",
    tone: "ok",
  };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function relativeTime(at: number, now: number): string {
  const sec = Math.round((now - at) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "in 30 s", "in 5 min", "in 2 h": when a retry is due. */
export function untilTime(at: number, now: number): string {
  const sec = Math.round((at - now) / 1000);
  if (sec <= 5) return "any moment";
  if (sec < 90) return `in ${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

/** One line about the queue: "3 waiting, next try in 2 min", "Nothing waiting". */
export function queueLine(q: QueueCounts, now: number): string {
  const parts: string[] = [];
  if (q.pending > 0) {
    parts.push(
      `${q.pending} waiting${q.nextAttemptAt && q.nextAttemptAt > now ? `, next try ${untilTime(q.nextAttemptAt, now)}` : ""}`,
    );
  } else {
    parts.push("Nothing waiting");
  }
  if (q.sentToday > 0) parts.push(`${q.sentToday} sent today`);
  if (q.dropped > 0) parts.push(`${q.dropped} given up on`);
  return parts.join(" · ");
}

/** The server answers errors as "Request failed (409): message". Show only the message. */
export function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (
    text.replace(/^Request failed \(\d+\):\s*/, "") || "Something went wrong."
  );
}

const TOKEN_RE = /^[\w-]{8,100}$/;

export function validListenBrainzToken(token: string): boolean {
  return TOKEN_RE.test(token.trim());
}

/** Accept "host.example.com" or a full http(s) address; reject credentials and queries. */
export function validServiceAddress(raw: string): boolean {
  const text = raw.trim();
  if (!text || /\s/.test(text) || /[?#]/.test(text)) return false;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !!url.hostname
    );
  } catch {
    return false;
  }
}

export const DEFAULT_LB_HOST = "https://api.listenbrainz.org";

export const SERVICE_BLURB: Record<ServiceId, string> = {
  lastfm: "Send what you play to your Last.fm profile.",
  librefm:
    "Send what you play to Libre.fm, the free Last.fm-compatible service.",
  listenbrainz:
    "Send what you play to ListenBrainz, or to your own ListenBrainz server.",
  maloja: "Send what you play to your own Maloja server.",
};

/** Upstream status codes mean little to people: say what is happening and that Cadence keeps trying. */
export function friendlyError(
  message: string,
  label: string,
  queued: boolean,
): string {
  if (
    /\(HTTP 5\d\d\)|\(HTTP 408\)|timed out|could not reach|unreachable/i.test(
      message,
    )
  ) {
    return queued
      ? `${label} isn't answering right now. Your plays are saved and will be sent automatically.`
      : `${label} wasn't answering a moment ago.`;
  }
  return message;
}
