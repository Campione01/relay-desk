/**
 * Terminal cell rules shared by the main-process screen projection and the renderer's native panel mirror, so both
 * place every grapheme in the same cells. Ambiguous-width characters use one cell; CJK/fullwidth and emoji
 * presentation use two. Dependency-free so the main and web builds compile the same definition.
 */
export type GlyphWidth = 0 | 1 | 2;

/** A pathological single grapheme keeps at most this many UTF-16 units; later joining characters are dropped. */
export const MAX_GRAPHEME_UNITS = 256;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const mark = /\p{Mark}/u;
const ignorable = /\p{Default_Ignorable_Code_Point}/u;
const emoji = /\p{Emoji}/u;
const emojiPresentation = /\p{Emoji_Presentation}/u;
const regionalIndicator = /\p{Regional_Indicator}/u;
// UAX #29 always breaks between two non-mark grapheme bases of these blocks (no Prepend, SpacingMark, jamo or RI).
const plainBase = /^(?=[\u0020-\u02ff\u0370-\u05ff\u1e00-\u1fff\u2000-\u2bff\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef])[^\p{M}\P{Grapheme_Base}]$/u;

function wide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f ||
    code >= 0xa960 && code <= 0xa97c || code >= 0xac00 && code <= 0xd7a3 ||
    code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe19 ||
    code >= 0xfe30 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
    code >= 0xffe0 && code <= 0xffe6 || code >= 0x16fe0 && code <= 0x18dff ||
    code >= 0x1aff0 && code <= 0x1afff || code >= 0x1b000 && code <= 0x1b2ff ||
    code >= 0x1f200 && code <= 0x1f251 || code >= 0x20000 && code <= 0x3fffd
  );
}

/** Cells one grapheme occupies: 0 for marks and default-ignorables alone, 2 for wide and emoji presentation. */
export function glyphWidth(grapheme: string): GlyphWidth {
  if (grapheme.length === 1 && grapheme.charCodeAt(0) < 0x7f) return 1;
  if (regionalIndicator.test(grapheme) || grapheme.includes('\u20e3') || grapheme.includes('\ufe0f') && emoji.test(grapheme)) return 2;
  const textPresentation = grapheme.includes('\ufe0e');
  let result: GlyphWidth = 0;
  for (const char of grapheme) {
    if (mark.test(char) || ignorable.test(char)) continue;
    if (wide(char.codePointAt(0)!) || !textPresentation && emojiPresentation.test(char)) return 2;
    result = 1;
  }
  return result;
}

/** Whether the code point `char` joins `grapheme` into one extended grapheme cluster. */
export function continuesGrapheme(grapheme: string, char: string): boolean {
  // Ordinary ASCII history does not need Unicode segmentation.
  if (char.charCodeAt(0) < 0x7f && grapheme.length === 1 && grapheme.charCodeAt(0) < 0x7f) return false;
  if (plainBase.test(char) && plainBase.test(grapheme[grapheme.length - 1])) return false;
  const segments = segmenter.segment(grapheme + char)[Symbol.iterator]();
  segments.next();
  return segments.next().done === true;
}

/**
 * The graphemes NativeTerminalScreen places for `text` printed in one go, each taking glyphWidth cells.
 * Split every NativePanelRun on its own: a run boundary may separate cells that would otherwise join.
 */
export function splitGraphemes(text: string): string[] {
  const graphemes: string[] = [];
  for (const char of text) {
    const last = graphemes.length - 1;
    if (last < 0 || !continuesGrapheme(graphemes[last], char)) graphemes.push(char);
    else if (graphemes[last].length + char.length <= MAX_GRAPHEME_UNITS) graphemes[last] += char;
  }
  return graphemes;
}

/** Terminal cells `text` occupies on one row. */
export function cellWidth(text: string): number {
  let cells = 0;
  for (const grapheme of splitGraphemes(text)) cells += glyphWidth(grapheme);
  return cells;
}
