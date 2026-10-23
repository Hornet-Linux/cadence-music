import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, useServer } from "../../builtins/server/serverStore";
import { emptyContributions, usePluginHost } from "../../host";
import audioAnalysis from "../audio-analysis";
import libraryHealth from "../library-health";
import loudness from "../loudness";
import smartPlaylists from "../smart-playlists";
import tagSuggestions from "../tag-suggestions";
import { TagSuggestionsPage } from "../tag-suggestions/TagSuggestionsPage";
import transcode from "../transcode";
import { explainError, formatBytes, isMissingFeature, pluralize } from "./api";
import { serverTrackToTrack } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("server library plugins", () => {
  beforeEach(() => usePluginHost.setState({ plugins: [], contributions: emptyContributions() }));

  it("each plugin registers and contributes only what its manifest allows", async () => {
    const all = [libraryHealth, tagSuggestions, loudness, audioAnalysis, transcode, smartPlaylists];
    for (const plugin of all) usePluginHost.getState().register(plugin);
    for (const plugin of all) await usePluginHost.getState().setEnabled(plugin.manifest.id, true);
    const { plugins, contributions } = usePluginHost.getState();
    for (const p of plugins) expect(p.enabled, p.plugin.manifest.id).toBe(true);
    expect(contributions.sidebar.map((s) => s.id).sort()).toEqual(["library-health", "smart-playlists", "tag-suggestions"]);
    expect(contributions.settings.map((s) => s.id).sort()).toEqual(["audio-analysis", "loudness", "streaming-quality"]);
    // Opt-in: none of them is built in.
    for (const plugin of all) expect(plugin.manifest.builtin).toBeFalsy();
    expect(new Set(all.map((p) => p.manifest.id)).size).toBe(all.length);
    for (const plugin of all) expect(plugin.manifest.id).toMatch(/^cadence\./);
  });
});

describe("helpers", () => {
  it("explains errors in plain words", () => {
    expect(explainError(new ApiError("x", 404))).toMatch(/not switched on/);
    expect(explainError(new ApiError("x", 403))).toMatch(/admin/);
    expect(explainError(new ApiError("x", 409, "ffmpeg_missing"))).toMatch(/ffmpeg/);
    expect(explainError(new ApiError("x", 400, "invalid_value"))).toBe("invalid value");
    expect(explainError(new Error("boom"))).toBe("boom");
    expect(isMissingFeature(new ApiError("x", 404))).toBe(true);
    expect(isMissingFeature(new ApiError("x", 500))).toBe(false);
  });

  it("formats sizes and counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("-");
    expect(pluralize(1, "song")).toBe("1 song");
    expect(pluralize(2, "fix", "fixes")).toBe("2 fixes");
  });

  it("maps server tracks to player tracks", () => {
    expect(serverTrackToTrack({ id: "abc", title: "T", artist: null, album: "A", durationSec: 12, albumArtist: "AA" })).toEqual({
      id: "server:abc",
      title: "T",
      artists: [{ id: "AA", name: "AA" }],
      album: "A",
      durationSec: 12,
      source: "server",
    });
    expect(serverTrackToTrack({ id: "x", title: "T", artist: null, album: null, durationSec: null }).artists[0]!.name).toBe(
      "Unknown artist",
    );
  });
});

describe("tag suggestions page", () => {
  let root: Root;
  let container: HTMLDivElement;
  const calls: { url: string; method: string; body: string | null }[] = [];

  beforeEach(() => {
    calls.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const suggestion = {
      id: 7,
      trackId: "t1",
      relPath: "Band/Album/loud.mp3",
      trackTitle: "LOUD SONG",
      trackArtist: "Band",
      field: "title",
      oldValue: "LOUD SONG ft. FRIEND",
      newValue: "Loud Song feat. Friend",
      rule: "feat,casing",
      reason: "Write featured artists as feat.",
      status: "pending",
      createdAt: 1,
      decidedAt: null,
    };
    useServer.setState({
      url: "https://cadence.example",
      token: "tok",
      user: { id: 1, username: "root", isAdmin: true } as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: (init?.body as string | undefined) ?? null });
        if (url.includes("/accept")) return json(200, { accepted: 1 });
        return json(200, {
          items: [suggestion],
          total: 1,
          byStatus: { pending: 1, accepted: 0, rejected: 0 },
          pendingByRule: { feat: 1, casing: 1 },
          overlays: 0,
        });
      }),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the change and accepts an edited value", async () => {
    await act(async () => root.render(<TagSuggestionsPage />));
    await act(async () => undefined);
    expect(container.textContent).toContain("LOUD SONG ft. FRIEND");
    expect(container.textContent).toContain("Loud Song feat. Friend");
    expect(container.textContent).toContain("feat. wording");
    expect(container.querySelector(".sl-path")?.textContent).toBe("Band/Album/loud.mp3");

    const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => button("Edit").click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New Title"]')!;
    expect(input.value).toBe("Loud Song feat. Friend");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Loud Song (feat. Friend)");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Accept").click());
    const accept = calls.find((c) => c.url.endsWith("/api/tag-suggestions/7/accept"))!;
    expect(accept.method).toBe("POST");
    expect(JSON.parse(accept.body!)).toEqual({ value: "Loud Song (feat. Friend)" });
  });

  it("asks a non-admin to leave it to the admin", async () => {
    useServer.setState({ user: { id: 2, username: "guest", isAdmin: false } as never });
    await act(async () => root.render(<TagSuggestionsPage />));
    expect(container.textContent).toContain("for the server admin");
    expect(calls).toHaveLength(0);
  });
});
