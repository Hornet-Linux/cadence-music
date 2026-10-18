import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { usePlayer } from "./playerStore";
import { usePluginHost } from "@/plugins/host";
import type { ExternalPlayback, ExternalPlaybackEvent, Plugin } from "@/plugins/types";
import type { Track } from "@/shared/types";

type FakeHandle = ExternalPlayback & {
  emit: (e: ExternalPlaybackEvent) => void;
  play: Mock<() => Promise<void>>;
  pause: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<void>>;
  seek: Mock<(seconds: number) => Promise<void>>;
  setVolume: Mock<(volume: number) => Promise<void>>;
};

function fakeHandle(): FakeHandle {
  const listeners = new Set<(e: ExternalPlaybackEvent) => void>();
  return {
    play: vi.fn<() => Promise<void>>(async () => undefined),
    pause: vi.fn<() => Promise<void>>(async () => undefined),
    stop: vi.fn<() => Promise<void>>(async () => undefined),
    seek: vi.fn<(seconds: number) => Promise<void>>(async () => undefined),
    setVolume: vi.fn<(volume: number) => Promise<void>>(async () => undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(e) {
      for (const l of listeners) l(e);
    },
  };
}

const track = (id: string): Track => ({ id, title: id, artists: [{ id: "a", name: "A" }] });

let handles: FakeHandle[] = [];
let releaseSlow: () => void = () => undefined;
let slowWaiting = false;

const externalSource: Plugin = {
  manifest: {
    id: "test.external",
    name: "External",
    version: "1.0.0",
    capabilities: ["source.audio"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerAudioSource({
      id: "external",
      label: "External",
      async resolve(t) {
        if (t.id.startsWith("slow:")) {
          await new Promise<void>((r) => {
            releaseSlow = r;
            slowWaiting = true;
          });
        } else if (!t.id.startsWith("ext:")) {
          return null;
        }
        const h = fakeHandle();
        handles.push(h);
        return h;
      },
    });
  },
};

beforeAll(() => {
  // jsdom does not implement media playback.
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

beforeEach(async () => {
  handles = [];
  usePluginHost.setState({
    plugins: [],
    contributions: {
      sidebar: [],
      homeWidgets: [],
      settings: [],
      setupSteps: [],
      audioSources: [],
      librarySources: [],
    },
  });
  usePluginHost.getState().register(externalSource);
  await usePluginHost.getState().setEnabled("test.external", true);
  usePlayer.setState({ volume: 0.8, muted: false, shuffle: false, repeat: "off" });
});

describe("player with external playback", () => {
  it("plays an external handle and advances when it ends", async () => {
    await usePlayer.getState().playQueue([track("ext:1"), track("ext:2")], 0);

    expect(handles).toHaveLength(1);
    const first = handles[0];
    expect(first.setVolume).toHaveBeenCalledWith(0.8);
    expect(first.play).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().isPlaying).toBe(true);

    first.emit({ position: 12, duration: 200 });
    expect(usePlayer.getState().position).toBe(12);
    expect(usePlayer.getState().duration).toBe(200);

    first.emit({ ended: true });
    await vi.waitFor(() => expect(handles).toHaveLength(2));
    await vi.waitFor(() => expect(handles[1].play).toHaveBeenCalled());
    expect(first.stop).toHaveBeenCalled();
    expect(usePlayer.getState().current?.id).toBe("ext:2");

    // Late events from the released handle are ignored.
    first.emit({ position: 99 });
    expect(usePlayer.getState().position).not.toBe(99);
  });

  it("routes transport controls to the active external player", async () => {
    await usePlayer.getState().playQueue([track("ext:1")], 0);
    const h = handles[0];
    const p = usePlayer.getState();

    p.toggle();
    expect(h.pause).toHaveBeenCalled();
    expect(usePlayer.getState().isPlaying).toBe(false);

    p.seek(30);
    expect(h.seek).toHaveBeenCalledWith(30);

    p.setVolume(0.5);
    expect(h.setVolume).toHaveBeenLastCalledWith(0.5);
    p.toggleMute();
    expect(h.setVolume).toHaveBeenLastCalledWith(0);
  });

  it("lets a newer selection win over a slow resolve", async () => {
    slowWaiting = false;
    const slow = usePlayer.getState().playQueue([track("slow:1")], 0);
    await vi.waitFor(() => expect(slowWaiting).toBe(true));
    await usePlayer.getState().playQueue([track("ext:2")], 0);
    releaseSlow();
    await slow;

    expect(usePlayer.getState().current?.id).toBe("ext:2");
    // ext:2 resolved first; the slow handle arrived afterwards and was dropped.
    const [newer, stale] = handles;
    expect(newer.play).toHaveBeenCalled();
    expect(stale.play).not.toHaveBeenCalled();
    expect(stale.stop).toHaveBeenCalled();
  });

  it("marks tracks no source can play", async () => {
    await usePlayer.getState().playQueue([track("nobody:1")], 0);
    expect(usePlayer.getState().unresolved).toBe(true);
    expect(usePlayer.getState().isPlaying).toBe(false);
  });
});
