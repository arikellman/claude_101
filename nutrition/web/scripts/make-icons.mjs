/**
 * Generates public/icon-192.png and public/icon-512.png directly as raw PNG bytes.
 *
 * Deliberately not "render an SVG in a browser, extract base64, paste it into a file":
 * that path was tried first and produced a genuinely corrupt PNG (browser's own decoder
 * threw InvalidStateError on read-back) - a multi-KB base64 string round-tripping through
 * a chat message is exactly the kind of thing that silently drops or mangles a character.
 * This script has no such string to transcribe: it builds pixels, deflates them with
 * Node's built-in zlib, and writes PNG chunks by hand (CRC32 included, no dependency).
 * Re-run with: node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const INK = [0x0b, 0x0b, 0x0d]; // matches tailwind.config.ts colors.ink.DEFAULT
const ORANGE = [0xf4, 0xa2, 0x61]; // matches colors.macro.kcal - same orange as the calorie number

/** Fork silhouette in a 100x100 design grid: four tines, a crossbar, a handle. */
const SHAPES = [
  { x: 25, y: 18, w: 8, h: 30, r: 4 },
  { x: 39.3, y: 18, w: 8, h: 30, r: 4 },
  { x: 53.6, y: 18, w: 8, h: 30, r: 4 },
  { x: 67.9, y: 18, w: 8, h: 30, r: 4 },
  { x: 25, y: 40, w: 50.9, h: 12, r: 6 },
  { x: 43, y: 46, w: 14, h: 40, r: 7 },
];

function insideRoundedRect(px, py, s) {
  const { x, y, w, h, r } = s;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  // Only the four corners need the rounded-radius test; the rest of the rect is a plain fill.
  const nearLeft = px < x + r, nearRight = px > x + w - r;
  const nearTop = py < y + r, nearBottom = py > y + h - r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? x + r : x + w - r;
    const cy = nearTop ? y + r : y + h - r;
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  }
  return true;
}

/** 4x supersampled coverage (0..1) for shape `s` at design-grid point (gx, gy). */
function coverage(gx, gy, s) {
  let hits = 0;
  const offsets = [0.125, 0.375, 0.625, 0.875];
  for (const oy of offsets) for (const ox of offsets) {
    if (insideRoundedRect(gx + ox, gy + oy, s)) hits++;
  }
  return hits / 16;
}

function renderPng(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 100 / size; // design grid is 100x100

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x * scale, gy = y * scale;
      let a = 0;
      for (const s of SHAPES) a = Math.max(a, coverage(gx, gy, s));

      const i = (y * size + x) * 4;
      // Alpha-blend the orange fork over the solid ink background - full-bleed to the
      // canvas edge with no transparency, as required for a maskable icon (the OS applies
      // its own circle/squircle crop; a transparent PNG background would show through as
      // black on some launchers instead of matching the shape properly).
      buf[i] = Math.round(ORANGE[0] * a + INK[0] * (1 - a));
      buf[i + 1] = Math.round(ORANGE[1] * a + INK[1] * (1 - a));
      buf[i + 2] = Math.round(ORANGE[2] * a + INK[2] * (1 - a));
      buf[i + 3] = 255;
    }
  }

  return encodePng(buf, size, size);
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder: 8-bit RGBA, filter type 0 (none) per scanline.
// ---------------------------------------------------------------------------

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter byte: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Standard PNG CRC32 (polynomial 0xEDB88320), computed with no external dependency.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ---------------------------------------------------------------------------

for (const size of [192, 512]) {
  const png = renderPng(size);
  const path = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
