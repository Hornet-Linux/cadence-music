import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDock } from "../_streaming/dock";
import { createEmbeddedPlayback } from "../_streaming/embedded";
import type { ExternalPlaybackEvent } from "@/plugins/types";
import { describeYouTubeError, youtubeDriver, type YTNamespace } from "./player";

type PlayerOptions = ConstructorParameters<YTNamespace["Player"]>[1];

/** A stand-in for YouTube's IFrame API that records calls and lets a test fire the player's events. */
class FakeYT {
  static last: FakePlayer | null = null;
  readonly namespace: YTNamespace;
  constructor() {
    this.namespace = {
      Player: class {
        constructor(el: HTMLElement, options: PlayerOptions) {
          const p = new FakePlayer(el, options);
          FakeYT.last = p;
          return p as never;
        }
      } as never,
    };
  }
}

class FakePlayer {
  calls: string[] = [];
  time = 0;
  duration = 0;
  destroyed = false;
  iframe: HTMLIFrameElement;
  constructor(
    el: HTMLElement,
    readonly options: PlayerOptions,
  ) {
    // The real API replaces the element with an iframe.
    this.iframe = document.createElement("iframe");
    el.replaceWith(this.iframe);
  }
  playVideo() {
    this.calls.push("play");
  }
  pauseVideo() {
    this.calls.push("pause");
  }
  seekTo(s: number, ahead: boolean) {
    this.calls.push(`seek ${s} ${ahead}`);
  }
  setVolume(v: number) {
    this.calls.push(`volume ${v}`);
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return this.duration;
  }
  destroy() {
    this.destroyed = true;
    this.iframe.remove();
  }
  ready() {
    this.options.events.onReady?.();
  }
  state(n: number) {
    this.options.events.onStateChange?.({ data: n });
  }
  error(n: number) {
    this.options.events.onError?.({ data: n });
  }
  blocked() {
    this.options.events.onAutoplayBlocked?.();
  }
}

const credit = { text: "YouTube Terms of Service", href: "https://www.youtube.com/t/terms" };

function setup() {
  const yt = new FakeYT();
  const pb = createEmbeddedPlayback({
    dock: { service: "YouTube", credit, height: 215 },
    driver: youtubeDriver("dQw4w9WgXcQ", { load: async () => yt.namespace, origin: "https://cadence.example" }),
  });
  const events: ExternalPlaybackEvent[] = [];
  pb.subscribe((e) => events.push(e));
  return { pb, events };
}

/** Start playback and let the fake player report ready. */
async function started() {
  const s = setup();
  const playing = s.pb.play();
  await vi.waitFor(() => expect(FakeYT.last).not.toBeNull());
  FakeYT.last!.duration = 212;
  FakeYT.last!.ready();
  await playing;
  return { ...s, player: FakeYT.last! };
}

beforeEach(() => {
  FakeYT.last = null;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  closeDock();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("YouTube IFrame driver", () => {
  it("creates YouTube's own player inside the visible panel with the documented options", async () => {
    const { player } = await started();
    expect(player.options.videoId).toBe("dQw4w9WgXcQ");
    expect(player.options.playerVars).toMatchObject({ playsinline: 1, enablejsapi: 1, origin: "https://cadence.example" });
    // No autoplay parameter: playback starts only when the host calls play().
    expect(player.options.playerVars).not.toHaveProperty("autoplay");
    expect(document.querySelector(".stream-dock-body iframe")).not.toBeNull();
    expect(document.querySelector(".stream-dock")!.getAttribute("aria-label")).toBe("YouTube player");
    expect(player.calls).toContain("play");
  });

  it("scales the volume to YouTube's 0-100", async () => {
    const { pb, player } = await started();
    await pb.setVolume(0.37);
    expect(player.calls).toContain("volume 37");
    await pb.setVolume(0);
    expect(player.calls).toContain("volume 0");
  });

  it("seeks with allowSeekAhead", async () => {
    const { pb, player } = await started();
    await pb.seek(61.5);
    expect(player.calls).toContain("seek 61.5 true");
  });

  it("maps state changes: playing starts progress reporting, paused and ended stop it", async () => {
    const { events, player } = await started();
    expect(events[0]).toEqual({ duration: 212 });
    player.time = 5;
    player.state(1);
    expect(events).toContainEqual({ playing: true });
    expect(events).toContainEqual({ position: 5, duration: 212 });

    player.time = 6;
    await vi.advanceTimersByTimeAsync(500);
    expect(events.at(-1)).toEqual({ position: 6, duration: 212 });

    player.state(3); // buffering: no event, polling continues
    player.state(2);
    expect(events.at(-1)).toEqual({ playing: false });
    const count = events.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toHaveLength(count);

    player.state(1);
    player.state(0);
    expect(events.at(-1)).toEqual({ playing: false, ended: true });
  });

  it("stop destroys the player and its panel and stops polling", async () => {
    const { pb, player, events } = await started();
    player.state(1);
    await pb.stop();
    expect(player.destroyed).toBe(true);
    expect(document.querySelector(".stream-dock")).toBeNull();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toHaveLength(count);
  });

  it("a video that cannot be embedded is skipped with an explanation", async () => {
    const { events, player } = await started();
    player.error(101);
    expect(document.querySelector(".stream-dock-note")!.textContent).toMatch(/doesn't allow this video/);
    expect(events).toContainEqual({ ended: true });
  });

  it("a missing-referrer error is explained but does not skip the queue", async () => {
    const { events, player } = await started();
    player.error(153);
    expect(document.querySelector(".stream-dock-note")!.textContent).toMatch(/referrer/);
    expect(events.some((e) => e.ended)).toBe(false);
  });

  it("blocked autoplay tells the person to press play in the player", async () => {
    const { events, player } = await started();
    player.state(1);
    player.blocked();
    expect(document.querySelector(".stream-dock-note")!.textContent).toMatch(/Press play in the player/);
    expect(events.at(-1)).toEqual({ playing: false });
  });

  it("an error before the player is ready rejects play()", async () => {
    const s = setup();
    const playing = s.pb.play();
    await vi.waitFor(() => expect(FakeYT.last).not.toBeNull());
    FakeYT.last!.error(100);
    await expect(playing).rejects.toThrow(/removed or is private/);
    expect(s.events).toContainEqual({ ended: true });
  });

  it("gives up if the player never becomes ready", async () => {
    const s = setup();
    const playing = s.pb.play();
    const assertion = expect(playing).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
  });

  it("closing the panel stops playback, and play reopens the video at the same spot", async () => {
    const { pb, player, events } = await started();
    player.time = 40;
    player.state(1);
    (document.querySelector(".stream-dock-close") as HTMLButtonElement).click();
    expect(player.destroyed).toBe(true);
    expect(events.at(-1)).toEqual({ playing: false });

    const again = pb.play();
    await vi.waitFor(() => expect(FakeYT.last).not.toBe(player));
    FakeYT.last!.ready();
    await again;
    expect(FakeYT.last!.calls).toEqual(expect.arrayContaining(["seek 40 true", "play"]));
  });
});

describe("error descriptions", () => {
  it("know which errors are permanent", () => {
    for (const code of [100, 101, 150]) expect(describeYouTubeError(code).skip).toBe(true);
    for (const code of [2, 5, 153, 999]) expect(describeYouTubeError(code).skip).toBe(false);
  });
});
