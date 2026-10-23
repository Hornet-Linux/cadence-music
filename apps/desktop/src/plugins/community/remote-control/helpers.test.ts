import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { labels } from "./RemotePage";
import { estimatedPosition, selectOthers } from "./remoteStore";
import { queueWindow } from "./target";
import { snapshot } from "./reporter";
import type { PluginContext } from "../../types";
import type { RemoteDevice } from "./types";

const dev = (id: string, name: string, extra: Partial<RemoteDevice> = {}): RemoteDevice => ({ id, name, kind: "web", online: true, lastSeen: 0, state: null, ...extra });

describe("remote control helpers", () => {
  it("never lists this device among the others", () => {
    expect(selectOthers([dev("a", "A"), dev("b", "B")], "a").map((d) => d.id)).toEqual(["b"]);
  });

  it("tells same-named devices apart with a short id", () => {
    const l = labels([dev("dev-1111", "Cadence in a browser"), dev("dev-2222", "Cadence in a browser"), dev("dev-3333", "Phone")]);
    expect(l.get("dev-1111")).toBe("Cadence in a browser (1111)");
    expect(l.get("dev-2222")).toBe("Cadence in a browser (2222)");
    expect(l.get("dev-3333")).toBe("Phone");
  });

  it("estimates the position between reports only while playing, and not past the end", () => {
    const state = { track: null, isPlaying: true, position: 10, duration: 100, volume: 1, queue: [], index: 0, updatedAt: 0 };
    expect(estimatedPosition(dev("a", "A", { state }), 1000, 4000)).toBe(13);
    expect(estimatedPosition(dev("a", "A", { state: { ...state, isPlaying: false } }), 1000, 4000)).toBe(10);
    expect(estimatedPosition(dev("a", "A", { state: { ...state, position: 99 } }), 0, 50_000)).toBe(99);
    expect(estimatedPosition(dev("a", "A", { state: { ...state, position: 99 } }), 1000, 51_000)).toBe(100);
    expect(estimatedPosition(dev("a", "A"), 1000, 4000)).toBe(0);
  });

  it("sends at most 200 tracks, windowed around the current one", () => {
    expect(queueWindow(new Array(50), 10)).toEqual({ start: 0, index: 10 });
    expect(queueWindow(new Array(1000), 500)).toEqual({ start: 480, index: 20 });
    expect(queueWindow(new Array(1000), 5)).toEqual({ start: 0, index: 5 });
    expect(queueWindow(new Array(1000), 999)).toEqual({ start: 800, index: 199 });
  });

  it("the reported state cuts a long queue the same way", () => {
    const queue: Track[] = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, artists: [] }));
    const ctx = { player: { getState: () => ({ current: queue[300], isPlaying: true, position: 5, duration: 60, volume: 0.5, queue, index: 300 }) } } as unknown as PluginContext;
    const s = snapshot(ctx, 99);
    expect(s.queue).toHaveLength(200);
    expect(s.queue[s.index]!.id).toBe("t300");
    expect(s.updatedAt).toBe(99);
  });
});
