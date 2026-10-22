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

  const coverSize = format === "portrait" ? W - pad * 2 : 560;
  const coverX = format === "portrait" ? pad : pad;
  const coverY = format === "portrait" ? 150 : 150;
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
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if (format === "portrait") {
    let y = coverY + coverSize + 110;
    const titleFont = `700 64px ${FONT}`;
    const lines = wrapLines(text.title, W - pad * 2, measure(titleFont), 2);
    ctx.font = titleFont;
    ctx.fillStyle = p.text;
    for (const line of lines) {
      ctx.fillText(line, pad, y);
      y += 78;
    }
    y += 4;
    ctx.font = `500 42px ${FONT}`;
    ctx.fillStyle = p.muted;
    ctx.fillText(fitLine(text.artist, W - pad * 2, measure(`500 42px ${FONT}`)), pad, y);
    if (text.album) {
      y += 56;
      ctx.font = `400 32px ${FONT}`;
      ctx.fillText(fitLine(text.album, W - pad * 2, measure(`400 32px ${FONT}`)), pad, y);
    }
  } else {
    // Square: cover on the left, text on the right would be cramped, so text sits under a smaller cover.
    let y = coverY + coverSize + 100;
    const titleFont = `700 58px ${FONT}`;
    const lines = wrapLines(text.title, W - pad * 2, measure(titleFont), 1);
    ctx.font = titleFont;
    ctx.fillStyle = p.text;
    for (const line of lines) {
      ctx.fillText(line, pad, y);
      y += 66;
    }
    ctx.font = `500 38px ${FONT}`;
    ctx.fillStyle = p.muted;
    ctx.fillText(fitLine(text.artist, W - pad * 2, measure(`500 38px ${FONT}`)), pad, y);
  }

  ctx.font = `700 24px ${FONT}`;
  ctx.fillStyle = p.muted;
  ctx.textAlign = "left";
  ctx.fillText("NOW PLAYING ON CADENCE", pad, H - 70);
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