import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages as sdkGetSessionMessages, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_HISTORY_CURSOR, type Profile } from '@shared/types';
import { buildChildEnv } from '../../src/main/system/env';
import { NETWORK_ENV } from './fixtures/networkEnv';
import sessionsFixture from './fixtures/sessions.json';

// R7: the real utilityProcess (and with it the real ~/.claude) must never be reached from tests.
vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('utilityProcess.fork must not run in tests');
    },
  },
}));

const { createListingClient } = await import('../../src/main/engine/listing');
const { createImageStore } = await import('../../src/main/engine/images');
const { MAX_SUBAGENTS, MAX_SUBAGENT_MESSAGES, agentIdsFor, runListingRequest, sortSessions, toSessionSummary } = await import(
  '../../src/main/engine/listingOps'
);
const { mapSessionMessages } = await import('../../src/main/engine/mapTranscript');
const { createHistoryPager, projectFolderName, INVALID_CURSOR, STALE_CURSOR } = await import('../../src/main/engine/transcriptReader');
type ListingSdk = import('../../src/main/engine/listingOps').ListingSdk;
type WorkerProcess = import('../../src/main/engine/listing').WorkerProcess;

const INFOS = sessionsFixture as SDKSessionInfo[];
const DEFAULT: Profile = { id: 'default', name: 'Default', configDir: null, createdAt: 0 };
const WORK: Profile = { id: 'work', name: 'Work', configDir: 'C:\\Relay\\profiles\\work', createdAt: 0 };
const SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';

function message(uuid: string, type: SessionMessage['type'], content: unknown, parent: string | null = null): SessionMessage {
  return {
    type,
    uuid,
    session_id: SESSION,
    message: { role: type, content },
    parent_tool_use_id: parent,
    parent_agent_id: null,
  };
}

function fakeSdk(overrides: Partial<ListingSdk> = {}) {
  const sdk = {
    listSessions: vi.fn(async () => INFOS),
    getSessionMessages: vi.fn(async () => [message('u1', 'user', 'hello')]),
    listSubagents: vi.fn(async () => [] as string[]),
    getSubagentMessages: vi.fn(async () => [] as SessionMessage[]),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: 'forked-id' })),
    deleteSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return sdk;
}

describe('listing worker logic', () => {
  it('maps SDKSessionInfo to SessionSummary with the customTitle, summary, firstPrompt title order', () => {
    expect(INFOS.map(toSessionSummary)).toEqual([
      {
        sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
        title: 'Desktop title A',
        cwd: 'D:\\work\\alpha',
        lastModified: 1000,
        createdAt: 500,
        gitBranch: 'main',
        firstPrompt: 'Set up the project',
        fileSize: 2048,
        tag: 'wip',
      },
      { sessionId: 'bbbbbbbb-2222-4222-8222-222222222222', title: 'Summary B', cwd: '', lastModified: 3000 },
      {
        sessionId: 'cccccccc-3333-4333-8333-333333333333',
        title: 'First prompt C',
        cwd: 'D:\\work\\gamma',
        lastModified: 2000,
        firstPrompt: 'First prompt C',
      },
    ]);
  });

  it('lists programmatic sessions too, newest first', async () => {
    const sdk = fakeSdk();
    const response = await runListingRequest({ id: 7, op: 'list' }, sdk);
    expect(sdk.listSessions).toHaveBeenCalledWith({ includeProgrammatic: true });
    expect(response.ok).toBe(true);
    const result = response.ok ? (response.result as Array<{ sessionId: string }>) : [];
    expect(response.id).toBe(7);
    expect(result.map((s) => s.sessionId.slice(0, 4))).toEqual(['bbbb', 'cccc', 'aaaa']);
    expect(sortSessions([])).toEqual([]);
  });

  it('reads history with system messages and appends the placeable messages of the subagents its Agent calls started', async () => {
    const main = [
      message('a1', 'assistant', [{ type: 'tool_use', id: 'toolu_task', name: 'Agent', input: { description: 'Review' } }]),
      message('u1', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'Done.\nagentId: a0201cf8574775420 (use SendMessage)' }]),
      message('a2', 'assistant', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]),
      message('u2', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'agentId: afffffffffffffff0 is only text' }]),
    ];
    const sub = [
      message('s1', 'assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], 'toolu_task'),
      message('s2', 'assistant', [{ type: 'text', text: 'orphan without a parent tool id' }]),
    ];
    const sdk = fakeSdk({
      getSessionMessages: vi.fn(async () => main),
      getSubagentMessages: vi.fn(async () => sub),
    });
    const response = await runListingRequest({ id: 1, op: 'history', sessionId: SESSION, cwd: 'D:\\work\\alpha' }, sdk);
    expect(sdk.getSessionMessages).toHaveBeenCalledWith(SESSION, { dir: 'D:\\work\\alpha', includeSystemMessages: true });
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls).toEqual([[SESSION, 'a0201cf8574775420', { dir: 'D:\\work\\alpha' }]]);
    expect(response).toEqual({ id: 1, ok: true, result: { messages: [...main, sub[0]] } });
  });

  it('retries history without the folder when the folder finds nothing, and caps subagents', async () => {
    const calls = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) => [
      message(`a${i}`, 'assistant', [{ type: 'tool_use', id: `toolu_${i}`, name: i % 2 ? 'Task' : 'Agent', input: {} }]),
      message(`u${i}`, 'user', [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `agentId: agent-${i}` }]),
    ]).flat();
    const getSessionMessages = vi.fn<ListingSdk['getSessionMessages']>().mockResolvedValueOnce([]).mockResolvedValueOnce(calls);
    const sdk = fakeSdk({ getSessionMessages });
    await runListingRequest({ id: 2, op: 'history', sessionId: SESSION, cwd: 'd:/WORK/alpha' }, sdk);
    expect(getSessionMessages.mock.calls).toEqual([
      [SESSION, { dir: 'd:/WORK/alpha', includeSystemMessages: true }],
      [SESSION, { includeSystemMessages: true }],
    ]);
    expect(sdk.getSubagentMessages).toHaveBeenCalledTimes(MAX_SUBAGENTS);
    // The newest calls first: they are the first seen when the cap leaves some out.
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls[0]).toEqual([SESSION, `agent-${MAX_SUBAGENTS + 4}`, {}]);
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls.at(-1)).toEqual([SESSION, 'agent-5', {}]);
  });

  it('finds subagent ids by the raw tool result first, then by the result text, also inside subagents', () => {
    const agent = (id: string, toolUseId: string, result: string, parent: string | null = null) => [
      message(`${id}-call`, 'assistant', [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: {} }], parent),
      message(`${id}-result`, 'user', [{ type: 'tool_result', tool_use_id: toolUseId, content: result }], parent),
    ];
    const messages = [...agent('x', 'toolu_x', 'agentId: a1111111111111111'), ...agent('y', 'toolu_y', 'no id here'), ...agent('z', 'toolu_z', 'agentId: a1111111111111111')];
    expect(agentIdsFor(messages)).toEqual(['a1111111111111111']);
    expect(agentIdsFor(messages, { toolu_y: 'a2222222222222222', toolu_x: 'a3333333333333333' })).toEqual([
      'a3333333333333333',
      'a2222222222222222',
      'a1111111111111111',
    ]);
    expect(agentIdsFor([message('r', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'agentId: a4444444444444444' }])])).toEqual([]);
  });

  it('renames with a trimmed title and rejects empty or oversized titles', async () => {
    const sdk = fakeSdk();
    await expect(runListingRequest({ id: 3, op: 'rename', sessionId: SESSION, title: '  New name ' }, sdk)).resolves.toEqual({
      id: 3,
      ok: true,
      result: null,
    });
    expect(sdk.renameSession).toHaveBeenCalledWith(SESSION, 'New name', {});
    for (const title of ['   ', 'x'.repeat(201)]) {
      await expect(runListingRequest({ id: 4, op: 'rename', sessionId: SESSION, title }, sdk)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('title'),
      });
    }
    expect(sdk.renameSession).toHaveBeenCalledTimes(1);
  });

  it('turns SDK failures and unknown ops into error responses instead of throwing', async () => {
    const sdk = fakeSdk({ listSessions: vi.fn(async () => Promise.reject(new Error('disk on fire'))) });
    await expect(runListingRequest({ id: 5, op: 'list' }, sdk)).resolves.toEqual({ id: 5, ok: false, error: 'disk on fire' });
    await expect(runListingRequest({ id: 6, op: 'drop' } as never, sdk)).resolves.toMatchObject({ id: 6, ok: false });
  });

  it('redacts SDK diagnostics before posting a worker failure response', async () => {
    const sdk = fakeSdk({ listSessions: vi.fn(async () => { throw new Error('ANTHROPIC_API_KEY=synthetic-secret'); }) });
    await expect(runListingRequest({ id: 1, op: 'list' }, sdk)).resolves.toEqual({
      id: 1,
      ok: false,
      error: 'ANTHROPIC_API_KEY=[redacted]',
    });
  });
});

class FakeWorker extends EventEmitter implements WorkerProcess {
  readonly posted: Array<Record<string, unknown>> = [];
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed = false;

  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 1));
    return true;
  }

  reply(index: number, body: Record<string, unknown>): void {
    this.emit('message', { id: this.posted[index]?.id, ...body });
  }
}

function client(options: { timeoutMs?: number; idleMs?: number; buildEnv?(profile: Profile): NodeJS.ProcessEnv } = {}) {
  const workers: FakeWorker[] = [];
  const fork = vi.fn((_path: string, _env: NodeJS.ProcessEnv, _name: string) => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const buildEnv = vi.fn((profile: Profile) => ({
    PATH: 'C:\\Windows',
    ...(profile.configDir ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
  }));
  const log = vi.fn();
  const listing = createListingClient('D:\\app\\out\\main\\listingWorker.js', { fork, buildEnv, log, ...options });
  return { listing, workers, fork, buildEnv, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('listing client', () => {
  it('passes scrubbed proxy casing variants and certificate variables to each profile worker', async () => {
    const base = {
      ...NETWORK_ENV,
      ANTHROPIC_AUTH_TOKEN: 'synthetic-never-forwarded',
      CLAUDE_CONFIG_DIR: 'C:\\synthetic\\wrong-profile',
    };
    const { listing, workers, fork } = client({ buildEnv: (profile) => buildChildEnv(profile, base) });
    const defaultRequest = listing.list(DEFAULT);
    const workRequest = listing.list(WORK);
    expect(fork.mock.calls[0]?.[1]).toEqual(NETWORK_ENV);
    expect(fork.mock.calls[1]?.[1]).toEqual({ ...NETWORK_ENV, CLAUDE_CONFIG_DIR: WORK.configDir });
    workers[0]?.reply(0, { ok: true, result: [] });
    workers[1]?.reply(0, { ok: true, result: [] });
    await Promise.all([defaultRequest, workRequest]);
    listing.dispose();
  });

  it('never gives a worker the launch-environment authentication values, whatever the account uses', async () => {
    const base = { ...NETWORK_ENV, ANTHROPIC_API_KEY: 'synthetic-inherited-never-forwarded' };
    const launch = { ANTHROPIC_API_KEY: 'synthetic-launch-key', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-launch-token' };
    const { listing, workers, fork } = client({ buildEnv: (profile) => buildChildEnv(profile, base, launch) });
    const request = listing.list({ ...WORK, authenticationSource: 'launch-environment' });
    expect(fork.mock.calls[0]?.[1]).toEqual({ ...NETWORK_ENV, CLAUDE_CONFIG_DIR: WORK.configDir });
    workers[0]?.reply(0, { ok: true, result: [] });
    await request;
    listing.dispose();
  });

  it('redacts worker stderr across chunks and errors before they leave the listing client', async () => {
    const { listing, workers, log } = client();
    const pending = listing.list(DEFAULT);
    workers[0]?.stderr.emit('data', 'warning sk-ant-');
    expect(log).not.toHaveBeenCalled();
    workers[0]?.stderr.emit('data', 'api03-SPLITSECRET\naccess_token="final-');
    workers[0]?.stderr.emit('data', 'secret"');
    workers[0]?.stderr.emit('end');
    workers[0]?.reply(0, { ok: false, error: 'Authorization: Bearer synthetic-error-secret' });
    await expect(pending).rejects.toThrow('Authorization: Bearer [redacted]');
    expect(log.mock.calls).toEqual([['warning sk-ant-[redacted]'], ['access_token="[redacted]"']]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SPLITSECRET|final-secret/);
    listing.dispose();
  });

  it('starts one worker per profile with that profile env and reuses it', async () => {
    const { listing, workers, fork } = client();
    const first = listing.list(DEFAULT);
    expect(fork).toHaveBeenCalledWith('D:\\app\\out\\main\\listingWorker.js', { PATH: 'C:\\Windows' }, 'relay-listing-default');
    expect(workers[0]?.posted).toEqual([{ op: 'list', id: 1 }]);
    workers[0]?.reply(0, { ok: true, result: [toSessionSummary(INFOS[1] as SDKSessionInfo)] });
    await expect(first).resolves.toEqual([
      { sessionId: 'bbbbbbbb-2222-4222-8222-222222222222', title: 'Summary B', cwd: '', lastModified: 3000 },
    ]);

    const second = listing.list(DEFAULT);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(workers[0]?.posted[1]).toEqual({ op: 'list', id: 2 });
    workers[0]?.reply(1, { ok: true, result: [] });
    await expect(second).resolves.toEqual([]);

    listing.list(WORK).catch(() => undefined);
    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork.mock.calls[1]?.[1]).toEqual({ PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\Relay\\profiles\\work' });
    listing.dispose();
  });

  it('never titles a session with the resume prompt of an automatic continue, which the CLI keeps as the last prompt', async () => {
    const { AUTO_CONTINUE_PROMPT } = await import('../../src/main/engine/mapTranscript');
    const { listing, workers } = client();
    const pending = listing.list(DEFAULT);
    const row = (id: string, extra: Record<string, unknown>) => ({ sessionId: id, cwd: '', lastModified: 1, ...extra });
    workers[0]?.reply(0, {
      ok: true,
      result: [
        row('s1', { title: AUTO_CONTINUE_PROMPT, firstPrompt: ' Build the parser ' }),
        row('s2', { title: AUTO_CONTINUE_PROMPT }),
        row('s3', { title: AUTO_CONTINUE_PROMPT, firstPrompt: AUTO_CONTINUE_PROMPT }),
        row('s4', { title: 'Renamed by hand', firstPrompt: 'Build the parser' }),
      ],
    });
    expect((await pending).map((summary) => [summary.sessionId, summary.title])).toEqual([
      ['s1', 'Build the parser'],
      ['s2', ''],
      ['s3', ''],
      ['s4', 'Renamed by hand'],
    ]);
    listing.dispose();
  });

  it('maps history pages in main and passes rename through', async () => {
    const { listing, workers } = client();
    const history = listing.history(DEFAULT, SESSION, 'D:\\work\\alpha');
    expect(workers[0]?.posted[0]).toEqual({ op: 'page', sessionId: SESSION, cwd: 'D:\\work\\alpha', id: 1 });
    workers[0]?.reply(0, {
      ok: true,
      result: {
        messages: [
          message('u1', 'user', 'hello'),
          message('a1', 'assistant', [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'D:\\work\\alpha\\src\\x.ts' } },
          ]),
        ],
        older: '1:aaaaaaaa:B:boundary-1:e',
      },
    });
    await expect(history).resolves.toEqual({
      items: [
        { kind: 'user', id: 'u1', text: 'hello' },
        expect.objectContaining({ kind: 'tool', id: 't1', summary: 'Read src\\x.ts', status: 'running' }),
      ],
      older: '1:aaaaaaaa:B:boundary-1:e',
    });

    // An older page: its thread went on in the newer page, so a call without a result there is no longer running.
    const older = listing.history(DEFAULT, SESSION, undefined, '1:aaaaaaaa:B:boundary-1:e');
    expect(workers[0]?.posted[1]).toEqual({ op: 'page', sessionId: SESSION, before: '1:aaaaaaaa:B:boundary-1:e', id: 2 });
    workers[0]?.reply(1, { ok: true, result: { messages: [message('a0', 'assistant', [{ type: 'tool_use', id: 't0', name: 'Bash', input: {} }])] } });
    await expect(older).resolves.toEqual({ items: [expect.objectContaining({ kind: 'tool', id: 't0', status: 'done' })] });

    const bad = [{ messages: [], older: '' }, { messages: [], older: 7 }, { messages: [], older: 'c'.repeat(MAX_HISTORY_CURSOR + 1) }];
    for (const [index, result] of bad.entries()) {
      const page = listing.history(DEFAULT, SESSION);
      workers[0]?.reply(2 + index, { ok: true, result });
      await expect(page).rejects.toThrow('unexpected answer');
    }

    const rename = listing.rename(DEFAULT, SESSION, 'Better title');
    expect(workers[0]?.posted.at(-1)).toEqual({ op: 'rename', sessionId: SESSION, title: 'Better title', id: 6 });
    workers[0]?.reply(5, { ok: true, result: null });
    await expect(rename).resolves.toBeUndefined();
    listing.dispose();
  });

  it('stores history images under session-scoped keys and settles finished subagent tools', async () => {
    const images = createImageStore();
    const workers: FakeWorker[] = [];
    const listing = createListingClient('worker.js', {
      fork: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      buildEnv: () => ({}),
      log: () => undefined,
      images,
    });
    const history = listing.history(DEFAULT, SESSION);
    workers[0]?.reply(0, {
      ok: true,
      result: {
        messages: [
          message('a1', 'assistant', [{ type: 'tool_use', id: 't-agent', name: 'Agent', input: {} }]),
          message('u1', 'user', [{ type: 'tool_result', tool_use_id: 't-agent', content: 'done' }]),
          message('s1', 'assistant', [{ type: 'tool_use', id: 't-sub', name: 'Read', input: {} }], 't-agent'),
          message('u2', 'user', [
            { type: 'text', text: 'pasted' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PIXELS' } },
          ]),
        ],
      },
    });
    const { items } = await history;
    expect(items.find((item) => item.id === 't-sub')).toMatchObject({ status: 'done', parentToolUseId: 't-agent' });
    expect(items.find((item) => item.id === 'u2')).toMatchObject({
      images: 1,
      imageRefs: [{ key: `${SESSION}:u2:0`, mediaType: 'image/png' }],
    });
    expect(images.get(`${SESSION}:u2:0`)).toBe('data:image/png;base64,PIXELS');
    listing.dispose();
  });

  it('derives background tasks from the raw history the worker returns', async () => {
    const { listing, workers } = client();
    const tasks = listing.tasks(WORK, SESSION, 'D:\\work\\alpha');
    expect(workers[0]?.posted[0]).toEqual({ op: 'history', sessionId: SESSION, cwd: 'D:\\work\\alpha', id: 1 });
    workers[0]?.reply(0, {
      ok: true,
      result: {
        messages: [
          message('a1', 'assistant', [
            { type: 'tool_use', id: 't-bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } },
          ]),
          message('u1', 'user', [
            { type: 'tool_result', tool_use_id: 't-bg', content: 'Command running in background with ID: bdev00001. Output is being written to: x' },
          ]),
        ],
      },
    });
    await expect(tasks).resolves.toEqual([
      { taskId: 'bdev00001', kind: 'shell', taskType: 'local_bash', description: 'npm run dev', status: 'running', toolUseId: 't-bg' },
    ]);
    const bad = listing.tasks(WORK, SESSION);
    workers[0]?.reply(1, { ok: true, result: null });
    await expect(bad).rejects.toThrow('unexpected answer');
    listing.dispose();
  });

  it('rejects with the worker error and ignores unknown or malformed replies', async () => {
    const { listing, workers } = client();
    const pending = listing.list(DEFAULT);
    workers[0]?.emit('message', { id: 99, ok: true, result: [] });
    workers[0]?.emit('message', 'garbage');
    workers[0]?.reply(0, { ok: false, error: 'EACCES: permission denied' });
    await expect(pending).rejects.toThrow('EACCES: permission denied');
    const bad = listing.history(DEFAULT, SESSION);
    workers[0]?.reply(1, { ok: true, result: 'not messages' });
    await expect(bad).rejects.toThrow('unexpected answer');
    listing.dispose();
  });

  it('times out a request, kills the stuck worker and starts a fresh one next time', async () => {
    vi.useFakeTimers();
    const { listing, workers, fork } = client({ timeoutMs: 1_000 });
    const stuck = listing.list(DEFAULT);
    const assertion = expect(stuck).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(workers[0]?.killed).toBe(true);

    listing.list(DEFAULT).catch(() => undefined);
    expect(fork).toHaveBeenCalledTimes(2);
    expect(workers[1]?.posted[0]).toMatchObject({ op: 'list' });
    listing.dispose();
  });

  it('fails pending requests when the worker crashes and recovers on the next request', async () => {
    const { listing, workers, fork, log } = client();
    const pending = listing.list(DEFAULT);
    workers[0]?.stderr.emit('data', 'something broke\n');
    workers[0]?.emit('exit', 3);
    await expect(pending).rejects.toThrow('exit code 3');
    expect(log).toHaveBeenCalledWith('something broke');

    const retry = listing.list(DEFAULT);
    expect(fork).toHaveBeenCalledTimes(2);
    workers[1]?.reply(0, { ok: true, result: [] });
    await expect(retry).resolves.toEqual([]);
    listing.dispose();
  });

  it('shuts an idle worker down and restarts it on demand', async () => {
    vi.useFakeTimers();
    const { listing, workers, fork } = client({ idleMs: 5_000 });
    const first = listing.list(DEFAULT);
    workers[0]?.reply(0, { ok: true, result: [] });
    await first;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(workers[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]?.killed).toBe(true);

    listing.list(DEFAULT).catch(() => undefined);
    expect(fork).toHaveBeenCalledTimes(2);
    listing.dispose();
  });

  it('dispose kills every worker and fails what is still pending', async () => {
    const { listing, workers } = client();
    const a = listing.list(DEFAULT);
    const b = listing.list(WORK);
    listing.dispose();
    await expect(a).rejects.toThrow('was closed');
    await expect(b).rejects.toThrow('was closed');
    expect(workers.map((w) => w.killed)).toEqual([true, true]);
  });
});

describe('subagent transcripts (desktop tasks pane)', () => {
  it('worker: reads one subagent in its folder, retries without the folder, keeps the newest messages', async () => {
    const many = Array.from({ length: MAX_SUBAGENT_MESSAGES + 3 }, (_, i) => message(`m${i}`, 'assistant', [{ type: 'text', text: `step ${i}` }], 'toolu_task'));
    const getSubagentMessages = vi.fn(async (_session: string, _agent: string, options?: { dir?: string }) => (options?.dir ? [] : many));
    const sdk = fakeSdk({ getSubagentMessages });
    const response = await runListingRequest({ id: 9, op: 'subagent', sessionId: SESSION, agentId: 'a0201cf8574775420', cwd: 'D:\\work\\alpha' }, sdk);
    expect(getSubagentMessages.mock.calls).toEqual([
      [SESSION, 'a0201cf8574775420', { dir: 'D:\\work\\alpha' }],
      [SESSION, 'a0201cf8574775420'],
    ]);
    expect(response).toMatchObject({ id: 9, ok: true });
    const messages = (response as { result: { messages: SessionMessage[] } }).result.messages;
    expect(messages).toHaveLength(MAX_SUBAGENT_MESSAGES);
    expect(messages[0]).toEqual(many[3]);
    await expect(runListingRequest({ id: 10, op: 'subagent', sessionId: SESSION, agentId: '' }, sdk)).resolves.toMatchObject({ id: 10, ok: false });
  });

  it('client: maps a subagent as its own main thread, with its running calls still running', async () => {
    const { listing, workers } = client();
    const items = listing.subagent(DEFAULT, SESSION, 'a1', 'D:\\work\\alpha');
    expect(workers[0]?.posted[0]).toEqual({ op: 'subagent', sessionId: SESSION, agentId: 'a1', cwd: 'D:\\work\\alpha', id: 1 });
    workers[0]?.reply(0, {
      ok: true,
      result: {
        messages: [
          message('s1', 'assistant', [{ type: 'text', text: 'Looking at the routes.' }], 'toolu_task'),
          message('s2', 'assistant', [{ type: 'tool_use', id: 't-read', name: 'Read', input: { file_path: 'D:\\work\\alpha\\src\\x.ts' } }], 'toolu_task'),
        ],
      },
    });
    const mapped = await items;
    expect(mapped[0]).toMatchObject({ kind: 'assistant', text: 'Looking at the routes.' });
    expect(mapped[1]).toMatchObject({ kind: 'tool', id: 't-read', status: 'running' });
    expect(mapped[1]).not.toHaveProperty('parentToolUseId');
    listing.dispose();
  });
});

describe('history pages in the worker', () => {
  // A synthetic transcript in a temp config folder; the real ~/.claude is never read.
  const PAGED = 'bbbbbbbb-5555-4555-8555-555555555555';
  const FOLDER = 'D:\\work\\paged';
  let configDir = '';

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'relay-listing-'));
    const dir = join(configDir, 'projects', projectFolderName(FOLDER));
    await mkdir(dir, { recursive: true });
    let time = Date.UTC(2026, 9, 1);
    const line = (type: string, uuid: string, parentUuid: string | null, message: Record<string, unknown>, extra = {}) =>
      JSON.stringify({ parentUuid, isSidechain: false, type, uuid, sessionId: PAGED, timestamp: new Date((time += 1000)).toISOString(), message, ...extra });
    const agentCall = (id: string, description: string) => ({ id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description } }] });
    const said = (text: string) => ({ id: `msg_${text}`, role: 'assistant', content: [{ type: 'text', text }] });
    const returned = (id: string, text: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
    const lines = [
      line('user', 'u1', null, { role: 'user', content: 'Review the old code' }),
      line('assistant', 'a1', 'u1', agentCall('toolu_old', 'Old review')),
      line('user', 'r1', 'a1', returned('toolu_old', 'Old review done.'), { toolUseResult: { agentId: 'a1111111111111111', status: 'completed' } }),
      line('assistant', 'a2', 'r1', said('Old summary')),
      line('user', 'u2', 'a2', { role: 'user', content: 'Review the new code' }),
      line('assistant', 'a3', 'u2', agentCall('toolu_new', 'New review')),
      line('user', 'r2', 'a3', returned('toolu_new', 'New review done.\nagentId: a2222222222222222 (use SendMessage to continue)')),
      line('assistant', 'a4', 'r2', said('New summary')),
    ];
    await writeFile(join(dir, `${PAGED}.jsonl`), `${lines.join('\n')}\n`);
  });

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  function pagedSdk() {
    const subagents: Record<string, SessionMessage[]> = {
      a1111111111111111: [message('s1', 'assistant', [{ type: 'tool_use', id: 't-old-read', name: 'Read', input: {} }], 'toolu_old')],
      a2222222222222222: [
        message('s2', 'assistant', [{ type: 'tool_use', id: 't-new-read', name: 'Read', input: {} }], 'toolu_new'),
        message('s2x', 'assistant', [{ type: 'text', text: 'orphan without a parent tool id' }]),
      ],
      a9999999999999999: [message('s9', 'assistant', [{ type: 'text', text: 'unrelated subagent' }], 'toolu_elsewhere')],
    };
    return fakeSdk({
      // The real SDK conversion over the entries the reader picked (sessionStore); nothing else is read through it.
      getSessionMessages: vi.fn(async (sessionId: string, options?: Parameters<ListingSdk['getSessionMessages']>[1]) => {
        if (!options?.sessionStore) throw new Error('only the in-memory store may be read');
        return sdkGetSessionMessages(sessionId, options);
      }),
      getSubagentMessages: vi.fn(async (_session: string, agentId: string) => subagents[agentId] ?? []),
    });
  }

  it('reads one page at a time with the subagents of the Agent calls on that page only', async () => {
    const sdk = pagedSdk();
    const context = { configDir, pager: createHistoryPager({ chunkSize: 32 }), pageSize: 4 };
    const first = await runListingRequest({ id: 1, op: 'page', sessionId: PAGED, cwd: FOLDER }, sdk, context);
    expect(first).toMatchObject({ id: 1, ok: true });
    const newest = (first as { result: { messages: SessionMessage[]; older?: string } }).result;
    expect(newest.messages.map((m) => m.uuid)).toEqual(['u2', 'a3', 'r2', 'a4', 's2']);
    expect(newest.older).toEqual(expect.any(String));
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls).toEqual([[PAGED, 'a2222222222222222', { dir: FOLDER }]]);
    const items = mapSessionMessages(newest.messages, { settleOpenTools: true });
    expect(items.map((item) => item.id)).toEqual(['u2', 'toolu_new', 't-new-read', 'a4:0']);

    const second = await runListingRequest({ id: 2, op: 'page', sessionId: PAGED, cwd: FOLDER, before: newest.older ?? '' }, sdk, context);
    const older = (second as { result: { messages: SessionMessage[]; older?: string } }).result;
    expect(older.messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'r1', 'a2', 's1']);
    expect(older).not.toHaveProperty('older');
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls.slice(1)).toEqual([[PAGED, 'a1111111111111111', { dir: FOLDER }]]);
  });

  it('searches other project folders, answers an empty newest page for a missing session and refuses bad requests', async () => {
    const sdk = pagedSdk();
    const context = { configDir, pager: createHistoryPager(), pageSize: 4 };
    const elsewhere = await runListingRequest({ id: 3, op: 'page', sessionId: PAGED, cwd: 'D:\\spelled\\differently' }, sdk, context);
    expect((elsewhere as { result: { messages: SessionMessage[] } }).result.messages.map((m) => m.uuid)).toEqual(['u2', 'a3', 'r2', 'a4', 's2']);
    expect(vi.mocked(sdk.getSubagentMessages).mock.calls).toEqual([[PAGED, 'a2222222222222222', {}]]);
    const missing = 'cccccccc-6666-4666-8666-666666666666';
    await expect(runListingRequest({ id: 4, op: 'page', sessionId: missing }, sdk, context)).resolves.toEqual({ id: 4, ok: true, result: { messages: [] } });
    await expect(runListingRequest({ id: 5, op: 'page', sessionId: missing, before: '1:cccccccc:B:x:e' }, sdk, context)).resolves.toEqual({
      id: 5,
      ok: false,
      error: STALE_CURSOR,
    });
    await expect(runListingRequest({ id: 6, op: 'page', sessionId: '..\\escape' }, sdk, context)).resolves.toMatchObject({ ok: false, error: 'Invalid session id.' });
    await expect(runListingRequest({ id: 7, op: 'page', sessionId: PAGED, before: 42 } as never, sdk, context)).resolves.toMatchObject({ ok: false, error: INVALID_CURSOR });
  });
});

describe('history page of a native /compact (native.13)', () => {
  const COMPACTED = 'dddddddd-7777-4777-8777-777777777777';
  const FOLDER = 'D:\\work\\compacted';
  let configDir = '';

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'relay-compact-'));
    const dir = join(configDir, 'projects', projectFolderName(FOLDER));
    await mkdir(dir, { recursive: true });
    // CLI 2.1.308's rows of one manual /compact (synthetic text, the real layout).
    const line = (type: string, uuid: string, parentUuid: string | null, timestamp: string, extra: Record<string, unknown>) =>
      JSON.stringify({ parentUuid, isSidechain: false, userType: 'external', cwd: FOLDER, sessionId: COMPACTED, version: '2.1.308', type, uuid, timestamp, ...extra });
    const user = (content: string, extra: Record<string, unknown> = {}) => ({ message: { role: 'user', content }, ...extra });
    const lines = [
      line('user', 'ask', null, '2026-10-24T06:20:00.000Z', user('Earlier question')),
      line('assistant', 'answer', 'ask', '2026-10-24T06:20:05.000Z', { message: { id: 'msg_answer', type: 'message', role: 'assistant',
        model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Earlier answer' }], stop_reason: 'end_turn' } }),
      line('user', 'typed', 'answer', '2026-10-24T06:31:47.170Z', user('/compact', { origin: { kind: 'plugin', name: 'relay-native-bridge' } })),
      line('system', 'boundary', null, '2026-10-24T06:34:34.939Z', { subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
        isMeta: false, logicalParentUuid: 'typed', compactMetadata: { trigger: 'manual', preTokens: 20453 } }),
      line('user', 'summary', 'boundary', '2026-10-24T06:34:34.940Z', user('This session is being continued from a previous conversation. SUMMARY BODY',
        { isCompactSummary: true, isVisibleInTranscriptOnly: true })),
      line('user', 'caveat', 'summary', '2026-10-24T06:31:47.192Z', user('<local-command-caveat>Caveat: synthetic.</local-command-caveat>', { isMeta: true })),
      line('user', 'command', 'caveat', '2026-10-24T06:31:47.192Z',
        user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')),
      line('user', 'stdout', 'command', '2026-10-24T06:34:35.038Z',
        user('<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>')),
      line('attachment', 'reread', 'stdout', '2026-10-24T06:34:35.040Z', { attachment: { type: 'todo_reminder', content: [], itemCount: 0 } }),
    ];
    await writeFile(join(dir, `${COMPACTED}.jsonl`), `${lines.join('\n')}\n`);
  });

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('carries the parent links the SDK drops, so a reopened /compact shows the running time live showed', async () => {
    const sdk = fakeSdk({
      getSessionMessages: vi.fn(async (sessionId: string, options?: Parameters<ListingSdk['getSessionMessages']>[1]) => {
        if (!options?.sessionStore) throw new Error('only the in-memory store may be read');
        return sdkGetSessionMessages(sessionId, options);
      }),
    });
    const response = await runListingRequest({ id: 1, op: 'page', sessionId: COMPACTED, cwd: FOLDER }, sdk, { configDir, pager: createHistoryPager() });
    const { messages } = (response as { result: { messages: SessionMessage[] } }).result;
    expect(messages.find((entry) => entry.uuid === 'stdout')).toMatchObject({ parentUuid: 'command', timestamp: '2026-10-24T06:34:35.038Z' });
    const items = mapSessionMessages(messages, { settleOpenTools: true });
    // The boundary row stays without a line of its own: its summary makes the one compaction line.
    expect(items.map((item) => item.id)).toEqual(['ask', 'answer:0', 'typed', 'summary', 'command', 'stdout']);
    expect(items.slice(-3)).toEqual([
      { kind: 'system', id: 'summary', text: 'Conversation compacted', level: 'info' },
      { kind: 'user', id: 'command', text: '/compact' },
      { kind: 'system', id: 'stdout', text: 'Compacted', level: 'info', durationMs: 167_846 },
    ]);
    expect(JSON.stringify(items)).not.toContain('SUMMARY BODY');
  });
});

describe('history page of a native /rename (native.13)', () => {
  const RENAMED = 'eeeeeeee-8888-4888-8888-888888888888';
  const FOLDER = 'D:\\work\\renamed';
  let configDir = '';

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'relay-rename-'));
    const dir = join(configDir, 'projects', projectFolderName(FOLDER));
    await mkdir(dir, { recursive: true });
    // CLI 2.1.308's rows of `/rename synthetic-name` (synthetic text in the CLI's layout): both
    // command rows are system `local_command` rows below the turn's turn_duration row, a meta user row after them (without a
    // user row after them the SDK leaves them out). Then a failing command of the same shape whose error came 3 s later.
    const base = { isSidechain: false, userType: 'external', cwd: FOLDER, sessionId: RENAMED, version: '2.1.308', gitBranch: '' };
    const line = (type: string, uuid: string, parentUuid: string | null, timestamp: string, extra: Record<string, unknown>) =>
      JSON.stringify({ parentUuid, ...base, type, uuid, timestamp, ...extra });
    const local = (uuid: string, parentUuid: string, timestamp: string, content: string) =>
      line('system', uuid, parentUuid, timestamp, { subtype: 'local_command', content, level: 'info', isMeta: false });
    const named = (command: string, args: string) =>
      `<command-name>/${command}</command-name>\n            <command-message>${command}</command-message>\n            <command-args>${args}</command-args>`;
    const lines = [
      line('user', 'ask', null, '2026-10-24T10:20:13.737Z', { message: { role: 'user', content: 'Earlier question' } }),
      line('assistant', 'answer', 'ask', '2026-10-24T10:20:13.865Z', { message: { id: 'msg_answer', type: 'message', role: 'assistant',
        model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Earlier answer' }], stop_reason: 'end_turn' } }),
      line('system', 'turn-end', 'answer', '2026-10-24T10:20:13.901Z', { subtype: 'turn_duration', durationMs: 178, isMeta: false }),
      JSON.stringify({ type: 'custom-title', customTitle: 'synthetic-name', sessionId: RENAMED }),
      JSON.stringify({ type: 'agent-name', agentName: 'synthetic-name', sessionId: RENAMED }),
      local('rename', 'turn-end', '2026-10-24T10:20:14.141Z', named('rename', 'synthetic-name')),
      local('rename-out', 'rename', '2026-10-24T10:20:14.141Z', '<local-command-stdout>Session renamed to: synthetic-name</local-command-stdout>'),
      line('user', 'rename-meta', 'rename-out', '2026-10-24T10:20:14.141Z', { message: { role: 'user', content: 'Synthetic meta note.' }, isMeta: true }),
      line('system', 'notice', 'rename-meta', '2026-10-24T10:21:00.000Z', { subtype: 'informational', content: 'A synthetic notice', level: 'info', isMeta: false }),
      local('mcp', 'notice', '2026-10-24T10:22:00.000Z', named('mcp', 'reconnect beta')),
      local('mcp-err', 'mcp', '2026-10-24T10:22:03.000Z', '<local-command-stderr>\u001b[31mFailed to reconnect to beta\u001b[39m</local-command-stderr>'),
      line('user', 'mcp-meta', 'mcp-err', '2026-10-24T10:22:03.000Z', { message: { role: 'user', content: 'Synthetic meta note.' }, isMeta: true }),
    ];
    await writeFile(join(dir, `${RENAMED}.jsonl`), `${lines.join('\n')}\n`);
  });

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('shows a reopened /rename as its command and result line, as live showed them, with the running time rule of user rows', async () => {
    const sdk = fakeSdk({
      getSessionMessages: vi.fn(async (sessionId: string, options?: Parameters<ListingSdk['getSessionMessages']>[1]) => {
        if (!options?.sessionStore) throw new Error('only the in-memory store may be read');
        return sdkGetSessionMessages(sessionId, options);
      }),
    });
    const response = await runListingRequest({ id: 1, op: 'page', sessionId: RENAMED, cwd: FOLDER }, sdk, { configDir, pager: createHistoryPager() });
    const { messages } = (response as { result: { messages: SessionMessage[] } }).result;
    expect(messages.find((entry) => entry.uuid === 'rename-out')).toMatchObject({ type: 'system', subtype: 'local_command', parentUuid: 'rename',
      content: '<local-command-stdout>Session renamed to: synthetic-name</local-command-stdout>' });
    expect(messages.find((entry) => entry.uuid === 'notice')).not.toHaveProperty('content');
    expect(mapSessionMessages(messages, { settleOpenTools: true })).toEqual([
      { kind: 'user', id: 'ask', text: 'Earlier question' },
      { kind: 'assistant', id: 'answer:0', text: 'Earlier answer' },
      { kind: 'user', id: 'rename', text: '/rename synthetic-name' },
      { kind: 'system', id: 'rename-out', text: 'Session renamed to: synthetic-name', level: 'info' },
      { kind: 'user', id: 'mcp', text: '/mcp reconnect beta' },
      { kind: 'system', id: 'mcp-err', text: 'Failed to reconnect to beta', level: 'warn', durationMs: 3_000 },
    ]);
  });
});

describe('fork and delete through the SDK (sidebar session menu)', () => {
  it('worker: forks and deletes in the session folder, retrying across projects when the folder fails', async () => {
    const forkSession = vi.fn(async (_id: string, options?: { dir?: string }) => {
      if (options?.dir) throw new Error('Session not found');
      return { sessionId: 'new-id' };
    });
    const deleteSession = vi.fn(async () => undefined);
    const sdk = fakeSdk({ forkSession, deleteSession });
    await expect(runListingRequest({ id: 1, op: 'fork', sessionId: SESSION, cwd: 'D:\\work\\alpha' }, sdk)).resolves.toEqual({ id: 1, ok: true, result: { sessionId: 'new-id' } });
    expect(forkSession.mock.calls).toEqual([
      [SESSION, { dir: 'D:\\work\\alpha' }],
      [SESSION, {}],
    ]);
    await expect(runListingRequest({ id: 2, op: 'delete', sessionId: SESSION, cwd: 'D:\\work\\alpha' }, sdk)).resolves.toEqual({ id: 2, ok: true, result: null });
    expect(deleteSession.mock.calls).toEqual([[SESSION, { dir: 'D:\\work\\alpha' }]]);
    deleteSession.mockRejectedValue(new Error('Session not found'));
    await expect(runListingRequest({ id: 3, op: 'delete', sessionId: SESSION }, sdk)).resolves.toEqual({ id: 3, ok: false, error: 'Session not found' });
    await expect(runListingRequest({ id: 4, op: 'fork', sessionId: '' }, sdk)).resolves.toMatchObject({ id: 4, ok: false });
  });

  it('client: answers the new id of a fork and rejects an answer without one', async () => {
    const { listing, workers } = client();
    const fork = listing.fork(DEFAULT, SESSION, 'D:\\work\\alpha');
    expect(workers[0]?.posted[0]).toEqual({ op: 'fork', sessionId: SESSION, cwd: 'D:\\work\\alpha', id: 1 });
    workers[0]?.reply(0, { ok: true, result: { sessionId: 'new-id' } });
    await expect(fork).resolves.toBe('new-id');
    const bad = listing.fork(DEFAULT, SESSION);
    workers[0]?.reply(1, { ok: true, result: {} });
    await expect(bad).rejects.toThrow('unexpected answer');
    const remove = listing.delete(DEFAULT, SESSION);
    expect(workers[0]?.posted[2]).toEqual({ op: 'delete', sessionId: SESSION, id: 3 });
    workers[0]?.reply(2, { ok: true, result: null });
    await expect(remove).resolves.toBeUndefined();
    listing.dispose();
  });
});
