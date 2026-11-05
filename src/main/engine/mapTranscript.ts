import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageRef, TaskNote, TranscriptItem } from '@shared/types';
import { workflowNameOf } from '@shared/workflowMeta';

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** Longest tool output kept on an item; longer output keeps its head and tail. */
export const OUTPUT_LIMIT = 4000;
const SUMMARY_ARG_LIMIT = 80;
const LCS_CELL_LIMIT = 250_000;

/** Prefix of the CLI's own rejection text; Relay's broker uses the same wording for its denials. */
export const DENIAL_PREFIX = "The user doesn't want to proceed with this tool use.";
const DENIAL_PATTERNS = [
  /^The user doesn't want to proceed with this tool use/,
  /^The user doesn't want to take this action right now/,
  /^Permission to use .+ has been denied/,
];

/** The CLI's resume prompt after a usage limit reset (autoContinueAtUsageLimit); Relay's automatic continue sends it too. */
export const AUTO_CONTINUE_PROMPT =
  'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';
/** How a transcript shows that prompt, live and in history. */
export const AUTO_CONTINUE_NOTE = 'Usage limit reset · Claude is continuing your task';

const INTERRUPTED_TEXTS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]'];
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * The CLI terminal's key hint for its compaction summary, under whatever key it is bound to; Relay offers no such view. The
 * CLI writes "Compacted " + [hint, message?, tip?].join("\n"), so lines may follow it.
 */
const COMPACT_SUMMARY_HINT = /[ \t]*\([^()\n]* to see full summary\)/g;
/** A local command that ran at least this long shows its running time on its last output row. */
export const COMMAND_DURATION_MIN_MS = 2_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clip(text: string, limit = SUMMARY_ARG_LIMIT): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  const more = line.length > limit || text.trim().includes('\n');
  return more ? `${line.slice(0, limit).trimEnd()}…` : line;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Keeps the head and the tail (errors usually end the output) of long tool output. */
export function truncateOutput(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`;
}

export function isDenialText(text: string): boolean {
  const trimmed = text.trimStart();
  return DENIAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

export interface LineCounts {
  added: number;
  removed: number;
}

/** Changed-line counts between two texts (line LCS after trimming the common prefix and suffix). */
export function lineDiff(before: string, after: string): LineCounts {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const common = midA.length * midB.length <= LCS_CELL_LIMIT ? lcsLength(midA, midB) : 0;
  return { added: midB.length - common, removed: midA.length - common };
}

/** Counts from an Edit/Write `structuredPatch` (live tool_use_result); undefined when absent. */
export function patchCounts(structuredPatch: unknown): LineCounts | undefined {
  if (!Array.isArray(structuredPatch)) return undefined;
  const counts = { added: 0, removed: 0 };
  for (const hunk of structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) counts.added++;
      else if (line.startsWith('-')) counts.removed++;
    }
  }
  return counts;
}

/** Path relative to `cwd` when it lies inside it (case-insensitive, either separator). */
export function displayPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const base = normalize(cwd);
  if (base && normalize(path).startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

function editCounts(name: string, input: Record<string, unknown>): LineCounts {
  if (name === 'Write') return { added: splitLines(str(input.content) ?? '').length, removed: 0 };
  if (name === 'MultiEdit') {
    const total = { added: 0, removed: 0 };
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      if (!isRecord(edit)) continue;
      const counts = lineDiff(str(edit.old_string) ?? '', str(edit.new_string) ?? '');
      total.added += counts.added;
      total.removed += counts.removed;
    }
    return total;
  }
  return lineDiff(str(input.old_string) ?? '', str(input.new_string) ?? '');
}

function mcpParts(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const parts = name.split('__');
  const server = parts[1];
  const tool = parts.slice(2).join('__');
  return server && tool ? { server, tool } : undefined;
}

/**
 * Pure: one-line tool summary, e.g. "Read src/a.ts", "Ran `npm test`", "Edited x (+3 −1)".
 * `counts` overrides the line counts computed from the input (live results carry the real patch).
 */
export function summarizeTool(name: string, input: unknown, cwd?: string, counts?: LineCounts): string {
  const args = isRecord(input) ? input : {};
  const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
  const shownPath = path ? clip(displayPath(path, cwd), 120) : undefined;
  const where = (p: string | undefined): string => (p ? ` in ${clip(displayPath(p, cwd))}` : '');
  switch (name) {
    case 'Read':
      return shownPath ? `Read ${shownPath}` : 'Read a file';
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const { added, removed } = counts ?? editCounts(name, args);
      const verb = name === 'Write' ? 'Wrote' : 'Edited';
      return `${verb} ${shownPath ?? 'a file'} (+${added} −${removed})`;
    }
    case 'NotebookEdit':
      return shownPath ? `Edited notebook ${shownPath}` : 'Edited a notebook';
    case 'Bash':
    case 'PowerShell': {
      const command = str(args.command);
      return command ? `Ran \`${clip(command)}\`` : 'Ran a command';
    }
    case 'Grep': {
      const pattern = str(args.pattern);
      return pattern ? `Searched for \`${clip(pattern)}\`${where(str(args.path))}` : 'Searched files';
    }
    case 'Glob': {
      const pattern = str(args.pattern);
      return pattern ? `Listed files \`${clip(pattern)}\`${where(str(args.path))}` : 'Listed files';
    }
    case 'WebFetch': {
      const url = str(args.url);
      return url ? `Fetched ${clip(url)}` : 'Fetched a web page';
    }
    case 'WebSearch':
    case 'web_search': {
      const query = str(args.query);
      return query ? `Searched the web for \`${clip(query)}\`` : 'Searched the web';
    }
    case 'Task':
    case 'Agent': {
      const description = str(args.description);
      const type = str(args.subagent_type);
      const label = type ? `Agent (${type})` : 'Agent';
      return description ? `${label}: ${clip(description)}` : label;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(args.todos) ? args.todos.length : 0;
      return `Updated the todo list (${todos} items)`;
    }
    case 'AskUserQuestion': {
      const first = Array.isArray(args.questions) && isRecord(args.questions[0]) ? str(args.questions[0].question) : undefined;
      return first ? `Asked: ${clip(first)}` : 'Asked a question';
    }
    case 'ExitPlanMode':
      return 'Presented a plan';
    case 'EnterPlanMode':
      return 'Entered plan mode';
    case 'Skill': {
      const skill = str(args.skill);
      return skill ? `Skill: ${clip(skill)}` : 'Used a skill';
    }
    case 'Workflow': {
      const workflow = workflowNameOf(args);
      return workflow ? `Workflow: ${clip(workflow)}` : 'Ran a workflow';
    }
    default: {
      const mcp = mcpParts(name);
      if (mcp) return `${mcp.server}/${mcp.tool}`;
      return `Used ${name}`;
    }
  }
}

export interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

/** tool_use, server_tool_use and mcp_tool_use content blocks. */
export function asToolUse(block: unknown): ToolUseInfo | undefined {
  if (!isRecord(block)) return undefined;
  const id = str(block.id);
  const name = str(block.name);
  if (!id || !name) return undefined;
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return { id, name, input: block.input ?? {} };
  if (block.type === 'mcp_tool_use') {
    const server = str(block.server_name);
    return { id, name: server ? `mcp__${server}__${name}` : name, input: block.input ?? {} };
  }
  return undefined;
}

export function toolItemFromUse(use: ToolUseInfo, options: { parentToolUseId?: string; cwd?: string } = {}): ToolItem {
  return {
    kind: 'tool',
    id: use.id,
    toolUseId: use.id,
    name: use.name,
    input: use.input,
    summary: summarizeTool(use.name, use.input, options.cwd),
    status: 'running',
    ...(options.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
  };
}

export interface ToolResultInfo {
  toolUseId: string;
  isError: boolean;
  text: string;
  images: number;
}

/** Text and image count of a tool_result `content` (string or blocks). */
function resultContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'image') images++;
  }
  return { text: texts.join('\n'), images };
}

export function asToolResult(block: unknown): ToolResultInfo | undefined {
  if (!isRecord(block) || block.type !== 'tool_result') return undefined;
  const toolUseId = str(block.tool_use_id);
  if (!toolUseId) return undefined;
  const { text, images } = resultContent(block.content);
  return { toolUseId, isError: block.is_error === true, text, images };
}

/** Pairs a tool_result with its tool item: status done/error/denied, truncated output, image count. */
export function applyToolResult(item: ToolItem, result: ToolResultInfo, options: { denied?: boolean } = {}): ToolItem {
  const output = truncateOutput(stripAnsi(result.text));
  const denied = result.isError && (options.denied === true || isDenialText(result.text));
  const status: ToolItem['status'] = denied ? 'denied' : result.isError ? 'error' : 'done';
  const next: ToolItem = { ...item, status };
  if (output) next.output = output;
  else delete next.output;
  if (result.images > 0) next.images = result.images;
  return next;
}

/** Text of an assistant text/thinking block. */
export function assistantBlockText(block: unknown): { kind: 'assistant' | 'thinking'; text: string } | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === 'text' && typeof block.text === 'string') return { kind: 'assistant', text: block.text };
  if (block.type === 'thinking' && typeof block.thinking === 'string') return { kind: 'thinking', text: block.thinking };
  return undefined;
}

function tagContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? (match[1] ?? '') : undefined;
}

type UserTextResult =
  | { kind: 'user'; text: string }
  | { kind: 'system'; text: string; level?: 'info' | 'warn'; tasks?: TaskNote[] }
  | { kind: 'skip' };

const decodeTagText = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The CLI saves background-task results as user turns; show them like the live `task_notification` line. */
function taskNotificationText(text: string): UserTextResult {
  const lines: string[] = [];
  const tasks: TaskNote[] = [];
  let failed = false;
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = match[1] ?? '';
    const status = tagContent(body, 'status')?.trim().toLowerCase() || 'finished';
    const summary = decodeTagText(tagContent(body, 'summary') ?? '').replace(/\s+/g, ' ').trim();
    if (status === 'failed') failed = true;
    lines.push(summary ? `Background task ${status}: ${summary}` : `Background task ${status}`);
    tasks.push({ status, summary });
  }
  if (lines.length === 0) return { kind: 'skip' };
  return { kind: 'system', text: lines.join('\n'), level: failed ? 'warn' : 'info', tasks };
}

/** Classifies user text the CLI writes for local commands, bash mode and interrupts. */
export function classifyUserText(raw: string): UserTextResult {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return { kind: 'skip' };
  if (INTERRUPTED_TEXTS.includes(text)) return { kind: 'system', text: 'Interrupted' };
  if (text.startsWith('<local-command-caveat>') || text.startsWith('Caveat: The messages below were generated')) {
    return { kind: 'skip' };
  }
  if (text.startsWith('<task-notification>')) return taskNotificationText(text);
  const command = tagContent(text, 'command-name');
  if (command !== undefined) {
    const args = tagContent(text, 'command-args')?.trim();
    const name = command.trim().startsWith('/') ? command.trim() : `/${command.trim()}`;
    return { kind: 'user', text: args ? `${name} ${args}` : name };
  }
  const stdout = tagContent(text, 'local-command-stdout');
  if (stdout !== undefined) {
    const out = stripAnsi(stdout).replace(COMPACT_SUMMARY_HINT, '').trim();
    return out ? { kind: 'system', text: truncateOutput(out) } : { kind: 'skip' };
  }
  const stderr = tagContent(text, 'local-command-stderr');
  if (stderr !== undefined) {
    const out = stripAnsi(stderr).trim();
    return out ? { kind: 'system', text: truncateOutput(out), level: 'warn' } : { kind: 'skip' };
  }
  const bash = tagContent(text, 'bash-input');
  if (bash !== undefined) return { kind: 'user', text: `! ${bash.trim()}` };
  const bashOut = tagContent(text, 'bash-stdout');
  const bashErr = tagContent(text, 'bash-stderr');
  if (bashOut !== undefined || bashErr !== undefined) {
    const out = stripAnsi([bashOut, bashErr].filter(Boolean).join('\n')).trim();
    return out ? { kind: 'system', text: truncateOutput(out) } : { kind: 'skip' };
  }
  return { kind: 'user', text };
}

/** The command a `<command-name>` row ran, without its slash; undefined for any other text. */
export function commandRowName(raw: string): string | undefined {
  const text = raw.trimStart();
  return text.startsWith('<command-name>') ? tagContent(text, 'command-name')?.trim().replace(/^\//, '') : undefined;
}

/** A row with what a local command printed (stdout or stderr, possibly empty). */
export function isCommandOutput(raw: string): boolean {
  return /^\s*<local-command-std(?:out|err)>/.test(raw);
}

/** A command's running time from the transcript timestamps of its `<command-name>` row and its last output row. */
export function commandDurationMs(started: unknown, ended: unknown): number | undefined {
  const duration = (typeof ended === 'string' ? Date.parse(ended) : NaN) - (typeof started === 'string' ? Date.parse(started) : NaN);
  return Number.isFinite(duration) && duration >= COMMAND_DURATION_MIN_MS ? duration : undefined;
}

/**
 * The resume prompt of an automatic continue, by its exact text. The origin alone is not enough: the CLI also gives it
 * to other prompts it sends itself (plan approval, /goal).
 */
export function isAutoContinuation(origin: unknown, text: string): boolean {
  if (isRecord(origin) && origin.kind !== 'auto-continuation') return false;
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() === AUTO_CONTINUE_PROMPT;
}

/** User-message content split into text, image count and tool results. */
export function userContent(content: unknown): { text: string; images: number; results: ToolResultInfo[] } {
  if (typeof content === 'string') return { text: content, images: 0, results: [] };
  const texts: string[] = [];
  const results: ToolResultInfo[] = [];
  let images = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (!isRecord(block)) continue;
    const result = asToolResult(block);
    if (result) results.push(result);
    else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image') images++;
  }
  return { text: texts.join('\n'), images, results };
}

export interface MapOptions {
  /** Session folder; paths inside it are shown relative. */
  cwd?: string;
  /** First part of image keys; defaults to each message's session_id. */
  sessionId?: string;
  /**
   * Stores the image blocks of a content array under `${keyPrefix}:${n}` and returns their refs
   * (history: storeImageBlocks into the process image store). Without it items keep only the image count.
   */
  storeImages?: (content: unknown, keyPrefix: string) => ImageRef[];
  /**
   * Saved history only, never live sessions: a tool still 'running' becomes 'done' (no output) once its
   * thread has moved on past it or its parent Task/Agent has finished; the SDK history can lack some
   * subagent tool results.
   */
  settleOpenTools?: boolean;
  /** With settleOpenTools, for an older history page: its thread went on in a newer page, so no tool is still live. */
  settleTrailingTools?: boolean;
}

function toolResultContent(blocks: readonly unknown[], toolUseId: string): unknown {
  const block = blocks.find((b) => isRecord(b) && b.type === 'tool_result' && b.tool_use_id === toolUseId);
  return isRecord(block) ? block.content : undefined;
}

/** Index of the last item that is not a running tool; running tools after it may still be live. */
function lastSettledIndex(list: readonly TranscriptItem[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && !(item.kind === 'tool' && item.status === 'running')) return i;
  }
  return -1;
}

/**
 * Pure: getSessionMessages() output (optionally with subagent messages, which carry parent_tool_use_id)
 * -> transcript items. Subagent tool calls follow the Task/Agent item that started them; subagent messages whose
 * Task/Agent call is not among `messages` are left out.
 */
export function mapSessionMessages(messages: readonly SessionMessage[], options: MapOptions = {}): TranscriptItem[] {
  const lists = new Map<string | null, TranscriptItem[]>();
  const tools = new Map<string, { list: TranscriptItem[]; index: number }>();
  // Local commands by parent link: a row's command row, each command's start and its last shown output row.
  const commandOf = new Map<string, string>();
  const commandStart = new Map<string, unknown>();
  const commandEnd = new Map<string, { item: Extract<TranscriptItem, { kind: 'system' }>; at: unknown }>();
  const listFor = (parent: string | null): TranscriptItem[] => {
    let list = lists.get(parent);
    if (!list) {
      list = [];
      lists.set(parent, list);
    }
    return list;
  };

  for (const message of messages) {
    const extra = message as unknown as Record<string, unknown>;
    const parent = message.parent_tool_use_id ?? null;
    const list = listFor(parent);
    const body = isRecord(message.message) ? message.message : undefined;

    if (message.type === 'assistant') {
      const content = Array.isArray(body?.content) ? body.content : [];
      const synthetic = body?.model === '<synthetic>';
      content.forEach((block, index) => {
        const use = asToolUse(block);
        if (use) {
          const item = toolItemFromUse(use, { cwd: options.cwd, ...(parent ? { parentToolUseId: parent } : {}) });
          const existing = tools.get(use.id);
          if (existing) existing.list[existing.index] = item;
          else tools.set(use.id, { list, index: list.push(item) - 1 });
          return;
        }
        if (parent) return;
        const part = assistantBlockText(block);
        if (!part || !part.text.trim()) return;
        const id = `${message.uuid}:${index}`;
        if (synthetic) {
          const level = /error|not logged in|invalid api key|please run \/login/i.test(part.text) ? 'error' : 'info';
          list.push({ kind: 'system', id, text: part.text.trim(), level });
        } else {
          list.push({ kind: part.kind, id, text: part.text });
        }
      });
      continue;
    }

    // A system `local_command` row stands for the user row of a command: CLI 2.1.308 writes /rename's rows that way.
    const local = message.type === 'system' && extra.subtype === 'local_command' ? str(extra.content) : undefined;
    if (message.type === 'user' || local !== undefined) {
      if (extra.isCompactSummary === true) {
        if (!parent) list.push({ kind: 'system', id: message.uuid, text: 'Conversation compacted', level: 'info' });
        continue;
      }
      const { text, images, results } = userContent(local ?? body?.content);
      const blocks: unknown[] = Array.isArray(body?.content) ? body.content : [];
      const sessionId = options.sessionId ?? message.session_id;
      for (const result of results) {
        const target = tools.get(result.toolUseId);
        const item = target?.list[target.index];
        if (!target || item?.kind !== 'tool') continue;
        const next = applyToolResult(item, result);
        const refs =
          result.images > 0 && options.storeImages
            ? options.storeImages(toolResultContent(blocks, result.toolUseId), `${sessionId}:${item.id}`)
            : [];
        if (refs.length > 0) next.imageRefs = refs;
        target.list[target.index] = next;
      }
      if (!parent && isAutoContinuation(extra.origin, text)) {
        list.push({ kind: 'system', id: message.uuid, text: AUTO_CONTINUE_NOTE, level: 'info' });
        continue;
      }
      if (parent || extra.is_meta === true) continue;
      const classified = classifyUserText(text);
      const link = str(extra.parentUuid);
      if (commandRowName(text) !== undefined) {
        commandOf.set(message.uuid, message.uuid);
        commandStart.set(message.uuid, extra.timestamp);
      } else if (link && isCommandOutput(text)) {
        const command = commandOf.get(link);
        if (command) commandOf.set(message.uuid, command);
      }
      const userImages = (): Pick<Extract<TranscriptItem, { kind: 'user' }>, 'images' | 'imageRefs'> => {
        if (images === 0) return {};
        const own = blocks.filter((block) => !(isRecord(block) && block.type === 'tool_result'));
        const refs = options.storeImages ? options.storeImages(own, `${sessionId}:${message.uuid}`) : [];
        return refs.length > 0 ? { images, imageRefs: refs } : { images };
      };
      if (classified.kind === 'user') {
        list.push({ kind: 'user', id: message.uuid, text: classified.text, ...userImages() });
      } else if (classified.kind === 'system') {
        const item: Extract<TranscriptItem, { kind: 'system' }> = {
          kind: 'system',
          id: message.uuid,
          text: classified.text,
          level: classified.level ?? 'info',
          ...(classified.tasks ? { tasks: classified.tasks } : {}),
        };
        list.push(item);
        const command = commandOf.get(message.uuid);
        if (command && command !== message.uuid) commandEnd.set(command, { item, at: extra.timestamp });
      } else if (images > 0 && results.length === 0) {
        list.push({ kind: 'user', id: message.uuid, text: '', ...userImages() });
      }
      continue;
    }

    if (message.type === 'system' && !parent) {
      const subtype = str(body?.subtype) ?? str(extra.subtype);
      const text =
        subtype === 'compact_boundary'
          ? 'Conversation compacted'
          : (str(message.message) ?? str(body?.content) ?? str(body?.text) ?? str(extra.content))?.trim();
      if (!text) continue;
      const rawLevel = str(body?.level) ?? str(extra.level);
      const level = rawLevel === 'error' ? 'error' : rawLevel === 'warning' || rawLevel === 'warn' ? 'warn' : 'info';
      list.push({ kind: 'system', id: message.uuid, text: stripAnsi(text), level });
    }
  }
  for (const [command, end] of commandEnd) {
    const durationMs = commandDurationMs(commandStart.get(command), end.at);
    if (durationMs !== undefined) end.item.durationMs = durationMs;
  }

  const out: TranscriptItem[] = [];
  const emitted = new Set<string | null>();
  const emit = (parent: string | null, parentFinished: boolean): void => {
    if (emitted.has(parent)) return;
    emitted.add(parent);
    const list = lists.get(parent) ?? [];
    const settledBefore = !options.settleOpenTools ? -1 : options.settleTrailingTools ? list.length : lastSettledIndex(list);
    list.forEach((raw, index) => {
      const settle = options.settleOpenTools === true && (parentFinished || index < settledBefore);
      const item: TranscriptItem =
        settle && raw.kind === 'tool' && raw.status === 'running' ? { ...raw, status: 'done' } : raw;
      out.push(item);
      if (item.kind === 'tool' && lists.has(item.toolUseId)) emit(item.toolUseId, item.status !== 'running');
    });
  };
  emit(null, false);
  return out;
}
