import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { closeDock } from "../_streaming/dock";
import { createEmbeddedPlayback } from "../_streaming/embedded";
import type { ExternalPlaybackEvent } from "@/plugins/types";
import { soundcloudDriver, widgetSrc, type SCNamespace, type SCWidget } from "./widget";

const EVENTS = { READY: "ready", PLAY: "play", PAUSE: "pause", FINISH: "finish", PLAY_PROGRESS: "play_progress", SEEK: "seek", ERROR: "error" };

class FakeWidget implements SCWidget {
  listeners = new Map<string, (d?: { currentPosition?: number }) => void>();
  calls: string[] = [];
  durationMs = 215_000;
  bind(ev: string, fn: (d?: { currentPosition?: number }) => void) {
    this.listeners.set(ev, fn);
  }
  unbind(ev: string) {
    this.listeners.delete(ev);
  }
  play() {
    this.calls.push("play");
  }
  pause() {
    this.calls.push("pause");
  }
  seekTo(ms: number) {
    this.calls.push(`seek ${ms}`);
  }
  setVolume(v: number) {
    this.calls.push(`volume ${v}`);
  }
  getDuration(cb: (ms: number) => void) {
    cb(this.durationMs);
  }
  load() {
    this.calls.push("load");
  }
  fire(ev: string, data?: { currentPosition?: number }) {
    this.listeners.get(ev)?.(data);
  }
}

function setup() {
  const widget = new FakeWidget();
  let iframe: HTMLIFrameElement | null = null;
  const ns = {
    Widget: Object.assign(
      (el: HTMLIFrameElement) => {
        iframe = el;
        return widget;
      },
      { Events: EVENTS },
    ),
  } as unknown as SCNamespace;
  const pb = createEmbeddedPlayback({
    dock: { service: "SoundCloud", credit: { text: "Powered by SoundCloud", href: "https://soundcloud.com/" }, height: 200 },
    driver: soundcloudDriver("555", { load: async () => ns }),
  });
  const events: ExternalPlaybackEvent[] = [];
  pb.subscribe((e) => events.push(e));
  return { pb, events, widget, iframe: () => iframe! };
}

/** play() resolves once the widget fires READY. */
async function started() {
  const s = setup();
  const playing = s.pb.play();
  await vi.waitFor(() => expect(s.widget.listeners.has(EVENTS.READY)).toBe(true));
  s.widget.fire(EVENTS.READY);
  await playing;
  return s;
}

afterEach(() => {
  closeDock();
  document.body.innerHTML = "";
});

describe("SoundCloud widget driver", () => {
  it("builds the official widget address for the track and keeps the uploader and artwork visible", () => {
    const u = new URL(widgetSrc("555"));
    expect(u.origin + u.pathname).toBe("https://w.soundcloud.com/player/");
    expect(u.searchParams.get("url")).toBe("https://api.soundcloud.com/tracks/555");
    expect(u.searchParams.get("auto_play")).toBe("false");
    expect(u.searchParams.get("show_user")).toBe("true");
    expect(u.searchParams.get("show_artwork")).toBe("true");
  });

  it("puts the widget iframe in the visible panel and starts it only on play", async () => {
    const { widget, iframe, events } = await started();
    expect(iframe().src).toContain("w.soundcloud.com/player/");
    expect(iframe().getAttribute("allow")).toBe("autoplay; encrypted-media");
    expect(document.querySelector(".stream-dock-body iframe")).toBe(iframe());
    expect(widget.calls).toEqual(["volume 100", "play"]);
    expect(events[0]).toEqual({ duration: 215 });
  });

  it("maps widget events to host events", async () => {
    const { widget, events } = await started();
    widget.fire(EVENTS.PLAY);
    widget.fire(EVENTS.PLAY_PROGRESS, { currentPosition: 12_500 });
    widget.fire(EVENTS.SEEK, { currentPosition: 60_000 });
    widget.fire(EVENTS.PAUSE);
    widget.fire(EVENTS.FINISH);
    expect(events.slice(1)).toEqual([
      { playing: true },
      { position: 12.5, duration: 215 },
      { position: 60, duration: 215 },
      { playing: false },
      { playing: false, ended: true },
    ]);
  });

  it("converts seconds and 0..1 volume to the widget's milliseconds and 0..100", async () => {
    const { pb, widget } = await started();
    await pb.seek(61.25);
    await pb.setVolume(0.5);
    expect(widget.calls).toEqual(expect.arrayContaining(["seek 61250", "volume 50"]));
  });

  it("an ERROR event explains itself and rejects a play that was waiting for READY", async () => {
    const s = setup();
    const playing = s.pb.play();
    await vi.waitFor(() => expect(s.widget.listeners.has(EVENTS.ERROR)).toBe(true));
    s.widget.fire(EVENTS.ERROR);
    await expect(playing).rejects.toThrow(/Open in SoundCloud/);
    expect(document.querySelector(".stream-dock-note")!.textContent).toMatch(/couldn't play this track/);
  });

  it("stop unbinds the widget and removes the iframe and panel", async () => {
    const { pb, widget, events } = await started();
    await pb.stop();
    expect(widget.listeners.size).toBe(0);
    expect(document.querySelector(".stream-dock")).toBeNull();
    widget.fire(EVENTS.PLAY);
    expect(events).toHaveLength(1);
  });
});
