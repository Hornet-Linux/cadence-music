import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyrics } from "../../types";

let position = 0;
vi.mock("./lyricsStore", () => ({ playbackPosition: () => position }));

const { prefersReducedMotion, useActiveLine, useAutoScroll, MANUAL_SCROLL_PAUSE_MS } = await import("./hooks");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lyrics: Lyrics = {
  lines: [
    { timeSec: 5, text: "a" },
    { timeSec: 10, text: "b" },
    { timeSec: 20, text: "c" },
  ],
  synced: true,
  source: "T",
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.classList.remove("reduce-motion");
  vi.useFakeTimers();
  // jsdom has no Element.scrollTo.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("prefersReducedMotion", () => {
  it("follows the app switch and the OS setting", () => {
    expect(prefersReducedMotion()).toBe(false);
    document.documentElement.classList.add("reduce-motion");
    expect(prefersReducedMotion()).toBe(true);
    document.documentElement.classList.remove("reduce-motion");
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  });
});

describe("useActiveLine", () => {
  function Probe({ lyrics }: { lyrics: Lyrics | null }) {
    return <span data-testid="i">{useActiveLine(lyrics)}</span>;
  }
  const read = () => host.querySelector("span")!.textContent;

  it("follows the playback position and stays -1 for unsynced lyrics", () => {
    position = 0;
    act(() => root.render(<Probe lyrics={lyrics} />));
    expect(read()).toBe("-1");
    position = 12;
    act(() => void vi.advanceTimersByTime(400));
    expect(read()).toBe("1");
    position = 50;
    act(() => void vi.advanceTimersByTime(400));
    expect(read()).toBe("2");
    act(() => root.render(<Probe lyrics={{ ...lyrics, synced: false }} />));
    expect(read()).toBe("-1");
  });
});

describe("useAutoScroll", () => {
  function List({ active }: { active: number }) {
    const list = useRef<HTMLOListElement>(null);
    const box = useRef<HTMLDivElement>(null);
    useAutoScroll(list, active, { anchor: 0.4, container: box });
    return (
      <div ref={box} id="box">
        <ol ref={list}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} data-i={i} />
          ))}
        </ol>
      </div>
    );
  }
  const spy = () => {
    const box = host.querySelector<HTMLElement>("#box")!;
    const scrollTo = Element.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();
    return { box, scrollTo };
  };

  it("jumps on the first line it shows, then scrolls smoothly", () => {
    act(() => root.render(<List active={-1} />));
    const { scrollTo } = spy();
    act(() => root.render(<List active={1} />));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
    act(() => root.render(<List active={2} />));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("does not animate when motion is reduced", () => {
    document.documentElement.classList.add("reduce-motion");
    act(() => root.render(<List active={0} />));
    const { scrollTo } = spy();
    act(() => root.render(<List active={1} />));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
  });

  it("leaves the scroll alone for a few seconds after the listener scrolls", () => {
    act(() => root.render(<List active={0} />));
    const { box, scrollTo } = spy();
    act(() => void box.dispatchEvent(new Event("wheel")));
    act(() => root.render(<List active={1} />));
    expect(scrollTo).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + MANUAL_SCROLL_PAUSE_MS + 100);
    act(() => root.render(<List active={2} />));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
