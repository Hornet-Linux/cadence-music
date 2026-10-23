import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDock, dockElement, openDock, MIN_PLAYER_PX } from "./dock";
import { createEmbeddedPlayback, type Driver, type DriverControls, type DriverHooks } from "./embedded";
import type { ExternalPlaybackEvent } from "@/plugins/types";

afterEach(() => {
  closeDock();
  document.body.innerHTML = "";
});

const credit = { text: "Powered by Test", href: "https://example.com/" };

describe("visible player panel", () => {
  it("never makes the player smaller than 200x200 and puts nothing over it", () => {
    const dock = openDock({ service: "Test", credit, height: 120, onClose: () => undefined });
    expect(dock.body.style.height).toBe(`${MIN_PLAYER_PX}px`);
    expect(dock.body.style.minWidth).toBe(`${MIN_PLAYER_PX}px`);
    const el = dockElement()!;
    // Title, close button, note and credit are siblings of the player area, not inside or overlaid on it.
    expect([...el.children].map((c) => c.tagName)).toEqual(["HEADER", "DIV", "P", "FOOTER"]);
    expect(dock.body.children).toHaveLength(0);
    expect(el.querySelector(".stream-dock-credit a")?.getAttribute("href")).toBe(credit.href);
    expect(el.getAttribute("role")).toBe("region");
  });

  it("keeps a larger requested height", () => {
    const dock = openDock({ service: "Test", credit, height: 300, onClose: () => undefined });
    expect(dock.body.style.height).toBe("300px");
  });

  it("has only one panel at a time", () => {
    openDock({ service: "A", credit, height: 200, onClose: () => undefined });
    const b = openDock({ service: "B", credit, height: 200, onClose: () => undefined });
    expect(document.querySelectorAll(".stream-dock")).toHaveLength(1);
    expect(dockElement()!.getAttribute("aria-label")).toBe("B player");
    expect(b.isOpen).toBe(true);
  });

  it("the Close button removes the panel and tells its owner; closing from code does not", () => {
    const onClose = vi.fn();
    const dock = openDock({ service: "Test", credit, height: 200, onClose });
    (document.querySelector(".stream-dock-close") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dock.isOpen).toBe(false);
    expect(document.querySelector(".stream-dock")).toBeNull();

    const quiet = vi.fn();
    const other = openDock({ service: "Test", credit, height: 200, onClose: quiet });
    other.close();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("shows and clears a note", () => {
    const dock = openDock({ service: "Test", credit, height: 200, onClose: () => undefined });
    const note = document.querySelector(".stream-dock-note") as HTMLElement;
    expect(note.hidden).toBe(true);
    dock.setNote("Press play");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Press play");
    dock.setNote(null);
    expect(note.hidden).toBe(true);
  });
});

interface FakeDriver {
  driver: Driver;
  hooks: () => DriverHooks;
  controls: () => DriverControls;
  setups: number;
  destroyed: number;
  calls: string[];
  resolveSetup: () => void;
  failSetup: (e: Error) => void;
}

function fakeDriver(autoResolve = true): FakeDriver {
  let hooks!: DriverHooks;
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const f = {
    setups: 0,
    destroyed: 0,
    calls: [] as string[],
  } as FakeDriver;
  const controls: DriverControls = {
    play: () => void f.calls.push("play"),
    pause: () => void f.calls.push("pause"),
    seek: (s) => void f.calls.push(`seek ${s}`),
    setVolume: (v) => void f.calls.push(`volume ${v}`),
    destroy: () => void f.destroyed++,
  };
  f.driver = {
    setup(_body, h) {
      f.setups++;
      hooks = h;
      return new Promise<DriverControls>((res, rej) => {
        resolve = () => res(controls);
        reject = rej;
        if (autoResolve) resolve();
      });
    },
  };
  f.hooks = () => hooks;
  f.controls = () => controls;
  f.resolveSetup = () => resolve();
  f.failSetup = (e) => reject(e);
  return f;
}

function make(f: FakeDriver) {
  const pb = createEmbeddedPlayback({ dock: { service: "Test", credit, height: 200 }, driver: f.driver });
  const events: ExternalPlaybackEvent[] = [];
  pb.subscribe((e) => events.push(e));
  return { pb, events };
}

describe("embedded playback state machine", () => {
  it("opens nothing until play, then opens the panel and starts the driver", async () => {
    const f = fakeDriver();
    const { pb } = make(f);
    expect(pb.state).toBe("idle");
    expect(document.querySelector(".stream-dock")).toBeNull();
    await pb.play();
    expect(document.querySelector(".stream-dock")).not.toBeNull();
    expect(f.calls).toEqual(["volume 1", "play"]);
    expect(pb.state).toBe("ready");
    f.hooks().state("playing");
    expect(pb.state).toBe("playing");
  });

  it("applies volume and a seek asked for before the player was ready", async () => {
    const f = fakeDriver(false);
    const { pb } = make(f);
    await pb.setVolume(0.4);
    await pb.seek(42);
    const playing = pb.play();
    expect(f.calls).toEqual([]);
    f.resolveSetup();
    await playing;
    expect(f.calls).toEqual(["volume 0.4", "seek 42", "play"]);
  });

  it("clamps volume and ignores negative seeks", async () => {
    const f = fakeDriver();
    const { pb } = make(f);
    await pb.play();
    await pb.setVolume(5);
    await pb.setVolume(-1);
    await pb.seek(-3);
    expect(f.calls.slice(-3)).toEqual(["volume 1", "volume 0", "seek 0"]);
  });

  it("reports play, pause, progress and duration as host events", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    f.hooks().ready({ durationSec: 200 });
    f.hooks().state("playing");
    f.hooks().progress(12, 200);
    f.hooks().progress(13);
    f.hooks().state("paused");
    expect(events).toEqual([{ duration: 200 }, { playing: true }, { position: 12, duration: 200 }, { position: 13 }, { playing: false }]);
  });

  it("reports the end of a track exactly once", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    f.hooks().state("ended");
    f.hooks().state("ended");
    expect(events.filter((e) => e.ended)).toHaveLength(1);
    expect(events[0]).toEqual({ playing: false, ended: true });
    expect(pb.state).toBe("ended");
  });

  it("pause goes to the driver", async () => {
    const f = fakeDriver();
    const { pb } = make(f);
    await pb.play();
    await pb.pause();
    expect(f.calls.at(-1)).toBe("pause");
  });

  it("closing the panel stops the sound and playing again reopens it where it left off", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    f.hooks().state("playing");
    f.hooks().progress(30, 200);
    (document.querySelector(".stream-dock-close") as HTMLButtonElement).click();
    expect(f.destroyed).toBe(1);
    expect(pb.state).toBe("closed");
    expect(events.at(-1)).toEqual({ playing: false });
    expect(document.querySelector(".stream-dock")).toBeNull();

    // Late events from the dead player are ignored.
    f.hooks().state("playing");
    expect(events.at(-1)).toEqual({ playing: false });

    f.calls.length = 0;
    await pb.play();
    expect(f.setups).toBe(2);
    expect(document.querySelector(".stream-dock")).not.toBeNull();
    expect(f.calls).toEqual(["volume 1", "seek 30", "play"]);
  });

  it("a failure that can never play asks the host to move on and says why", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    f.hooks().failed("Owner disallows embedding", true);
    expect(document.querySelector(".stream-dock-note")!.textContent).toBe("Owner disallows embedding");
    expect(events).toEqual([{ playing: false }, { ended: true }]);
    expect(pb.state).toBe("failed");
  });

  it("a failure that might be temporary only stops and explains", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    f.hooks().failed("Autoplay blocked", false);
    expect(events).toEqual([{ playing: false }]);
  });

  it("a player that cannot start rejects play() and explains in the panel", async () => {
    const f = fakeDriver(false);
    const { pb } = make(f);
    const playing = pb.play();
    f.failSetup(new Error("Couldn't load the player"));
    await expect(playing).rejects.toThrow("Couldn't load");
    expect(document.querySelector(".stream-dock-note")!.textContent).toBe("Couldn't load the player");
    expect(pb.state).toBe("failed");
  });

  it("stop releases the player and the panel, and later calls do nothing", async () => {
    const f = fakeDriver();
    const { pb, events } = make(f);
    await pb.play();
    await pb.stop();
    expect(f.destroyed).toBe(1);
    expect(document.querySelector(".stream-dock")).toBeNull();
    expect(pb.state).toBe("stopped");
    f.hooks().state("playing");
    await pb.play();
    await pb.seek(5);
    expect(events).toEqual([]);
    expect(f.setups).toBe(1);
    await pb.stop();
    expect(f.destroyed).toBe(1);
  });

  it("a player that finishes starting after stop is destroyed straight away", async () => {
    const f = fakeDriver(false);
    const { pb } = make(f);
    const playing = pb.play().catch(() => undefined);
    await pb.stop();
    f.resolveSetup();
    await playing;
    expect(f.destroyed).toBe(1);
    expect(f.calls).toEqual([]);
  });

  it("a new panel (another track) replaces the old one without the old driver reopening it", async () => {
    const a = fakeDriver();
    const b = fakeDriver();
    const first = make(a);
    const second = make(b);
    await first.pb.play();
    await second.pb.play();
    expect(document.querySelectorAll(".stream-dock")).toHaveLength(1);
    await first.pb.stop();
    // Stopping the old track must not close the new track's panel.
    expect(document.querySelectorAll(".stream-dock")).toHaveLength(1);
    expect(b.destroyed).toBe(0);
    await second.pb.stop();
    expect(document.querySelector(".stream-dock")).toBeNull();
  });
});
