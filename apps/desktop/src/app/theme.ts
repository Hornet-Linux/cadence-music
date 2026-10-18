import { useEffect } from "react";
import { ACCENTS, usePrefs } from "@/features/preferences/prefsStore";
import { usePlayer } from "@/player/playerStore";
import { dominantColor, fallbackPair, hslCss, rgbToHsl, vivid, type Hsl } from "@/ui/color";

function hexToHsl(hex: string): Hsl {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/**
 * Keeps the theme in sync with preferences and the playing track: the
 * ambient background (and, with the "From artwork" accent, the accent too)
 * follows the colours of the current artwork.
 */
export function useTheme(): void {
  const current = usePlayer((s) => s.current);
  const accent = usePrefs((s) => s.accent);
  const ambientOn = usePrefs((s) => s.ambientBackground);
  const reduceMotion = usePrefs((s) => s.reduceMotion);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    let cancelled = false;
    const root = document.documentElement.style;

    const apply = (base: Hsl) => {
      if (cancelled) return;
      const color = vivid(base);
      root.setProperty("--ambient", ambientOn ? hslCss(color) : "hsl(250 30% 22%)");
      if (accent === "artwork") {
        root.setProperty("--accent-from", hslCss(color));
        root.setProperty("--accent-to", hslCss({ ...color, h: (color.h + 45) % 360 }));
      }
    };

    if (accent !== "artwork") {
      const preset = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[1];
      root.setProperty("--accent-from", preset.from);
      root.setProperty("--accent-to", preset.to);
    }

    const seed = current?.album ?? current?.title ?? "";
    const fallback = hexToHsl(current ? fallbackPair(seed)[0] : "#8b6bff");
    if (current?.artwork) {
      dominantColor(current.artwork).then(apply, () => apply(fallback));
    } else {
      apply(fallback);
    }
    return () => {
      cancelled = true;
    };
  }, [current, accent, ambientOn]);
}
