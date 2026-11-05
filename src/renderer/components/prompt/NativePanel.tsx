import { X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { glyphWidth, splitGraphemes } from '@shared/terminalWidth';
import {
  MAX_NATIVE_PANEL_TEXT,
  NATIVE_PANEL_CTRL_LETTERS,
  type NativePanel as PanelData,
  type NativePanelCtrlLetter,
  type NativePanelInput,
  type NativePanelKey,
  type NativePanelRow,
  type NativePanelStyle,
} from '@shared/types';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { ICON_SM, IconButton } from '../ui/primitives';

const MIN_FONT = 10;
const MAX_FONT = 13;
const LINE_HEIGHT = 1.25;
/** Advance of the mono font per px of font size until a layout measures it (jsdom never does). */
const DEFAULT_RATIO = 0.6;
const PROBE_CELLS = 40;
const CELL_PROBE = '0'.repeat(PROBE_CELLS);
const BOX_PROBE = String.fromCharCode(0x2500).repeat(PROBE_CELLS);
const WHEEL_MS = 40;
const MAX_CACHED_ROWS = 4000;
/** Dim text sits halfway between its color and its background, like Relay's muted text. */
const DIM_MIX = 0.5;
const LIGHTNESS_STEPS = 32;
/** Lowest contrast a panel foreground keeps against its background. */
export const MIN_PANEL_CONTRAST = 3;

// ---------------------------------------------------------------- colors

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function parseColor(value: string | undefined): Rgb | null {
  const text = value?.trim() ?? '';
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)?.[1];
  if (hex) {
    const n = Number.parseInt(hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i.exec(text);
  if (!rgb || (rgb[4] !== undefined && Number.parseFloat(rgb[4]) === 0)) return null;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

const toHex = (color: Rgb): string =>
  `#${color.map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`;

const rounded = (color: Rgb): Rgb => [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])];

const mix = (a: Rgb, b: Rgb, amount: number): Rgb =>
  [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];

function luminance([r, g, b]: Rgb): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): Rgb {
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255];
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number): number => {
    const t = (((hue + offset) % 1) + 1) % 1;
    if (t < 1 / 6) return (p + (q - p) * 6 * t) * 255;
    if (t < 1 / 2) return q * 255;
    if (t < 2 / 3) return (p + (q - p) * (2 / 3 - t) * 6) * 255;
    return p * 255;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

/** WCAG contrast ratio of two CSS colors (#rgb, #rrggbb or rgb()); 1 when either cannot be read. */
export function contrastRatio(a: string, b: string): number {
  const x = parseColor(a);
  const y = parseColor(b);
  return x && y ? ratio(x, y) : 1;
}

/**
 * `fg` when it reads on `bg` at `min` contrast; otherwise the same hue and saturation with the lightness moved toward the
 * theme's `text` color just far enough (on to black or white when even that lightness is not enough).
 */
export function readableColor(fg: string, bg: string, text: string, min = MIN_PANEL_CONTRAST): string {
  const color = parseColor(fg);
  const back = parseColor(bg);
  if (!color || !back || ratio(color, back) >= min) return fg;
  const [hue, saturation, lightness] = toHsl(color);
  const extreme = ratio(BLACK, back) >= ratio(WHITE, back) ? 0 : 1;
  const theme = parseColor(text);
  const themeLightness = theme ? toHsl(theme)[2] : extreme;
  const stops = [lightness];
  if (extreme === 0 ? themeLightness < lightness : themeLightness > lightness) stops.push(themeLightness);
  stops.push(extreme);
  for (let leg = 1; leg < stops.length; leg++) {
    const from = stops[leg - 1];
    const to = stops[leg];
    for (let step = 1; step <= LIGHTNESS_STEPS; step++) {
      const candidate = rounded(fromHsl(hue, saturation, from + ((to - from) * step) / LIGHTNESS_STEPS));
      if (ratio(candidate, back) >= min) return toHex(candidate);
    }
  }
  return toHex(extreme === 0 ? BLACK : WHITE);
}

export interface PanelPalette {
  /** Default foreground: the theme's text color. */
  text: string;
  /** Default background: the card's. */
  background: string;
}

const FALLBACK_PALETTES: Readonly<Record<'light' | 'dark', PanelPalette>> = {
  light: { text: '#0b0b0b', background: '#ffffff' },
  dark: { text: '#ececec', background: '#262626' },
};

const currentTheme = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/** The card's text and background colors as nativePanel.css resolves them from the theme tokens. */
function readPalette(card: HTMLElement | null): PanelPalette {
  const fallback = FALLBACK_PALETTES[currentTheme()];
  if (!card) return fallback;
  const style = getComputedStyle(card);
  const text = parseColor(style.getPropertyValue('--rd-npanel-fg'));
  const background = parseColor(style.getPropertyValue('--rd-npanel-bg'));
  return { text: text ? toHex(text) : fallback.text, background: background ? toHex(background) : fallback.background };
}

const adapted = new Map<string, string>();

function foreground(fg: string, bg: string, text: string, dim: boolean): string {
  const key = `${fg}|${bg}|${text}|${dim ? 1 : 0}`;
  let value = adapted.get(key);
  if (value === undefined) {
    const color = parseColor(fg);
    const back = parseColor(bg);
    value = readableColor(dim && color && back ? toHex(mix(color, back, DIM_MIX)) : fg, bg, text);
    if (adapted.size >= 1024) adapted.clear();
    adapted.set(key, value);
  }
  return value;
}

/** Inline style of a run: inverse swaps the colors, dim fades toward the background, the foreground stays readable. */
export function runStyle(style: NativePanelStyle | undefined, palette: PanelPalette): CSSProperties {
  const css: CSSProperties = {};
  if (!style) return css;
  const fg = style.inverse ? (style.bg ?? palette.background) : style.fg;
  const bg = style.inverse ? (style.fg ?? palette.text) : style.bg;
  if (bg) css.backgroundColor = bg;
  if (fg || bg || style.dim) css.color = foreground(fg ?? palette.text, bg ?? palette.background, palette.text, style.dim === true);
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  if (style.underline || style.strike) {
    css.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].join(' ').trim();
  }
  return css;
}

// ---------------------------------------------------------------- keys and text

const NAMED_KEYS: ReadonlyMap<string, NativePanelKey> = new Map<string, NativePanelKey>([
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
  ['Enter', 'enter'], ['Escape', 'escape'], ['Tab', 'tab'], ['Backspace', 'backspace'], ['Delete', 'delete'],
  ['Home', 'home'], ['End', 'end'], ['PageUp', 'pageup'], ['PageDown', 'pagedown'], [' ', 'space'],
]);
const CTRL_LETTERS: ReadonlySet<string> = new Set<string>(NATIVE_PANEL_CTRL_LETTERS);
/** Held down, these would act again on whatever the CLI shows next. */
const SINGLE_PRESS: ReadonlySet<NativePanelKey> = new Set<NativePanelKey>(['enter', 'escape', 'tab', 'shift-tab']);

export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** The panel input a key press stands for; null for printable text (the input event carries it) and the app's shortcuts. */
export function panelKeyInput(event: KeyPress): NativePanelInput | null {
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
    return letter && CTRL_LETTERS.has(letter) ? { kind: 'ctrl', letter: letter as NativePanelCtrlLetter } : null;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const key = NAMED_KEYS.get(event.key);
  if (!key) return null;
  return { kind: 'key', key: key === 'tab' && event.shiftKey ? 'shift-tab' : key };
}

/** At most MAX_NATIVE_PANEL_TEXT UTF-16 units, never half a surrogate pair. */
function clampText(text: string): string {
  if (text.length <= MAX_NATIVE_PANEL_TEXT) return text;
  const last = text.charCodeAt(MAX_NATIVE_PANEL_TEXT - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_NATIVE_PANEL_TEXT - 1 : MAX_NATIVE_PANEL_TEXT);
}

/** Another field holds text the user is writing; an appearing panel leaves the focus there. */
function typingElsewhere(active: Element | null, input: HTMLElement): boolean {
  if (active === input) return false;
  const field = active instanceof HTMLTextAreaElement
    || (active instanceof HTMLInputElement && ['text', 'search', 'url', 'email'].includes(active.type));
  return field && (active as HTMLInputElement | HTMLTextAreaElement).value.trim().length > 0;
}

// ---------------------------------------------------------------- rows on the cell grid

type SegmentKind = 'text' | 'glyph' | 'box';
interface Segment {
  text: string;
  cells: number;
  kind: SegmentKind;
}
interface RunModel {
  style: NativePanelStyle | undefined;
  segments: Segment[];
}
interface RowModel {
  runs: RunModel[];
  /** Columns up to the last cell that shows anything. */
  used: number;
}

const SEGMENT_CLASS: Readonly<Record<SegmentKind, string>> = {
  text: 'rd-npanel__text',
  glyph: 'rd-npanel__glyph',
  box: 'rd-npanel__box',
};

const isPlain = (grapheme: string): boolean => grapheme.length === 1 && grapheme >= ' ' && grapheme <= '~';
/** Box drawing and block elements come from one fallback mono font, so a run of them stretches to its cells as a whole. */
const isBox = (grapheme: string): boolean =>
  grapheme.length === 1 && grapheme.charCodeAt(0) >= 0x2500 && grapheme.charCodeAt(0) <= 0x259f;
const painted = (style: NativePanelStyle | undefined): boolean =>
  Boolean(style && (style.bg || style.inverse || style.underline || style.strike));

/** Plain ASCII keeps runs of text; every other grapheme gets its own cells; zero-width ones take none. */
function buildRow(row: NativePanelRow, styles: readonly NativePanelStyle[]): RowModel {
  let column = 0;
  let used = 0;
  const runs = row.runs.map((run): RunModel => {
    const style = styles[run.s];
    const fill = painted(style);
    const segments: Segment[] = [];
    let plain = '';
    let box = '';
    const flushPlain = (): void => {
      if (plain) segments.push({ text: plain, cells: plain.length, kind: 'text' });
      plain = '';
    };
    const flushBox = (): void => {
      if (box) segments.push({ text: box, cells: box.length, kind: 'box' });
      box = '';
    };
    for (const grapheme of splitGraphemes(run.text)) {
      const width = glyphWidth(grapheme);
      if (width === 0) continue;
      column += width;
      if (fill || /\S/u.test(grapheme)) used = column;
      if (isPlain(grapheme)) {
        flushBox();
        plain += grapheme;
      } else if (width === 1 && isBox(grapheme)) {
        flushPlain();
        box += grapheme;
      } else {
        flushPlain();
        flushBox();
        segments.push({ text: grapheme, cells: width, kind: 'glyph' });
      }
    }
    flushPlain();
    flushBox();
    return { style, segments };
  });
  return { runs, used };
}

function rowKey(row: NativePanelRow, styleKeys: readonly string[]): string {
  let key = '';
  for (const run of row.runs) key += `${styleKeys[run.s] ?? ''}\u0001${run.text}\u0002`;
  return key;
}

const PanelRow = memo(function PanelRow({ model, palette }: { model: RowModel; palette: PanelPalette }) {
  return (
    <div className="rd-npanel__row">
      {model.runs.flatMap((run, r) => {
        const css = runStyle(run.style, palette);
        return run.segments.map((segment, s) => (
          <span
            key={`${r}.${s}`}
            className={SEGMENT_CLASS[segment.kind]}
            style={{ ...css, '--rd-cells': segment.cells } as CSSProperties}
            aria-hidden={segment.kind === 'box' || undefined}
          >
            {segment.kind === 'box' ? <span>{segment.text}</span> : segment.text}
          </span>
        ));
      })}
    </div>
  );
});

// ---------------------------------------------------------------- font fitting

interface Metrics {
  font: number;
  cell: number;
  row: number;
  /** Horizontal scale for box drawing, whose fallback font may advance more or less than a cell. */
  box: number;
}

const measured = new Map<number, { cell: number; box: number }>();
let lastMetrics: Metrics | null = null;

const defaultMetrics = (): Metrics => ({
  font: MAX_FONT,
  cell: MAX_FONT * DEFAULT_RATIO,
  row: Math.round(MAX_FONT * LINE_HEIGHT),
  box: 1,
});

const sameMetrics = (a: Metrics, b: Metrics): boolean =>
  a.font === b.font && a.cell === b.cell && a.row === b.row && a.box === b.box;

/** Cell advance at `font` px read from the hidden probes; cached per size until fonts finish loading. */
function measureCell(probes: HTMLElement | null, font: number): { cell: number; box: number } {
  const known = measured.get(font);
  if (known) return known;
  const cellProbe = probes?.querySelector<HTMLElement>('[data-probe="cell"]');
  const boxProbe = probes?.querySelector<HTMLElement>('[data-probe="box"]');
  if (cellProbe && boxProbe) {
    cellProbe.style.fontSize = `${font}px`;
    boxProbe.style.fontSize = `${font}px`;
    const cell = cellProbe.getBoundingClientRect().width / PROBE_CELLS;
    const box = boxProbe.getBoundingClientRect().width / PROBE_CELLS;
    if (cell > 0) {
      const value = { cell, box: box > 0 ? cell / box : 1 };
      measured.set(font, value);
      return value;
    }
  }
  return { cell: font * DEFAULT_RATIO, box: 1 };
}

/** The largest font from MIN_FONT to MAX_FONT (times the app's font scale) that fits `columns` cells into `available` px. */
function fitMetrics(available: number, columns: number, probes: HTMLElement | null, scale: number): Metrics {
  const max = MAX_FONT * scale;
  const min = MIN_FONT * scale;
  let font = max;
  if (available > 0) {
    const perPx = measureCell(probes, max).cell / max;
    font = Math.min(max, Math.max(min, Math.floor((available / (columns * perPx)) * 2) / 2));
    while (font > min && columns * measureCell(probes, font).cell > available) font = Math.max(min, font - 0.5);
  }
  const { cell, box } = measureCell(probes, font);
  return { font, cell, row: Math.round(font * LINE_HEIGHT), box };
}

function fontScale(): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rd-font-scale'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Changes whenever <html> switches the theme or the font scale. */
function useDocumentLook(): number {
  const [look, setLook] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setLook((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => observer.disconnect();
  }, []);
  return look;
}

// ---------------------------------------------------------------- card

const PanelCard = memo(function PanelCard({ viewKey, panel }: { viewKey: string; panel: PanelData }) {
  const controller = useController();
  const t = useT();
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const probesRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const committedRef = useRef('');
  const rowCache = useRef(new Map<string, RowModel>());
  const look = useDocumentLook();
  const [palette, setPalette] = useState<PanelPalette>(() => FALLBACK_PALETTES[currentTheme()]);
  const [metrics, setMetrics] = useState<Metrics>(() => lastMetrics ?? defaultMetrics());

  const rows = useMemo(() => {
    const cache = rowCache.current;
    if (cache.size > MAX_CACHED_ROWS) cache.clear();
    const styleKeys = panel.styles.map((style) => JSON.stringify(style));
    return panel.rows.map((row) => {
      const key = rowKey(row, styleKeys);
      let model = cache.get(key);
      if (!model) {
        model = buildRow(row, panel.styles);
        cache.set(key, model);
      }
      return model;
    });
  }, [panel]);

  // The widest content so far sets the font, so the text does not jump while the user moves through the panel.
  const used = rows.reduce((max, row) => Math.max(max, row.used), 1);
  const [widest, setWidest] = useState(used);
  if (used > widest) setWidest(used);
  const columns = Math.max(1, Math.min(Math.max(widest, used), panel.columns));

  const latest = useRef({ viewKey, panel, metrics, columns });
  latest.current = { viewKey, panel, metrics, columns };

  const send = useCallback((input: NativePanelInput): void => {
    void controller.panelInput(latest.current.viewKey, input);
  }, [controller]);

  const focusInput = useCallback((): void => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const cellAt = useCallback((clientX: number, clientY: number): { row: number; column: number } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const { panel: shown, metrics: size } = latest.current;
    const rect = grid.getBoundingClientRect();
    const column = Math.floor((clientX - rect.left) / size.cell);
    const row = Math.floor((clientY - rect.top) / size.row);
    return row >= 0 && row < shown.rows.length && column >= 0 && column < shown.columns ? { row, column } : null;
  }, []);

  const refit = useCallback((): void => {
    const body = bodyRef.current;
    if (!body) return;
    const style = getComputedStyle(body);
    const available = body.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
    const next = fitMetrics(available, latest.current.columns, probesRef.current, fontScale());
    lastMetrics = next;
    setMetrics((previous) => (sameMetrics(previous, next) ? previous : next));
  }, []);

  useLayoutEffect(() => {
    const next = readPalette(cardRef.current);
    setPalette((previous) => (previous.text === next.text && previous.background === next.background ? previous : next));
  }, [look]);

  useLayoutEffect(() => refit(), [refit, columns, look]);

  useEffect(() => {
    const body = bodyRef.current;
    const observer = body && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => refit()) : undefined;
    if (body) observer?.observe(body);
    const fonts = typeof document.fonts?.addEventListener === 'function' ? document.fonts : undefined;
    const reload = (): void => {
      measured.clear();
      refit();
    };
    fonts?.addEventListener('loadingdone', reload);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', reload);
    };
  }, [refit]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let last = Number.NEGATIVE_INFINITY;
    const onWheel = (event: WheelEvent): void => {
      if (!latest.current.panel.mouse || event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const up = event.deltaY < 0;
      // A card taller than its room scrolls itself first; the CLI gets the wheel at the edge.
      if (up ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight - 1) return;
      event.preventDefault();
      if (event.timeStamp - last < WHEEL_MS) return;
      const cell = cellAt(event.clientX, event.clientY);
      if (!cell) return;
      last = event.timeStamp;
      send({ kind: 'mouse', action: up ? 'wheel-up' : 'wheel-down', ...cell });
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [cellAt, send]);

  useEffect(() => {
    let live = true;
    // Queued behind the composer's own focus effect of the same commit, which a view switch runs.
    queueMicrotask(() => {
      const input = inputRef.current;
      if (!live || !input || document.querySelector('[aria-modal="true"]')) return;
      if (!typingElsewhere(document.activeElement, input)) input.focus({ preventScroll: true });
    });
    return () => {
      live = false;
    };
  }, []);

  // A layout cleanup runs while the card is still in the document, so focus inside it can still be seen.
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    if (active && cardRef.current?.contains(active)) controller.focusPrompt();
  }, [controller]);

  const takeText = (): string => {
    const input = inputRef.current;
    if (!input) return '';
    const text = input.value;
    input.value = '';
    return text;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    committedRef.current = '';
    const input = panelKeyInput(event);
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && input.kind === 'key' && SINGLE_PRESS.has(input.key)) return;
    send(input);
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    const text = takeText();
    if (!text) return;
    // Some browsers report a committed composition once more right after compositionend.
    if (text === committedRef.current) {
      committedRef.current = '';
      return;
    }
    send({ kind: 'text', text: clampText(text) });
  };

  const onCompositionEnd = (event: ReactCompositionEvent<HTMLTextAreaElement>): void => {
    composingRef.current = false;
    const text = takeText() || event.data;
    committedRef.current = text;
    if (text) send({ kind: 'text', text: clampText(text) });
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) send({ kind: 'text', text: clampText(text), paste: true });
  };

  const onGridMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !panel.mouse) return;
    event.preventDefault();
    focusInput();
    const cell = cellAt(event.clientX, event.clientY);
    if (cell) send({ kind: 'mouse', action: 'click', ...cell });
  };

  const onCardMouseDown = (event: ReactMouseEvent<HTMLElement>): void => {
    const target = event.target as Node;
    if (event.button !== 0 || (target instanceof Element && target.closest('button')) || target === bodyRef.current) return;
    // The panel keeps the keyboard; text of a panel without mouse support stays selectable.
    if (!panel.mouse && gridRef.current?.contains(target)) return;
    event.preventDefault();
  };

  const onCardClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) return;
    focusInput();
  };

  const gridStyle = {
    fontSize: `${metrics.font}px`,
    width: `${columns * metrics.cell}px`,
    '--rd-npanel-cell': `${metrics.cell}px`,
    '--rd-npanel-row': `${metrics.row}px`,
    '--rd-npanel-box': String(metrics.box),
  } as CSSProperties;

  return (
    <section
      ref={cardRef}
      className="rd-npanel"
      role="region"
      aria-label={panel.command ? t('nativePanel.name', { command: panel.command }) : t('nativePanel.generic')}
      data-testid="native-panel"
      data-mouse={panel.mouse || undefined}
      onMouseDown={onCardMouseDown}
      onClick={onCardClick}
    >
      <div className="rd-npanel__head">
        <h3 className="rd-npanel__title">{panel.command ? `/${panel.command}` : t('nativePanel.generic')}</h3>
        <IconButton
          label={t('nativePanel.close')}
          icon={<X {...ICON_SM} />}
          size="small"
          muted
          tipPlace="top"
          onClick={() => void controller.closePanel(viewKey)}
        />
      </div>
      <textarea
        ref={inputRef}
        className="rd-npanel__input"
        aria-label={t('nativePanel.input')}
        rows={1}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onInput={onInput}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
      />
      <div ref={bodyRef} className="rd-npanel__body">
        <div
          ref={gridRef}
          className={panel.mouse ? 'rd-npanel__grid' : 'rd-npanel__grid rd-selectable'}
          data-testid="native-panel-grid"
          style={gridStyle}
          onMouseDown={onGridMouseDown}
        >
          {rows.map((model, index) => (
            <PanelRow key={index} model={model} palette={palette} />
          ))}
        </div>
      </div>
      <div ref={probesRef} className="rd-npanel__probes" aria-hidden="true">
        <span data-probe="cell">{CELL_PROBE}</span>
        <span data-probe="box">{BOX_PROBE}</span>
      </div>
    </section>
  );
});

/** The native CLI dialog of the view's open handle (a slash command's panel), docked above the composer while it is open. */
export function NativePanel({ view }: { view: SessionView }) {
  if (!view.panel || !view.handleId || !hasOpenHandle(view)) return null;
  return <PanelCard key={`${view.key}\u0000${view.handleId}`} viewKey={view.key} panel={view.panel} />;
}
