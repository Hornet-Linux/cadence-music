// Colour helpers for the art-driven theme.

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

// Quiet, low-saturation pairs: artwork placeholders should recede, not shout.
const FALLBACKS: [string, string][] = [
  ["#5d6590", "#46506f"],
  ["#845d6c", "#5f4553"],
  ["#4f7782", "#3c5964"],
  ["#7b6a90", "#5a4d6e"],
  ["#587a67", "#42604f"],
  ["#8a7157", "#665240"],
  ["#4f6f95", "#3b5373"],
  ["#74698f", "#574f6d"],
];

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A stable, pleasant gradient pair for things without artwork. */
export function fallbackPair(seed: string): [string, string] {
  return FALLBACKS[hashString(seed) % FALLBACKS.length];
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslCss({ h, s, l }: Hsl): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

/**
 * Tame a colour into a restrained accent: soft saturation and a light, even
 * tone so text on top stays readable (dark text on the accent, accent text on
 * the dark surfaces both pass WCAG AA).
 */
export function calm(c: Hsl): Hsl {
  return { h: c.h, s: Math.min(0.42, Math.max(0.2, c.s * 0.5)), l: Math.min(0.74, Math.max(0.64, c.l)) };
}

/**
 * Most characterful colour of an image: averages pixels weighted by how
 * saturated and mid-toned they are, so a grey border doesn't win.
 * Rejects if the image can't be read (e.g. no CORS headers).
 */
export function dominantColor(src: string): Promise<Hsl> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          const weight = 0.05 + hsl.s * (1 - Math.abs(hsl.l - 0.5) * 1.6);
          if (weight <= 0) continue;
          r += data[i] * weight;
          g += data[i + 1] * weight;
          b += data[i + 2] * weight;
          total += weight;
        }
        if (total === 0) throw new Error("empty image");
        resolve(rgbToHsl(r / total, g / total, b / total));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}
