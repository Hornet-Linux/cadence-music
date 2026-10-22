import { hashString } from "@/ui/color";

/** Small canvas helpers for the shareable cards. Drawing needs a browser; the maths here is plain. */

/** Break text into lines that fit `maxWidth` (by `measure`), adding an ellipsis if it runs past `maxLines`. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  const pushLong = (word: string) => {
    // A single word wider than the line is cut by characters.
    let chunk = "";
    for (const ch of word) {
      if (measure(chunk + ch) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const word of words) {
    const attempt = line ? `${line} ${word}` : word;
    if (measure(attempt) <= maxWidth) {
      line = attempt;
      continue;
    }
    if (line) lines.push(line);
    line = measure(word) <= maxWidth ? word : pushLong(word);
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && measure(`${last}\u2026`) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}\u2026`;
  return kept;
}

/** Shrink text to one line by dropping characters and adding an ellipsis. */
export function fitLine(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measure(`${out}\u2026`) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}\u2026`;
}

export interface Palette {
  /** Background top and bottom. */
  bgTop: string;
  bgBottom: string;
  /** Soft tone used behind the cover and for bars. */
  tint: string;
  text: string;
  muted: string;
}

/** A calm, muted palette picked by a seed, so the same track always gets the same card. */
export function paletteFor(seed: string): Palette {
  const hue = (hashString(seed) * 47) % 360;
  return {
    bgTop: `hsl(${hue} 18% 17%)`,
    bgBottom: `hsl(${(hue + 24) % 360} 20% 10%)`,
    tint: `hsl(${hue} 30% 46%)`,
    text: "#f1efe9",
    muted: "rgba(241, 239, 233, 0.62)",
  };
}

/** A filename that is safe on every system. */
export function safeFileName(name: string, ext: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60) || "cadence";
  return `${base}.${ext}`;
}

/** Load an image for drawing. Rejects when it cannot be fetched or the server forbids cross-origin use. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = url;
  });
}

export async function tryLoadImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) return null;
  try {
    return await loadImage(url);
  } catch {
    return null;
  }
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Draw a cover (or a calm placeholder with the first letter) into a rounded square. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource | null,
  x: number,
  y: number,
  size: number,
  radius: number,
  seed: string,
  letter: string,
): void {
  ctx.save();
  roundRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    const p = paletteFor(seed);
    const g = ctx.createLinearGradient(x, y, x + size, y + size);
    g.addColorStop(0, p.tint);
    g.addColorStop(1, p.bgTop);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = `600 ${Math.round(size * 0.4)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter.slice(0, 1).toUpperCase(), x + size / 2, y + size / 2);
  }
  ctx.restore();
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not create the image."))), "image/png");
  });
}

/** Save a blob as a file download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ShareResult = "shared" | "cancelled" | "unsupported";

/** Share an image with the system share sheet (Web Share API), if the device can share files. */
export async function shareImage(blob: Blob, filename: string, title: string, text: string): Promise<ShareResult> {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || !nav.canShare?.({ files: [file] })) return "unsupported";
  try {
    await nav.share({ files: [file], title, text });
    return "shared";
  } catch (err) {
    return (err as Error).name === "AbortError" ? "cancelled" : "unsupported";
  }
}

/** Copy an image to the clipboard. */
export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch {
    return false;
  }
}