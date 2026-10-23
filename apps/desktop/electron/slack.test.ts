// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { clearSlackStatus, parseSlackStatus, setSlackStatus, testSlackToken } from "./slack";

const TOKEN = "xoxp-1234567890-abcdefghij";

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

describe("parseSlackStatus", () => {
  const now = 1_800_000_000_000;
  it("accepts a normal status and trims whitespace", () => {
    expect(parseSlackStatus({ text: "  Song   - Artist ", emoji: ":headphones:", expiration: now / 1000 + 300 }, now)).toEqual({
      text: "Song - Artist",
      emoji: ":headphones:",
      expiration: now / 1000 + 300,
    });
  });
  it("rejects long text, bad emoji and far or past expirations", () => {
    expect(parseSlackStatus({ text: "x".repeat(101), emoji: ":a:" }, now)).toBeNull();
    expect(parseSlackStatus({ text: "ok", emoji: "headphones" }, now)).toBeNull();
    expect(parseSlackStatus({ text: "ok", emoji: ":a:", expiration: now / 1000 - 10 }, now)).toBeNull();
    expect(parseSlackStatus({ text: "ok", emoji: ":a:", expiration: now / 1000 + 10 * 86_400 }, now)).toBeNull();
    expect(parseSlackStatus({ text: "", emoji: ":a:" }, now)).toBeNull();
    expect(parseSlackStatus(null, now)).toBeNull();
  });
});

describe("Slack calls", () => {
  it("posts users.profile.set with the status and a bearer token", async () => {
    const f = fakeFetch({ ok: true });
    const res = await setSlackStatus(TOKEN, { text: "Song", emoji: ":musical_note:", expiration: 123 }, f);
    expect(res).toEqual({ ok: true, user: undefined, team: undefined });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string; method: string }];
    expect(url).toBe("https://slack.com/api/users.profile.set");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ profile: { status_text: "Song", status_emoji: ":musical_note:", status_expiration: 123 } });
  });

  it("clears by sending an empty status", async () => {
    const f = fakeFetch({ ok: true });
    await clearSlackStatus(TOKEN, f);
    const init = (f.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toEqual({ profile: { status_text: "", status_emoji: "", status_expiration: 0 } });
  });

  it("reports Slack's error codes, rate limits and network failures", async () => {
    expect(await testSlackToken(TOKEN, fakeFetch({ ok: false, error: "invalid_auth" }))).toEqual({ ok: false, error: "invalid_auth" });
    expect(await testSlackToken(TOKEN, fakeFetch({}, 429))).toMatchObject({ ok: false, error: expect.stringContaining("slow down") });
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await testSlackToken(TOKEN, failing)).toEqual({ ok: false, error: "Could not reach Slack" });
  });

  it("never sends something that is not a Slack token", async () => {
    const f = fakeFetch({ ok: true });
    const res = await testSlackToken("hunter2", f);
    expect(res.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns the account name from auth.test", async () => {
    expect(await testSlackToken(TOKEN, fakeFetch({ ok: true, user: "sam", team: "Acme" }))).toEqual({ ok: true, user: "sam", team: "Acme" });
  });
});