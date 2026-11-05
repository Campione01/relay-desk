// Worker-side listing logic. No Electron or main-process imports: the utilityProcess bundle loads it.
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions,
  ListSessionsOptions,
  SDKSessionInfo,
  SessionMessage,
  SessionMutationOptions,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { HISTORY_PAGE_MESSAGES, type SessionSummary } from '@shared/types';
import type { ListingRequest, ListingResponse } from './listing';
import { asToolResult, asToolUse, isRecord } from './mapTranscript';
import { redactSecrets } from './redaction';
import {
  claudeConfigDir,
  createHistoryPager,
  findSessionFile,
  INVALID_CURSOR,
  SESSION_FILE_ID,
  STALE_CURSOR,
  type HistoryPager,
  type RawEntry,
} from './transcriptReader';

/** The SDK session helpers the worker uses (injectable for tests). */
export interface ListingSdk {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  getSubagentMessages(sessionId: string, agentId: string, options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;
  renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void>;
  forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
  deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void>;
}

/** What the worker reads history with besides the SDK (injectable for tests). */
export interface ListingContext {
  /** The profile's config folder; by default the one this process's CLAUDE_CONFIG_DIR names. */
  configDir?: string;
  pager?: HistoryPager;
  /** Main-thread messages per page; HISTORY_PAGE_MESSAGES by default. */
  pageSize?: number;
}

/** Subagent transcripts read per history page (and per task list). */
export const MAX_SUBAGENTS = 50;
/** Newest messages returned for one subagent's own transcript. */
export const MAX_SUBAGENT_MESSAGES = 2000;
export const MAX_TITLE_LENGTH = 200;

/** Result of the `history` op (task list): main derives tasks from it. */
export interface HistoryResult {
  messages: SessionMessage[];
}

/** Result of the `page` op: main maps it with mapSessionMessages. */
export interface HistoryPageResult {
  /** The page's main-thread messages, oldest first, then the messages of its subagents. */
  messages: SessionMessage[];
  older?: string;
}

const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const AGENT_ID_TEXT = /\bagentId:\s*([A-Za-z0-9_-]{1,100})/;

let sharedPager: HistoryPager | undefined;

/** SDKSessionInfo -> SessionSummary; title = customTitle, else summary, else first prompt. */
export function toSessionSummary(info: SDKSessionInfo): SessionSummary {
  const title = [info.customTitle, info.summary, info.firstPrompt].map((t) => t?.trim() ?? '').find(Boolean) ?? '';
  return {
    sessionId: info.sessionId,
    title,
    cwd: info.cwd ?? '',
    lastModified: info.lastModified,
    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
    ...(info.fileSize !== undefined ? { fileSize: info.fileSize } : {}),
    ...(info.tag ? { tag: info.tag } : {}),
  };
}

/** Newest first. */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
}

function dirOption(cwd: string | undefined): { dir?: string } {
  return cwd ? { dir: cwd } : {};
}

function contentOf(message: SessionMessage): unknown[] {
  const body = message.message as unknown;
  return isRecord(body) && Array.isArray(body.content) ? body.content : [];
}

/**
 * Subagents started by the Agent/Task calls among `messages`: the id the raw tool result recorded (`known`, by tool
 * use id), else the `agentId:` its text reports.
 */
export function agentIdsFor(messages: readonly SessionMessage[], known: Readonly<Record<string, string>> = {}): string[] {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of contentOf(message)) {
      const use = asToolUse(block);
      if (use && AGENT_TOOLS.has(use.name)) calls.add(use.id);
    }
  }
  const ids: string[] = [];
  for (const message of messages) {
    if (message.type !== 'user') continue;
    for (const block of contentOf(message)) {
      const result = asToolResult(block);
      if (!result || !calls.has(result.toolUseId)) continue;
      const agentId = Object.hasOwn(known, result.toolUseId) ? known[result.toolUseId] : AGENT_ID_TEXT.exec(result.text)?.[1];
      if (agentId && !ids.includes(agentId)) ids.push(agentId);
    }
  }
  return ids;
}

/**
 * Messages of the subagents the given messages started (and of the ones those started), never of unrelated ones;
 * newest calls first, which are the first seen when MAX_SUBAGENTS leaves some out.
 */
async function relatedSubagents(
  sdk: ListingSdk,
  sessionId: string,
  messages: readonly SessionMessage[],
  known: Readonly<Record<string, string>>,
  cwd: string | undefined,
): Promise<SessionMessage[]> {
  const queue = agentIdsFor(messages, known).reverse();
  const seen = new Set(queue);
  const placed: SessionMessage[] = [];
  for (let index = 0; index < queue.length && index < MAX_SUBAGENTS; index++) {
    const agentId = queue[index] ?? '';
    const sub = await sdk.getSubagentMessages(sessionId, agentId, dirOption(cwd)).catch(() => [] as SessionMessage[]);
    // Without the sidecar's tool id a subagent message cannot be placed; never show it as main-thread text.
    const own = sub.filter((message) => Boolean(message.parent_tool_use_id));
    placed.push(...own);
    for (const nested of agentIdsFor(own)) {
      if (seen.has(nested)) continue;
      seen.add(nested);
      queue.push(nested);
    }
  }
  return placed;
}

async function readHistory(sdk: ListingSdk, sessionId: string, cwd: string | undefined): Promise<HistoryResult> {
  let messages = await sdk.getSessionMessages(sessionId, { ...dirOption(cwd), includeSystemMessages: true });
  let folder = cwd;
  // A cwd spelled differently from the transcript's project folder finds nothing; search every project instead.
  if (messages.length === 0 && cwd) {
    messages = await sdk.getSessionMessages(sessionId, { includeSystemMessages: true });
    folder = undefined;
  }
  return { messages: [...messages, ...(await relatedSubagents(sdk, sessionId, messages, {}, folder))] };
}

/** The SDK's own conversion over entries the transcript reader picked (an in-memory session store). */
function memoryStore(entries: readonly RawEntry[]): SessionStore {
  return {
    append: async () => undefined,
    load: async () => [...entries] as SessionStoreEntry[],
  };
}

/**
 * The SDK's messages drop each row's parent link (and an older build the timestamp); a local command's running time needs
 * both, so they are carried through from the raw entries of the same rows. So is the text of a system `local_command` row
 * (CLI 2.1.308 writes /rename's rows that way), which the SDK drops too; other system rows keep what the SDK gives.
 */
function withTranscriptLinks(messages: SessionMessage[], entries: readonly RawEntry[]): SessionMessage[] {
  const raw = new Map(entries.flatMap((entry) => (typeof entry.uuid === 'string' ? [[entry.uuid, entry] as const] : [])));
  return messages.map((message) => {
    const entry = raw.get(message.uuid);
    const parentUuid = typeof entry?.parentUuid === 'string' ? entry.parentUuid : undefined;
    const timestamp = typeof (message as { timestamp?: unknown }).timestamp !== 'string' && typeof entry?.timestamp === 'string' ? entry.timestamp : undefined;
    const content = message.type === 'system' && entry?.subtype === 'local_command' && typeof entry.content === 'string' ? entry.content : undefined;
    return parentUuid || timestamp || content !== undefined
      ? { ...message, ...(parentUuid ? { parentUuid } : {}), ...(timestamp ? { timestamp } : {}), ...(content !== undefined ? { subtype: 'local_command', content } : {}) }
      : message;
  });
}

async function readHistoryPage(
  sdk: ListingSdk,
  context: ListingContext,
  sessionId: string,
  cwd: string | undefined,
  before: unknown,
): Promise<HistoryPageResult> {
  if (!SESSION_FILE_ID.test(sessionId)) throw new Error('Invalid session id.');
  if (before !== undefined && typeof before !== 'string') throw new Error(INVALID_CURSOR);
  const file = await findSessionFile(context.configDir ?? claudeConfigDir(), sessionId, cwd);
  if (!file) {
    if (before !== undefined) throw new Error(STALE_CURSOR);
    return { messages: [] };
  }
  const pager = context.pager ?? (sharedPager ??= createHistoryPager());
  const page = await pager.page({
    file: file.path,
    sessionId,
    ...(before !== undefined ? { before } : {}),
    pageSize: context.pageSize ?? HISTORY_PAGE_MESSAGES,
    convert: async (entries) =>
      withTranscriptLinks(await sdk.getSessionMessages(sessionId, { includeSystemMessages: true, sessionStore: memoryStore(entries) }), entries),
  });
  const subagents = await relatedSubagents(sdk, sessionId, page.messages, page.agentIds, file.inCwdFolder ? cwd : undefined);
  return { messages: [...page.messages, ...subagents], ...(page.older ? { older: page.older } : {}) };
}

/** Runs a session change in the given folder; a folder spelled differently from the transcript's finds nothing, so a
 * failure there is retried across every project. */
async function inFolder<T>(cwd: string | undefined, run: (options: { dir?: string }) => Promise<T>): Promise<T> {
  if (!cwd) return run({});
  try {
    return await run(dirOption(cwd));
  } catch {
    return run({});
  }
}

/** Serves one request; never throws. */
export async function runListingRequest(request: ListingRequest, sdk: ListingSdk, context: ListingContext = {}): Promise<ListingResponse> {
  const id = typeof request?.id === 'number' ? request.id : -1;
  try {
    switch (request.op) {
      case 'list': {
        const sessions = await sdk.listSessions({ includeProgrammatic: true });
        return { id, ok: true, result: sortSessions(sessions.map(toSessionSummary)) };
      }
      case 'history': {
        if (!request.sessionId) throw new Error('No session id given.');
        return { id, ok: true, result: await readHistory(sdk, request.sessionId, request.cwd) };
      }
      case 'page': {
        if (!request.sessionId) throw new Error('No session id given.');
        return { id, ok: true, result: await readHistoryPage(sdk, context, request.sessionId, request.cwd, request.before) };
      }
      case 'subagent': {
        if (!request.sessionId || !request.agentId) throw new Error('No session or agent id given.');
        let messages = await sdk.getSubagentMessages(request.sessionId, request.agentId, dirOption(request.cwd));
        if (messages.length === 0 && request.cwd) messages = await sdk.getSubagentMessages(request.sessionId, request.agentId);
        return { id, ok: true, result: { messages: messages.slice(-MAX_SUBAGENT_MESSAGES) } satisfies HistoryResult };
      }
      case 'fork': {
        if (!request.sessionId) throw new Error('No session id given.');
        const sessionId = request.sessionId;
        const forked = await inFolder(request.cwd, (options) => sdk.forkSession(sessionId, options));
        return { id, ok: true, result: { sessionId: forked.sessionId } };
      }
      case 'delete': {
        if (!request.sessionId) throw new Error('No session id given.');
        const sessionId = request.sessionId;
        await inFolder(request.cwd, (options) => sdk.deleteSession(sessionId, options));
        return { id, ok: true, result: null };
      }
      case 'rename': {
        const title = request.title?.trim() ?? '';
        if (!request.sessionId) throw new Error('No session id given.');
        if (!title || title.length > MAX_TITLE_LENGTH) throw new Error(`A title needs 1 to ${MAX_TITLE_LENGTH} characters.`);
        await sdk.renameSession(request.sessionId, title, dirOption(request.cwd));
        return { id, ok: true, result: null };
      }
      default:
        throw new Error(`Unknown listing request: ${String((request as { op?: unknown }).op)}`);
    }
  } catch (error) {
    return { id, ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}
