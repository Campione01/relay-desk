import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const tokens = readFileSync(join(root, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');

/** The `--rd-*: #rrggbb` declarations inside the first block that `selector` opens. */
function declarations(selector: string): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = tokens.slice(start, tokens.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--rd-[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((match) => [match[1], match[2].toLowerCase()]));
}

const light = declarations(':root');
const dark = new Map([...light, ...declarations(':root[data-theme="dark"]')]);

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

// Every background the accent's dots, spinner and fast-mode mark can sit on.
const SURFACES = ['--rd-bg-app', '--rd-bg-sidebar', '--rd-bg-card', '--rd-bg-input', '--rd-bg-search', '--rd-bg-elevated', '--rd-bg-inset',
  '--rd-bg-hover', '--rd-bg-active', '--rd-bg-pressed', '--rd-bg-pressed-soft', '--rd-bg-user-bubble'];

describe('accent colour', () => {
  for (const [theme, values] of [['light', light], ['dark', dark]] as const) {
    it(`keeps 4.5:1 or more on every ${theme} surface`, () => {
      const accent = values.get('--rd-accent');
      expect(accent, '--rd-accent').toMatch(/^#[0-9a-f]{6}$/);
      const checked = SURFACES.filter((name) => values.has(name));
      expect(checked.length).toBeGreaterThanOrEqual(10);
      for (const name of checked) expect(contrast(accent!, values.get(name)!), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the icon draws the dark-theme accent on the dark window colour', async () => {
    const icon = (await import(pathToFileURL(join(root, 'build', 'make-icon.mjs')).href)) as { ACCENT: number[]; BACKGROUND: number[] };
    const hex = (rgb: number[]): string => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    expect(hex(icon.ACCENT)).toBe(dark.get('--rd-accent'));
    expect(hex(icon.BACKGROUND)).toBe(dark.get('--rd-bg-app'));
  });
});
