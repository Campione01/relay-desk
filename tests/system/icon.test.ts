import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';

interface IconModule {
  render(size: number): Buffer;
  buildIco(images: Array<{ size: number; data: Buffer }>): Buffer;
  ICO_SIZES: number[];
  BACKGROUND: number[];
  ACCENT: number[];
}

const buildDir = join(import.meta.dirname, '..', '..', 'build');
let icon: IconModule;

beforeAll(async () => {
  icon = (await import(pathToFileURL(join(buildDir, 'make-icon.mjs')).href)) as IconModule;
});

const pixel = (png: PNG, x: number, y: number): number[] => {
  const i = (y * png.width + x) * 4;
  return [...png.data.subarray(i, i + 4)];
};

describe('icon generator', () => {
  it('renders a rounded square: transparent corners, opaque dark edge, accent mark and centre dot', () => {
    const png = PNG.sync.read(icon.render(128));
    expect([png.width, png.height]).toEqual([128, 128]);
    expect(pixel(png, 0, 0)[3]).toBe(0);
    expect(pixel(png, 127, 127)[3]).toBe(0);
    expect(pixel(png, 64, 2)).toEqual([...icon.BACKGROUND, 255]);
    expect(pixel(png, 64, 64)).toEqual([...icon.ACCENT, 255]);
    // On the ring, left side of the upper arc (angle ~250 deg, radius 138/512).
    const r = (138 / 512) * 128;
    const a = (250 * Math.PI) / 180;
    expect(pixel(png, Math.round(64 + r * Math.cos(a)), Math.round(64 + r * Math.sin(a)))).toEqual([...icon.ACCENT, 255]);
    // Between ring and centre dot stays background.
    expect(pixel(png, 64, 64 - Math.round((80 / 512) * 128))).toEqual([...icon.BACKGROUND, 255]);
  });

  it('writes an ICO directory with PNG entries for every size, 256 encoded as 0', () => {
    const images = icon.ICO_SIZES.map((size) => ({ size, data: icon.render(size) }));
    const ico = icon.buildIco(images);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(icon.ICO_SIZES.length);
    icon.ICO_SIZES.forEach((size, index) => {
      const entry = 6 + 16 * index;
      expect(ico[entry]).toBe(size >= 256 ? 0 : size);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const png = PNG.sync.read(ico.subarray(offset, offset + length));
      expect([png.width, png.height]).toEqual([size, size]);
    });
    expect(icon.ICO_SIZES).toContain(256);
    expect(icon.ICO_SIZES).toContain(16);
  });

  it('the committed build/icon.png and icon.ico are the generator output', () => {
    expect(readFileSync(join(buildDir, 'icon.png')).equals(icon.render(512))).toBe(true);
    const ico = icon.buildIco(icon.ICO_SIZES.map((size) => ({ size, data: icon.render(size) })));
    expect(readFileSync(join(buildDir, 'icon.ico')).equals(ico)).toBe(true);
  });
});
