// Reads a slash command's printed rows back from the session transcript. CLI 2.1.308 writes some of them without any
// Mod hook (/compact's result, a dialog command's closing line), around or after command.run answers.
import { open, type FileHandle } from 'node:fs/promises';
import type { TranscriptItem } from '@shared/types';
import { classifyUserText, commandDurationMs, commandRowName, isCommandOutput, isRecord, userContent } from '../engine/mapTranscript';
import { claudeConfigDir, findSessionFile, SESSION_FILE_ID } from '../engine/transcriptReader';

export type CommandResultItem = Extract<TranscriptItem, { kind: 'system' }>;

/** When the transcript is read, in ms after command.run answers; the CLI writes it out every 100 ms. */
export const COMMAND_RESULT_READS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000, 4_000];
/** How much earlier than Relay's send a command's `<command-name>` row may be dated. */
export const COMMAND_ANCHOR_SLACK_MS = 2_000;
/** The transcript tail read first, and the most it grows to while the command's row is not in it. */
export const COMMAND_TAIL_BYTES = { first: 1024 * 1024, max: 8 * 1024 * 1024 };

/**
 * CLI 2.1.308's slash command aliases, alias → command (claude.exe c9796ba2…); CLI 2.1.311 and 2.1.322 have the same table. Its
 * `<command-name>` row names the command an alias runs, and its command.list names no aliases.
 */
const CLI_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  bg: 'background', reset: 'clear', new: 'clear', settings: 'config', app: 'desktop', quit: 'exit', share: 'bug',
  peers: 'list-agents', ios: 'mobile', android: 'mobile', 'memory-pause': 'pause-memory', 'toggle-memory': 'pause-memory',
  'allowed-tools': 'permissions', plugins: 'plugin', marketplace: 'plugin', rc: 'remote-control', name: 'rename',
  update: 'restart', continue: 'resume', checkpoint: 'rewind', undo: 'rewind', remote: 'session', bashes: 'tasks',
  tp: 'teleport', cost: 'usage', stats: 'usage', breaks: 'wellbeing', 'break-reminder': 'wellbeing', downtime: 'wellbeing',
  checkup: 'doctor', routines: 'schedule', review: 'code-review', 'setup-cowork': 'setup-claude', proactive: 'loop',
};

/** The command a typed name runs, lower-cased, resolved as the CLI does: a listed command of that exact name first, then an alias. */
export function cliCommandName(typed: string, listed: readonly string[]): string {
  const name = typed.toLowerCase();
  if (listed.some((entry) => entry.toLowerCase() === name) || !Object.hasOwn(CLI_COMMAND_ALIASES, name)) return name;
  return CLI_COMMAND_ALIASES[name] ?? name;
}

export interface CommandResultQuery {
  /** The command as sent, without its slash. */
  name: string;
  /** The command it runs when that is another name (an alias); the CLI writes this one in the `<command-name>` row. */
  resolved?: string;
  /** Epoch ms: an older `<command-name>` row belongs to an earlier command. */
  since: number;
  /** `<command-name>` rows another read-back already owns. */
  taken?: ReadonlySet<string>;
  /** The row an earlier read of the same read-back found. */
  anchor?: string;
}

export interface CommandResultScan {
  /** The command's `<command-name>` row, once written. */
  anchor?: string;
  /** Its output rows as history maps them, in chain order; the last carries the running time. */
  items: CommandResultItem[];
  /** Nothing more will come: its output rows are written, or the conversation went on past the command. */
  done: boolean;
}

/** The session's transcript as the history reader finds it, in the config folder of the CLI's own environment. */
export async function nativeTranscriptFile(env: NodeJS.ProcessEnv, sessionId: string, cwd: string): Promise<string | undefined> {
  if (!SESSION_FILE_ID.test(sessionId)) return undefined;
  return (await findSessionFile(claudeConfigDir(env), sessionId, cwd))?.path;
}

interface Row {
  uuid: string;
  parent?: string;
  /** A system `local_command` row reads as the user row it stands for: CLI 2.1.308 writes /rename's rows that way. */
  type: string;
  main: boolean;
  meta: boolean;
  text: string;
  at: unknown;
  offset: number;
}

const NEWLINE = 0x0a;
const MAX_FOLLOWED = 64;

const timeOf = (row: Row): number => (typeof row.at === 'string' ? Date.parse(row.at) : NaN);
const byTime = (a: Row, b: Row): number => timeOf(a) - timeOf(b) || a.offset - b.offset;

function parseRow(bytes: Buffer, offset: number): Row | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.uuid !== 'string' || typeof raw.type !== 'string') return undefined;
  const message = isRecord(raw.message) ? raw.message : undefined;
  const local = raw.type === 'system' && raw.subtype === 'local_command';
  return {
    uuid: raw.uuid,
    ...(typeof raw.parentUuid === 'string' ? { parent: raw.parentUuid } : {}),
    type: local ? 'user' : raw.type,
    main: raw.isSidechain !== true && !raw.teamName,
    // What the SDK leaves out of history or marks as meta there.
    meta: raw.isMeta === true || raw.isCompactSummary === true || raw.isVisibleInTranscriptOnly === true,
    text: raw.type === 'user' ? userContent(message?.content).text : local && typeof raw.content === 'string' ? raw.content : '',
    at: raw.timestamp,
    offset,
  };
}

/** The complete rows of `tail` that contain `needle`, in file order. */
function rowsWith(tail: Buffer, whole: boolean, needle: string): Row[] {
  const rows: Row[] = [];
  let line = -1;
  for (let at = tail.indexOf(needle); at >= 0; at = tail.indexOf(needle, at + needle.length)) {
    const start = tail.lastIndexOf(NEWLINE, at) + 1;
    // The first line of a tail that does not reach the file start is cut.
    if (start === line || (start === 0 && !whole)) continue;
    line = start;
    const end = tail.indexOf(NEWLINE, at);
    const row = parseRow(tail.subarray(start, end < 0 ? tail.length : end), start);
    if (row) rows.push(row);
  }
  return rows;
}

function findAnchor(tail: Buffer, whole: boolean, query: CommandResultQuery): Row | undefined {
  if (query.anchor) return rowsWith(tail, whole, `"${query.anchor}"`).find((row) => row.uuid === query.anchor);
  const names = new Set([query.name, query.resolved ?? query.name].map((name) => name.toLowerCase()));
  let newest: Row | undefined;
  for (const row of rowsWith(tail, whole, '<command-name>')) {
    if (row.type !== 'user' || !row.main || row.meta || query.taken?.has(row.uuid)) continue;
    const name = commandRowName(row.text)?.toLowerCase();
    if (name === undefined || !names.has(name) || !(timeOf(row) >= query.since)) continue;
    if (!newest || timeOf(row) >= timeOf(newest)) newest = row;
  }
  return newest;
}

/** The output rows below the `<command-name>` row by parent links, whatever order the file has them in. */
function resultsOf(tail: Buffer, whole: boolean, anchor: Row): CommandResultScan {
  const outputs: Row[] = [];
  const followed = new Set([anchor.uuid]);
  const queue = [anchor.uuid];
  let movedOn = false;
  for (let index = 0; index < queue.length && index < MAX_FOLLOWED; index++) {
    const parent = queue[index] ?? '';
    const children = rowsWith(tail, whole, `"${parent}"`).filter((row) => row.parent === parent && row.main && !followed.has(row.uuid));
    for (const row of children.sort(byTime)) {
      if (row.type === 'user' && isCommandOutput(row.text)) {
        if (!row.meta) outputs.push(row);
      } else if (!row.meta && (row.type === 'user' || row.type === 'assistant')) {
        movedOn = true;
        continue;
      }
      followed.add(row.uuid);
      queue.push(row.uuid);
    }
  }
  const items: CommandResultItem[] = [];
  let last: Row | undefined;
  for (const row of outputs) {
    const display = classifyUserText(row.text);
    if (display.kind !== 'system') continue;
    items.push({ kind: 'system', id: row.uuid, text: display.text, level: display.level ?? 'info' });
    last = row;
  }
  const durationMs = last ? commandDurationMs(anchor.at, last.at) : undefined;
  const final = items.at(-1);
  if (final && durationMs !== undefined) final.durationMs = durationMs;
  return { anchor: anchor.uuid, items, done: outputs.length > 0 || movedOn };
}

async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

/** One look at the transcript's tail, never the whole file: it grows from `bytes.first` to `bytes.max` only while the command's row is not in it. */
export async function scanCommandResults(file: string, query: CommandResultQuery, bytes = COMMAND_TAIL_BYTES): Promise<CommandResultScan> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    let start = size;
    let tail = Buffer.alloc(0);
    for (let want = bytes.first; ; want *= 2) {
      const from = Math.max(0, size - Math.min(want, bytes.max));
      tail = Buffer.concat([await readRange(handle, from, start - from), tail]);
      start = from;
      const anchor = findAnchor(tail, start === 0, query);
      if (anchor) return resultsOf(tail, start === 0, anchor);
      if (start === 0 || size - start >= bytes.max) return { items: [], done: false };
    }
  } finally {
    await handle.close();
  }
}

export interface CommandResultReadBack extends CommandResultQuery {
  /** The session's transcript file, found the way the history reader finds it. */
  file(): Promise<string | undefined>;
  /** Aborted when the session closes or a newer run of the command starts; a stopped read-back finds nothing. */
  signal: AbortSignal;
  /** The command's `<command-name>` row was found; no other read-back may take it. */
  onAnchor?(uuid: string): void;
  reads?: readonly number[];
  bytes?: typeof COMMAND_TAIL_BYTES;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    if (signal.aborted) return done();
    timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Reads the transcript at COMMAND_RESULT_READS_MS after command.run answered, until nothing more will come; never throws. */
export async function readCommandResults(options: CommandResultReadBack): Promise<CommandResultScan> {
  const wait = options.wait ?? delay;
  let path: string | undefined;
  let anchor: string | undefined;
  let scan: CommandResultScan = { items: [], done: false };
  let elapsed = 0;
  for (const at of options.reads ?? COMMAND_RESULT_READS_MS) {
    await wait(at - elapsed, options.signal);
    elapsed = at;
    if (options.signal.aborted) break;
    try {
      path ??= await options.file();
      if (path && !options.signal.aborted) {
        const found = await scanCommandResults(path, { name: options.name, ...(options.resolved ? { resolved: options.resolved } : {}),
          since: options.since, ...(options.taken ? { taken: options.taken } : {}), ...(anchor ? { anchor } : {}) }, options.bytes);
        // Stopped while reading: what the read found may be a newer run's.
        if (options.signal.aborted) break;
        scan = found;
        if (scan.anchor && !anchor) {
          anchor = scan.anchor;
          options.onAnchor?.(anchor);
        }
      }
    } catch {
      // Not written yet, or being replaced: the next read looks again.
    }
    if (options.signal.aborted || scan.done) break;
  }
  return { ...scan, ...(anchor ? { anchor } : {}) };
}
