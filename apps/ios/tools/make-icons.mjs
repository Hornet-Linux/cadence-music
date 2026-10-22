// Regenerates the app icon and launch logo PNGs in the asset catalog (no dependencies).
//   node apps/ios/tools/make-icons.mjs
// The icon is a full-bleed, opaque square: iOS rounds the corners itself, so a
// pre-rounded icon with transparent corners would show black corners.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "Cadence", "Assets.xcassets");

// The mark, in a 1024 design grid: five bars that shorten, then a dot.
const BARS = [
  { x: 265, h: 512 },
  { x: 389, h: 394 },
  { x: 512, h: 274 },
  { x: 636, h: 162 },
];
const DOT = { x: 760, r: 41 };
const BAR_W = 82;
const CY = 512;

// Signed distance from (px, py) to a vertical capsule centred at (cx, CY).
function capsule(px, py, cx, height, width) {
  const r = width / 2;
  const half = height / 2 - r;
  const dy = Math.max(Math.abs(py - CY) - half, 0);
  return Math.hypot(px - cx, dy) - r;
}

function glyphCoverage(px, py) {
  let d = Math.hypot(px - DOT.x, py - CY) - DOT.r;
  for (const b of BARS) d = Math.min(d, capsule(px, py, b.x, b.h, BAR_W));
  return Math.min(1, Math.max(0, 0.5 - d)); // 1px wide anti-aliased edge in grid units
}

const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const TABLE = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// channels: 3 = RGB (opaque), 4 = RGBA.
function png(size, channels, pixel) {
  const raw = Buffer.alloc((size * channels + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * channels + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = pixel(x, y);
      const o = y * (size * channels + 1) + 1 + x * channels;
      for (let c = 0; c < channels; c++) raw[o + c] = px[c];
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Average coverage over an n x n grid of sub-samples; `scale` maps pixels to the 1024 grid.
function coverage(x, y, scale, n = 3) {
  let sum = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) sum += glyphCoverage(((x + (i + 0.5) / n) * scale), ((y + (j + 0.5) / n) * scale));
  return sum / (n * n);
}

// App icon: calm slate-blue diagonal gradient, soft off-white mark.
const top = hex(0x4d6d88);
const bottom = hex(0x25364a);
const ink = hex(0xeef2f6);
const icon = png(1024, 3, (x, y) => {
  const base = mix(top, bottom, (x + y) / 2046);
  return mix(base, ink, coverage(x, y, 1));
});
writeFileSync(join(assets, "AppIcon.appiconset", "icon.png"), icon);

// Launch logo: the mark alone on a transparent square, in one colour per appearance.
function logo(size, color) {
  const scale = 1024 / size;
  return png(size, 4, (x, y) => [...color, Math.round(255 * coverage(x, y, scale))]);
}
const dir = join(assets, "LaunchLogo.imageset");
mkdirSync(dir, { recursive: true });
for (const [name, color] of [["light", hex(0x3f5b73)], ["dark", hex(0x9fb4c7)]]) {
  for (const scale of [1, 2, 3]) writeFileSync(join(dir, `logo-${name}@${scale}x.png`), logo(96 * scale, color));
}
console.log("wrote icons");
