// Worker-side reader of saved session transcripts: pages a session across its compactions, newest page first, without
// loading the whole file. No Electron or main-process imports: the listing utilityProcess bundle loads it.
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/** One parsed transcript line. */
export type RawEntry = { type: string; [key: string]: unknown };

/**
 * Turns one compaction segment's raw entries into SessionMessages. The worker passes the SDK's own getSessionMessages
 * over an in-memory session store, so queued prompts, parallel tool results and meta entries come out as the SDK shows
 * them.
 */
export type ConvertEntries = (entries: RawEntry[]) => Promise<SessionMessage[]>;

export interface TranscriptPage {
  /** Main-thread messages, oldest first. */
  messages: SessionMessage[];
  /** Cursor for the page before this one; absent at the session start. */
  older?: string;
  /** Agent tool_use id -> subagent id, from the raw tool results of this page. */
  agentIds: Record<string, string>;
}

export interface PageRequest {
  file: string;
  sessionId: string;
  before?: string;
  pageSize: number;
  convert: ConvertEntries;
}

export interface HistoryPager {
  page(request: PageRequest): Promise<TranscriptPage>;
}

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Session ids name the transcript file; nothing that could leave the project folder. */
export const SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
export const INVALID_CURSOR = 'Invalid history cursor.';
export const FOREIGN_CURSOR = 'This history cursor belongs to another session.';
export const STALE_CURSOR = 'This history cursor no longer matches the saved session. Reload the session.';

/** Longer project folder names get a hash suffix from the CLI; those sessions are found by the search instead. */
const MAX_PROJECT_FOLDER = 200;
const CHAIN_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);
/** Parent of nothing real: closes each converted segment so the SDK takes the segment's own leaf as the newest chain end. */
const PAGE_END_UUID = '00000000-0000-4000-8000-000000000000';
const SEGMENT_CACHE = 2;
const MAX_READ_GAP = 64 * 1024;
const MAX_READ_RANGE = 32 * 1024 * 1024;
const MAX_SUMMARY_DEPTH = 1000;
const CURSOR_PATTERN = /^1:([0-9A-Za-z-]{1,8}):([LB]):([A-Za-z0-9_.-]{1,100}):(e|[1-9]\d{0,8})$/;

/** The profile's config folder as the SDK resolves it in this process (CLAUDE_CONFIG_DIR from buildChildEnv, else ~/.claude). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).normalize('NFC');
}

/** Project folder name the CLI uses for a cwd: every character other than A-Z, a-z and 0-9 becomes '-'. */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export interface SessionFile {
  path: string;
  /** Found in the project folder named after the given cwd. */
  inCwdFolder: boolean;
}

async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** `<configDir>/projects/<cwd folder>/<id>.jsonl`, else the first non-empty `<id>.jsonl` in any project folder. */
export async function findSessionFile(configDir: string, sessionId: string, cwd?: string): Promise<SessionFile | undefined> {
  const projects = join(configDir, 'projects');
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const folder = projectFolderName(cwd);
    const path = join(projects, folder, name);
    if (folder.length <= MAX_PROJECT_FOLDER && (await nonEmptyFile(path))) return { path, inCwdFolder: true };
  }
  const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const path = join(projects, folder.name, name);
    if (await nonEmptyFile(path)) return { path, inCwdFolder: false };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function parseLine(bytes: Buffer): RawEntry | undefined {
  if (bytes.length === 0) return undefined;
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(raw) && typeof raw.type === 'string' ? (raw as RawEntry) : undefined;
  } catch {
    return undefined;
  }
}

interface BoundaryInfo {
  logicalParent?: string;
  /** compactMetadata.preservedMessages: kept messages the SDK splices in after the summary. */
  kept?: { anchor?: string; uuids: string[] };
  /** compactMetadata.preservedSegment, used by the SDK only without preservedMessages. */
  segment?: { head: string; anchor: string; tail: string };
}

type Relink =
  | { kind: 'messages'; anchor: string; uuids: readonly string[] }
  | { kind: 'segment'; anchor: string; head: string; tail: string };

interface Entry {
  uuid: string;
  /** Byte range of the newest copy of the line. */
  offset: number;
  length: number;
  /** Offset of the oldest copy seen so far. */
  firstOffset: number;
  /** Position in scan order (newest copy first). */
  seq: number;
  type: string;
  parent: string | null;
  /** Parents of older copies that differ: the desktop app rewrites a compaction's preserved head under its summary. */
  otherParents?: Array<string | null>;
  /** Not a sidechain or team entry. */
  main: boolean;
  /** Can end the main chain (the SDK's leaf candidates). */
  capable: boolean;
  compactSummary: boolean;
  toolResult: boolean;
  messageId?: string;
  toolUses?: string[];
  boundary?: BoundaryInfo;
  /** Key of the queue removals that mark a queued_command attachment as delivered. */
  queueKey?: string;
}

function isMessage(entry: Entry): boolean {
  return entry.type === 'user' || entry.type === 'assistant';
}

function boundaryInfo(raw: RawEntry): BoundaryInfo {
  const meta = isRecord(raw.compactMetadata) ? raw.compactMetadata : {};
  const info: BoundaryInfo = {};
  const logicalParent = nonEmpty(raw.logicalParentUuid);
  if (logicalParent) info.logicalParent = logicalParent;
  if (isRecord(meta.preservedMessages)) {
    const kept = meta.preservedMessages;
    const anchor = nonEmpty(kept.anchorUuid);
    const uuids = Array.isArray(kept.uuids) ? kept.uuids.filter((uuid): uuid is string => typeof uuid === 'string') : [];
    info.kept = { ...(anchor ? { anchor } : {}), uuids };
  }
  if (isRecord(meta.preservedSegment)) {
    const head = nonEmpty(meta.preservedSegment.headUuid);
    const anchor = nonEmpty(meta.preservedSegment.anchorUuid);
    const tail = nonEmpty(meta.preservedSegment.tailUuid);
    if (head && anchor && tail) info.segment = { head, anchor, tail };
  }
  return info;
}

type SegmentRef = { kind: 'latest'; terminal: string } | { kind: 'older'; boundary: string };

interface SegmentWalk {
  leaf?: string;
  /** From the walk's start down to the leaf (exclusive), newest first. */
  trailing: string[];
  /** From the leaf to the segment's first entry, newest first. */
  chain: string[];
  /** The compact boundary that opens the segment, when there is one. */
  boundary?: string;
}

interface SegmentStart {
  uuid: string;
  inclusive: boolean;
  /** Parent of an exclusive start, used instead of its own. */
  parent?: string;
}

interface SegmentOutput {
  messages: SessionMessage[];
  agentIds: Map<string, string>;
  boundary?: string;
}

interface Cursor {
  ref: SegmentRef;
  end?: number;
}

function sessionTag(sessionId: string): string {
  return sessionId.slice(0, 8).toLowerCase();
}

function formatCursor(sessionId: string, ref: SegmentRef, end?: number): string | undefined {
  const uuid = ref.kind === 'latest' ? ref.terminal : ref.boundary;
  const cursor = `1:${sessionTag(sessionId)}:${ref.kind === 'latest' ? 'L' : 'B'}:${uuid}:${end ?? 'e'}`;
  return CURSOR_PATTERN.test(cursor) ? cursor : undefined;
}

function parseCursor(cursor: string, sessionId: string): Cursor {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new Error(INVALID_CURSOR);
  const [, tag = '', kind, uuid = '', end = 'e'] = match;
  if (tag !== sessionTag(sessionId)) throw new Error(FOREIGN_CURSOR);
  return {
    ref: kind === 'L' ? { kind: 'latest', terminal: uuid } : { kind: 'older', boundary: uuid },
    ...(end === 'e' ? {} : { end: Number(end) }),
  };
}

function contentOf(message: SessionMessage): unknown[] {
  const body = message.message as unknown;
  return isRecord(body) && Array.isArray(body.content) ? body.content : [];
}

function messageIdOf(message: SessionMessage): string | undefined {
  const body = message.message as unknown;
  return isRecord(body) ? nonEmpty(body.id) : undefined;
}

/** A page may start at `index` without parting a tool result or a split assistant message from what precedes it. */
function startsCleanly(messages: readonly SessionMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  if (message.type === 'user' && contentOf(message).some((block) => isRecord(block) && block.type === 'tool_result')) return false;
  const previous = messages[index - 1];
  if (message.type === 'assistant' && previous?.type === 'assistant') {
    const id = messageIdOf(message);
    if (id && id === messageIdOf(previous)) return false;
  }
  return true;
}

function cleanStart(messages: readonly SessionMessage[], from: number, stop: number): number {
  for (let index = from; index < stop; index++) if (startsCleanly(messages, index)) return index;
  return from;
}

function agentIdsOf(entries: Iterable<RawEntry>): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'user' || !isRecord(entry.toolUseResult)) continue;
    const agentId = nonEmpty(entry.toolUseResult.agentId);
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!agentId || !Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') ids.set(block.tool_use_id, agentId);
    }
  }
  return ids;
}

/**
 * Line index of one transcript file, built backwards from its end only as far as the walks need. Keeps byte ranges and
 * the few fields the chain walk needs; full entries are parsed again only for the segments being converted.
 */
class TranscriptIndex {
  private handle: FileHandle | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly ordered: string[] = [];
  private readonly children = new Map<string, string[]>();
  private readonly byMessageId = new Map<string, string[]>();
  private readonly resultsByToolUse = new Map<string, string[]>();
  private readonly bySourceTool = new Map<string, string[]>();
  /** Compact-summary uuid -> boundary uuid. */
  private readonly anchors = new Map<string, string>();
  private readonly relinks = new Map<string, Relink | null>();
  private readonly crossings = new Map<string, SegmentStart | null>();
  private readonly removals = new Map<string, number>();
  private readonly segments = new Map<string, SegmentOutput>();
  private leaf: { terminal: string; leaf: string } | null | undefined;
  private position: number;
  private pending: Buffer[] = [];
  private readonly chunkSize: number;

  constructor(size: number, chunkSize: number) {
    this.position = size;
    this.chunkSize = Math.max(1, Math.floor(chunkSize));
  }

  async withFile<T>(handle: FileHandle, run: () => Promise<T>): Promise<T> {
    this.handle = handle;
    try {
      return await run();
    } finally {
      this.handle = undefined;
    }
  }

  private async read(position: number, length: number): Promise<Buffer> {
    if (!this.handle) throw new Error('The session file is not open.');
    const buffer = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, position + done);
      if (bytesRead === 0) throw new Error('The session file changed while it was read.');
      done += bytesRead;
    }
    return buffer;
  }

  private takePending(head: Buffer): Buffer {
    if (this.pending.length === 0) return head;
    const line = Buffer.concat([head, ...this.pending]);
    this.pending = [];
    return line;
  }

  /** Indexes one more chunk towards the start of the file; false once everything is indexed. */
  private async scanChunk(): Promise<boolean> {
    if (this.position === 0) return false;
    const start = Math.max(0, this.position - this.chunkSize);
    const chunk = await this.read(start, this.position - start);
    let end = chunk.length;
    while (end > 0) {
      const newline = chunk.lastIndexOf(0x0a, end - 1);
      if (newline < 0) break;
      this.indexLine(start + newline + 1, this.takePending(chunk.subarray(newline + 1, end)));
      end = newline;
    }
    if (end > 0) this.pending.unshift(chunk.subarray(0, end));
    this.position = start;
    if (start === 0) this.indexLine(0, this.takePending(Buffer.alloc(0)));
    return true;
  }

  private indexLine(offset: number, bytes: Buffer): void {
    const raw = parseLine(bytes);
    if (!raw) return;
    if (raw.type === 'queue-operation') {
      this.countRemoval(raw);
      return;
    }
    const uuid = nonEmpty(raw.uuid);
    if (!uuid || !CHAIN_TYPES.has(raw.type)) return;
    const parent = nonEmpty(raw.parentUuid) ?? null;
    const known = this.entries.get(uuid);
    if (known) {
      known.firstOffset = offset;
      if (parent !== known.parent && !known.otherParents?.includes(parent)) (known.otherParents ??= []).push(parent);
      return;
    }
    const main = raw.isSidechain !== true && !raw.teamName;
    const attachment = raw.type === 'attachment' && isRecord(raw.attachment) ? raw.attachment : undefined;
    const entry: Entry = {
      uuid,
      offset,
      length: bytes.length,
      firstOffset: offset,
      seq: this.ordered.length,
      type: raw.type,
      parent,
      main,
      capable: main && raw.type !== 'progress' && attachment?.type !== 'fork_briefing',
      compactSummary: raw.isCompactSummary === true,
      toolResult: false,
    };
    const message = isRecord(raw.message) ? raw.message : undefined;
    const content: unknown[] = Array.isArray(message?.content) ? message.content : [];
    if (raw.type === 'assistant') {
      const id = nonEmpty(message?.id);
      if (id) {
        entry.messageId = id;
        push(this.byMessageId, id, uuid);
      }
      const uses = content.flatMap((block) => (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : []));
      if (uses.length > 0) entry.toolUses = uses;
    } else if (raw.type === 'user') {
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        entry.toolResult = true;
        push(this.resultsByToolUse, block.tool_use_id, uuid);
      }
      const source = nonEmpty(raw.sourceToolAssistantUUID);
      if (source) push(this.bySourceTool, source, uuid);
    } else if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
      entry.boundary = boundaryInfo(raw);
      const anchor = entry.boundary.kept?.anchor ?? entry.boundary.segment?.anchor;
      if (anchor && !this.anchors.has(anchor)) this.anchors.set(anchor, uuid);
    } else if (attachment?.type === 'queued_command') {
      const delivery = nonEmpty(attachment.delivery_id);
      const source = nonEmpty(attachment.source_uuid);
      if (delivery) entry.queueKey = `delivery:${delivery}`;
      else if (source) entry.queueKey = `uuid:${source}`;
    }
    this.entries.set(uuid, entry);
    this.ordered.push(uuid);
    if (parent) push(this.children, parent, uuid);
  }

  /** Queue removals the SDK counts to tell which queued prompts reached the model. */
  private countRemoval(raw: RawEntry): void {
    if (raw.operation !== 'remove' || raw.reason !== 'absorbed_mid_turn') return;
    const delivery = nonEmpty(raw.deliveryId);
    const key = delivery ? `delivery:${delivery}` : typeof raw.commandUuid === 'string' ? `uuid:${raw.commandUuid}` : undefined;
    if (key) this.removals.set(key, (this.removals.get(key) ?? 0) + 1);
  }

  private async ensure(uuid: string): Promise<Entry | undefined> {
    for (;;) {
      const entry = this.entries.get(uuid);
      if (entry || !(await this.scanChunk())) return entry;
    }
  }

  private async relinkOf(boundary: string): Promise<Relink | undefined> {
    const known = this.relinks.get(boundary);
    if (known !== undefined) return known ?? undefined;
    const info = this.entries.get(boundary)?.boundary;
    let relink: Relink | null = null;
    // As the SDK: preservedMessages wins even when it cannot be applied; preservedSegment counts only without it.
    if (info?.kept) {
      const { anchor, uuids } = info.kept;
      let complete = uuids.length > 0;
      for (const uuid of uuids) if (complete && !(await this.ensure(uuid))) complete = false;
      if (anchor && complete) relink = { kind: 'messages', anchor, uuids };
    } else if (info?.segment) {
      relink = { kind: 'segment', ...info.segment };
    }
    this.relinks.set(boundary, relink);
    return relink ?? undefined;
  }

  /** The relink of the boundary whose summary is `anchor`, if `anchor` is one. */
  private async relinkAt(anchor: string): Promise<Relink | undefined> {
    let boundary = this.anchors.get(anchor);
    if (!boundary) {
      let entry = await this.ensure(anchor);
      if (!entry?.compactSummary) return undefined;
      // Indexing up to the summary's own boundary registers it as an anchor.
      for (let depth = 0; entry?.parent && depth < MAX_SUMMARY_DEPTH && !this.anchors.has(anchor); depth++) {
        entry = await this.ensure(entry.parent);
      }
      boundary = this.anchors.get(anchor);
      if (!boundary) return undefined;
    }
    const relink = await this.relinkOf(boundary);
    return relink?.anchor === anchor ? relink : undefined;
  }

  /**
   * Parent stepping with the SDK's compaction relinking: a preserved run is walked in its recorded order after the
   * summary, and every other child of the summary continues from the run's tail.
   */
  private stepper(): (uuid: string, parent: string | null) => Promise<string | null> {
    let run: { uuids: readonly string[]; at: number; anchor: string } | undefined;
    let segment: { head: string; anchor: string } | undefined;
    return async (uuid, parent) => {
      if (run) {
        if (run.at > 0) return run.uuids[--run.at] ?? null;
        const { anchor } = run;
        run = undefined;
        return anchor;
      }
      if (segment && uuid === segment.head) {
        const { anchor } = segment;
        segment = undefined;
        return anchor;
      }
      if (!parent) return null;
      const relink = await this.relinkAt(parent);
      if (relink?.kind === 'messages' && uuid !== relink.uuids[0]) {
        run = { uuids: relink.uuids, at: relink.uuids.length - 1, anchor: parent };
        return relink.uuids[run.at] ?? null;
      }
      if (relink?.kind === 'segment' && uuid !== relink.head) {
        segment = { head: relink.head, anchor: parent };
        return relink.tail;
      }
      return parent;
    };
  }

  private hasCapableChild(uuid: string): boolean {
    return (this.children.get(uuid) ?? []).some((child) => this.entries.get(child)?.capable === true);
  }

  /**
   * The SDK's leaf: the newest chain end that is not a parent of another, walked up to its nearest user or assistant
   * entry. `terminal` is that chain end.
   */
  async findLeaf(): Promise<{ terminal: string; leaf: string } | undefined> {
    if (this.leaf !== undefined) return this.leaf ?? undefined;
    const visited = new Set<string>();
    for (let index = 0; ; index++) {
      while (index >= this.ordered.length) {
        if (!(await this.scanChunk())) {
          this.leaf = null;
          return undefined;
        }
      }
      const terminal = this.ordered[index] ?? '';
      if (!this.entries.get(terminal)?.capable || this.hasCapableChild(terminal)) continue;
      const next = this.stepper();
      const path: string[] = [];
      const seen = new Set<string>();
      let current: string | null = terminal;
      while (current && !visited.has(current) && !seen.has(current)) {
        const entry = await this.ensure(current);
        if (!entry) break;
        if (isMessage(entry)) {
          this.leaf = { terminal, leaf: current };
          return this.leaf;
        }
        seen.add(current);
        path.push(current);
        current = await next(current, entry.parent);
      }
      for (const uuid of path) visited.add(uuid);
    }
  }

  private async walk(start: SegmentStart): Promise<SegmentWalk> {
    const next = this.stepper();
    const walk: SegmentWalk = { trailing: [], chain: [] };
    const seen = new Set<string>();
    let current: string | null = start.uuid;
    if (!start.inclusive) {
      const first = await this.ensure(start.uuid);
      current = first ? await next(start.uuid, start.parent ?? first.parent) : null;
    }
    while (current && !seen.has(current)) {
      const entry = await this.ensure(current);
      if (!entry) break;
      seen.add(current);
      if (!walk.leaf && isMessage(entry)) walk.leaf = current;
      (walk.leaf ? walk.chain : walk.trailing).push(current);
      if (entry.parent === null && entry.boundary) {
        walk.boundary = current;
        break;
      }
      current = await next(current, entry.parent);
    }
    return walk;
  }

  /**
   * Where the segment before a compaction ends. The SDK shows the preserved run after the summary, so the older segment
   * continues from the preserved head's parent before the compaction; without a usable preserved run, from the logical
   * parent; without one in the file, from the last main entry written before the boundary (best effort).
   */
  private async crossing(boundary: string): Promise<SegmentStart | undefined> {
    const known = this.crossings.get(boundary);
    if (known !== undefined) return known ?? undefined;
    const start = await this.findCrossing(boundary);
    this.crossings.set(boundary, start ?? null);
    return start;
  }

  private async findCrossing(boundary: string): Promise<SegmentStart | undefined> {
    const entry = await this.ensure(boundary);
    if (!entry?.boundary) return undefined;
    const relink = await this.relinkOf(boundary);
    const head = relink ? (relink.kind === 'messages' ? relink.uuids[0] : relink.head) : undefined;
    if (relink && head && (await this.ensure(head))) {
      const parent = await this.originalParent(head, relink.anchor);
      if (parent === null) return undefined;
      if (parent !== undefined) return { uuid: head, inclusive: false, parent };
    }
    const logical = entry.boundary.logicalParent;
    if (logical && (await this.ensure(logical))) return { uuid: logical, inclusive: true };
    const before = await this.entryBefore(entry);
    return before ? { uuid: before, inclusive: true } : undefined;
  }

  /** The head's parent that is not the summary, scanning further back for an older copy when needed. */
  private async originalParent(head: string, anchor: string): Promise<string | null | undefined> {
    for (;;) {
      const entry = this.entries.get(head);
      if (!entry) return undefined;
      const found = [entry.parent, ...(entry.otherParents ?? [])].find((parent) => parent !== anchor);
      if (found !== undefined) return found;
      if (!(await this.scanChunk())) return undefined;
    }
  }

  private async entryBefore(boundary: Entry): Promise<string | undefined> {
    for (let index = boundary.seq + 1; ; index++) {
      while (index >= this.ordered.length) if (!(await this.scanChunk())) return undefined;
      const entry = this.entries.get(this.ordered[index] ?? '');
      if (entry && entry.main && entry.offset < boundary.firstOffset) return entry.uuid;
    }
  }

  /**
   * Entries the SDK attaches to the segment's assistant messages although they are off the chain: the other parts of a
   * split assistant message and the results of its parallel tool calls.
   */
  private related(chain: readonly string[], skip: ReadonlySet<string>): string[] {
    const found = new Set<string>();
    const add = (uuid: string): void => {
      if (!skip.has(uuid)) found.add(uuid);
    };
    const groups = new Set<string>();
    for (const uuid of chain) {
      const id = this.entries.get(uuid)?.messageId;
      if (!id || groups.has(id)) continue;
      groups.add(id);
      for (const member of this.byMessageId.get(id) ?? []) {
        add(member);
        for (const child of this.children.get(member) ?? []) if (this.entries.get(child)?.toolResult) add(child);
        for (const user of this.bySourceTool.get(member) ?? []) add(user);
        for (const use of this.entries.get(member)?.toolUses ?? []) for (const user of this.resultsByToolUse.get(use) ?? []) add(user);
      }
    }
    return [...found];
  }

  /** Entries after the leaf through non-message entries (where the SDK finds still-queued prompts). */
  private after(leaf: string, skip: ReadonlySet<string>): string[] {
    const found: string[] = [];
    const seen = new Set([leaf]);
    const queue = [leaf];
    for (let index = 0; index < queue.length; index++) {
      for (const child of this.children.get(queue[index] ?? '') ?? []) {
        const entry = this.entries.get(child);
        if (!entry || isMessage(entry) || seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
        if (!skip.has(child)) found.push(child);
      }
    }
    return found;
  }

  private queueOperations(uuids: readonly string[]): RawEntry[] {
    const keys = new Set<string>();
    for (const uuid of uuids) {
      const key = this.entries.get(uuid)?.queueKey;
      if (key) keys.add(key);
    }
    const operations: RawEntry[] = [];
    for (const key of keys) {
      const id = key.slice(key.indexOf(':') + 1);
      const target = key.startsWith('delivery:') ? { deliveryId: id } : { commandUuid: id };
      for (let count = this.removals.get(key) ?? 0; count > 0; count--) {
        operations.push({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', ...target });
      }
    }
    return operations;
  }

  /** Parses the given entries again from the file, reading neighbouring lines in one go. */
  private async readEntries(uuids: readonly string[]): Promise<Map<string, RawEntry>> {
    const wanted = uuids.flatMap((uuid) => this.entries.get(uuid) ?? []).sort((a, b) => a.offset - b.offset);
    const found = new Map<string, RawEntry>();
    for (let first = 0; first < wanted.length; ) {
      const start = wanted[first]?.offset ?? 0;
      let end = start + (wanted[first]?.length ?? 0);
      let last = first + 1;
      for (; last < wanted.length; last++) {
        const entry = wanted[last];
        if (!entry || entry.offset - end > MAX_READ_GAP || entry.offset + entry.length - start > MAX_READ_RANGE) break;
        end = Math.max(end, entry.offset + entry.length);
      }
      const buffer = await this.read(start, end - start);
      for (let index = first; index < last; index++) {
        const entry = wanted[index];
        if (!entry) continue;
        const raw = parseLine(buffer.subarray(entry.offset - start, entry.offset - start + entry.length));
        if (raw) found.set(entry.uuid, raw);
      }
      first = last;
    }
    return found;
  }

  private async segment(ref: SegmentRef, convert: ConvertEntries): Promise<SegmentOutput> {
    const key = ref.kind === 'latest' ? `L${ref.terminal}` : `B${ref.boundary}`;
    const cached = this.segments.get(key);
    if (cached) {
      this.segments.delete(key);
      this.segments.set(key, cached);
      return cached;
    }
    const output = await this.convertSegment(ref, convert);
    this.segments.set(key, output);
    for (const oldest of this.segments.keys()) {
      if (this.segments.size <= SEGMENT_CACHE) break;
      this.segments.delete(oldest);
    }
    return output;
  }

  private async convertSegment(ref: SegmentRef, convert: ConvertEntries): Promise<SegmentOutput> {
    let walk: SegmentWalk;
    const hidden = new Set<string>();
    if (ref.kind === 'latest') {
      walk = await this.walk({ uuid: ref.terminal, inclusive: true });
    } else {
      const start = await this.crossing(ref.boundary);
      if (!start) return { messages: [], agentIds: new Map() };
      walk = await this.walk(start);
      const newer = await this.relinkOf(ref.boundary);
      // The newer segment already shows its preserved run.
      if (newer?.kind === 'messages') for (const uuid of newer.uuids) hidden.add(uuid);
    }
    const leaf = walk.leaf;
    const boundary = walk.boundary ? { boundary: walk.boundary } : {};
    if (!leaf) return { messages: [], agentIds: new Map(), ...boundary };
    const latest = ref.kind === 'latest';
    const taken = new Set([...walk.chain, ...walk.trailing, ...hidden]);
    const related = this.related(walk.chain, taken);
    for (const uuid of related) taken.add(uuid);
    const byOffset = (a: string, b: string): number => (this.entries.get(a)?.offset ?? 0) - (this.entries.get(b)?.offset ?? 0);
    // Off-chain entries first, then the chain oldest first: the SDK takes the newest chain end as the leaf.
    const order = [
      ...related.sort(byOffset),
      ...[...walk.chain].reverse(),
      ...(latest ? [...walk.trailing].reverse() : []),
      ...(latest ? this.after(leaf, taken).sort(byOffset) : []),
    ];
    const raws = await this.readEntries(order);
    const entries = order.flatMap((uuid) => raws.get(uuid) ?? []);
    const pageEnd: RawEntry = { type: 'attachment', uuid: PAGE_END_UUID, parentUuid: leaf, isSidechain: false, attachment: { type: 'relay_page_end' } };
    const messages = await convert([...this.queueOperations(order), ...entries, pageEnd]);
    return { messages, agentIds: agentIdsOf(entries), ...boundary };
  }

  async page(request: PageRequest): Promise<TranscriptPage> {
    const { sessionId, before, pageSize, convert } = request;
    let ref: SegmentRef;
    let end: number | undefined;
    if (before === undefined) {
      const leaf = await this.findLeaf();
      if (!leaf) return { messages: [], agentIds: {} };
      ref = { kind: 'latest', terminal: leaf.terminal };
    } else {
      const cursor = parseCursor(before, sessionId);
      const uuid = cursor.ref.kind === 'latest' ? cursor.ref.terminal : cursor.ref.boundary;
      const entry = await this.ensure(uuid);
      if (!entry || (cursor.ref.kind === 'older' && !entry.boundary)) throw new Error(STALE_CURSOR);
      ref = cursor.ref;
      end = cursor.end;
    }
    const parts: SessionMessage[][] = [];
    const agentIds = new Map<string, string>();
    const visited = new Set<string>();
    let remaining = Math.max(1, Math.floor(pageSize));
    let older: string | undefined;
    for (;;) {
      const key = ref.kind === 'latest' ? `L${ref.terminal}` : `B${ref.boundary}`;
      if (visited.has(key)) break;
      visited.add(key);
      const segment = await this.segment(ref, convert);
      const stop = end === undefined ? segment.messages.length : Math.min(end, segment.messages.length);
      let from = Math.max(0, stop - remaining);
      if (from > 0) from = cleanStart(segment.messages, from, stop);
      parts.unshift(segment.messages.slice(from, stop));
      for (const [toolUseId, agentId] of segment.agentIds) agentIds.set(toolUseId, agentId);
      remaining -= stop - from;
      if (from > 0) {
        older = formatCursor(sessionId, ref, from);
        break;
      }
      if (!segment.boundary || !(await this.crossing(segment.boundary))) break;
      const next: SegmentRef = { kind: 'older', boundary: segment.boundary };
      if (remaining <= 0) {
        older = formatCursor(sessionId, next);
        break;
      }
      ref = next;
      end = undefined;
    }
    const messages = parts.flat();
    const onPage = new Set<string>();
    for (const message of messages) {
      for (const block of contentOf(message)) if (isRecord(block) && typeof block.tool_use_id === 'string') onPage.add(block.tool_use_id);
    }
    return {
      messages,
      ...(older ? { older } : {}),
      agentIds: Object.fromEntries([...agentIds].filter(([toolUseId]) => onPage.has(toolUseId))),
    };
  }
}

/**
 * Pages saved sessions. Keeps the index of the most recently read file (keyed by path, size and modification time),
 * so an older page continues where the previous one stopped; requests run one at a time.
 */
export function createHistoryPager(options: { chunkSize?: number } = {}): HistoryPager {
  const chunkSize = options.chunkSize ?? READ_CHUNK_BYTES;
  let cached: { key: string; index: TranscriptIndex } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (request: PageRequest): Promise<TranscriptPage> => {
    const info = await stat(request.file);
    const key = `${request.file}\u0000${info.size}\u0000${info.mtimeMs}`;
    if (cached?.key !== key) cached = { key, index: new TranscriptIndex(info.size, chunkSize) };
    const { index } = cached;
    const handle = await open(request.file, 'r');
    try {
      return await index.withFile(handle, () => index.page(request));
    } catch (error) {
      if (cached?.index === index && !(error instanceof Error && [INVALID_CURSOR, FOREIGN_CURSOR, STALE_CURSOR].includes(error.message))) {
        cached = undefined;
      }
      throw error;
    } finally {
      await handle.close();
    }
  };
  return {
    page(request) {
      const result = queue.then(() => run(request));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
