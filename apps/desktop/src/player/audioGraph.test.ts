import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioEffect } from "@/plugins/types";
import { AudioGraph, canRouteUrl, resetRouteCache } from "./audioGraph";
import { FakeAudioContext, FakeNode, type FakeContextOptions } from "./fakeAudio";

function setup(opts: FakeContextOptions = {}) {
  return new AudioGraph(() => new FakeAudioContext(opts) as unknown as AudioContext);
}

function effect(id: string, extra: Partial<AudioEffect> = {}): AudioEffect & { nodes: FakeNode; dispose: ReturnType<typeof vi.fn> } {
  const nodes = new FakeNode(id);
  const dispose = vi.fn();
  return {
    id,
    label: id,
    nodes,
    dispose,
    create: () => ({ input: nodes as unknown as AudioNode, output: nodes as unknown as AudioNode, dispose }),
    ...extra,
  };
}

const el = () => document.createElement("audio");
const ctxOf = (g: AudioGraph) => g.context as unknown as FakeAudioContext;

beforeEach(() => {
  FakeAudioContext.instances = [];
});

describe("AudioGraph", () => {
  it("does nothing until an effect exists", async () => {
    const graph = setup();
    expect(graph.wanted).toBe(false);
    expect(await graph.attach(el())).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(graph.status).toBe("idle");
  });

  it("chains source -> bus -> effects -> destination in order", async () => {
    const graph = setup();
    const a = effect("a");
    const b = effect("b");
    graph.setEffects([a, b]);
    const element = el();
    expect(await graph.attach(element)).toBe(true);
    const ctx = ctxOf(graph);
    const bus = ctx.gains[0];
    expect(ctx.captured).toEqual([element]);
    expect(bus.edges).toEqual([a.nodes]);
    expect(a.nodes.edges).toEqual([b.nodes]);
    expect(b.nodes.edges).toEqual([ctx.destination]);
    expect(graph.isCaptured(element)).toBe(true);
    expect(graph.status).toBe("running");
  });

  it("captures an element only once", async () => {
    const graph = setup();
    graph.setEffects([effect("a")]);
    const element = el();
    await graph.attach(element);
    await graph.attach(element);
    expect(ctxOf(graph).captured).toHaveLength(1);
  });

  it("rebuilds and disposes when the effects change, but not when they are the same", async () => {
    const graph = setup();
    const a = effect("a");
    graph.setEffects([a]);
    await graph.attach(el());
    const createSpy = vi.spyOn(a, "create");
    graph.setEffects([a]);
    expect(createSpy).not.toHaveBeenCalled();

    const b = effect("b");
    graph.setEffects([b]);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    const ctx = ctxOf(graph);
    expect(ctx.gains[0].edges).toEqual([b.nodes]);
    expect(b.nodes.edges).toEqual([ctx.destination]);
  });

  it("falls back to a direct connection when all effects are removed", async () => {
    const graph = setup();
    graph.setEffects([effect("a")]);
    await graph.attach(el());
    graph.setEffects([]);
    const ctx = ctxOf(graph);
    expect(ctx.gains[0].edges).toEqual([ctx.destination]);
    expect(graph.wanted).toBe(false);
  });

  it("skips an effect that throws and keeps the rest", async () => {
    const graph = setup();
    const bad = effect("bad", {
      create: () => {
        throw new Error("boom");
      },
    });
    const good = effect("good");
    graph.setEffects([bad, good]);
    await graph.attach(el());
    const ctx = ctxOf(graph);
    expect(ctx.gains[0].edges).toEqual([good.nodes]);
    expect(good.nodes.edges).toEqual([ctx.destination]);
  });

  it("reports wanted changes", () => {
    const graph = setup();
    const seen: boolean[] = [];
    graph.onWantedChange((w) => seen.push(w));
    graph.setEffects([effect("a")]);
    graph.setEffects([effect("b")]);
    graph.setEffects([]);
    expect(seen).toEqual([true, false]);
  });

  it("plays plain when AudioContext is unavailable", async () => {
    const graph = new AudioGraph(() => null);
    graph.setEffects([effect("a")]);
    expect(await graph.attach(el())).toBe(false);
    expect(graph.status).toBe("unavailable");
    expect(graph.wanted).toBe(false);
  });

  it("does not capture while the context is blocked, and does once it can run", async () => {
    const graph = setup({ state: "suspended", resumable: false });
    graph.setEffects([effect("a")]);
    const element = el();
    expect(await graph.attach(element)).toBe(false);
    expect(graph.isCaptured(element)).toBe(false);
    expect(graph.status).toBe("suspended");

    ctxOf(graph).opts.resumable = true;
    expect(await graph.attach(element)).toBe(true);
  });

  it("resumes a suspended context on a user gesture", async () => {
    const graph = setup();
    graph.setEffects([effect("a")]);
    await graph.attach(el());
    const ctx = ctxOf(graph);
    ctx.state = "suspended";
    const target = new EventTarget();
    graph.watchGestures(target as unknown as Window);
    target.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(ctx.resume).toHaveBeenCalled());
    expect(ctx.state).toBe("running");
  });

  it("returns false when the browser refuses to capture the element", async () => {
    const graph = setup({ failCapture: true });
    graph.setEffects([effect("a")]);
    expect(await graph.attach(el())).toBe(false);
  });

  it("bypasses the effects if connecting the chain fails", async () => {
    const graph = setup();
    const broken = effect("broken");
    broken.nodes.connect = () => {
      throw new Error("cannot connect");
    };
    graph.setEffects([broken]);
    await graph.attach(el());
    const ctx = ctxOf(graph);
    expect(ctx.gains[0].edges).toContain(ctx.destination);
  });
});

describe("canRouteUrl", () => {
  const base = "http://app.test/app/";
  beforeEach(() => resetRouteCache());
  afterEach(() => vi.useRealTimers());

  it("passes same-origin, blob and data URLs without any request", async () => {
    const fetchFn = vi.fn();
    expect(await canRouteUrl("/api/x", { base, fetchFn })).toBe(true);
    expect(await canRouteUrl("blob:http://app.test/abc", { base, fetchFn })).toBe(true);
    expect(await canRouteUrl("data:audio/wav;base64,AAAA", { base, fetchFn })).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects file URLs and garbage", async () => {
    expect(await canRouteUrl("file:///c:/a.mp3", { base })).toBe(false);
    expect(await canRouteUrl("http://[bad", { base })).toBe(false);
  });

  it("accepts a cross-origin URL that answers a CORS request and caches the verdict", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 206 }));
    expect(await canRouteUrl("http://media.test/a.mp3", { base, fetchFn })).toBe(true);
    expect(await canRouteUrl("http://media.test/b.mp3", { base, fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.mode).toBe("cors");
    expect(init.credentials).toBe("omit");
  });

  it("rejects a cross-origin URL without CORS headers and remembers it", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await canRouteUrl("http://radio.test/stream", { base, fetchFn })).toBe(false);
    expect(await canRouteUrl("http://radio.test/other", { base, fetchFn })).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gives up on a probe that hangs", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    expect(await canRouteUrl("http://slow.test/a", { base, fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 })).toBe(false);
  });
});
