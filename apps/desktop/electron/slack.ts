// Slack status, set with Slack's official users.profile.set method and a token
// the person pasted (a user token with the users.profile:write scope).
// Runs in the main process so the token never reaches web content and Slack's
// API (which does not allow browser requests) can be called.

export const SLACK_TOKEN_KEY = "statussync.slack-token";
const SLACK_API = "https://slack.com/api/";

/** Slack user tokens look like xoxp-..., and rotating ones xoxe.xoxp-.... */
export const SLACK_TOKEN_RE = /^(xoxe\.)?xox[pb]-[A-Za-z0-9-]{10,200}$/;
export const SLACK_EMOJI_RE = /^:[a-z0-9_+'-]{1,50}:$/;
export const SLACK_STATUS_MAX = 100;

export interface SlackStatusInput {
  text: string;
  emoji: string;
  /** Epoch seconds when Slack should clear the status by itself (0 = never). */
  expiration: number;
}

export type SlackResult = { ok: true; user?: string; team?: string } | { ok: false; error: string };

/** Check an untrusted status; null if unusable. */
export function parseSlackStatus(input: unknown, now = Date.now()): SlackStatusInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.text !== "string" || typeof raw.emoji !== "string") return null;
  const text = raw.text.replace(/\s+/g, " ").trim();
  if (!text || text.length > SLACK_STATUS_MAX) return null;
  if (!SLACK_EMOJI_RE.test(raw.emoji)) return null;
  let expiration = 0;
  if (typeof raw.expiration === "number" && Number.isFinite(raw.expiration) && raw.expiration > 0) {
    expiration = Math.floor(raw.expiration);
    // Within a day: a stuck status must not outlive a listening session.
    if (expiration < now / 1000 || expiration > now / 1000 + 86_400) return null;
  }
  return { text, emoji: raw.emoji, expiration };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

async function call(token: string, method: string, body: unknown, fetchFn: FetchLike): Promise<SlackResult> {
  if (!SLACK_TOKEN_RE.test(token)) return { ok: false, error: "That does not look like a Slack user token (xoxp-...)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchFn(`${SLACK_API}${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429) return { ok: false, error: "Slack asked us to slow down; try again in a minute" };
    const data = (await res.json()) as { ok?: boolean; error?: string; user?: string; team?: string };
    if (!data.ok) return { ok: false, error: data.error ?? `Slack returned ${res.status}` };
    return { ok: true, user: data.user, team: data.team };
  } catch {
    return { ok: false, error: "Could not reach Slack" };
  } finally {
    clearTimeout(timer);
  }
}

export function setSlackStatus(token: string, status: SlackStatusInput, fetchFn: FetchLike = fetch as unknown as FetchLike) {
  return call(
    token,
    "users.profile.set",
    {
      profile: {
        status_text: status.text,
        status_emoji: status.emoji,
        status_expiration: status.expiration,
      },
    },
    fetchFn,
  );
}

export function clearSlackStatus(token: string, fetchFn: FetchLike = fetch as unknown as FetchLike) {
  return call(
    token,
    "users.profile.set",
    { profile: { status_text: "", status_emoji: "", status_expiration: 0 } },
    fetchFn,
  );
}

/** auth.test: confirms the token works and names the account. */
export function testSlackToken(token: string, fetchFn: FetchLike = fetch as unknown as FetchLike) {
  return call(token, "auth.test", undefined, fetchFn);
}