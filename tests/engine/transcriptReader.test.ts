import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { mapSessionMessages } from '../../src/main/engine/mapTranscript';
import {
  claudeConfigDir,
  createHistoryPager,
  findSessionFile,
  FOREIGN_CURSOR,
  INVALID_CURSOR,
  projectFolderName,
  STALE_CURSOR,
  type RawEntry,
  type TranscriptPage,
} from '../../src/main/engine/transcriptReader';

// Synthetic transcripts in a temp config folder only; the real ~/.claude is never read.
const CWD = 'D:\\work\\pages';
let configDir = '';
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'relay-history-'));
  // The parity checks call the SDK's own file reader, which must only see this folder.
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterAll(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

type Line = Record<string, unknown>;

class Transcript {
  readonly lines: Line[] = [];
  private time = Date.UTC(2026, 8, 1, 8);

  constructor(readonly sessionId: string) {}

  entry(type: string, uuid: string, parentUuid: string | null, extra: Line = {}): Line {
    this.time += 1000;
    const line = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: CWD,
      sessionId: this.sessionId,
      version: '2.1.302',
      type,
      uuid,
      timestamp: new Date(this.time).toISOString(),
      ...extra,
    };
    this.lines.push(line);
    return line;
  }

  user(uuid: string, parent: string | null, content: unknown, extra: Line = {}): Line {
    return this.entry('user', uuid, parent, { message: { role: 'user', content }, ...extra });
  }

  assistant(uuid: string, parent: string | null, content: string | unknown[], messageId = `msg_${uuid}`): Line {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return this.entry('assistant', uuid, parent, {
      message: { id: messageId, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: blocks, stop_reason: 'end_turn' },
    });
  }

  attachment(uuid: string, parent: string | null, attachment: Line): Line {
    return this.entry('attachment', uuid, parent, { attachment });
  }

  boundary(uuid: string, options: { logical?: string; kept?: { anchor: string; uuids: string[] }; segment?: { head: string; anchor: string; tail: string } } = {}): Line {
    return this.entry('system', uuid, null, {
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      ...(options.logical ? { logicalParentUuid: options.logical } : {}),
      compactMetadata: {
        trigger: 'auto',
        preTokens: 1000,
        ...(options.kept ? { preservedMessages: { anchorUuid: options.kept.anchor, uuids: options.kept.uuids } } : {}),
        ...(options.segment
          ? { preservedSegment: { headUuid: options.segment.head, anchorUuid: options.segment.anchor, tailUuid: options.segment.tail } }
          : {}),
      },
    });
  }

  summary(uuid: string, parent: string): Line {
    return this.user(uuid, parent, 'This session is being continued from a previous conversation.', {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    });
  }

  /** A later copy of an entry, as the desktop app writes when it resumes a session. */
  copy(uuid: string, changes: Line = {}): void {
    const line = this.lines.findLast((candidate) => candidate.uuid === uuid);
    if (!line) throw new Error(`no line ${uuid}`);
    this.lines.push({ ...line, ...changes });
  }

  raw(line: Line): void {
    this.lines.push(line);
  }

  text(): string {
    return `${this.lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  }

  async write(folder = projectFolderName(CWD)): Promise<string> {
    const dir = join(configDir, 'projects', folder);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${this.sessionId}.jsonl`);
    await writeFile(file, this.text());
    return file;
  }
}

const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const result = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });

const convertFor =
  (sessionId: string) =>
  (entries: RawEntry[]): Promise<SessionMessage[]> =>
    getSessionMessages(sessionId, {
      includeSystemMessages: true,
      sessionStore: { append: async () => undefined, load: async () => entries as never },
    });

async function allPages(file: string, sessionId: string, pageSize: number, chunkSize?: number): Promise<TranscriptPage[]> {
  const pager = createHistoryPager(chunkSize ? { chunkSize } : {});
  const pages: TranscriptPage[] = [];
  let before: string | undefined;
  do {
    const page = await pager.page({ file, sessionId, ...(before ? { before } : {}), pageSize, convert: convertFor(sessionId) });
    pages.push(page);
    before = page.older;
  } while (before && pages.length < 100);
  return pages;
}

const uuids = (messages: readonly SessionMessage[]): string[] => messages.map((message) => message.uuid);
const oldestFirst = (pages: readonly TranscriptPage[]): SessionMessage[] => [...pages].reverse().flatMap((page) => page.messages);
const texts = (items: readonly TranscriptItem[]): string[] =>
  items.map((item) => (item.kind === 'tool' ? `tool:${item.id}:${item.status}:${item.output ?? ''}` : `${item.kind}:${item.text}`));

/**
 * Three compaction segments: the first compaction has only a logical parent, the second keeps two messages
 * (preservedMessages) and the desktop app later rewrote that segment with the head under the summary.
 */
function threeSegments(sessionId: string): Transcript {
  const t = new Transcript(sessionId);
  t.user('u1', null, 'First prompt');
  t.assistant('a1', 'u1', 'Answer one');
  t.user('u2', 'a1', 'Run the checks');
  t.assistant('a2a', 'u2', [bash('t1', 'npm test')], 'msg_a2');
  t.assistant('a2b', 'a2a', [bash('t2', 'npm run lint')], 'msg_a2');
  // Parallel calls: the first result hangs off its own call, off the chain.
  t.user('r1', 'a2a', [result('t1', 'tests ok')], { sourceToolAssistantUUID: 'a2a' });
  t.user('r2', 'a2b', [result('t2', 'lint ok')], { sourceToolAssistantUUID: 'a2b' });
  t.entry('system', 'h0', 'r2', { subtype: 'stop_hook_summary', content: 'Hooks ran', level: 'info' });
  t.assistant('a3', 'h0', 'Checks pass');
  t.raw({ type: 'custom-title', customTitle: 'Pages', sessionId });
  t.boundary('b1', { logical: 'a3' });
  t.summary('s1', 'b1');
  t.user('u3', 's1', 'Third prompt');
  t.attachment('q1', 'u3', { type: 'queued_command', prompt: 'Also check the logs', commandMode: 'prompt' });
  t.assistant('a4', 'q1', 'Answer three');
  t.user('u4', 'a4', 'Fourth prompt');
  t.assistant('a5', 'u4', 'Answer four');
  t.boundary('b2', { logical: 'a5', kept: { anchor: 's2', uuids: ['u4', 'a5'] }, segment: { head: 'u4', anchor: 's2', tail: 'a5' } });
  t.attachment('at1', 'b2', { type: 'date' });
  t.summary('s2', 'at1');
  t.attachment('at2', 's2', { type: 'environment' });
  t.user('u5', 'at2', 'Fifth prompt');
  t.assistant('a6', 'u5', 'Answer five');
  for (const uuid of ['b2', 'at1', 's2']) t.copy(uuid);
  t.copy('u4', { parentUuid: 's2' });
  t.copy('a5');
  t.copy('at2', { parentUuid: 'a5' });
  t.copy('u5');
  t.copy('a6');
  // A rewind: the first try is older in the file, the second try is the session's leaf.
  t.user('u6x', 'a6', 'Sixth prompt, first try');
  t.assistant('a7x', 'u6x', 'Abandoned answer');
  t.user('u6', 'a6', 'Sixth prompt');
  t.entry('progress', 'p1', 'u6', { data: { type: 'hook_progress' } });
  t.assistant('a7', 'p1', 'Answer six');
  t.attachment('at3', 'a7', { type: 'total_tokens_reminder' });
  // Still queued when the session was left: the SDK shows it after the last message.
  t.attachment('q2', 'at3', { type: 'queued_command', prompt: 'Then deploy', commandMode: 'prompt' });
  // The newest chain line is a sidechain one, which never ends the main chain.
  t.user('side', 'a7', 'Subagent prompt in the main file', { isSidechain: true });
  t.raw({ type: 'last-prompt', lastPrompt: 'Sixth prompt', sessionId });
  return t;
}

const THREE_SEGMENTS = ['u1', 'a1', 'u2', 'a2a', 'a2b', 'r1', 'r2', 'h0', 'a3', 'b1', 's1', 'u3', 'q1', 'a4', 'b2', 's2', 'u4', 'a5', 'u5', 'a6', 'u6', 'a7', 'q2'];

describe('transcript reader across compactions', () => {
  const sessionId = '5e55a0b1-0000-4000-8000-000000000001';
  let file = '';

  beforeAll(async () => {
    file = await threeSegments(sessionId).write();
  });

  it('pages from the newest messages to the session start, oldest first, without gaps or duplicates', async () => {
    const pages = await allPages(file, sessionId, 4);
    expect(pages.map((page) => uuids(page.messages))).toEqual([
      ['a6', 'u6', 'a7', 'q2'],
      ['s2', 'u4', 'a5', 'u5'],
      ['u3', 'q1', 'a4', 'b2'],
      ['h0', 'a3', 'b1', 's1'],
      ['a2a', 'a2b', 'r1', 'r2'],
      ['u1', 'a1', 'u2'],
    ]);
    expect(pages.slice(0, -1).every((page) => typeof page.older === 'string' && page.older.length <= 512)).toBe(true);
    expect(pages.at(-1)).not.toHaveProperty('older');
    expect(uuids(oldestFirst(pages))).toEqual(THREE_SEGMENTS);
  });

  it('ends the newest page with exactly what the SDK reads after the last compaction', async () => {
    const [page] = await allPages(file, sessionId, 2000);
    const sdk = await getSessionMessages(sessionId, { includeSystemMessages: true });
    expect(uuids(sdk)).toEqual(['b2', 's2', 'u4', 'a5', 'u5', 'a6', 'u6', 'a7', 'q2']);
    expect(page?.messages.slice(-sdk.length)).toEqual(sdk);
    expect(uuids(page?.messages ?? [])).toEqual(THREE_SEGMENTS);
    expect(page).not.toHaveProperty('older');
  });

  it('keeps a still-queued prompt that hangs off the last message beside the newest chain end', async () => {
    const t = new Transcript('5e55a0b1-0000-4000-8000-000000000003');
    t.user('u1', null, 'First prompt');
    t.assistant('a1', 'u1', 'Answer one');
    t.attachment('q1', 'a1', { type: 'queued_command', prompt: 'Then deploy', commandMode: 'prompt' });
    t.attachment('at1', 'a1', { type: 'total_tokens_reminder' });
    const [page] = await allPages(await t.write(), t.sessionId, 2000);
    const sdk = await getSessionMessages(t.sessionId, { includeSystemMessages: true });
    expect(uuids(sdk)).toEqual(['u1', 'a1', 'q1']);
    expect(page?.messages).toEqual(sdk);
  });

  // One-byte chunks make thousands of reads: about 0.6 s alone, but much slower while the full suite loads the disk.
  it('reads the same pages when chunk boundaries split every line', async () => {
    const normal = await allPages(file, sessionId, 3);
    for (const chunkSize of [1, 7, 64]) expect(await allPages(file, sessionId, 3, chunkSize)).toEqual(normal);
  }, 30_000);

  it('maps every page like the newest one: one compaction row per compaction, queued prompts and parallel results kept', async () => {
    const pages = await allPages(file, sessionId, 4);
    const items = [...pages].reverse().flatMap((page) => mapSessionMessages(page.messages, { settleOpenTools: true }));
    expect(texts(items)).toEqual([
      'user:First prompt',
      'assistant:Answer one',
      'user:Run the checks',
      'tool:t1:done:tests ok',
      'tool:t2:done:lint ok',
      'assistant:Checks pass',
      'system:Conversation compacted',
      'user:Third prompt',
      'user:Also check the logs',
      'assistant:Answer three',
      'system:Conversation compacted',
      'user:Fourth prompt',
      'assistant:Answer four',
      'user:Fifth prompt',
      'assistant:Answer five',
      'user:Sixth prompt',
      'assistant:Answer six',
      'user:Then deploy',
    ]);
    expect(JSON.stringify(items)).not.toMatch(/first try|Abandoned|Subagent prompt/);
  });

  it('refuses malformed, foreign and stale cursors with a clear error', async () => {
    const pager = createHistoryPager();
    const page = (before: string) => pager.page({ file, sessionId, before, pageSize: 4, convert: convertFor(sessionId) });
    const [first] = await allPages(file, sessionId, 4);
    expect(first?.older).toBe('1:5e55a0b1:L:q2:5');
    for (const before of ['', 'garbage', '1:5e55a0b1:L:q2:0', '1:5e55a0b1:X:q2:5', '1:5e55a0b1:L:q 2:5', '2:5e55a0b1:L:q2:5']) {
      await expect(page(before)).rejects.toThrow(INVALID_CURSOR);
    }
    await expect(page('1:aaaaaaaa:L:q2:5')).rejects.toThrow(FOREIGN_CURSOR);
    await expect(page('1:5e55a0b1:B:unknown-uuid:e')).rejects.toThrow(STALE_CURSOR);
    await expect(page('1:5e55a0b1:B:a3:e')).rejects.toThrow(STALE_CURSOR);
    await expect(page(first?.older ?? '')).resolves.toMatchObject({ messages: [{ uuid: 's2' }, { uuid: 'u4' }, { uuid: 'a5' }, { uuid: 'u5' }] });
  });

  it('reads the raw agent ids of the Agent calls on a page', async () => {
    const t = new Transcript('5e55a0b1-0000-4000-8000-000000000002');
    t.user('u1', null, 'Review it');
    t.assistant('a1', 'u1', [{ type: 'tool_use', id: 'toolu_old', name: 'Agent', input: { description: 'Old review' } }]);
    t.user('r1', 'a1', [result('toolu_old', 'Old review done.')], { toolUseResult: { agentId: 'a1111111111111111', status: 'completed' } });
    t.assistant('a2', 'r1', 'Done');
    t.user('u2', 'a2', 'Again');
    t.assistant('a3', 'u2', [{ type: 'tool_use', id: 'toolu_new', name: 'Agent', input: { description: 'New review' } }]);
    t.user('r2', 'a3', [result('toolu_new', 'New review done.')], { toolUseResult: { agentId: 'a2222222222222222', status: 'completed' } });
    t.assistant('a4', 'r2', 'Done again');
    const pages = await allPages(await t.write(), t.sessionId, 4);
    expect(pages.map((page) => page.agentIds)).toEqual([{ toolu_new: 'a2222222222222222' }, { toolu_old: 'a1111111111111111' }]);
  });
});

describe('transcript reader compaction forms', () => {
  it('continues before a boundary without a usable logical parent from the last main entry written before it', async () => {
    for (const [index, logical] of [undefined, 'not-in-the-file'].entries()) {
      const t = new Transcript(`5e55a0b1-0000-4000-8000-00000000001${index}`);
      t.user('u1', null, 'Start');
      t.assistant('a1', 'u1', 'Reply');
      t.user('side', 'a1', 'Sidechain line', { isSidechain: true });
      t.boundary('b1', logical ? { logical } : {});
      t.summary('s1', 'b1');
      t.user('u2', 's1', 'Next');
      t.assistant('a2', 'u2', 'Reply two');
      const pages = await allPages(await t.write(), t.sessionId, 3);
      expect(uuids(oldestFirst(pages))).toEqual(['u1', 'a1', 'b1', 's1', 'u2', 'a2']);
    }
  });

  it('follows the SDK for preserved messages, a preserved segment and preserved messages it cannot apply', async () => {
    // As the CLI writes a compaction: the kept messages stay before the boundary and the SDK splices them in.
    const kept = new Transcript('5e55a0b1-0000-4000-8000-000000000022');
    kept.user('u1', null, 'Start');
    kept.assistant('a1', 'u1', 'Reply');
    kept.user('u2', 'a1', 'Kept prompt');
    kept.assistant('a2', 'u2', 'Kept reply');
    kept.boundary('b1', { logical: 'a2', kept: { anchor: 's1', uuids: ['u2', 'a2'] }, segment: { head: 'u2', anchor: 's1', tail: 'a2' } });
    kept.summary('s1', 'b1');
    kept.attachment('at1', 's1', { type: 'date' });
    kept.user('u3', 'at1', 'After');
    kept.assistant('a3', 'u3', 'Reply three');

    const segment = new Transcript('5e55a0b1-0000-4000-8000-000000000020');
    segment.user('u1', null, 'Start');
    segment.assistant('a1', 'u1', 'Reply');
    segment.user('u2', 'a1', 'Kept prompt');
    segment.assistant('a2', 'u2', 'Kept reply');
    segment.boundary('b1', { segment: { head: 'u2', anchor: 's1', tail: 'a2' } });
    segment.summary('s1', 'b1');
    segment.attachment('at1', 's1', { type: 'date' });
    segment.user('u3', 'at1', 'After');
    segment.assistant('a3', 'u3', 'Reply three');

    const broken = new Transcript('5e55a0b1-0000-4000-8000-000000000021');
    broken.user('u1', null, 'Start');
    broken.assistant('a1', 'u1', 'Reply');
    broken.user('u2', 'a1', 'Prompt');
    broken.assistant('a2', 'u2', 'Reply two');
    broken.boundary('b1', { logical: 'a2', kept: { anchor: 's1', uuids: ['u2', 'missing'] }, segment: { head: 'u2', anchor: 's1', tail: 'a2' } });
    broken.summary('s1', 'b1');
    broken.user('u3', 's1', 'After');
    broken.assistant('a3', 'u3', 'Reply three');

    for (const [t, newest, all] of [
      [kept, ['b1', 's1', 'u2', 'a2', 'u3', 'a3'], ['u1', 'a1', 'b1', 's1', 'u2', 'a2', 'u3', 'a3']],
      [segment, ['b1', 's1', 'u2', 'a2', 'u3', 'a3'], ['u1', 'a1', 'b1', 's1', 'u2', 'a2', 'u3', 'a3']],
      [broken, ['b1', 's1', 'u3', 'a3'], ['u1', 'a1', 'u2', 'a2', 'b1', 's1', 'u3', 'a3']],
    ] as const) {
      const file = await t.write();
      const sdk = await getSessionMessages(t.sessionId, { includeSystemMessages: true });
      expect(uuids(sdk)).toEqual(newest);
      const pages = await allPages(file, t.sessionId, 2000);
      expect(pages[0]?.messages.slice(-sdk.length)).toEqual(sdk);
      expect(uuids(oldestFirst(await allPages(file, t.sessionId, 2)))).toEqual(all);
    }
  });

  it('never starts a page with a tool result, so a call and its result stay on one page', async () => {
    const t = new Transcript('5e55a0b1-0000-4000-8000-000000000030');
    t.user('u1', null, 'Go');
    let parent = 'u1';
    for (let index = 0; index < 4; index++) {
      t.assistant(`c${index}`, parent, [bash(`t${index}`, `step ${index}`)]);
      t.user(`r${index}`, `c${index}`, [result(`t${index}`, `out ${index}`)]);
      parent = `r${index}`;
    }
    t.assistant('done', parent, 'All steps ran');
    const pages = await allPages(await t.write(), t.sessionId, 4);
    expect(pages.map((page) => uuids(page.messages))).toEqual([['c3', 'r3', 'done'], ['c1', 'r1', 'c2', 'r2'], ['u1', 'c0', 'r0']]);
    for (const page of pages) {
      const items = mapSessionMessages(page.messages, { settleOpenTools: true, settleTrailingTools: true });
      expect(items.filter((item) => item.kind === 'tool').every((item) => item.kind === 'tool' && item.output?.startsWith('out'))).toBe(true);
    }
  });

  it('serves a session that grew since the last page from its new end', async () => {
    const t = new Transcript('5e55a0b1-0000-4000-8000-000000000040');
    t.user('u1', null, 'Start');
    t.assistant('a1', 'u1', 'Reply');
    const file = await t.write();
    const pager = createHistoryPager({ chunkSize: 16 });
    const request = { file, sessionId: t.sessionId, pageSize: 10, convert: convertFor(t.sessionId) };
    expect(uuids((await pager.page(request)).messages)).toEqual(['u1', 'a1']);
    const more = new Transcript(t.sessionId);
    more.user('u2', 'a1', 'More');
    more.assistant('a2', 'u2', 'Reply two');
    await appendFile(file, more.text());
    expect(uuids((await pager.page(request)).messages)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});

describe('session file lookup', () => {
  const sessionId = '5e55a0b1-0000-4000-8000-000000000050';

  afterEach(async () => {
    await rm(join(configDir, 'projects', 'E----'), { recursive: true, force: true });
    await rm(join(configDir, 'projects', 'other-folder'), { recursive: true, force: true });
  });

  it('names project folders as the CLI does and reads the config folder of the process profile', () => {
    expect(projectFolderName('E:\\构建')).toBe('E----');
    expect(projectFolderName('D:\\')).toBe('D--');
    expect(projectFolderName('D:\\work\\relay-desk')).toBe('D--work-relay-desk');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'C:\\Relay\\profiles\\work' })).toBe('C:\\Relay\\profiles\\work');
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'));
  });

  it('finds the transcript in the folder of its cwd, else in any project folder, skipping empty files', async () => {
    const t = new Transcript(sessionId);
    t.user('u1', null, 'Hi');
    expect(await findSessionFile(configDir, sessionId, 'E:\\构建')).toBeUndefined();
    const elsewhere = await t.write('other-folder');
    expect(await findSessionFile(configDir, sessionId, 'E:\\构建')).toEqual({ path: elsewhere, inCwdFolder: false });
    await mkdir(join(configDir, 'projects', 'E----'), { recursive: true });
    await writeFile(join(configDir, 'projects', 'E----', `${sessionId}.jsonl`), '');
    expect(await findSessionFile(configDir, sessionId, 'E:\\构建')).toEqual({ path: elsewhere, inCwdFolder: false });
    const own = await t.write('E----');
    expect(await findSessionFile(configDir, sessionId, 'E:\\构建')).toEqual({ path: own, inCwdFolder: true });
    expect(await findSessionFile(join(configDir, 'missing'), sessionId)).toBeUndefined();
  });
});
