import { MAX_NATIVE_PANEL_TEXT, NATIVE_PANEL_CTRL_LETTERS, type NativePanel, type NativePanelInput, type NativePanelKey, type NativePanelRow, type NativePanelStyle } from '@shared/types';
import type { NativeTerminalScreen } from './terminalScreen';

/** Screen rows of a docked native dialog: its U+2594 top border, then its content through the last non-blank row. */
export interface NativePanelRegion { borderRow: number; firstRow: number; lastRow: number }
export interface NativePanelInputContext { mouse: boolean; bracketedPaste: boolean; firstRow: number; rowCount: number; columns: number }

const BORDER = /^\u2594{40}/;
const KEYS = new Map<string, string>(Object.entries({
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', escape: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z',
  backspace: '\x7f', delete: '\x1b[3~', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', space: ' ',
} satisfies Record<NativePanelKey, string>));
const CTRL_LETTERS = new Set<string>(NATIVE_PANEL_CTRL_LETTERS);
const MOUSE_ACTIONS = new Set(['click', 'wheel-up', 'wheel-down']);
const FIELDS = new Map<string, readonly string[]>(Object.entries({
  key: ['kind', 'key'], ctrl: ['kind', 'letter'], text: ['kind', 'text', 'paste'], mouse: ['kind', 'action', 'row', 'column'],
} satisfies Record<NativePanelInput['kind'], readonly string[]>));
const TYPED_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const PASTED_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cell = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < limit;

/** The last docked dialog on screen; the idle composer's U+2500 rules never match. */
export function detectNativePanel(screen: NativeTerminalScreen): NativePanelRegion | undefined {
  const lines = screen.lineTexts();
  const borderRow = lines.findLastIndex((line) => BORDER.test(line));
  let lastRow = lines.length - 1;
  while (lastRow > borderRow && !lines[lastRow].trim()) lastRow--;
  return borderRow >= 0 && lastRow > borderRow ? { borderRow, firstRow: borderRow + 1, lastRow } : undefined;
}

/** The shared mirror of `region`: styled rows with only the styles they use, re-indexed in first-use order. */
export function nativePanelPayload(screen: NativeTerminalScreen, region: NativePanelRegion, revision: number, command?: string): NativePanel {
  const { firstRow, lastRow } = region;
  if (!Number.isSafeInteger(firstRow) || !Number.isSafeInteger(lastRow) || firstRow < 0 || lastRow < firstRow || lastRow >= screen.rows) throw new Error('Invalid native panel region.');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid native panel revision.');
  const table = screen.styleTable(), styles: NativePanelStyle[] = [], ids = new Map<number, number>(), rows: NativePanelRow[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    rows.push({ runs: screen.styledRow(row).runs.map(({ text, s }) => {
      let id = ids.get(s);
      if (id === undefined) { id = styles.push({ ...table[s] }) - 1; ids.set(s, id); }
      return { text, s: id };
    }) });
  }
  return { revision, ...(command === undefined ? {} : { command }), columns: screen.columns, rows, styles, mouse: screen.mouse };
}

/** Terminal bytes for one renderer input to the shown panel; throws on anything the panel must not receive. */
export function encodeNativePanelInput(input: unknown, context: NativePanelInputContext): string {
  const fields = record(input) && typeof input.kind === 'string' ? FIELDS.get(input.kind) : undefined;
  if (!record(input) || !fields) throw new Error('Invalid native panel input.');
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error('Invalid native panel input.');
  if (input.kind === 'key') {
    const bytes = typeof input.key === 'string' ? KEYS.get(input.key) : undefined;
    if (bytes === undefined) throw new Error('Unknown native panel key.');
    return bytes;
  }
  if (input.kind === 'ctrl') {
    if (typeof input.letter !== 'string' || !CTRL_LETTERS.has(input.letter)) throw new Error('Unsupported Ctrl letter.');
    return String.fromCharCode(input.letter.charCodeAt(0) & 0x1f);
  }
  if (input.kind === 'text') {
    const { text, paste } = input;
    if (typeof text !== 'string' || paste !== undefined && typeof paste !== 'boolean') throw new Error('Invalid native panel input.');
    if (!text) throw new Error('Native panel text is empty.');
    if (text.length > MAX_NATIVE_PANEL_TEXT) throw new Error('Native panel text is too long.');
    if (!text.isWellFormed()) throw new Error('Native panel text is not valid Unicode.');
    if (!paste) {
      if (TYPED_CONTROL.test(text)) throw new Error('Typed text cannot contain control characters.');
      return text;
    }
    if (PASTED_CONTROL.test(text)) throw new Error('Pasted text can contain only newlines and tabs as control characters.');
    const normalized = text.replace(/\r\n?|\n/g, '\r');
    if (context.bracketedPaste) return `\x1b[200~${normalized}\x1b[201~`;
    if (normalized.includes('\r')) throw new Error('Multi-line paste needs bracketed paste.');
    if (normalized.includes('\t')) throw new Error('Pasting a tab needs bracketed paste.');
    return normalized;
  }
  if (!context.mouse) throw new Error('This native panel does not read the mouse.');
  const { action, row, column } = input;
  if (typeof action !== 'string' || !MOUSE_ACTIONS.has(action)) throw new Error('Unknown native panel mouse action.');
  if (!Number.isSafeInteger(context.firstRow) || context.firstRow < 0 || !cell(row, context.rowCount) || !cell(column, context.columns)) throw new Error('Mouse position is outside the native panel.');
  const position = `${column + 1};${context.firstRow + row + 1}`;
  return action === 'click' ? `\x1b[<0;${position}M\x1b[<0;${position}m` : `\x1b[<${action === 'wheel-up' ? 64 : 65};${position}M`;
}
