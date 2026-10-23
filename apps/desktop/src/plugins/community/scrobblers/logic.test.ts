import { describe, expect, it } from "vitest";
import {
  cleanError,
  queueLine,
  relativeTime,
  summarize,
  untilTime,
  validListenBrainzToken,
  validServiceAddress,
  type ServiceStatus,
} from "./logic";

const base: ServiceStatus = {
  id: "listenbrainz",
  label: "ListenBrainz",
  available: true,
  connected: true,
  enabled: true,
  needsReauth: false,
  awaitingApproval: false,
  sent: 0,
  queue: { pending: 0, sentToday: 0, dropped: 0, nextAttemptAt: null },
};

describe("summarize", () => {
  it("describes each state in plain words", () => {
    expect(summarize({ ...base, connected: false })).toEqual({ label: "Not connected", tone: "off" });
    expect(summarize({ ...base, connected: false, available: false })).toEqual({ label: "Not set up on this server", tone: "off" });
    expect(summarize({ ...base, connected: false, awaitingApproval: true })).toEqual({ label: "Waiting for your approval", tone: "warn" });
    expect(summarize({ ...base, username: "rj" })).toEqual({ label: "Connected as rj", tone: "ok" });
    expect(summarize({ ...base, enabled: false })).toEqual({ label: "Paused", tone: "off" });
    expect(summarize({ ...base, needsReauth: true }).tone).toBe("error");
    const retrying = summarize({
      ...base,
      lastError: { message: "down", at: 1 },
      queue: { pending: 3, sentToday: 0, dropped: 0, nextAttemptAt: 5 },
    });
    expect(retrying).toEqual({ label: "Retrying, 3 waiting", tone: "warn" });
  });
});

describe("time wording", () => {
  const now = 1_000_000_000;
  it("says how long ago", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 72 * 3600_000, now)).toBe("3 days ago");
  });
  it("says when a retry is due", () => {
    expect(untilTime(now + 2000, now)).toBe("any moment");
    expect(untilTime(now + 30_000, now)).toBe("in 30 s");
    expect(untilTime(now + 5 * 60_000, now)).toBe("in 5 min");
    expect(untilTime(now + 4 * 3600_000, now)).toBe("in 4 h");
  });
  it("summarises the queue", () => {
    expect(queueLine({ pending: 0, sentToday: 0, dropped: 0, nextAttemptAt: null }, now)).toBe("Nothing waiting");
    expect(queueLine({ pending: 2, sentToday: 5, dropped: 1, nextAttemptAt: now + 120_000 }, now)).toBe(
      "2 waiting, next try in 2 min · 5 sent today · 1 given up on",
    );
  });
});

describe("input checks", () => {
  it("accepts a ListenBrainz token shape", () => {
    expect(validListenBrainzToken("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    expect(validListenBrainzToken("  abcdefgh  ")).toBe(true);
    expect(validListenBrainzToken("short")).toBe(false);
    expect(validListenBrainzToken("has space inside here")).toBe(false);
  });
  it("accepts server addresses with or without a scheme and refuses secrets in the URL", () => {
    expect(validServiceAddress("maloja.example.com")).toBe(true);
    expect(validServiceAddress("http://192.168.1.4:42010")).toBe(true);
    expect(validServiceAddress("https://user:pw@x.example")).toBe(false);
    expect(validServiceAddress("https://x.example/?key=1")).toBe(false);
    expect(validServiceAddress("ftp://x.example")).toBe(false);
    expect(validServiceAddress("")).toBe(false);
    expect(validServiceAddress("two words")).toBe(false);
  });
});

describe("cleanError", () => {
  it("keeps only the server's message", () => {
    expect(cleanError(new Error("Request failed (409): Last.fm isn't set up on this server."))).toBe("Last.fm isn't set up on this server.");
    expect(cleanError(new Error("Could not reach"))).toBe("Could not reach");
    expect(cleanError("plain")).toBe("plain");
  });
});
