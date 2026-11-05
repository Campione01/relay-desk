import type { TaskNote, TranscriptItem } from '@shared/types';
import type { MessageKey, Translate } from '../i18n';
import { diffLines, diffStats, type DiffLine, type DiffStats } from './diff';
import { countLines } from './format';

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;
export type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>;
export type PlainItem = Exclude<TranscriptItem, { kind: 'tool' }>;
/** A background-task notification: progress from outside the main conversation, folded into the activity line. */
export type NoteItem = Extract<TranscriptItem, { kind: 'system' }> & { tasks: TaskNote[] };

export function isTaskNote(item: TranscriptItem): item is NoteItem {
  return item.kind === 'system' && Array.isArray(item.tasks) && item.tasks.length > 0;
}

/** One rendered transcript block: a plain item, or a run of tool calls and task notes shown as one summary line. */
export type Block =
  | { type: 'item'; item: PlainItem }
  | { type: 'tools'; id: string; tools: ToolItem[]; notes: NoteItem[]; entries: Array<ToolItem | ThinkingItem | NoteItem> };

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoEntry {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface PlanState {
  toolId: string;
  todos: TodoEntry[];
  /** A user message came after the plan was written. */
  stale: boolean;
}

const PLAN_TOOL = 'TodoWrite';

export function parseTodos(input: unknown): TodoEntry[] | null {
  if (!input || typeof input !== 'object') return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const out: TodoEntry[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof entry.content !== 'string') continue;
    const status: TodoStatus =
      entry.status === 'in_progress' || entry.status === 'completed' ? entry.status : 'pending';
    out.push({
      content: entry.content,
      status,
      ...(typeof entry.activeForm === 'string' ? { activeForm: entry.activeForm } : {}),
    });
  }
  return out;
}

/** Consecutive thinking blocks shown as one: the first id (stable while more arrive), texts joined. */
export function mergeThinking(items: readonly ThinkingItem[]): ThinkingItem {
  if (items.length === 1) return items[0]!;
  const streaming = items.some((item) => item.streaming);
  return {
    kind: 'thinking',
    id: items[0]!.id,
    text: items.map((item) => item.text.trim()).filter(Boolean).join('\n\n'),
    ...(streaming ? { streaming: true } : {}),
  };
}

/**
 * Groups consecutive tool calls. Thinking right before a tool, between two tool calls or after the last call of the
 * final group joins that group; any other
 * run of thinking becomes one merged row, so a turn never stacks thinking rows (desktop parity). TodoWrite feeds the plan.
 * Background-task notifications join the activity line too, so long command dumps never fill the conversation.
 */
export function buildBlocks(items: readonly TranscriptItem[]): { blocks: Block[]; plan: PlanState | null } {
  const blocks: Block[] = [];
  let group: Extract<Block, { type: 'tools' }> | null = null;
  let held: ThinkingItem[] = [];
  let plan: { toolId: string; todos: TodoEntry[]; index: number } | null = null;
  let lastUserIndex = -1;

  const flushHeld = (): void => {
    if (held.length > 0) blocks.push({ type: 'item', item: mergeThinking(held) });
    held = [];
  };

  items.forEach((item, index) => {
    if (item.kind === 'tool' && item.name === PLAN_TOOL) {
      const todos = parseTodos(item.input);
      if (todos) plan = { toolId: item.id, todos, index };
      return;
    }
    if (item.kind === 'tool' || isTaskNote(item)) {
      const thinking = held.length > 0 ? [mergeThinking(held)] : [];
      held = [];
      if (!group) {
        group = { type: 'tools', id: `tools-${item.id}`, tools: [], notes: [], entries: [] };
        blocks.push(group);
      }
      group.entries.push(...thinking, item);
      if (item.kind === 'tool') group.tools.push(item);
      else group.notes.push(item);
      return;
    }
    if (item.kind === 'thinking') {
      held.push(item);
      return;
    }
    group = null;
    flushHeld();
    if (item.kind === 'user') lastUserIndex = index;
    blocks.push({ type: 'item', item });
  });
  // Thinking after the calls of a line that is still open stays in that line: as a row of its own it would appear and
  // vanish between calls and make the whole transcript jump.
  const open = group as Extract<Block, { type: 'tools' }> | null;
  if (open && held.length > 0) {
    open.entries.push(mergeThinking(held));
    held = [];
  }
  flushHeld();

  const found = plan as { toolId: string; todos: TodoEntry[]; index: number } | null;
  return {
    blocks,
    plan: found ? { toolId: found.toolId, todos: found.todos, stale: lastUserIndex > found.index } : null,
  };
}

export type ToolCategory = 'create' | 'edit' | 'read' | 'command' | 'search' | 'web' | 'agent' | 'other';

export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case 'Write':
      return 'create';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Bash':
    case 'PowerShell':
      return 'command';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'agent';
    default:
      return 'other';
  }
}

const CATEGORY_KEYS: Record<ToolCategory, readonly [MessageKey, MessageKey]> = {
  create: ['tools.create.one', 'tools.create.other'],
  edit: ['tools.edit.one', 'tools.edit.other'],
  read: ['tools.read.one', 'tools.read.other'],
  command: ['tools.command.one', 'tools.command.other'],
  search: ['tools.search.one', 'tools.search.other'],
  web: ['tools.web.one', 'tools.web.other'],
  agent: ['tools.agent.one', 'tools.agent.other'],
  other: ['tools.other.one', 'tools.other.other'],
};

const MAX_PHRASES = 3;

/** Verbs whose forms do not follow the plain rules: [past, -ing]. */
const VERB_FORMS: Readonly<Record<string, readonly [string, string]>> = {
  begin: ['began', 'beginning'],
  bring: ['brought', 'bringing'],
  build: ['built', 'building'],
  commit: ['committed', 'committing'],
  cut: ['cut', 'cutting'],
  do: ['did', 'doing'],
  drop: ['dropped', 'dropping'],
  find: ['found', 'finding'],
  format: ['formatted', 'formatting'],
  get: ['got', 'getting'],
  go: ['went', 'going'],
  grep: ['grepped', 'grepping'],
  keep: ['kept', 'keeping'],
  log: ['logged', 'logging'],
  make: ['made', 'making'],
  map: ['mapped', 'mapping'],
  pin: ['pinned', 'pinning'],
  plan: ['planned', 'planning'],
  put: ['put', 'putting'],
  quit: ['quit', 'quitting'],
  read: ['read', 'reading'],
  rebuild: ['rebuilt', 'rebuilding'],
  reread: ['reread', 'rereading'],
  rerun: ['reran', 'rerunning'],
  rescan: ['rescanned', 'rescanning'],
  reset: ['reset', 'resetting'],
  rewrite: ['rewrote', 'rewriting'],
  run: ['ran', 'running'],
  scan: ['scanned', 'scanning'],
  see: ['saw', 'seeing'],
  send: ['sent', 'sending'],
  set: ['set', 'setting'],
  ship: ['shipped', 'shipping'],
  show: ['showed', 'showing'],
  shut: ['shut', 'shutting'],
  skip: ['skipped', 'skipping'],
  split: ['split', 'splitting'],
  stop: ['stopped', 'stopping'],
  strip: ['stripped', 'stripping'],
  submit: ['submitted', 'submitting'],
  swap: ['swapped', 'swapping'],
  tag: ['tagged', 'tagging'],
  take: ['took', 'taking'],
  undo: ['undid', 'undoing'],
  unzip: ['unzipped', 'unzipping'],
  wrap: ['wrapped', 'wrapping'],
  write: ['wrote', 'writing'],
  zip: ['zipped', 'zipping'],
};

/** Verbs that take the plain -ed / -ing rules; any other first word leaves the description as written. */
const REGULAR_VERBS = new Set(
  (
    'add analyze append apply attach back bump calculate call capture check clean clear clone close collect compare ' +
    'compile compress confirm convert copy count create debug delete deploy detach diff disable display download edit ' +
    'empty enable ensure execute export extract fetch filter fix free gather generate import inspect install kill launch lint ' +
    'list load locate look mark measure merge monitor move open package parse patch pause poll prepare print probe ' +
    'publish pull push query rebase record refresh register reinstall reload remove rename render repair replace ' +
    'reproduce restart restore resume retry return revert review save search simulate sort start stash summarize sync ' +
    'tail test touch trace try typecheck uninstall update upgrade upload validate verify view wait watch'
  ).split(' '),
);

function plainPast(verb: string): string {
  if (verb.endsWith('e')) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

function plainIng(verb: string): string {
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`;
  if (verb.endsWith('e') && !/[eoy]e$/.test(verb)) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

/**
 * "Render the chart" becomes "Rendering the chart" while it runs and "Rendered the chart" afterwards, as the desktop
 * shows command descriptions. A first word that is not a known verb leaves the text as written.
 */
export function inflectDescription(text: string, running: boolean): string {
  const match = /^([A-Za-z]+)(.*)$/s.exec(text.trim());
  if (!match) return text.trim();
  const [, word, rest] = match as unknown as [string, string, string];
  const verb = word.toLowerCase();
  const forms = VERB_FORMS[verb] ?? (REGULAR_VERBS.has(verb) ? ([plainPast(verb), plainIng(verb)] as const) : null);
  if (!forms) return text.trim();
  const form = running ? forms[1] : forms[0];
  const cased = word.charAt(0) === word.charAt(0).toUpperCase() ? form.charAt(0).toUpperCase() + form.slice(1) : form;
  return cased + rest;
}

function fileName(input: unknown): string | null {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const path = [args.file_path, args.notebook_path].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  if (!path) return null;
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name ?? null;
}

/** The past-tense verbs main's summaries start with, and their running form. */
const LIVE_VERBS: Readonly<Record<string, string>> = {
  Asked: 'Asking',
  Edited: 'Editing',
  Entered: 'Entering',
  Fetched: 'Fetching',
  Listed: 'Listing',
  Presented: 'Presenting',
  Ran: 'Running',
  Read: 'Reading',
  Searched: 'Searching',
  Updated: 'Updating',
  Used: 'Using',
  Wrote: 'Writing',
};

function liveSummary(summary: string): string {
  const match = /^(\S+)(.*)$/s.exec(summary);
  const verb = match ? LIVE_VERBS[match[1]!] : undefined;
  return verb ? verb + match![2] : summary;
}

/**
 * One tool's line, as the desktop shows it: the command's own description, or "Read zoom.png". `live` gives the
 * running form ("Rendering …", "Reading zoom.png") for the activity line of a call still in progress.
 */
export function toolTitle(tool: ToolItem, live = false): string {
  const args = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : {};
  if ((tool.name === 'Bash' || tool.name === 'PowerShell') && typeof args.description === 'string' && args.description.trim()) {
    return inflectDescription(args.description, live);
  }
  if (tool.name === 'Read') {
    const name = fileName(tool.input);
    if (name) return `${live ? 'Reading' : 'Read'} ${name}`;
  }
  const summary = tool.summary || tool.name;
  return live ? liveSummary(summary) : summary;
}

/** A category with one file names it ("read zoom.png"), like the desktop's activity line. */
const NAMED_KEYS: Partial<Record<ToolCategory, MessageKey>> = {
  create: 'tools.create.named',
  edit: 'tools.edit.named',
  read: 'tools.read.named',
};

/** "Created a file, ran 3 commands, read a file, and 6 more actions (1 failed)". A single call uses its own summary. */
export function summarizeTools(tools: readonly ToolItem[], t: Translate): string {
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const denied = tools.filter((tool) => tool.status === 'denied').length;
  let text: string;
  if (tools.length === 1) {
    text = toolTitle(tools[0]!);
  } else {
    const counts = new Map<ToolCategory, number>();
    for (const tool of tools) {
      const category = toolCategory(tool.name);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const entries = [...counts.entries()];
    const shown = entries.slice(0, MAX_PHRASES);
    const rest = entries.slice(MAX_PHRASES).reduce((sum, [, n]) => sum + n, 0);
    const phrases = shown.map(([category, n]) => {
      const named = n === 1 ? NAMED_KEYS[category] : undefined;
      const name = named ? fileName(tools.find((tool) => toolCategory(tool.name) === category)?.input) : null;
      if (named && name) return t(named, { name });
      const [one, other] = CATEGORY_KEYS[category];
      return t(n === 1 ? one : other, { n });
    });
    text = phrases.join(t('tools.join'));
    if (rest > 0) text += t(rest === 1 ? 'tools.more.one' : 'tools.more.other', { n: rest });
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  if (failed > 0) text += t('tools.failed', { n: failed });
  if (denied > 0) text += t('tools.denied', { n: denied });
  return text;
}

/** The activity line: the tool summary, then " · 2 background tasks finished (1 failed)" for task notes. */
export function summarizeActivity(tools: readonly ToolItem[], notes: readonly NoteItem[], t: Translate): string {
  const parts = tools.length > 0 ? [summarizeTools(tools, t)] : [];
  const tasks = notes.flatMap((note) => note.tasks);
  if (tasks.length > 0) {
    let phrase = t(tasks.length === 1 ? 'tools.tasks.one' : 'tools.tasks.other', { n: tasks.length });
    const failed = tasks.filter((task) => task.status === 'failed').length;
    if (failed > 0) phrase += t('tools.failed', { n: failed });
    parts.push(parts.length > 0 ? phrase : phrase.charAt(0).toUpperCase() + phrase.slice(1));
  }
  return parts.join(t('tools.noteJoin'));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export interface InputDiff {
  path?: string;
  lines: DiffLine[];
  stats: DiffStats;
  /** Write: the whole new content (the previous file is unknown). */
  isNewContent: boolean;
}

/** Diff preview for Edit / MultiEdit / Write inputs; null for other tools. */
export function inputDiff(toolName: string, input: unknown): InputDiff | null {
  const record = asRecord(input);
  if (!record) return null;
  const path = typeof record.file_path === 'string' ? record.file_path : undefined;
  if (toolName === 'Edit' && typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    const lines = diffLines(record.old_string, record.new_string);
    return { path, lines, stats: diffStats(lines), isNewContent: false };
  }
  if (toolName === 'MultiEdit' && Array.isArray(record.edits)) {
    const lines: DiffLine[] = [];
    for (const raw of record.edits) {
      const edit = asRecord(raw);
      if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') continue;
      lines.push(...diffLines(edit.old_string, edit.new_string));
    }
    return { path, lines, stats: diffStats(lines), isNewContent: false };
  }
  if (toolName === 'Write' && typeof record.content === 'string') {
    const lines = diffLines('', record.content);
    return { path, lines, stats: { added: countLines(record.content), removed: 0 }, isNewContent: true };
  }
  return null;
}

/** +N −M across the finished edits of a group; null when the group changed no file. */
export function groupDiffStats(tools: readonly ToolItem[]): DiffStats | null {
  let found = false;
  const total: DiffStats = { added: 0, removed: 0 };
  for (const tool of tools) {
    if (tool.status !== 'done') continue;
    const diff = inputDiff(tool.name, tool.input);
    if (!diff) continue;
    found = true;
    total.added += diff.stats.added;
    total.removed += diff.stats.removed;
  }
  return found ? total : null;
}

export interface ParamRow {
  key: string;
  value: string;
  /** Prose values use the sans font; JSON-like values and identifiers use mono. */
  prose: boolean;
}

const MAX_PARAM_LENGTH = 600;

function looksLikeProse(value: string): boolean {
  return /\s/.test(value.trim()) && !/^[[{]/.test(value.trim()) && !/^[A-Za-z]:[\\/]|^\//.test(value.trim());
}

export function paramRows(input: unknown): ParamRow[] {
  const record = asRecord(input);
  if (!record) {
    if (input === undefined || input === null) return [];
    return [{ key: 'input', value: JSON.stringify(input) ?? String(input), prose: false }];
  }
  return Object.entries(record).map(([key, value]) => {
    let text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    if (text.length > MAX_PARAM_LENGTH) text = `${text.slice(0, MAX_PARAM_LENGTH)}…`;
    return { key, value: text, prose: typeof value === 'string' && looksLikeProse(value) };
  });
}
