// Generates build/icon.png (512x512) and build/icon.ico (16-256 px, PNG entries) for Relay Desk.
// The mark: two arcing arrows chasing each other around a ring (a relay loop) with a baton dot in the centre,
// in the accent colour on a dark rounded square. Original artwork; no third-party marks. Re-run with: node build/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const OUT_DIR = import.meta.dirname;
export const BACKGROUND = [0x1f, 0x1f, 0x1f]; // --rd-bg-app (dark)
export const ACCENT = [0xe3, 0x99, 0x81]; // --rd-accent (dark)
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 6;

// Geometry in a 512-unit design space.
const UNIT = 512;
const CORNER = 112;
const CENTER = 256;
const RING = 138;
const STROKE = 46;
const ARCS = [
  [208, 322],
  [28, 142],
]; // degrees, clockwise on screen (y grows downwards); each arc ends in an arrowhead
const HEAD_LENGTH = 30; // degrees along the ring from the arc end to the tip
const HEAD_HALF_WIDTH = 54; // radial half-width of the arrowhead base
const BATON = 34; // radius of the centre dot: the session handed around the loop

const toRad = (deg) => (deg * Math.PI) / 180;

function insideRoundedSquare(x, y) {
  const qx = Math.abs(x - UNIT / 2) - (UNIT / 2 - CORNER);
  const qy = Math.abs(y - UNIT / 2) - (UNIT / 2 - CORNER);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - CORNER <= 0;
}

function angleOf(x, y) {
  const deg = (Math.atan2(y - CENTER, x - CENTER) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function polar(deg, radius) {
  return [CENTER + radius * Math.cos(toRad(deg)), CENTER + radius * Math.sin(toRad(deg))];
}

function insideTriangle(p, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const HEADS = ARCS.map(([, end]) => [
  polar(end, RING - HEAD_HALF_WIDTH),
  polar(end, RING + HEAD_HALF_WIDTH),
  polar(end + HEAD_LENGTH, RING),
]);

function insideMark(x, y) {
  const r = Math.hypot(x - CENTER, y - CENTER);
  if (r <= BATON) return true;
  if (Math.abs(r - RING) <= STROKE / 2) {
    const a = angleOf(x, y);
    // Round tail cap is approximated by the band itself; the band stops exactly at the arrowhead base.
    if (ARCS.some(([start, end]) => a >= start && a <= end)) return true;
  }
  return HEADS.some(([a, b, c]) => insideTriangle([x, y], a, b, c));
}

/** Renders the icon at `size` px with SUPERSAMPLE^2 samples per pixel. */
export function render(size) {
  const png = new PNG({ width: size, height: size });
  const scale = UNIT / size;
  const n = SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let mark = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) * scale;
          const y = (py + (sy + 0.5) / n) * scale;
          if (!insideRoundedSquare(x, y)) continue;
          bg++;
          if (insideMark(x, y)) mark++;
        }
      }
      const total = n * n;
      const alpha = bg / total;
      const t = bg ? mark / bg : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.round(BACKGROUND[c] * (1 - t) + ACCENT[c] * t);
      png.data[i + 3] = Math.round(alpha * 255);
    }
  }
  return PNG.sync.write(png, { colorType: 6 });
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
export function buildIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(OUT_DIR, 'icon.png'), render(512));
  writeFileSync(join(OUT_DIR, 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: render(size) }))));
  console.log(`wrote ${join(OUT_DIR, 'icon.png')} and ${join(OUT_DIR, 'icon.ico')} (${ICO_SIZES.join(', ')})`);
}
