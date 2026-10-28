import { useEffect, useRef, useState, type RefObject } from "react";
import type { Lyrics } from "../../types";
import { activeLineIndex } from "./lrc";
import { playbackPosition, useLyricsView } from "./lyricsStore";

/** Lines light up a touch early, which reads better than lighting up late. */
export const LEAD_SEC = 0.2;
const POLL_MS = 200;
/** After the listener scrolls by hand, auto-scroll waits this long. */
export const MANUAL_SCROLL_PAUSE_MS = 4000;

/** The OS setting or the app own "reduce motion" switch. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
      document.documentElement.classList.contains("reduce-motion")
    );
  } catch {
    return false;
  }
}

/** The index of the line being sung, or -1 (before the first line, or unsynced lyrics). */
export function useActiveLine(lyrics: Lyrics | null): number {
  const [index, setIndex] = useState(-1);
  const offsetSec = useLyricsView((s) => s.offsetSec);
  useEffect(() => {
    if (!lyrics?.synced) {
      setIndex(-1);
      return;
    }
    const tick = () => setIndex(activeLineIndex(lyrics.lines, playbackPosition(), LEAD_SEC + offsetSec));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [lyrics, offsetSec]);
  return index;
}

/** The scrolling ancestor of an element: the app main column on the page, or a given container. */
function scroller(list: HTMLElement, given?: HTMLElement | null): HTMLElement {
  return given ?? (list.closest(".main") as HTMLElement | null) ?? (document.scrollingElement as HTMLElement);
}

/**
 * Keep the active line in view. Scrolling by hand (wheel, touch, drag) pauses this for a few
 * seconds so the page never fights the listener. `anchor` is where the line sits (0.5 = middle).
 */
export function useAutoScroll(
  listRef: RefObject<HTMLElement | null>,
  active: number,
  options: { anchor: number; container?: RefObject<HTMLElement | null> },
): void {
  const pausedUntil = useRef(0);
  const first = useRef(true);
  const { anchor, container } = options;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = scroller(list, container?.current);
    const pause = () => {
      pausedUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS;
    };
    el.addEventListener("wheel", pause, { passive: true });
    el.addEventListener("touchmove", pause, { passive: true });
    el.addEventListener("pointerdown", pause, { passive: true });
    return () => {
      el.removeEventListener("wheel", pause);
      el.removeEventListener("touchmove", pause);
      el.removeEventListener("pointerdown", pause);
    };
  }, [listRef, container]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || active < 0) return;
    const line = list.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!line) return;
    const el = scroller(list, container?.current);
    const jumpNow = first.current;
    first.current = false;
    if (!jumpNow && Date.now() < pausedUntil.current) return;
    const box = el.getBoundingClientRect();
    const at = line.getBoundingClientRect();
    const top = at.top - box.top + el.scrollTop - box.height * anchor + at.height / 2;
    el.scrollTo({ top: Math.max(0, top), behavior: jumpNow || prefersReducedMotion() ? "instant" : "smooth" });
  }, [active, anchor, container, listRef]);
}

/** Keep the screen awake while `on` (karaoke on a phone), if the browser allows it. */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    const acquire = () => {
      nav.wakeLock
        ?.request("screen")
        .then((s) => {
          if (cancelled) void s.release();
          else sentinel = s;
        })
        .catch(() => undefined);
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [on]);
}
