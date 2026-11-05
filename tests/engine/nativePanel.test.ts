import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_NATIVE_PANEL_TEXT, NATIVE_PANEL_CTRL_LETTERS, type NativePanel, type NativePanelRow } from '@shared/types';
import { cellWidth, glyphWidth, splitGraphemes } from '@shared/terminalWidth';
import { detectNativePanel, encodeNativePanelInput, nativePanelPayload, type NativePanelInputContext } from '../../src/main/native/panel';
import { NativeTerminalScreen } from '../../src/main/native/terminalScreen';

// Terminal output of the official CLI 2.1.308 on a 140x48 ConPTY in the isolated fixture (synthetic HOME, fake key,
// loopback provider), captured by the maintainers' panel survey: X.open.ansi from dispatching /X until its
// dialog was drawn, X.esc0/esc1.ansi after each Esc, X.open.txt the projection recorded at that moment.
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'native-panel', name), 'utf8');
const replay = (...names: string[]): NativeTerminalScreen => {
  const screen = new NativeTerminalScreen(140, 48);
  for (const name of names) screen.write(fixture(name));
  return screen;
};
const mirror = (screen: NativeTerminalScreen, command?: string): NativePanel => {
  const region = detectNativePanel(screen);
  if (!region) throw new Error('no panel');
  return nativePanelPayload(screen, region, 1, command);
};
const rowText = (row: NativePanelRow): string => row.runs.map(({ text }) => text).join('');
const rowOf = (panel: NativePanel, text: string): number => panel.rows.findIndex((row) => rowText(row).includes(text));
const runsOf = (panel: NativePanel, text: string) => panel.rows[rowOf(panel, text)].runs.map((run) => ({ text: run.text, style: panel.styles[run.s] }));
// Cell columns the renderer computes: every run split on its own, each grapheme glyphWidth cells wide.
const grid = (row: NativePanelRow): [string, number][] => {
  const cells: [string, number][] = [];
  let column = 0;
  for (const run of row.runs) for (const grapheme of splitGraphemes(run.text)) { cells.push([grapheme, column]); column += glyphWidth(grapheme); }
  return cells;
};
const columnOf = (row: NativePanelRow, text: string): number => {
  const cells = grid(row), graphemes = cells.map(([grapheme]) => grapheme);
  const index = graphemes.findIndex((_, start) => graphemes.slice(start).join('').startsWith(text));
  return index < 0 ? -1 : cells[index][1];
};
const contextOf = (screen: NativeTerminalScreen, panel: NativePanel): NativePanelInputContext => ({
  mouse: panel.mouse, bracketedPaste: screen.bracketedPaste, firstRow: detectNativePanel(screen)!.firstRow, rowCount: panel.rows.length, columns: panel.columns,
});

const PANELS = [
  ['config', 2, /^Settings {2}Status {3}Config {3}Usage {3}Stats$/, /^Type to filter \u00b7 Enter\/\u2193 to select \u00b7 \u2191 to tabs \u00b7 Esc to clear$/],
  ['effort', 39, /^Effort$/, /s for this session only \u00b7 Esc to cancel$/],
  ['permissions', 37, /^Permissions {2}Recently denied {3}Allow /, /^\u2190\/\u2192 to switch \u00b7 \u2193 to select \u00b7 Esc to cancel$/],
  ['model', 35, /^Select model$/, /^Enter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel$/],
  ['help', 28, /^Help {2}General {3}Commands {3}Custom commands/, /^Esc to cancel$/],
  ['tasks', 42, /^Background/, /^\u2191\/\u2193 to select \u00b7 Enter to view \u00b7 Esc to close$/],
] as const;

describe('native panel detection on CLI 2.1.308 captures', () => {
  it.each(PANELS)('detects the docked /%s dialog and mirrors the rows the CLI drew', (name, borderRow, first, last) => {
    const screen = replay(`${name}.open.ansi`);
    const region = detectNativePanel(screen);
    expect(region).toEqual({ borderRow, firstRow: borderRow + 1, lastRow: 47 });
    const lines = screen.lineTexts();
    expect(lines[borderRow]).toMatch(/^\u2594{40,} \u25c9 xhigh \u00b7 \/effort \u2594$/);
    expect(lines[borderRow + 1].trim()).toMatch(first);
    expect(lines[47].trim()).toMatch(last);
    const panel = nativePanelPayload(screen, region!, 3, name);
    expect(panel).toMatchObject({ revision: 3, command: name, columns: 140, mouse: false });
    const recorded = fixture(`${name}.open.txt`).split('\n');
    expect(panel.rows.map((row) => rowText(row).trimEnd())).toEqual(recorded.slice(recorded.findLastIndex((line) => /^\u2594{40}/.test(line)) + 1));
    const used = new Set(panel.rows.flatMap((row) => row.runs.map((run) => run.s)));
    expect([...used].sort((a, b) => a - b)).toEqual(panel.styles.map((_, index) => index));
    expect(new Set(panel.styles.map((style) => JSON.stringify(style))).size).toBe(panel.styles.length);
    for (const row of panel.rows) {
      expect(row.runs.every((run) => run.text.length > 0)).toBe(true);
      expect(row.runs.reduce((cells, run) => cells + cellWidth(run.text), 0)).toBeLessThanOrEqual(140);
    }
    expect(JSON.parse(JSON.stringify(panel))).toEqual(panel);
  });

  it.each(['effort', 'permissions', 'model', 'help', 'tasks'])('finds no dialog once Esc closed /%s', (name) => {
    expect(detectNativePanel(replay(`${name}.open.ansi`, `${name}.esc0.ansi`))).toBeUndefined();
  });

  it('finds no dialog on the idle composer', () => {
    const screen = new NativeTerminalScreen(140, 48);
    screen.write(fixture('idle.txt').split('\n').join('\r\n'));
    expect(screen.lineTexts().filter((line) => /^\u2500{40}/.test(line))).toHaveLength(2);
    expect(detectNativePanel(screen)).toBeUndefined();
  });

  it('mirrors the /config tab colors and search cursor, and keeps the startup mouse mode after the first Esc', () => {
    const stream = fixture('config.open.ansi');
    const firstFrame = new NativeTerminalScreen(140, 48);
    firstFrame.write(stream.slice(0, stream.indexOf('\u2733 Claude Code')));
    const early = mirror(firstFrame, 'config');
    expect(runsOf(early, 'Settings')).toEqual([{ text: '   ', style: {} }, { text: 'Settings', style: { fg: '#b1b9f9', bold: true } },
      { text: '  Status  ', style: {} }, { text: ' Config ', style: { fg: '#000000', bg: '#b1b9f9', bold: true } }, { text: '  Usage   Stats', style: {} }]);

    const screen = replay('startup.ansi', 'config.open.ansi');
    const panel = mirror(screen, 'config');
    expect(runsOf(panel, 'Settings')).toContainEqual({ text: ' Config ', style: { bold: true, inverse: true } });
    expect(runsOf(panel, 'Search settings').slice(1, 6)).toEqual([{ text: '\u2502', style: { fg: '#b1b9f9' } }, { text: ' \u2315 ', style: {} },
      { text: 'S', style: { inverse: true } }, { text: 'earch settings\u2026', style: { fg: '#999999' } }, { text: ' '.repeat(113), style: {} }]);
    // The CLI turns SGR mouse tracking and bracketed paste on once at startup; dialogs never switch them.
    expect([screen.mouse, screen.bracketedPaste, panel.mouse]).toEqual([true, true, true]);
    const alone = replay('config.open.ansi');
    expect([alone.mouse, alone.bracketedPaste, mirror(alone).mouse]).toEqual([false, false, false]);

    const focused = replay('startup.ansi', 'config.open.ansi', 'config.esc0.ansi');
    const list = mirror(focused, 'config');
    expect([focused.mouse, focused.bracketedPaste, list.mouse]).toEqual([true, true, true]);
    expect(rowText(list.rows.at(-1)!).trim()).toBe('Enter/Space to change \u00b7 / to search \u00b7 Esc to close');
    expect(runsOf(list, 'Search settings').find((run) => run.text.includes('S'))?.style).toEqual({ fg: '#999999' });
    expect(detectNativePanel(replay('config.open.ansi', 'config.esc0.ansi', 'config.esc1.ansi'))).toBeUndefined();
  });

  it('encodes a click on a mirrored tab at the screen cell the CLI drew it in', () => {
    const screen = replay('startup.ansi', 'config.open.ansi', 'config.esc0.ansi');
    const panel = mirror(screen);
    const row = rowOf(panel, 'Settings'), column = columnOf(panel.rows[row], 'Usage');
    const click = encodeNativePanelInput({ kind: 'mouse', action: 'click', row, column }, contextOf(screen, panel));
    const [, x, y] = /^\x1b\[<0;(\d+);(\d+)M\x1b\[<0;\1;\2m$/.exec(click)!.map(Number);
    expect(screen.lineTexts()[y - 1].slice(x - 1)).toMatch(/^Usage {3}Stats$/);
    expect([x, y]).toEqual([column + 1, detectNativePanel(screen)!.firstRow + row + 1]);
  });

  it('keeps background-color erases the CLI uses for bars and diff rows', () => {
    const powerup = mirror(replay('powerup.open.ansi'), 'powerup');
    expect(runsOf(powerup, '0/10 unlocked')).toContainEqual({ text: ' '.repeat(16), style: { bg: '#999999' } });
    const theme = mirror(replay('theme.open.ansi'), 'theme');
    const removed = runsOf(theme, 'console.log("Hello, World!");');
    // The preview is indented three cells and its row ends with ECH (CSI 99 X) in the row's background.
    expect(removed.at(-1)).toEqual({ text: ' '.repeat(99), style: { bg: '#3d0100' } });
    expect(removed.reduce((cells, run) => cells + cellWidth(run.text), 0)).toBe(137);
  });
});

describe('native panel geometry', () => {
  const detect = (input: string) => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write(input);
    return detectNativePanel(screen);
  };
  const border = '\u2594'.repeat(40);

  it('needs a full border at column 0 and visible content below it, and takes the last border', () => {
    expect(detect(`\x1b[10;1H${border}`)).toBeUndefined();
    expect(detect(`\x1b[5;1H${border}\x1b[6;1H\x1b[44m\x1b[K\x1b[m`)).toBeUndefined();
    expect(detect(`\x1b[5;1H${'\u2594'.repeat(39)}\x1b[6;1Hx`)).toBeUndefined();
    expect(detect(`\x1b[5;2H${'\u2594'.repeat(39)}\x1b[6;1Hx`)).toBeUndefined();
    expect(detect(`\x1b[2;1H${'\u2500'.repeat(40)}\x1b[3;1H> x\x1b[4;1H${'\u2500'.repeat(40)}\x1b[5;1Hfooter`)).toBeUndefined();
    expect(detect(`\x1b[2;1H${border}\x1b[3;1Hold\x1b[6;1H${border}\x1b[8;1Hnew\x1b[10;1Hhint`)).toEqual({ borderRow: 5, firstRow: 6, lastRow: 9 });
  });

  it('keeps wide, emoji and separately drawn glyphs on the CLI cell grid', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write(`\x1b[?1000;1006h\x1b[7;1H${border}\x1b[8;1H\x1b[1m\u4e2d\u6587\x1b[0m A\u{1f600}\u{1f1fa}\u{1f1f8} e\u0301 \u2764\ufe0f>` +
      '\x1b[9;1H\x1b[31m\u{1f1fa}\x1b[9;3H\u{1f1f8}\x1b[9;5H\u4e2d\x1b[m|');
    const region = detectNativePanel(screen)!;
    expect(region).toEqual({ borderRow: 6, firstRow: 7, lastRow: 8 });
    const panel = nativePanelPayload(screen, region, 4);
    expect(panel.rows[0].runs).toEqual([{ text: '\u4e2d\u6587', s: 0 }, { text: ' A\u{1f600}\u{1f1fa}\u{1f1f8} e\u0301 \u2764\ufe0f>', s: 1 }]);
    expect(panel.styles).toEqual([{ bold: true }, {}, { fg: '#cd0000' }]);
    expect(grid(panel.rows[0])).toEqual([['\u4e2d', 0], ['\u6587', 2], [' ', 4], ['A', 5], ['\u{1f600}', 6], ['\u{1f1fa}\u{1f1f8}', 8], [' ', 10],
      ['e\u0301', 11], [' ', 12], ['\u2764\ufe0f', 13], ['>', 15]]);
    expect(grid(panel.rows[1])).toEqual([['\u{1f1fa}', 0], ['\u{1f1f8}', 2], ['\u4e2d', 4], ['|', 6]]);
    expect(panel.rows.map((row) => row.runs.reduce((cells, run) => cells + cellWidth(run.text), 0))).toEqual([16, 7]);
    expect(encodeNativePanelInput({ kind: 'mouse', action: 'click', row: 0, column: 15 }, contextOf(screen, panel))).toBe('\x1b[<0;16;8M\x1b[<0;16;8m');
    expect(screen.lineTexts()[7]).toBe('\u4e2d\u6587 A\u{1f600}\u{1f1fa}\u{1f1f8} e\u0301 \u2764\ufe0f>');
  });

  it('validates the region and revision and carries the command only when given', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write(`\x1b[2;1H${border}\x1b[3;1Hbody`);
    const region = detectNativePanel(screen)!;
    for (const bad of [{ ...region, firstRow: -1 }, { ...region, lastRow: 1 }, { ...region, lastRow: 10 }, { ...region, firstRow: 1.5 }]) {
      expect(() => nativePanelPayload(screen, bad, 1)).toThrow('Invalid native panel region.');
    }
    for (const revision of [-1, 1.5, NaN]) expect(() => nativePanelPayload(screen, region, revision)).toThrow('Invalid native panel revision.');
    expect('command' in nativePanelPayload(screen, region, 0)).toBe(false);
    expect(nativePanelPayload(screen, region, 0, 'help')).toEqual({ revision: 0, command: 'help', columns: 40, rows: [{ runs: [{ text: 'body', s: 0 }] }], styles: [{}], mouse: false });
  });
});

describe('native panel input encoding', () => {
  const context: NativePanelInputContext = { mouse: true, bracketedPaste: true, firstRow: 37, rowCount: 11, columns: 140 };
  const encode = (input: unknown, at: NativePanelInputContext = context) => encodeNativePanelInput(input, at);

  it.each([
    ['up', '\x1b[A'], ['down', '\x1b[B'], ['right', '\x1b[C'], ['left', '\x1b[D'], ['enter', '\r'], ['escape', '\x1b'], ['tab', '\t'],
    ['shift-tab', '\x1b[Z'], ['backspace', '\x7f'], ['delete', '\x1b[3~'], ['home', '\x1b[H'], ['end', '\x1b[F'], ['pageup', '\x1b[5~'],
    ['pagedown', '\x1b[6~'], ['space', ' '],
  ])('encodes the %s key', (key, bytes) => {
    expect(encode({ kind: 'key', key })).toBe(bytes);
  });

  it('rejects keys outside the panel set', () => {
    for (const key of ['F1', 'Up', 'ctrl-c', 'constructor', 'toString', '__proto__', '', 1, null, undefined]) {
      expect(() => encode({ kind: 'key', key })).toThrow('Unknown native panel key.');
    }
  });

  it('encodes only the allowed Ctrl letters', () => {
    expect(NATIVE_PANEL_CTRL_LETTERS.map((letter) => encode({ kind: 'ctrl', letter }))).toEqual(['\x01', '\x02', '\x05', '\x06', '\x0b', '\x0e', '\x10', '\x12', '\x15', '\x17', '\x19']);
    for (const letter of ['c', 'd', 'z', 'A', 'B', 'ab', '', '\x01', 1, undefined]) {
      expect(() => encode({ kind: 'ctrl', letter })).toThrow('Unsupported Ctrl letter.');
    }
  });

  it('sends typed text as typed and refuses control characters in it', () => {
    expect(encode({ kind: 'text', text: 'model \u4e2d\u6587 e\u0301 \u{1f600}' })).toBe('model \u4e2d\u6587 e\u0301 \u{1f600}');
    expect(encode({ kind: 'text', text: 'x', paste: false })).toBe('x');
    expect(encode({ kind: 'text', text: 'a'.repeat(MAX_NATIVE_PANEL_TEXT) })).toHaveLength(MAX_NATIVE_PANEL_TEXT);
    for (const text of ['\x1b[A', 'a\x7f', 'a\x9b2J', 'a\x85', 'a\nb', 'a\rb', 'a\tb', '\x00', '\x03']) {
      expect(() => encode({ kind: 'text', text })).toThrow('Typed text cannot contain control characters.');
    }
    expect(() => encode({ kind: 'text', text: '' })).toThrow('Native panel text is empty.');
    expect(() => encode({ kind: 'text', text: 'a'.repeat(MAX_NATIVE_PANEL_TEXT + 1), paste: true })).toThrow('Native panel text is too long.');
    expect(() => encode({ kind: 'text', text: 'a\ud800' })).toThrow('Native panel text is not valid Unicode.');
    expect(() => encode({ kind: 'text', text: '\udc00b', paste: true })).toThrow('Native panel text is not valid Unicode.');
    for (const input of [{ kind: 'text' }, { kind: 'text', text: 1 }, { kind: 'text', text: 'a', paste: 'yes' }, { kind: 'text', text: 'a', paste: null }]) {
      expect(() => encode(input)).toThrow('Invalid native panel input.');
    }
  });

  it('wraps a paste in bracketed paste with carriage-return newlines', () => {
    expect(encode({ kind: 'text', text: 'one\r\ntwo\nthree\rfour\tfive', paste: true })).toBe('\x1b[200~one\rtwo\rthree\rfour\tfive\x1b[201~');
    expect(encode({ kind: 'text', text: '\n', paste: true })).toBe('\x1b[200~\r\x1b[201~');
    expect(encode({ kind: 'text', text: 'single', paste: true })).toBe('\x1b[200~single\x1b[201~');
    for (const text of ['a\x1b[201~b', 'a\x1bb', 'a\x7f', 'a\x9b', 'a\x00', 'a\x0b', 'a\x0c', 'a\x08']) {
      expect(() => encode({ kind: 'text', text, paste: true })).toThrow('Pasted text can contain only newlines and tabs as control characters.');
    }
  });

  it('sends a single-line paste as typed text when the CLI has no bracketed paste', () => {
    const plain = { ...context, bracketedPaste: false };
    expect(encode({ kind: 'text', text: 'path/to file', paste: true }, plain)).toBe('path/to file');
    expect(() => encode({ kind: 'text', text: 'a\nb', paste: true }, plain)).toThrow('Multi-line paste needs bracketed paste.');
    expect(() => encode({ kind: 'text', text: 'a\r\n', paste: true }, plain)).toThrow('Multi-line paste needs bracketed paste.');
    expect(() => encode({ kind: 'text', text: 'a\tb', paste: true }, plain)).toThrow('Pasting a tab needs bracketed paste.');
    expect(() => encode({ kind: 'text', text: 'a\x1bb', paste: true }, plain)).toThrow('Pasted text can contain only newlines and tabs as control characters.');
  });

  it('encodes SGR clicks and wheel steps at absolute screen cells', () => {
    expect(encode({ kind: 'mouse', action: 'click', row: 0, column: 0 })).toBe('\x1b[<0;1;38M\x1b[<0;1;38m');
    expect(encode({ kind: 'mouse', action: 'click', row: 10, column: 139 })).toBe('\x1b[<0;140;48M\x1b[<0;140;48m');
    expect(encode({ kind: 'mouse', action: 'wheel-up', row: 3, column: 19 })).toBe('\x1b[<64;20;41M');
    expect(encode({ kind: 'mouse', action: 'wheel-down', row: 3, column: 19 })).toBe('\x1b[<65;20;41M');
  });

  it('rejects mouse input the panel cannot take', () => {
    expect(() => encode({ kind: 'mouse', action: 'click', row: 0, column: 0 }, { ...context, mouse: false })).toThrow('This native panel does not read the mouse.');
    for (const [row, column] of [[-1, 0], [11, 0], [0, 140], [0, -1], [0.5, 0], [0, 1.5], [NaN, 0], [Infinity, 0], ['1', 0], [null, 0], [undefined, 0]]) {
      expect(() => encode({ kind: 'mouse', action: 'click', row, column })).toThrow('Mouse position is outside the native panel.');
    }
    expect(() => encode({ kind: 'mouse', action: 'click', row: 0, column: 0 }, { ...context, firstRow: -1 })).toThrow('Mouse position is outside the native panel.');
    for (const action of ['double-click', 'press', 'Click', '', undefined, 1]) {
      expect(() => encode({ kind: 'mouse', action, row: 0, column: 0 })).toThrow('Unknown native panel mouse action.');
    }
  });

  it('rejects malformed inputs and extra fields', () => {
    for (const input of [null, undefined, 'up', 1, [], [{ kind: 'key', key: 'up' }], {}, { kind: 'paste', text: 'a' }, { kind: 'KEY', key: 'up' },
      { kind: 'constructor' }, { kind: 'key', key: 'up', bytes: '\x03' }, { kind: 'text', text: 'a', raw: true },
      { kind: 'mouse', action: 'click', row: 0, column: 0, button: 2 }]) {
      expect(() => encode(input)).toThrow('Invalid native panel input.');
    }
  });
});
