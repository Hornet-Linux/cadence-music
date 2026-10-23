import type { Track } from "@/shared/types";
import { primaryArtist } from "@/shared/types";
import { canvasToBlob, drawCover, fitLine, paletteFor, safeFileName, tryLoadImage, wrapLines } from "../_social/canvasCard";

export type CardFormat = "portrait" | "square";

export const FORMATS: Record<CardFormat, { label: string; width: number; height: number }> = {
  portrait: { label: "Portrait (4:5)", width: 1080, height: 1350 },
  square: { label: "Square", width: 1080, height: 1080 },
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** The text a card shows, kept separate from drawing so it can be tested. */
export function cardText(track: Track): { title: string; artist: string; album: string | null; fileName: string } {
  return {
    title: track.title.trim() || "Untitled",
    artist: primaryArtist(track),
    album: track.album?.trim() || null,
    fileName: safeFileName(`${primaryArtist(track)} ${track.title}`, "png"),
  };
}

export function drawTrackCard(ctx: CanvasRenderingContext2D, track: Track, format: CardFormat, cover: CanvasImageSource | null): void {
  const { width: W, height: H } = FORMATS[format];
  const text = cardText(track);
  const p = paletteFor(`${text.artist}|${text.album ?? text.title}`);
  const pad = 90;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, p.bgTop);
  bg.addColorStop(1, p.bgBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Everything is centred: a calm, symmetrical card.
  const coverSize = format === "portrait" ? 720 : 560;
  const coverX = (W - coverSize) / 2;
  const coverY = format === "portrait" ? 160 : 130;
  // A soft shadow under the cover keeps it from floating.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 50;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = p.bgBottom;
  ctx.fillRect(coverX, coverY, coverSize, coverSize);
  ctx.restore();
  drawCover(ctx, cover, coverX, coverY, coverSize, 36, text.album ?? text.title, text.title);

  const measure = (font: string) => (s: string) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const cx = W / 2;
  const maxW = W - pad * 2;
  const titleSize = format === "portrait" ? 62 : 54;
  const titleFont = `700 ${titleSize}px ${FONT}`;
  let y = coverY + coverSize + (format === "portrait" ? 110 : 90);
  ctx.font = titleFont;
  ctx.fillStyle = p.text;
  for (const line of wrapLines(text.title, maxW, measure(titleFont), format === "portrait" ? 2 : 1)) {
    ctx.fillText(line, cx, y);
    y += titleSize + 14;
  }
  const artistFont = `500 ${format === "portrait" ? 40 : 36}px ${FONT}`;
  ctx.font = artistFont;
  ctx.fillStyle = p.muted;
  ctx.fillText(fitLine(text.artist, maxW, measure(artistFont)), cx, y + 6);
  if (text.album && format === "portrait") {
    const albumFont = `400 30px ${FONT}`;
    ctx.font = albumFont;
    ctx.fillText(fitLine(text.album, maxW, measure(albumFont)), cx, y + 62);
  }

  ctx.font = `700 24px ${FONT}`;
  ctx.fillStyle = p.muted;
  ctx.fillText("NOW PLAYING ON CADENCE", cx, H - 64);
}
/** Render the card for a track to a PNG. The cover is used when its host allows it, otherwise a placeholder. */
export async function renderTrackCard(track: Track, format: CardFormat): Promise<Blob> {
  const { width, height } = FORMATS[format];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot draw the card.");
  const cover = await tryLoadImage(track.artwork);
  drawTrackCard(ctx, track, format, cover);
  return canvasToBlob(canvas);
}