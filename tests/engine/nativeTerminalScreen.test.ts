import { describe, expect, it, vi } from 'vitest';
import type { NativePanelStyle } from '@shared/types';
import { cellWidth, glyphWidth, splitGraphemes } from '@shared/terminalWidth';
import { NativeTerminalScreen } from '../../src/main/native/terminalScreen';

const project = (input: string): string => {
  const screen = new NativeTerminalScreen(40, 10);
  screen.write(input);
  return screen.text();
};
const effortRedraw = '\u4e2d'.repeat(20) + 'Enter to confirm' + '\r\x1b[A\x1b[2K' +
  'Effort\r\n\x1b[B' + 's for this session only \u00b7 Esc to cancel';

describe('native terminal cell projection', () => {
  it('preserves the confirmation row when CJK output wraps before a cursor redraw', () => {
    expect(project(effortRedraw)).toBe('Effort\nEnter to confirm\ns for this session only \u00b7 Esc to cancel');
  });

  it('preserves public geometry and rejects invalid dimensions', () => {
    const screen = new NativeTerminalScreen();
    expect([screen.columns, screen.rows, screen.revision, screen.text()]).toEqual([120, 40, 0, '']);
    for (const [columns, rows] of [[39, 10], [501, 10], [40.5, 10], [40, 9], [40, 201], [40, NaN]]) {
      expect(() => new NativeTerminalScreen(columns, rows)).toThrow('Invalid native screen size.');
    }
  });

  it.each([
    ['carriage return and erase suffix', 'old tail\rnew\x1b[K', 'new'],
    ['backspace and tab', 'A\tB\bC', 'A       C'],
    ['line feed retains column', 'abc\nx', 'abc\n   x'],
    ['relative cursor', 'start\r\n123456\r\nend\x1b[A\x1b[2DX\x1b[2C!', 'start\n1X34!6\nend'],
    ['next and previous line', 'first\r\nsecond\x1b[F1\x1b[2E3', '1irst\nsecond\n3'],
    ['absolute cursor', 'abcd\x1b[2GZ\x1b[3dQ\x1b[2;4HR\x1b[4;2fS', 'aZcd\n   R\n  Q\n S'],
    ['CSI save and restore', 'abc\x1b[s\x1b[2;1Hrow\x1b[uX', 'abcX\nrow'],
    ['ESC save and restore', 'abc\x1b7\x1b[2;1Hrow\x1b8X', 'abcX\nrow'],
    ['erase display suffix', 'first\r\nsecond\r\nthird\x1b[2;3H\x1b[J', 'first\nse'],
    ['erase display prefix', 'first\r\nsecond\r\nthird\x1b[2;3H\x1b[1J', 'ond\nthird'],
    ['erase display without cursor reset', 'old\x1b[2;3H\x1b[2JX\x1b[HY', 'Y\n  X'],
    ['erase display and scrollback request', 'old\x1b[3J\x1b[Hnew', 'new'],
    ['erase line prefix', '|\r\nabcdef\x1b[3G\x1b[1K', '|\n   def'],
    ['erase complete line', 'old\r\x1b[2Knew', 'new'],
    ['erase characters', 'abcdef\x1b[3G\x1b[2X', 'ab  ef'],
    ['delete characters', 'abcdef\x1b[3G\x1b[2P', 'abef'],
    ['insert characters', 'abcdef\x1b[3G\x1b[2@', 'ab  cdef'],
    ['insert line', 'one\r\ntwo\r\nthree\x1b[2;1H\x1b[Lnew', 'one\nnew\ntwo\nthree'],
    ['delete line', 'one\r\ntwo\r\nthree\x1b[2;1H\x1b[M', 'one\nthree'],
    ['scroll', 'one\r\ntwo\r\nthree\x1b[S', 'two\nthree'],
    ['large scroll count', 'old\x1b[999999999S', ''],
    ['alternate screen 1049', 'old\x1b[?1049hnew\x1b[?1049l', 'new'],
    ['alternate screen 1047', 'old\x1b[?1047hnew\x1b[?1047l', 'new'],
    ['attributes and visibility', '\x1b[31mred\x1b[0m\x1b[?25l\x1b[?25h', 'red'],
    ['OSC BEL and ST', 'A\x1b]0;hidden\x07B\x1b]8;;hidden\x1b\\C', 'ABC'],
    ['deferred ASCII wrapping', 'a'.repeat(40) + 'B', 'a'.repeat(40) + '\nB'],
    ['bottom scrolling', Array.from({ length: 11 }, (_, index) => String(index)).join('\r\n'), Array.from({ length: 10 }, (_, index) => String(index + 1)).join('\n')],
  ])('preserves ASCII projection: %s', (_name, input, expected) => {
    expect(project(input)).toBe(expected);
  });

  it.each([
    ['CJK', '\u4e2d'], ['fullwidth Latin', '\uff21'], ['Hangul', '\ud55c'], ['Kana', '\u30ab'],
    ['supplementary Han', '\u{20000}'], ['combining CJK', '\u4e2d\u0301'],
    ['emoji', '\u{1f600}'], ['emoji variation', '\u2764\ufe0f'],
    ['modifier', '\u{1f44d}\u{1f3fd}'], ['ZWJ', '\u{1f469}\u200d\u{1f4bb}'],
    ['family ZWJ', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'],
    ['flag', '\u{1f1fa}\u{1f1f8}'], ['keycap', '1\ufe0f\u20e3'],
  ])('uses two terminal cells for %s', (_name, glyph) => {
    expect(project(`A${glyph}B\x1b[4GZ`)).toBe(`A${glyph}Z`);
    expect(project('a'.repeat(39) + glyph + 'Z')).toBe('a'.repeat(39) + '\n' + glyph + 'Z');
  });

  it.each([
    ['combining Latin', 'e\u0301'], ['several combining marks', 'a\u0308\u0301'],
    ['text variation', '\u263a\ufe0e'], ['text heart', '\u2764'], ['ambiguous middle dot', '\u00b7'],
    ['halfwidth Kana', '\uff76'], ['ZWJ without emoji', 'A\u200d'],
  ])('keeps %s in one cell', (_name, glyph) => {
    expect(project(`A${glyph}B\x1b[3GZ`)).toBe(`A${glyph}Z`);
    expect(project('a'.repeat(39) + glyph + 'Z')).toBe('a'.repeat(39) + glyph + '\nZ');
  });

  it('uses one glyph for a regional-indicator pair but starts a new glyph for the third', () => {
    const flag = '\u{1f1fa}\u{1f1f8}', third = '\u{1f1e8}';
    expect(project(`A${flag}${third}B\x1b[6GZ`)).toBe(`A${flag}${third}Z`);
  });

  it('attaches marks through attribute-only traffic without wrapping a full row', () => {
    expect(project('a'.repeat(39) + 'e\x1b[31m\u0301\x1b[0mZ')).toBe('a'.repeat(39) + 'e\u0301\nZ');
    expect(project('\u0301\u200bA')).toBe('A');
  });

  it.each([
    ['overwrite lead', 'A\u4e2dB\x1b[2GZ', 'AZ B'],
    ['overwrite continuation', 'A\u4e2dB\x1b[3GZ', 'A ZB'],
    ['wide overwrite overlaps two glyphs', 'A\u4e2d\u65e5B\x1b[3G\u8a9e', 'A \u8a9e B'],
    ['erase lead', 'A\u4e2dB\x1b[2G\x1b[X', 'A  B'],
    ['erase continuation', 'A\u4e2dB\x1b[3G\x1b[X', 'A  B'],
    ['erase suffix through continuation', 'A\u4e2dB\x1b[3G\x1b[K', 'A'],
    ['erase prefix through lead', '|\r\nA\u4e2dB\x1b[2G\x1b[1K', '|\n   B'],
    ['erase display through continuation', '|\r\nA\u4e2dB\r\nold\x1b[2;3H\x1b[J', '|\nA'],
    ['erase display prefix through lead', 'old\r\nA\u4e2dB\r\nend\x1b[2;2H\x1b[1J', 'B\nend'],
    ['insert at lead', 'A\u4e2dB\x1b[2G\x1b[@', 'A \u4e2dB'],
    ['insert through continuation', 'A\u4e2dB\x1b[3G\x1b[@', 'A   B'],
    ['delete lead', 'A\u4e2dB\x1b[2G\x1b[P', 'A B'],
    ['delete continuation', 'A\u4e2dB\x1b[3G\x1b[P', 'A B'],
    ['delete across two glyph halves', 'A\u4e2d\u65e5B\x1b[3G\x1b[2P', 'A  B'],
    ['delete before intact glyph', 'A\u4e2dB\x1b[1G\x1b[P', '\u4e2dB'],
    ['insert clips right edge', '|\r\n' + 'a'.repeat(38) + '\u4e2d\x1b[1G\x1b[@', '|\n ' + 'a'.repeat(38)],
    ['wide right-edge deferred wrap', 'a'.repeat(38) + '\u4e2dZ', 'a'.repeat(38) + '\u4e2d\nZ'],
    ['scroll keeps complete glyphs', '\u4e2d\r\n\u65e5\r\nend\x1b[S', '\u65e5\nend'],
    ['insert/delete lines keep complete glyphs', 'top\r\n\u4e2d\r\n\u65e5\x1b[2;1H\x1b[L\x1b[3;1H\x1b[M', 'top\n\n\u65e5'],
  ])('does not retain a partial wide glyph: %s', (_name, input, expected) => {
    expect(project(input)).toBe(expected);
  });

  it.each([
    ['erase characters', '\x1b[X'], ['delete characters', '\x1b[P'], ['insert characters', '\x1b[@'],
  ])('starts %s at the physical last column after deferred wrap', (_name, operation) => {
    expect(project('a'.repeat(38) + '\u4e2d' + operation)).toBe('a'.repeat(38));
    expect(project('a'.repeat(38) + '\u4e2d' + operation + 'Z')).toBe('a'.repeat(38) + ' Z');
    expect(project('a'.repeat(39) + 'X' + operation)).toBe('a'.repeat(39));
  });

  it.each([
    ['line', '\x1b[K'], ['display', '\x1b[J'],
  ])('keeps erase-%s end-of-line semantics distinct from character edits', (_name, operation) => {
    const full = 'a'.repeat(38) + '\u4e2d';
    expect(project(full + operation)).toBe(full);
    expect(project(full + '\x1b[40G' + operation)).toBe('a'.repeat(38));
  });

  it.each([
    ['up', 'top\r\n' + 'a'.repeat(40) + '\x1b[AZ', 'top' + ' '.repeat(36) + 'Z\n' + 'a'.repeat(40)],
    ['down', 'a'.repeat(40) + '\x1b[BZ', 'a'.repeat(40) + '\n' + ' '.repeat(39) + 'Z'],
    ['right', 'a'.repeat(40) + '\x1b[CZ', 'a'.repeat(39) + 'Z'],
    ['left', 'a'.repeat(40) + '\x1b[DZ', 'a'.repeat(38) + 'Za'],
    ['left two', 'a'.repeat(40) + '\x1b[2DZ', 'a'.repeat(37) + 'Zaa'],
  ])('applies relative %s from the physical column before its delta', (_name, input, expected) => {
    expect(project(input)).toBe(expected);
  });

  it.each(['a'.repeat(40), 'a'.repeat(38) + '\u4e2d'])('feeds a full line once without a second implicit wrap: %s', (full) => {
    expect(project(full + '\nZ')).toBe(full + '\n' + ' '.repeat(39) + 'Z');
    expect(project(full + '\nZY')).toBe(full + '\n' + ' '.repeat(39) + 'Z\nY');
  });

  it('scrolls exactly once for line feed from a full bottom row', () => {
    const initial = Array.from({ length: 10 }, (_, index) => String(index));
    const full = 'a'.repeat(38) + '\u4e2d';
    expect(project(initial.join('\r\n') + '\x1b[10;1H' + full + '\nZ'))
      .toBe(initial.slice(1, 9).join('\n') + '\n' + full + '\n' + ' '.repeat(39) + 'Z');
  });

  it.each([['CSI', '\x1b[s', '\x1b[u'], ['ESC', '\x1b7', '\x1b8']])('preserves %s saved deferred-wrap position', (_name, save, restore) => {
    expect(project('a'.repeat(40) + save + '\x1b[H!' + restore + 'Z')).toBe('!' + 'a'.repeat(39) + '\nZ');
  });

  it('repairs a late width increase at the last column', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('a'.repeat(39) + '\u2764');
    expect(screen.text()).toBe('a'.repeat(39) + '\u2764');
    screen.write('\ufe0fZ');
    expect(screen.text()).toBe('a'.repeat(39) + '\n\u2764\ufe0fZ');
  });

  it('restores overwritten cells when a late text selector reverses a tentative wrap', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('top\r\nXYZ\x1b[1;40H\u{1f600}');
    expect(screen.text()).toBe('top\n\u{1f600}Z');
    screen.write('\ufe0e');
    expect(screen.text()).toBe('top' + ' '.repeat(36) + '\u{1f600}\ufe0e\nXYZ');
  });

  it('repairs late width changes at the bottom edge without losing an extra row', () => {
    const initial = Array.from({ length: 10 }, (_, index) => String(index));
    const screen = new NativeTerminalScreen(40, 10);
    screen.write(initial.join('\r\n') + '\x1b[10;40H\u{1f600}');
    expect(screen.text()).toBe(initial.slice(1).join('\n') + '\n\u{1f600}');
    screen.write('\ufe0e');
    expect(screen.text()).toBe(initial.join('\n') + ' '.repeat(38) + '\u{1f600}\ufe0e');
    screen.write('Z');
    expect(screen.text()).toBe(initial.slice(1).join('\n') + ' '.repeat(38) + '\u{1f600}\ufe0e\nZ');
  });

  const chunkStreams = [
    effortRedraw,
    'a'.repeat(39) + '\u2764\ufe0f\r\nA\u{1f469}\u{1f3fd}\u200d\u{1f4bb}B\x1b[4GZ',
    'e\u0301 \u{1f1fa}\u{1f1f8}\u{1f1e8} 1\ufe0f\u20e3\x1b]0;hidden\x1b\\\x1b[2K\rnew',
    Array.from({ length: 10 }, (_, index) => String(index)).join('\r\n') + '\x1b[10;40H\u{1f600}\ufe0eZ',
    'a\ud800b\udc00c\u{1f600}d',
  ];
  it.each(chunkStreams.map((stream, index) => [index, stream] as const))('is invariant under UTF-16/ANSI chunk boundaries: stream %s', (_index, stream) => {
    const expected = project(stream);
    for (let split = 0; split <= stream.length; split++) {
      const screen = new NativeTerminalScreen(40, 10);
      screen.write(stream.slice(0, split)); screen.write(''); screen.write(stream.slice(split));
      expect(screen.text(), `split ${split}`).toBe(expected);
    }
    const screen = new NativeTerminalScreen(40, 10);
    for (let index = 0; index < stream.length; index++) screen.write(stream[index]);
    expect(screen.text()).toBe(expected);
  });

  it('buffers a split surrogate and replaces malformed completed UTF-16', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\ud83d'); expect(screen.text()).toBe(''); expect(screen.revision).toBe(0);
    screen.write('\ude00'); expect(screen.text()).toBe('\u{1f600}');
    expect(project('A\ud800B\udc00C')).toBe('A\ufffdB\ufffdC');
  });

  it('does not make an identical Unicode redraw or cursor-only traffic a fresh revision', () => {
    const screen = new NativeTerminalScreen(40, 10);
    const draw = '\x1b[2J\x1b[H\u4e2d e\u0301 \u{1f469}\u200d\u{1f4bb}';
    screen.write(draw); expect(screen.revision).toBe(1);
    screen.write(draw); expect(screen.revision).toBe(1);
    screen.write('\x1b[?25l\x1b[?25h\x1b[1;1H\x1b[31m\x1b]0;title\x07'); expect(screen.revision).toBe(1);
    screen.write('Z'); expect(screen.revision).toBe(2);
  });

  it('does not invoke Unicode segmentation for long ASCII history', () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
    try {
      const screen = new NativeTerminalScreen(40, 10);
      screen.write('ASCII history\r\n'.repeat(5_000));
      expect(screen.text()).toContain('ASCII history');
      expect(segment).not.toHaveBeenCalled();
    } finally { segment.mockRestore(); }
  });

  it('bounds a pathological combining cluster while still accepting the next base', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('e' + '\u0301'.repeat(4_096));
    screen.write('\u0301'.repeat(4_096) + 'X');
    expect(screen.text()).toBe('e' + '\u0301'.repeat(255) + 'X');
    screen.write('\x1b[2GZ');
    expect(screen.text()).toBe('e' + '\u0301'.repeat(255) + 'Z');
  });
});

const styled = (screen: NativeTerminalScreen, row = 0): [string, NativePanelStyle][] =>
  screen.styledRow(row).runs.map(({ text, s }): [string, NativePanelStyle] => [text, screen.styleTable()[s]]);
const penAfter = (input: string): NativePanelStyle => {
  const screen = new NativeTerminalScreen(40, 10);
  screen.write(`${input}X`);
  const [[text, style]] = styled(screen);
  expect(text).toBe('X');
  return style;
};
const red = { fg: '#cd0000' }, blue = { bg: '#0000ee' };

describe('native terminal styles and modes', () => {
  it.each([
    ['bold', '\x1b[1m', { bold: true }],
    ['dim', '\x1b[2m', { dim: true }],
    ['italic', '\x1b[3m', { italic: true }],
    ['underline', '\x1b[4m', { underline: true }],
    ['inverse', '\x1b[7m', { inverse: true }],
    ['strike', '\x1b[9m', { strike: true }],
    ['several attributes', '\x1b[1;3;4;7;9m', { bold: true, italic: true, underline: true, inverse: true, strike: true }],
    ['22 clears bold and dim', '\x1b[1;2;3m\x1b[22m', { italic: true }],
    ['23, 24, 27 and 29', '\x1b[3;4;7;9;1m\x1b[23;24;27;29m', { bold: true }],
    ['0 resets', '\x1b[1;31;42m\x1b[0m', {}],
    ['empty parameters reset', '\x1b[1;31;42m\x1b[m', {}],
    ['an empty item resets inside a list', '\x1b[1;31m\x1b[;3m', { italic: true }],
    ['39 and 49', '\x1b[31;42m\x1b[39;49;1m', { bold: true }],
    ['base colors', '\x1b[30;47m', { fg: '#000000', bg: '#e5e5e5' }],
    ['red on green', '\x1b[31;42m', { fg: '#cd0000', bg: '#00cd00' }],
    ['bright white on gray', '\x1b[97;100m', { fg: '#ffffff', bg: '#7f7f7f' }],
    ['bright blue on red', '\x1b[94;101m', { fg: '#5c5cff', bg: '#ff0000' }],
    ['256 base indices', '\x1b[38;5;4;48;5;11m', { fg: '#0000ee', bg: '#ffff00' }],
    ['256 cube', '\x1b[38;5;196;48;5;110m', { fg: '#ff0000', bg: '#87afd7' }],
    ['256 cube corners', '\x1b[38;5;16;48;5;231m', { fg: '#000000', bg: '#ffffff' }],
    ['256 gray ramp', '\x1b[38;5;232;48;5;255m', { fg: '#080808', bg: '#eeeeee' }],
    ['truecolor', '\x1b[38;2;0;0;0m\x1b[48;2;177;185;249m\x1b[1m', { fg: '#000000', bg: '#b1b9f9', bold: true }],
    ['colon truecolor with a color space', '\x1b[38:2::255:128:0m', { fg: '#ff8000' }],
    ['colon truecolor without a color space', '\x1b[48:2:1:2:3m', { bg: '#010203' }],
    ['colon indexed color', '\x1b[38:5:21m', { fg: '#0000ff' }],
    ['colon underline style', '\x1b[4:3m', { underline: true }],
    ['colon underline off', '\x1b[4m\x1b[4:0m', {}],
    ['underline colors are consumed', '\x1b[58;2;1;3;4m\x1b[58;5;9m\x1b[58:2::1:3:4m', {}],
    ['unknown codes keep the pen', '\x1b[1m\x1b[5;6;8;21;53;73m\x1b[1:2m', { bold: true }],
    ['out-of-range colors are ignored', '\x1b[31m\x1b[38;5;256m\x1b[38;2;1;2;300m', red],
    ['truncated truecolor is ignored', '\x1b[31m\x1b[38;2;1;2m', red],
    ['an unknown color selector is skipped', '\x1b[38;7m', {}],
    ['private m sequences are not SGR', '\x1b[>4;2m\x1b[?7m\x1b[=1m', {}],
  ])('parses SGR: %s', (_name, input, expected) => {
    expect(penAfter(input)).toEqual(expected);
  });

  it('keeps each printed glyph in its own pen and interns equal styles', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\x1b[31mab\x1b[1mc\x1b[0md\x1b[31me\x1b[0m\x1b[31mf');
    expect(styled(screen)).toEqual([['ab', red], ['c', { ...red, bold: true }], ['d', {}], ['ef', red]]);
    expect(screen.text()).toBe('abcdef');
  });

  it('keeps a grapheme in the style of its first character', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('e\x1b[31m\u0301 \x1b[32m\u2764\x1b[31m\ufe0f\x1b[0mA\x1b[33m\u4e2d\x1b[0mB');
    expect(styled(screen)).toEqual([['e\u0301', {}], [' ', red], ['\u2764\ufe0f', { fg: '#00cd00' }], ['A', {}], ['\u4e2d', { fg: '#cdcd00' }], ['B', {}]]);
  });

  it('erases with the default style unless a background is set', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\x1b[1;31;4mabcdef\x1b[3G\x1b[2X\x1b[44m\x1b[6G\x1b[3X\x1b[2;1H\x1b[K\x1b[3;1H\x1b[0m\x1b[44mx\x1b[0m\x1b[3;3H\x1b[45m\x1b[4X');
    expect(styled(screen)).toEqual([['ab', { fg: '#cd0000', bold: true, underline: true }], ['  ', {}], ['e', { fg: '#cd0000', bold: true, underline: true }], ['   ', blue]]);
    expect(styled(screen, 1)).toEqual([[' '.repeat(40), blue]]);
    expect(styled(screen, 2)).toEqual([['x', blue], [' ', {}], ['    ', { bg: '#cd00cd' }]]);
    expect(screen.text()).toBe('ab  e\n\nx');
  });

  it('fills inserted, deleted and scrolled cells and lines with the current background', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('abcdef\x1b[1;2H\x1b[42m\x1b[@\x1b[1;5H\x1b[41m\x1b[2P');
    expect(styled(screen)).toEqual([['a', {}], [' ', { bg: '#00cd00' }], ['bcf' + ' '.repeat(33), {}], ['  ', { bg: '#cd0000' }]]);
    screen.write('\x1b[2;1H\x1b[43m\x1b[L\x1b[10;1H\x1b[45m\x1b[M\x1b[m\x1b[3;1Hline\x1b[46m\x1b[S\x1b[m');
    expect([0, 1, 8, 9].map((row) => styled(screen, row))).toEqual([
      [[' '.repeat(40), { bg: '#cdcd00' }]], [['line', {}]], [[' '.repeat(40), { bg: '#cd00cd' }]], [[' '.repeat(40), { bg: '#00cdcd' }]]]);
    expect(screen.text()).toBe('line');
  });

  it('trims only trailing cells that show nothing', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('a\x1b[3Cb\x1b[31m   \x1b[2;1H\x1b[0;7mx  \x1b[3;1H\x1b[0;4m  \x1b[4;1H\x1b[0;9m \x1b[5;1H\x1b[0m\u3000\x1b[6;1H\x1b[7m\u3000');
    expect(styled(screen, 0)).toEqual([['a   b', {}]]);
    expect(styled(screen, 1)).toEqual([['x  ', { inverse: true }]]);
    expect(styled(screen, 2)).toEqual([['  ', { underline: true }]]);
    expect(styled(screen, 3)).toEqual([[' ', { strike: true }]]);
    expect(styled(screen, 4)).toEqual([]);
    expect(styled(screen, 5)).toEqual([['\u3000', { inverse: true }]]);
    for (const row of [-1, 10, 1.5, NaN]) expect(() => screen.styledRow(row)).toThrow('Invalid native screen row.');
  });

  it('splits runs where a renderer would otherwise join two cells into one grapheme', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\x1b[31m\u{1f1fa}\x1b[1;3H\u{1f1f8}\x1b[2;1H\u0600\x1b[2;2Hx\x1b[3;1He\x1b[3;2H\u0301\x1b[0m');
    expect(styled(screen, 0)).toEqual([['\u{1f1fa}', red], ['\u{1f1f8}', red]]);
    expect(splitGraphemes('\u{1f1fa}\u{1f1f8}')).toEqual(['\u{1f1fa}\u{1f1f8}']);
    expect(styled(screen, 1)).toEqual([['\u0600', red], ['x', red]]);
    expect(splitGraphemes('\u0600x')).toHaveLength(1);
    expect(styled(screen, 2)).toEqual([['e', red]]);
    for (const row of [0, 1]) {
      expect(screen.styledRow(row).runs.flatMap(({ text }) => splitGraphemes(text)).map(glyphWidth)).toEqual(row ? [1, 1] : [2, 2]);
    }
  });

  it('splits and measures graphemes like the screen places them', () => {
    expect(splitGraphemes('A\u4e2de\u0301\u{1f469}\u200d\u{1f4bb}\u{1f1fa}\u{1f1f8}\u{1f1e8}1\ufe0f\u20e3\u2764\ufe0e')).toEqual(
      ['A', '\u4e2d', 'e\u0301', '\u{1f469}\u200d\u{1f4bb}', '\u{1f1fa}\u{1f1f8}', '\u{1f1e8}', '1\ufe0f\u20e3', '\u2764\ufe0e']);
    expect(['A', '\u4e2d', 'e\u0301', '\u{1f469}\u200d\u{1f4bb}', '\u{1f1fa}\u{1f1f8}', '\u{1f1e8}', '1\ufe0f\u20e3', '\u2764\ufe0e', '\u0301', '\u00b7', '\uff76'].map(glyphWidth))
      .toEqual([1, 2, 1, 2, 2, 2, 2, 1, 0, 1, 1]);
    expect(cellWidth('\u2594\u2594 \u25c9 xhigh \u00b7 /effort \u2594')).toBe(22);
    expect(cellWidth('A\u4e2d\u6587\u{1f600}B')).toBe(8);
    expect(splitGraphemes('e' + '\u0301'.repeat(300) + 'X')).toEqual(['e' + '\u0301'.repeat(255), 'X']);
    expect(splitGraphemes('')).toEqual([]);
  });

  it('counts style-only and line changes in visualRevision without a text revision', () => {
    const screen = new NativeTerminalScreen(40, 10);
    const revisions = () => [screen.revision, screen.visualRevision];
    screen.write('abc'); expect(revisions()).toEqual([1, 1]);
    screen.write('\x1b[H\x1b[31mabc'); expect(revisions()).toEqual([1, 2]);
    screen.write('\x1b[H\x1b[31mabc'); expect(revisions()).toEqual([1, 2]);
    screen.write('\x1b[?25l\x1b[5;5H\x1b[1;44m\x1b]0;title\x07\x1b[?1000;1006;2004h\x1b[m'); expect(revisions()).toEqual([1, 2]);
    screen.write('\x1b[1;5H\x1b[44m\x1b[3X'); expect(revisions()).toEqual([1, 3]);
    screen.write('\x1b[1;5H\x1b[3X'); expect(revisions()).toEqual([1, 3]);
    screen.write('\x1b[m\x1b[1;5H\x1b[3X'); expect(revisions()).toEqual([1, 4]);
    screen.write('\x1b[1;1H\x1b[45m\x1b[2K\x1b[m\x1b[2;1Hx'); expect(revisions()).toEqual([2, 5]);
    screen.write('\x1b[1;1H\x1b[M'); expect(revisions()).toEqual([2, 6]);
    expect([screen.text(), styled(screen, 0)]).toEqual(['x', [['x', {}]]]);
    screen.write('\x1b[1;1H\x1b[46m\x1b[L\x1b[m'); expect(revisions()).toEqual([2, 7]);
    expect([screen.text(), styled(screen, 0)]).toEqual(['x', [[' '.repeat(40), { bg: '#00cdcd' }]]]);
    screen.write('\x1b[S'); expect(revisions()).toEqual([2, 8]);
    screen.write('\x1b[1;1H\x1b[1m\x1b[2J'); expect(revisions()).toEqual([3, 9]);
    screen.write('\x1b[2J\x1b[H'); expect(revisions()).toEqual([3, 9]);
  });

  it('tracks SGR mouse reporting and bracketed paste modes', () => {
    const screen = new NativeTerminalScreen(40, 10);
    const modes = () => [screen.mouse, screen.bracketedPaste];
    expect(modes()).toEqual([false, false]);
    screen.write('\x1b[?1000h'); expect(modes()).toEqual([false, false]);
    screen.write('\x1b[?10'); screen.write('06h'); expect(modes()).toEqual([true, false]);
    screen.write('\x1b[?1000l'); expect(modes()).toEqual([false, false]);
    screen.write('\x1b[?1003h'); expect(modes()).toEqual([true, false]);
    screen.write('\x1b[?1003;1006l\x1b[?1002h'); expect(modes()).toEqual([false, false]);
    screen.write('\x1b[?1006;2004h'); expect(modes()).toEqual([true, true]);
    screen.write('\x1b[?1002$p\x1b[?2004$p\x1b[1002l\x1b[2004l'); expect(modes()).toEqual([true, true]);
    screen.write('\x1b[?2004l'); expect(modes()).toEqual([true, false]);
    screen.write('\x1b[?2004h\x1bc'); expect(modes()).toEqual([false, false]);
    expect([screen.revision, screen.visualRevision, screen.text()]).toEqual([0, 0, '']);
  });

  it('saves the pen with the cursor and resets it on DECSTR and RIS', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('X\x1b[31m\x1b7\x1b[0;1m\x1b[2;1HA\x1b8B\x1b[3;1H\x1b[0;3mC\x1b[32m\x1b[s\x1b[0;1;4m\x1b[uD\x1b[4;1H\x1b[1;31m\x1b[!pE\x1b[44m\x1bcF');
    expect([styled(screen, 0), styled(screen, 1), styled(screen, 2), styled(screen, 3)]).toEqual([
      [['X', {}], ['B', red]], [['A', { bold: true }]], [['C', { italic: true }], ['D', { fg: '#00cd00', italic: true }]], [['EF', {}]]]);
  });

  it('projects every row with absolute indices for panel detection', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\x1b[2;3Habc   \x1b[4;1H\u4e2dZ\x1b[5;1H\x1b[44m\x1b[K');
    const lines = screen.lineTexts();
    expect(lines).toEqual(['', '  abc', '', '\u4e2dZ', '', '', '', '', '', '']);
    expect(lines.join('\n').trim()).toBe(screen.text());
    lines[1] = 'changed';
    expect(screen.lineTexts()[1]).toBe('  abc');
  });

  it('keeps the style table bounded while every cell keeps its colors', () => {
    const screen = new NativeTerminalScreen(40, 10);
    screen.write('\x1b[38;2;1;2;3mK');
    let index = 0, before = 0;
    do {
      before = screen.styleTable().length;
      screen.write(`\x1b[1;2H\x1b[38;2;${index >> 8};${index & 255};7m\u2764`);
      index++;
    } while (screen.styleTable().length > before && index < 10_000);
    expect(index).toBeLessThan(10_000);
    expect(screen.styleTable().length).toBeLessThan(8);
    screen.write('\ufe0f\x1b[38;2;9;9;9mZ');
    const last = index - 1, color = `#${(last >> 8).toString(16).padStart(2, '0')}${(last & 255).toString(16).padStart(2, '0')}07`;
    expect(styled(screen)).toEqual([['K', { fg: '#010203' }], ['\u2764\ufe0f', { fg: color }], ['Z', { fg: '#090909' }]]);
    expect(screen.styleTable()[0]).toEqual({});
    expect(screen.text()).toBe('K\u2764\ufe0fZ');
  });

  it('parses styles identically across chunk boundaries', () => {
    const stream = '\x1b[38;2;177;185;249mA\x1b[1;7mB\x1b[38:5:196m\x1b[4:3mC\x1b[0;48;5;110m \x1b[?1006;1003h\x1b[mD';
    const whole = new NativeTerminalScreen(40, 10);
    whole.write(stream);
    const expected = styled(whole);
    expect(expected).toEqual([['A', { fg: '#b1b9f9' }], ['B', { fg: '#b1b9f9', bold: true, inverse: true }],
      ['C', { fg: '#ff0000', bold: true, inverse: true, underline: true }], [' ', { bg: '#87afd7' }], ['D', {}]]);
    for (let split = 0; split <= stream.length; split++) {
      const screen = new NativeTerminalScreen(40, 10);
      screen.write(stream.slice(0, split)); screen.write(stream.slice(split));
      expect(styled(screen), `split ${split}`).toEqual(expected);
      expect(screen.mouse, `split ${split}`).toBe(true);
    }
  });
});
