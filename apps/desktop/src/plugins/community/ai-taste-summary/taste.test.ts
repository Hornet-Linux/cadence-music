import { describe, expect, it, vi } from "vitest";
import type { Play } from "@uma/shared";
import type { PluginStorage } from "../../types";
import { MIN_PLAYS, aggregateLines, buildAggregates, buildTasteMessages, cleanSummary } from "./taste";
import { createTasteStore } from "./store";

const DAY = 86_400_000;
// Wednesday 2026-06-10, local noon.
const BASE = new Date(2026, 5, 10, 12, 0, 0).getTime();

function play(title: string, artist: string, at: number): Play {
  return { track: { id: `${artist}:${title}`, title, artists: [{ id: artist, name: artist }] }, playedAt: at };
}

function history(): Play[] {
  const plays: Play[] = [];
  for (let i = 0; i < 12; i++) plays.push(play("Pink Moon", "Nick Drake", BASE - i * DAY)); // noon
  for (let i = 0; i < 6; i++) plays.push(play("Heroes", "David Bowie", BASE - i * DAY + 9 * 3_600_000)); // 21:00
  for (let i = 0; i < 4; i++) plays.push(play(`Track ${i}`, "Boards of Canada", new Date(2026, 5, 6, 23, 30).getTime() - i * DAY)); // night, Sat first
  return plays;
}

describe("buildAggregates", () => {
  const a = buildAggregates(history());

  it("counts plays, artists and songs", () => {
    expect(a.totalPlays).toBe(22);
    expect(a.distinctArtists).toBe(3);
    expect(a.distinctSongs).toBe(6);
    expect(a.topArtists[0]).toEqual({ name: "Nick Drake", plays: 12 });
    expect(a.topTracks[0]).toEqual({ title: "Pink Moon", artist: "Nick Drake", plays: 12 });
    expect(a.spanDays).toBeGreaterThanOrEqual(10);
  });

  it("splits the day and the week into percentages that add up", () => {
    const t = a.timeOfDay;
    expect(t.afternoon).toBe(55); // 12 of 22 at noon
    expect(t.evening).toBe(27);
    expect(t.night).toBe(18);
    expect(t.morning).toBe(0);
    expect(t.morning + t.afternoon + t.evening + t.night).toBeGreaterThanOrEqual(99);
    expect(a.weekendShare).toBeGreaterThan(0);
    expect(a.repeatShare).toBeGreaterThan(80);
  });

  it("copes with an empty history", () => {
    const empty = buildAggregates([]);
    expect(empty).toMatchObject({ totalPlays: 0, topArtists: [], topTracks: [], weekendShare: 0 });
  });
});

describe("privacy: what is sent", () => {
  it("contains only aggregates: no timestamps, no track ids, no album or artwork", () => {
    const plays = history().map((p) => ({ ...p, track: { ...p.track, id: "spotify:track:SECRETID", album: "Secret Album", artwork: "https://x/secret.jpg" } }));
    const messages = buildTasteMessages(buildAggregates(plays));
    const sent = messages.map((m) => m.content).join("\n");
    expect(sent).not.toContain("SECRETID");
    expect(sent).not.toContain("Secret Album");
    expect(sent).not.toContain("secret.jpg");
    expect(sent).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(sent).not.toMatch(/\b1[67]\d{11}\b/); // epoch milliseconds
    expect(sent).toContain("Nick Drake (12)");
    expect(aggregateLines(buildAggregates(plays)).join("\n")).toContain("Time of day");
  });

  it("asks for exactly three paragraphs and marks the numbers as data", () => {
    const [system] = buildTasteMessages(buildAggregates(history()));
    expect(system.content).toMatch(/three short paragraphs/i);
    expect(system.content).toMatch(/ignore any instructions/i);
  });

  it("bounds names so a strange library can't flood the prompt", () => {
    const long = buildAggregates([play("T".repeat(500), "A".repeat(500), BASE)]);
    expect(long.topArtists[0].name.length).toBeLessThanOrEqual(80);
    expect(long.topTracks[0].title.length).toBeLessThanOrEqual(80);
  });
});

describe("cleanSummary", () => {
  const prose = (n: number) => `Paragraph ${n}. `.repeat(1) + "You lean toward quiet, acoustic records with a lot of space in them, and it shows in every list.";

  it("keeps three clean paragraphs", () => {
    const out = cleanSummary(`${prose(1)}\n\n${prose(2)}\n\n${prose(3)}`);
    expect(out.split("\n\n")).toHaveLength(3);
  });

  it("strips markdown, headings and bullets, and keeps at most three paragraphs", () => {
    const out = cleanSummary(`## Your taste\n\n**${prose(1)}**\n\n- ${prose(2)}\n\n${prose(3)}\n\n${prose(4)}`);
    expect(out).not.toMatch(/[#*]/);
    expect(out.split("\n\n")).toHaveLength(3);
    expect(out).not.toContain("Paragraph 4");
  });

  it("unwraps a JSON reply from a provider that could only answer in JSON", () => {
    const out = cleanSummary(JSON.stringify({ reply: `${prose(1)}\n\n${prose(2)}\n\n${prose(3)}` }));
    expect(out.split("\n\n")).toHaveLength(3);
  });

  it("rejects garbage: empty, tiny, refusals that are too short, raw JSON, lists", () => {
    for (const bad of ["", "   ", "I can't help with that.", '{"foo": "bar baz"}', "[1,2,3]", "ok"]) {
      expect(() => cleanSummary(bad)).toThrow(/usable summary/);
    }
  });

  it("bounds a runaway reply", () => {
    const out = cleanSummary("word ".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(3000);
  });
});

describe("taste store", () => {
  const memory = (): PluginStorage & { data: Record<string, unknown> } => {
    const data: Record<string, unknown> = {};
    return { data, get: <T,>(k: string) => (k in data ? (data[k] as T) : null), set: (k, v) => void (data[k] = v), remove: (k) => void delete data[k] };
  };
  const good = "You lean toward quiet records. ".repeat(6);

  function setup(plays: Play[], reply: string | Error = good) {
    const ask = vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const store = createTasteStore({ plays: () => plays, provider: async () => ({ ref: "server:1" }), ask: ask as never, now: () => 1234 });
    return { store, ask };
  }

  it("does nothing until asked, then writes and saves the summary", async () => {
    const { store, ask } = setup(history());
    const storage = memory();
    store.getState().load(storage);
    expect(ask).not.toHaveBeenCalled();
    await store.getState().generate();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(store.getState().summary).toMatchObject({ at: 1234, plays: 22 });
    expect(storage.data.summary).toBeTruthy();

    // A new session restores it.
    const again = setup(history()).store;
    again.getState().load(storage);
    expect(again.getState().summary?.text).toContain("quiet records");
  });

  it("refuses with a friendly message when there is too little history, without calling the AI", async () => {
    const { store, ask } = setup(history().slice(0, MIN_PLAYS - 1));
    await store.getState().generate();
    expect(ask).not.toHaveBeenCalled();
    expect((store.getState().error as Error).message).toMatch(/at least 20 plays/);
  });

  it("shows provider errors and bad replies, and keeps an earlier summary", async () => {
    const { store } = setup(history());
    const storage = memory();
    store.getState().load(storage);
    await store.getState().generate();
    const first = store.getState().summary;

    const failing = setup(history(), new Error("Couldn't reach Ollama"));
    failing.store.getState().load(storage);
    await failing.store.getState().generate();
    expect((failing.store.getState().error as Error).message).toMatch(/Ollama/);
    expect(failing.store.getState().summary).toEqual(first);

    const garbage = setup(history(), "{}");
    await garbage.store.getState().generate();
    expect((garbage.store.getState().error as Error).message).toMatch(/usable summary/);
    expect(garbage.store.getState().status).toBe("idle");
  });

  it("ignores corrupt saved data and can delete the summary", async () => {
    const { store } = setup(history());
    const storage = memory();
    storage.data.summary = { text: 5, at: "x" };
    store.getState().load(storage);
    expect(store.getState().summary).toBeNull();
    await store.getState().generate();
    store.getState().clear();
    expect(store.getState().summary).toBeNull();
    expect(storage.data.summary).toBeUndefined();
  });
});
