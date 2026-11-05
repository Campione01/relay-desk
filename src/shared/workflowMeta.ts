/**
 * The `export const meta = { name, description, phases }` block a Workflow script must start with (CLI rule: the
 * first statement, a pure literal). Read without evaluating anything: a small reader for the literals the CLI 2.1.302
 * accepts there, which gives up on anything else, so a script that is not plain data yields undefined.
 */
export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases: WorkflowMetaPhase[];
}

const MAX_SCAN = 20_000;
const MAX_DEPTH = 8;
const MAX_PHASES = 40;
const MAX_TEXT = 300;
/** Keys the CLI refuses in meta. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class NotLiteral extends Error {}

class LiteralReader {
  private at = 0;

  constructor(private readonly text: string) {}

  /** A leading hashbang line, as JavaScript allows. */
  skipHashbang(): void {
    if (!this.text.startsWith('#!')) return;
    const end = this.text.search(/[\n\r\u2028\u2029]/);
    this.at = end < 0 ? this.text.length : end;
  }

  /** Whitespace, line terminators and comments. */
  skip(): void {
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) return;
      if (/\s/.test(c)) {
        this.at++;
      } else if (c === '/' && this.text[this.at + 1] === '/') {
        const rest = this.text.slice(this.at).search(/[\n\r\u2028\u2029]/);
        this.at = rest < 0 ? this.text.length : this.at + rest + 1;
      } else if (c === '/' && this.text[this.at + 1] === '*') {
        const end = this.text.indexOf('*/', this.at + 2);
        if (end < 0) throw new NotLiteral();
        this.at = end + 2;
      } else {
        return;
      }
    }
  }

  word(): string | undefined {
    this.skip();
    const match = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/u.exec(this.text.slice(this.at, this.at + 200));
    if (!match) return undefined;
    this.at += match[0].length;
    return match[0];
  }

  expectWord(word: string): void {
    if (this.word() !== word) throw new NotLiteral();
  }

  expectChar(char: string): void {
    this.skip();
    if (this.text[this.at] !== char) throw new NotLiteral();
    this.at++;
  }

  private peek(): string | undefined {
    this.skip();
    return this.text[this.at];
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new NotLiteral();
    const c = this.peek();
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === "'" || c === '"' || c === '`') return this.string(c);
    // A minus sign is the only unary the CLI allows, and only before a number.
    if (c === '-') {
      this.at++;
      this.skip();
      return -this.number();
    }
    if (c !== undefined && /[.\d]/.test(c)) return this.number();
    switch (this.word()) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      default:
        throw new NotLiteral();
    }
  }

  private object(depth: number): Record<string, unknown> {
    this.expectChar('{');
    // No prototype, in case a key slips through as plain data.
    const result = Object.create(null) as Record<string, unknown>;
    for (;;) {
      const c = this.peek();
      if (c === '}') {
        this.at++;
        return result;
      }
      let key: string | undefined;
      if (c === "'" || c === '"') key = this.string(c);
      else if (c !== undefined && /\d/.test(c)) key = String(this.number());
      else key = this.word();
      if (key === undefined || RESERVED_KEYS.has(key)) throw new NotLiteral();
      // Shorthand, methods, computed keys and spreads are not plain data.
      this.expectChar(':');
      result[key] = this.value(depth + 1);
      if (this.peek() === ',') this.at++;
      else if (this.peek() !== '}') throw new NotLiteral();
    }
  }

  private array(depth: number): unknown[] {
    this.expectChar('[');
    const result: unknown[] = [];
    for (;;) {
      const c = this.peek();
      if (c === ']') {
        this.at++;
        return result;
      }
      if (c === ',') throw new NotLiteral();
      result.push(this.value(depth + 1));
      if (this.peek() === ',') this.at++;
      else if (this.peek() !== ']') throw new NotLiteral();
    }
  }

  private number(): number {
    const match = /^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.at, this.at + 64));
    if (!match) throw new NotLiteral();
    this.at += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new NotLiteral();
    return value;
  }

  private string(quote: string): string {
    this.at++;
    let out = '';
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) throw new NotLiteral();
      this.at++;
      if (c === quote) return out;
      if (quote === '`' && c === '$' && this.text[this.at] === '{') throw new NotLiteral();
      if ((c === '\n' || c === '\r') && quote !== '`') throw new NotLiteral();
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.text[this.at++];
      if (e === undefined) throw new NotLiteral();
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === 'b') out += '\b';
      else if (e === 'f') out += '\f';
      else if (e === 'v') out += '\v';
      else if (e === '0') out += '\0';
      else if (e === '\r') {
        if (this.text[this.at] === '\n') this.at++;
      } else if (e === '\n' || e === '\u2028' || e === '\u2029') {
        // Line continuation.
      } else if (e === 'x') out += this.code(/^[0-9a-fA-F]{2}/);
      else if (e === 'u' && this.text[this.at] === '{') out += this.codePoint();
      else if (e === 'u') out += this.code(/^[0-9a-fA-F]{4}/);
      else out += e;
    }
  }

  private code(pattern: RegExp): string {
    const match = pattern.exec(this.text.slice(this.at, this.at + 4));
    if (!match) throw new NotLiteral();
    this.at += match[0].length;
    return String.fromCharCode(Number.parseInt(match[0], 16));
  }

  /** `\u{…}`: hex digits only, up to U+10FFFF. */
  private codePoint(): string {
    const match = /^\{([0-9a-fA-F]{1,8})\}/.exec(this.text.slice(this.at, this.at + 10));
    if (!match) throw new NotLiteral();
    const point = Number.parseInt(match[1]!, 16);
    if (point > 0x10ffff) throw new NotLiteral();
    this.at += match[0].length;
    return String.fromCodePoint(point);
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

/** Like the CLI's progress view: only objects with a title are phases. */
function phaseOf(value: unknown): WorkflowMetaPhase | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const title = text(record.title);
  if (!title) return undefined;
  const detail = text(record.detail);
  return detail ? { title, detail } : { title };
}

function readMeta(script: string): WorkflowMeta | undefined {
  const reader = new LiteralReader(script.slice(0, MAX_SCAN));
  reader.skipHashbang();
  reader.expectWord('export');
  reader.expectWord('const');
  reader.expectWord('meta');
  reader.expectChar('=');
  const value = reader.value(0);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const meta = value as Record<string, unknown>;
  const name = text(meta.name);
  const description = text(meta.description);
  const phases = Array.isArray(meta.phases)
    ? meta.phases
        .map(phaseOf)
        .filter((phase): phase is WorkflowMetaPhase => phase !== undefined)
        .slice(0, MAX_PHASES)
    : [];
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), phases };
}

/** Meta of a Workflow script; undefined when the script does not start with a plain-data meta block. Never throws. */
export function parseWorkflowMeta(script: unknown): WorkflowMeta | undefined {
  if (typeof script !== 'string') return undefined;
  try {
    return readMeta(script);
  } catch {
    // Whatever the model sent, a display helper must not break the session or the transcript.
    return undefined;
  }
}

/** Display name of a Workflow call: the script's meta name, the named workflow, or the script file's name. */
export function workflowNameOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const fromMeta = parseWorkflowMeta(args.script)?.name;
  if (fromMeta) return fromMeta;
  const named = text(args.name);
  if (named) return named;
  const path = text(args.scriptPath);
  if (!path) return undefined;
  const file = path.split(/[\\/]/).pop() ?? path;
  // The CLI saves a run's script as "<name>-<runId>.js".
  return /^(.+)-wf_[\w-]+\.js$/i.exec(file)?.[1] ?? file.replace(/\.js$/i, '');
}
