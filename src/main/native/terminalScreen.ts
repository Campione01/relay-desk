import type { NativePanelRow, NativePanelRun, NativePanelStyle } from '@shared/types';
import { continuesGrapheme, glyphWidth, MAX_GRAPHEME_UNITS, type GlyphWidth } from '@shared/terminalWidth';

type Cell = { text: string; width: 1 | 2; style: number } | null | undefined;
interface GraphemePlacement {
  text: string;
  width: GlyphWidth;
  style: number;
  beforeX: number;
  beforeY: number;
  changes: { line: Cell[]; column: number; previous: Cell }[];
  cell?: { line: Cell[]; column: number };
  scrolled?: Cell[];
}
interface Pen { readonly fg?: string; readonly bg?: string; readonly flags: number }

const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, INVERSE = 16, STRIKE = 32;
const DEFAULT_PEN: Pen = { flags: 0 };
const MOUSE_TRACKING = 1 | 2 | 4, SGR_MOUSE = 8, BRACKETED_PASTE = 16;
const PRIVATE_MODES = new Map([['1000', 1], ['1002', 2], ['1003', 4], ['1006', SGR_MOUSE], ['2004', BRACKETED_PASTE]]);
const STYLE_LIMIT = 1024;
const hex = (red: number, green: number, blue: number): string => `#${(0x1000000 | red << 16 | green << 8 | blue).toString(16).slice(1)}`;
const level = (step: number): number => step ? 55 + step * 40 : 0;
// xterm's default 16 colors, its 6x6x6 cube and its 24-step gray ramp.
const PALETTE = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  ...Array.from({ length: 216 }, (_, index) => hex(level(Math.floor(index / 36)), level(Math.floor(index / 6) % 6), level(index % 6))),
  ...Array.from({ length: 24 }, (_, index) => hex(8 + index * 10, 8 + index * 10, 8 + index * 10)),
];
const byte = (value: string | undefined): number | undefined => {
  const number = value === undefined ? NaN : Number(value || 0);
  return Number.isInteger(number) && number <= 255 ? number : undefined;
};
const indexed = (value: string | undefined): string | undefined => {
  const index = byte(value);
  return index === undefined ? undefined : PALETTE[index];
};
const rgb = (red: string | undefined, green: string | undefined, blue: string | undefined): string | undefined => {
  const r = byte(red), g = byte(green), b = byte(blue);
  return r === undefined || g === undefined || b === undefined ? undefined : hex(r, g, b);
};
const sameCell = (a: Cell, b: Cell): boolean => a === b || Boolean(a && b && a.text === b.text && a.width === b.width && a.style === b.style);

/**
 * Version-bound text and style projection, not a full terminal emulator. Cell widths and graphemes follow
 * @shared/terminalWidth. A pathological single grapheme is capped at 256 UTF-16 units. Only its latest
 * placement can be undone in memory; no terminal history or event log is kept. Erases fill with the current
 * background (xterm BCE), which ConPTY relies on for colored bars and diff rows.
 */
export class NativeTerminalScreen {
  readonly columns: number;
  readonly rows: number;
  private lines: Cell[][];
  private x = 0;
  private y = 0;
  private escape = '';
  private osc = false;
  private highSurrogate = '';
  private grapheme?: GraphemePlacement;
  private saved: { x: number; y: number; pen: Pen } = { x: 0, y: 0, pen: DEFAULT_PEN };
  private pen = DEFAULT_PEN;
  private penStyle: number | undefined = 0;
  private styles: NativePanelStyle[] = [Object.freeze({})];
  private styleKeys = ['||0'];
  private styleIds = new Map([['||0', 0]]);
  private styleLimit = STYLE_LIMIT;
  private modes = 0;
  private changed = false;
  private projection: string[] | undefined;
  private projected: string | undefined;
  private visual = 0;
  revision = 0;

  constructor(columns = 120, rows = 40) {
    if (!Number.isSafeInteger(columns) || columns < 40 || columns > 500 || !Number.isSafeInteger(rows) || rows < 10 || rows > 200) throw new Error('Invalid native screen size.');
    this.columns = columns; this.rows = rows; this.lines = this.blank();
  }

  /** Grows whenever a visible cell's text or style may have changed; `revision` follows text() only. */
  get visualRevision(): number { return this.visual; }
  /** The CLI reads SGR-encoded mouse reports. */
  get mouse(): boolean { return (this.modes & SGR_MOUSE) !== 0 && (this.modes & MOUSE_TRACKING) !== 0; }
  get bracketedPaste(): boolean { return (this.modes & BRACKETED_PASTE) !== 0; }

  private blankLine(fill: Cell = undefined): Cell[] { return Array<Cell>(this.columns).fill(fill); }
  private blank(): Cell[][] { return Array.from({ length: this.rows }, () => this.blankLine()); }

  write(data: string): void {
    const before = this.text();
    let input = this.highSurrogate + data;
    const last = input.charCodeAt(input.length - 1);
    this.highSurrogate = last >= 0xd800 && last <= 0xdbff ? input.slice(-1) : '';
    if (this.highSurrogate) input = input.slice(0, -1);
    for (let char of input) {
      if (char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff) char = '\ufffd';
      if (this.osc) {
        if (char === '\x07' || this.escape === '\x1b' && char === '\\') { this.osc = false; this.escape = ''; }
        else this.escape = char === '\x1b' ? '\x1b' : '';
        continue;
      }
      if (this.escape) {
        this.escape += char;
        if (this.escape === '\x1b]') { this.osc = true; this.escape = ''; continue; }
        if (this.escape === '\x1b[') continue;
        if (this.escape.startsWith('\x1b[') && /[@-~]/.test(char)) {
          this.control(this.escape.slice(2, -1), char); this.escape = ''; continue;
        }
        if (this.escape === '\x1b7') this.saved = { x: this.x, y: this.y, pen: this.pen };
        if (this.escape === '\x1b8') { this.grapheme = undefined; this.x = this.saved.x; this.y = this.saved.y; this.setPen(this.saved.pen); }
        if (this.escape === '\x1bc') { this.setPen(DEFAULT_PEN); this.modes = 0; }
        if (!this.escape.startsWith('\x1b[') || this.escape.length > 80) this.escape = '';
        continue;
      }
      if (char === '\x1b') { this.escape = char; continue; }
      if (char === '\r' || char === '\n' || char === '\b' || char === '\t') {
        this.grapheme = undefined;
        if (char === '\r') this.x = 0;
        else if (char === '\n') { this.down(); this.x = Math.min(this.columns - 1, this.x); }
        else if (char === '\b') this.x = Math.max(0, this.x - 1);
        else this.x = Math.min(this.columns - 1, (Math.floor(this.x / 8) + 1) * 8);
      } else if (char.charCodeAt(0) >= 32 && !(char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f)) this.print(char);
    }
    if (this.styles.length > this.styleLimit) this.compactStyles();
    if (!this.changed) return;
    this.changed = false; this.projection = this.projected = undefined; this.visual++;
    // Cursor/attribute traffic and identical redraws cannot attest a new panel.
    if (this.text() !== before) this.revision++;
  }

  text(): string {
    return this.projected ??= this.rowTexts().join('\n').trim();
  }

  /** Every row top to bottom, right-trimmed; a wide glyph's second cell adds nothing. */
  lineTexts(): string[] { return this.rowTexts().slice(); }

  /** One row as style runs whose `s` indexes styleTable(), without the trailing cells a renderer would not show. */
  styledRow(row: number): NativePanelRow {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rows) throw new RangeError('Invalid native screen row.');
    const line = this.lines[row];
    let end = this.columns;
    while (end > 0) {
      const lead = line[end - 1] === null ? end - 2 : end - 1;
      if (lead < 0 || !this.unseen(line[lead])) break;
      end = lead;
    }
    const runs: NativePanelRun[] = [];
    let text = '', style = 0, last = '';
    for (let column = 0; column < end; column++) {
      const cell = line[column];
      if (cell === null) continue;
      const glyph = cell?.text ?? ' ', id = cell?.style ?? 0;
      // Renderers split each run with splitGraphemes, so no cell may join the previous cell's grapheme there.
      if (text && (id !== style || continuesGrapheme(last, String.fromCodePoint(glyph.codePointAt(0)!)))) { runs.push({ text, s: style }); text = ''; }
      if (!text) style = id;
      text += glyph; last = glyph;
    }
    if (text) runs.push({ text, s: style });
    return { runs };
  }

  /** Interned styles; id 0 is the terminal default. Ids are valid until the next write(). */
  styleTable(): readonly NativePanelStyle[] { return this.styles; }

  private rowTexts(): string[] {
    return this.projection ??= this.lines.map((line) => line.map((cell) => cell === null ? '' : cell?.text ?? ' ').join('').trimEnd());
  }

  private unseen(cell: Cell): boolean {
    if (cell === undefined) return true;
    if (cell === null || cell.text.trim()) return false;
    const style = this.styles[cell.style];
    return !style.bg && !style.inverse && !style.underline && !style.strike;
  }

  private print(char: string): void {
    const previous = this.grapheme;
    if (previous && continuesGrapheme(previous.text, char)) {
      const combined = previous.text + char;
      if (combined.length > MAX_GRAPHEME_UNITS) return;
      const nextWidth = glyphWidth(combined);
      if (nextWidth === previous.width) {
        previous.text = combined;
        if (previous.cell && nextWidth) { previous.cell.line[previous.cell.column] = { text: combined, width: nextWidth, style: previous.style }; this.changed = true; }
      } else {
        this.undo(previous);
        this.grapheme = this.place(combined, nextWidth, previous.style);
      }
      return;
    }
    this.grapheme = this.place(char, glyphWidth(char), this.penStyle ??= this.intern(this.pen.fg, this.pen.bg, this.pen.flags));
  }

  private place(text: string, cellWidth: GlyphWidth, style: number): GraphemePlacement {
    const placement: GraphemePlacement = { text, width: cellWidth, style, beforeX: this.x, beforeY: this.y, changes: [] };
    if (!cellWidth) return placement;
    if (this.x + cellWidth > this.columns) {
      if (this.x < this.columns) this.clearGlyph(this.lines[this.y], this.x, placement);
      this.x = 0; this.down(placement);
    }
    const line = this.lines[this.y];
    for (let column = this.x; column < this.x + cellWidth; column++) this.clearGlyph(line, column, placement);
    this.setCell(line, this.x, { text, width: cellWidth, style }, placement);
    if (cellWidth === 2) this.setCell(line, this.x + 1, null, placement);
    placement.cell = { line, column: this.x };
    this.x += cellWidth;
    // A redraw first clears the cells it writes; only a net difference from the first recorded value is visible.
    this.changed ||= placement.changes.some(({ line: target, column, previous }, index, changes) =>
      changes.findIndex((change) => change.line === target && change.column === column) === index && !sameCell(previous, target[column]));
    return placement;
  }

  private undo(placement: GraphemePlacement): void {
    for (let index = placement.changes.length - 1; index >= 0; index--) {
      const change = placement.changes[index];
      change.line[change.column] = change.previous;
    }
    if (placement.scrolled) { this.lines.pop(); this.lines.unshift(placement.scrolled); }
    if (placement.changes.length || placement.scrolled) this.changed = true;
    this.x = placement.beforeX; this.y = placement.beforeY;
  }

  private setCell(line: Cell[], column: number, value: Cell, placement?: GraphemePlacement): void {
    if (column < 0 || column >= this.columns || line[column] === value) return;
    if (placement) placement.changes.push({ line, column, previous: line[column] });
    else if (sameCell(line[column], value)) return;
    else this.changed = true;
    line[column] = value;
  }

  private clearGlyph(line: Cell[], column: number, placement?: GraphemePlacement): void {
    const cell = line[column];
    if (cell === null) this.setCell(line, column - 1, undefined, placement);
    else if (cell?.width === 2) this.setCell(line, column + 1, undefined, placement);
    this.setCell(line, column, undefined, placement);
  }

  private erase(row: number, start: number, end: number, blank: Cell): void {
    const line = this.lines[row];
    for (let column = Math.max(0, start); column < Math.min(this.columns, end); column++) {
      if (sameCell(line[column], blank)) continue;
      this.clearGlyph(line, column); this.setCell(line, column, blank);
    }
  }

  private eraseCell(): Cell {
    return this.pen.bg === undefined ? undefined : { text: ' ', width: 1, style: this.intern(undefined, this.pen.bg, 0) };
  }

  private repairLine(line: Cell[]): void {
    for (let column = 0; column < this.columns; column++) {
      const cell = line[column];
      if (cell === null ? line[column - 1]?.width !== 2 : cell?.width === 2 && (column + 1 === this.columns || line[column + 1] !== null)) line[column] = undefined;
    }
  }

  private down(placement?: GraphemePlacement): void {
    this.y++;
    if (this.y >= this.rows) {
      const removed = this.lines.shift()!;
      if (placement) placement.scrolled = removed;
      this.lines.push(this.blankLine(this.eraseCell())); this.y = this.rows - 1;
      this.changed = true;
    }
  }

  private setPen(pen: Pen): void { this.pen = pen; this.penStyle = undefined; }

  private intern(fg: string | undefined, bg: string | undefined, flags: number): number {
    const key = `${fg ?? ''}|${bg ?? ''}|${flags}`;
    let id = this.styleIds.get(key);
    if (id === undefined) {
      const style: NativePanelStyle = {};
      if (fg) style.fg = fg;
      if (bg) style.bg = bg;
      if (flags & BOLD) style.bold = true;
      if (flags & DIM) style.dim = true;
      if (flags & ITALIC) style.italic = true;
      if (flags & UNDERLINE) style.underline = true;
      if (flags & INVERSE) style.inverse = true;
      if (flags & STRIKE) style.strike = true;
      id = this.styles.push(Object.freeze(style)) - 1;
      this.styleKeys.push(key); this.styleIds.set(key, id);
    }
    return id;
  }

  // Long colorful sessions keep only the styles a cell (or the undoable grapheme) still uses.
  private compactStyles(): void {
    const styles = [this.styles[0]], keys = [this.styleKeys[0]], ids = new Map([[0, 0]]), seen = new Set<object>();
    const keep = (id: number): number => {
      let next = ids.get(id);
      if (next === undefined) { next = styles.push(this.styles[id]) - 1; keys.push(this.styleKeys[id]); ids.set(id, next); }
      return next;
    };
    const visit = (cell: Cell): void => { if (cell && !seen.has(cell)) { seen.add(cell); cell.style = keep(cell.style); } };
    for (const line of this.lines) line.forEach(visit);
    if (this.grapheme) {
      this.grapheme.style = keep(this.grapheme.style);
      for (const change of this.grapheme.changes) visit(change.previous);
      this.grapheme.scrolled?.forEach(visit);
    }
    this.styles = styles; this.styleKeys = keys; this.styleIds = new Map(keys.map((key, id): [string, number] => [key, id]));
    this.penStyle = undefined; this.styleLimit = Math.max(STYLE_LIMIT, styles.length * 2);
  }

  private sgr(parameters: string): void {
    const parts = parameters.split(';');
    let { fg, bg, flags } = this.pen;
    for (let index = 0; index < parts.length; index++) {
      const fields = parts[index].split(':'), code = Number(fields[0] || 0);
      if (code === 38 || code === 48 || code === 58) {
        let color: string | undefined;
        if (fields.length > 1) {
          const at = fields.length > 5 ? 3 : 2;
          color = fields[1] === '5' ? indexed(fields[2]) : fields[1] === '2' ? rgb(fields[at], fields[at + 1], fields[at + 2]) : undefined;
        } else if (parts[index + 1] === '5') { color = indexed(parts[index + 2]); index += 2; }
        else if (parts[index + 1] === '2') { color = rgb(parts[index + 2], parts[index + 3], parts[index + 4]); index += 4; }
        else index++;
        // 58 is the underline color, which a panel mirror does not draw.
        if (color && code === 38) fg = color;
        else if (color && code === 48) bg = color;
        continue;
      }
      if (fields.length > 1 && code !== 4) continue;
      switch (code) {
        case 0: fg = bg = undefined; flags = 0; break;
        case 1: flags |= BOLD; break;
        case 2: flags |= DIM; break;
        case 3: flags |= ITALIC; break;
        case 4: flags = fields[1] === '0' ? flags & ~UNDERLINE : flags | UNDERLINE; break;
        case 7: flags |= INVERSE; break;
        case 9: flags |= STRIKE; break;
        case 22: flags &= ~(BOLD | DIM); break;
        case 23: flags &= ~ITALIC; break;
        case 24: flags &= ~UNDERLINE; break;
        case 27: flags &= ~INVERSE; break;
        case 29: flags &= ~STRIKE; break;
        case 39: fg = undefined; break;
        case 49: bg = undefined; break;
        default:
          if (code >= 30 && code <= 37 || code >= 90 && code <= 97) fg = PALETTE[code < 90 ? code - 30 : code - 82];
          else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) bg = PALETTE[code < 100 ? code - 40 : code - 92];
      }
    }
    this.setPen({ fg, bg, flags });
  }

  private control(parameters: string, operation: string): void {
    if (parameters.startsWith('?')) {
      if ((parameters === '?1049' || parameters === '?1047') && operation === 'h') { this.grapheme = undefined; this.lines = this.blank(); this.x = this.y = 0; this.changed = true; }
      if (operation === 'h' || operation === 'l') {
        for (const mode of parameters.slice(1).split(';')) {
          const bit = PRIVATE_MODES.get(mode) ?? 0;
          this.modes = operation === 'h' ? this.modes | bit : this.modes & ~bit;
        }
      }
      return;
    }
    if (operation === 'm') { if (/^[\d:;]*$/.test(parameters)) this.sgr(parameters); return; }
    if (operation === 'p' && parameters === '!') { this.setPen(DEFAULT_PEN); return; }
    if (operation === 's') { this.saved = { x: this.x, y: this.y, pen: this.pen }; return; }
    if (!['A', 'B', 'C', 'D', 'E', 'F', 'G', 'd', 'H', 'f', 'J', 'K', 'u', 'X', 'P', '@', 'L', 'M', 'S'].includes(operation)) return;
    this.grapheme = undefined;
    const values = parameters.split(';').map((value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    }), first = values[0] || 1;
    // Movement and character edits leave deferred wrap; ED/EL retain the end sentinel.
    if ('ABCDXP@'.includes(operation)) this.x = Math.min(this.columns - 1, this.x);
    const blank = 'JKXP@LMS'.includes(operation) ? this.eraseCell() : undefined;
    switch (operation) {
      case 'A': this.y = Math.max(0, this.y - first); break;
      case 'B': this.y = Math.min(this.rows - 1, this.y + first); break;
      case 'C': this.x = Math.min(this.columns - 1, this.x + first); break;
      case 'D': this.x = Math.max(0, this.x - first); break;
      case 'E': this.y = Math.min(this.rows - 1, this.y + first); this.x = 0; break;
      case 'F': this.y = Math.max(0, this.y - first); this.x = 0; break;
      case 'G': this.x = Math.min(this.columns - 1, first - 1); break;
      case 'd': this.y = Math.min(this.rows - 1, first - 1); break;
      case 'H': case 'f': this.y = Math.min(this.rows - 1, first - 1); this.x = Math.min(this.columns - 1, (values[1] || 1) - 1); break;
      case 'J':
        if (values[0] === 2 || values[0] === 3) for (let row = 0; row < this.rows; row++) this.erase(row, 0, this.columns, blank);
        else if (!values[0]) { this.erase(this.y, this.x, this.columns, blank); for (let row = this.y + 1; row < this.rows; row++) this.erase(row, 0, this.columns, blank); }
        else if (values[0] === 1) { this.erase(this.y, 0, this.x + 1, blank); for (let row = 0; row < this.y; row++) this.erase(row, 0, this.columns, blank); }
        break;
      case 'K':
        if (values[0] === 2) this.erase(this.y, 0, this.columns, blank);
        else if (values[0] === 1) this.erase(this.y, 0, this.x + 1, blank);
        else this.erase(this.y, this.x, this.columns, blank);
        break;
      case 'u': this.x = this.saved.x; this.y = this.saved.y; this.setPen(this.saved.pen); break;
      case 'X': this.erase(this.y, this.x, this.x + first, blank); break;
      case 'P': {
        const line = this.lines[this.y];
        this.erase(this.y, this.x, this.x + first, blank);
        line.splice(this.x, first);
        while (line.length < this.columns) line.push(blank);
        this.repairLine(line); this.changed = true;
        break;
      }
      case '@': {
        const line = this.lines[this.y];
        if (line[this.x] === null) this.clearGlyph(line, this.x);
        line.splice(this.x, 0, ...Array<Cell>(Math.min(first, this.columns)).fill(blank));
        line.length = this.columns;
        this.repairLine(line); this.changed = true;
        break;
      }
      case 'L': for (let index = 0; index < Math.min(first, this.rows - this.y); index++) { this.lines.splice(this.y, 0, this.blankLine(blank)); this.lines.pop(); } this.changed = true; break;
      case 'M': for (let index = 0; index < Math.min(first, this.rows - this.y); index++) { this.lines.splice(this.y, 1); this.lines.push(this.blankLine(blank)); } this.changed = true; break;
      case 'S': for (let index = 0; index < Math.min(first, this.rows); index++) { this.lines.shift(); this.lines.push(this.blankLine(blank)); } this.changed = true; break;
      default: break;
    }
  }
}
