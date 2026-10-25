// "Interface size": the desktop app's own zoom, remembered between launches.
// Windows display scaling (125-200%) plus a small laptop screen can make the
// whole UI feel too big, so the size is adjustable in Settings > Appearance and
// with Ctrl+= / Ctrl+- / Ctrl+0.

export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_SCALE = 1;
const KEY = "ui:scale";

export function normalizeScale(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SCALE;
  // Snap to the closest allowed step.
  return UI_SCALES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), DEFAULT_SCALE as number);
}

/** One step bigger (+1) or smaller (-1), staying within the allowed range. */
export function stepScale(current: number, dir: 1 | -1): number {
  const i = UI_SCALES.indexOf(normalizeScale(current) as (typeof UI_SCALES)[number]);
  return UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, i + dir))]!;
}

/** Maps a key press to a zoom action, or null. Accepts Ctrl or Cmd with =, +, -, _ and 0. */
export function zoomKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

export function readScale(): number {
  try {
    return normalizeScale(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SCALE;
  }
}

export function setScale(scale: number): number {
  const s = normalizeScale(scale);
  try {
    localStorage.setItem(KEY, String(s));
  } catch {
    // Not remembered; still applied for this session.
  }
  window.host?.ui?.setZoom(s);
  window.dispatchEvent(new CustomEvent("ui-scale", { detail: s }));
  return s;
}

/** Applies the saved size and wires the keyboard shortcuts. Desktop app only. */
export function startUiScale(): void {
  if (!window.host?.ui) return;
  window.host.ui.setZoom(readScale());
  // Chromium drops the page zoom back to its default when the display's scale
  // changes (moving between monitors, docking, changing Windows scaling) or the
  // window is restored, which rescales the content without resizing the window.
  // Re-apply the saved size whenever that can happen.
  const reapply = () => window.host?.ui?.setZoom(readScale());
  window.addEventListener("resize", reapply);
  window.addEventListener("focus", reapply);
  const watchDpr = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener(
      "change",
      () => {
        reapply();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();
  window.addEventListener("keydown", (e) => {
    const action = zoomKeyAction(e);
    if (!action) return;
    e.preventDefault();
    setScale(action === "reset" ? DEFAULT_SCALE : stepScale(readScale(), action === "in" ? 1 : -1));
  });
}
