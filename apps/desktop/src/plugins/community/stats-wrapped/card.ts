import { canvasToBlob, drawCover, fitLine, paletteFor, roundRectPath, tryLoadImage } from "../_social/canvasCard";
import { formatHours, peakHour, type Stats } from "./stats";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Draw the shareable summary. `cover` is the top album's artwork when it could be loaded. */
export function drawSummaryCard(ctx: CanvasRenderingContext2D, stats: Stats, label: string, cover: CanvasImageSource | null): void {
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const p = paletteFor(label + (stats.topArtists[0]?.name ?? ""));
  const pad = 84;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, p.bgTop);
  bg.addColorStop(1, p.bgBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const font = (weight: number, size: number) => `${weight} ${size}px ${FONT}`;
  const measure = (f: string) => (s: string) => {
    ctx.font = f;
    return ctx.measureText(s).width;
  };
  const text = (s: string, x: number, y: number, f: string, color = p.text, align: CanvasTextAlign = "left") => {
    ctx.font = f;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  };

  text("CADENCE", pad, 110, font(700, 26), p.muted);
  text(label, W - pad, 110, font(600, 26), p.muted, "right");

  // Headline number.
  text(formatHours(stats.seconds), pad, 270, font(800, 150));
  text("of music", pad, 322, font(500, 40), p.muted);
  text(`${stats.plays.toLocaleString()} plays · ${stats.uniqueTracks.toLocaleString()} songs · ${stats.uniqueArtists.toLocaleString()} artists`, pad, 376, font(500, 30), p.muted);

  // Cover of the top album, top right.
  const coverSize = 260;
  const top = stats.topAlbums[0];
  drawCover(ctx, cover, W - pad - coverSize, 160, coverSize, 28, top?.album ?? label, top?.album ?? "?");

  // Top artists.
  let y = 450;
  text("TOP ARTISTS", pad, y, font(700, 24), p.muted);
  y += 20;
  const maxArtist = Math.max(1, stats.topArtists[0]?.plays ?? 1);
  stats.topArtists.slice(0, 5).forEach((a, i) => {
    y += 56;
    text(String(i + 1), pad, y, font(600, 34), p.muted);
    text(fitLine(a.name, W - pad * 2 - 260, measure(font(i === 0 ? 700 : 500, 40))), pad + 56, y, font(i === 0 ? 700 : 500, 40));
    text(`${a.plays}`, W - pad, y, font(500, 30), p.muted, "right");
    // A quiet bar under each name.
    const barW = (W - pad * 2 - 56) * (a.plays / maxArtist);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    roundRectPath(ctx, pad + 56, y + 12, barW, 5, 3);
    ctx.fill();
  });

  // Top tracks.
  y += 74;
  text("TOP SONGS", pad, y, font(700, 24), p.muted);
  stats.topTracks.slice(0, 5).forEach((t, i) => {
    y += 50;
    text(String(i + 1), pad, y, font(600, 30), p.muted);
    const title = fitLine(t.track.title, W - pad * 2 - 150, measure(font(500, 34)));
    text(title, pad + 56, y, font(500, 34));
    text(`${t.plays}×`, W - pad, y, font(500, 28), p.muted, "right");
  });

  // Footer facts.
  const facts: [string, string][] = [
    [`${stats.streaks.longest}`, "day streak"],
    [`${Math.round(stats.newVsRepeat.newShare * 100)}%`, "new to you"],
    [peakHour(stats.secondsByHour) ?? "-", "peak hour"],
  ];
  const colW = (W - pad * 2) / facts.length;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  roundRectPath(ctx, pad, H - 240, W - pad * 2, 140, 28);
  ctx.fill();
  facts.forEach(([value, caption], i) => {
    const cx = pad + colW * i + colW / 2;
    text(value, cx, H - 165, font(700, 54), p.text, "center");
    text(caption, cx, H - 120, font(500, 26), p.muted, "center");
  });
}

/** Render the summary to a PNG. Artwork is used when the image host allows it; otherwise a calm placeholder. */
export async function renderSummaryCard(stats: Stats, label: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot draw the card.");
  const cover = await tryLoadImage(stats.topAlbums[0]?.artwork);
  drawSummaryCard(ctx, stats, label, cover);
  return canvasToBlob(canvas);
}