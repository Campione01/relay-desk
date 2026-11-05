import type { EngineInterface, On } from 'claude-code';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, createNativeBridge, MAX_ACTIVE_REQUESTS, MAX_DIAGNOSTIC_ENTRIES, MAX_PENDING_INTERACTIONS,
  type NativeBridgeDiagnostics } from '../../native-mod/hooks/bridge';
import type { BridgeEvent, BridgeOutput, BridgeReply, BridgeRequest } from '../../native-mod/hooks/protocol';
import { register, STARTUP_FAILURE_NOTICE } from '../../native-mod/hooks/register';
import { createProcessTransport, type BridgeTransport } from '../../native-mod/hooks/transport';

vi.mock('../../native-mod/hooks/transport', async (original) => ({
  ...await original<typeof import('../../native-mod/hooks/transport')>(),
  createProcessTransport: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const outputs: BridgeOutput[] = [];
  const timers: { callback: () => void; canceled: boolean }[] = [];
  let inbound: (request: BridgeRequest) => void = () => undefined;
  let failed: (message: string) => void = () => undefined;
  let sessionId = 'native-session';
  const transport: BridgeTransport = {
    send: vi.fn((output) => { outputs.push(output); }),
    start: vi.fn((receive, onFailure) => { inbound = receive; failed = onFailure; }),
    close: vi.fn(), flush: vi.fn(async () => undefined),
  };
  const api = {
    ui: { toast: vi.fn() },
    env: { get: vi.fn(async (_key: string): Promise<string | undefined> => undefined) },
    session: {
      id: vi.fn(async () => sessionId), model: vi.fn(async () => 'claude-opus-5-5'), cwd: vi.fn(async () => 'C:\\fixture'),
      usage: vi.fn(async () => ({ context: { percent: 13 }, rateLimits: [] })),
      messages: vi.fn(async () => []), compact: vi.fn(async () => ({ compacted: true })),
    },
    prompt: { submit: vi.fn(async () => ({ turnId: 'turn-1' })) },
    turn: { abort: vi.fn(async () => undefined) },
    config: { list: vi.fn(async () => [{ key: 'effort', value: 'xhigh' }]), set: vi.fn() },
    command: { list: vi.fn(async () => []), run: vi.fn(async () => ({ text: 'status' })) },
    tool: { list: vi.fn(async () => []), call: vi.fn(async () => ({ result: 'stopped' })) },
    agent: { list: vi.fn(async () => []) },
    clock: {
      after: vi.fn((_ms, callback: () => void) => {
        const timer = { callback, canceled: false };
        timers.push(timer);
        return { cancel: () => { timer.canceled = true; } };
      }),
    },
  };
  const $ = api as unknown as EngineInterface;
  const bridge = createNativeBridge($, transport);
  return { $, api, bridge, transport, outputs, timers,
    request: (request: BridgeRequest) => inbound(request), disconnect: () => failed('pipe disconnected'),
    setSession: (value: string) => { sessionId = value; },
  };
}

function request(id: string, method: string, args?: unknown): BridgeRequest {
  return { type: 'request', id, method, args };
}

function interaction(outputs: BridgeOutput[]): BridgeEvent {
  return outputs.filter((row): row is BridgeEvent => row.type === 'event' && row.event === 'interaction.request').at(-1)!;
}

async function tick() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function hooksFixture(interactive = true, configure?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  vi.mocked(createProcessTransport).mockResolvedValue(f.transport);
  configure?.(f);
  const handlers = new Map<string, (...args: any[]) => any>();
  const catches = new Map<string, (...args: any[]) => any>();
  const on = (event: string, matcherOrHandler: any, handler?: any) => {
    if (handlers.has(event)) throw new Error('duplicate hook registration');
    handlers.set(event, handler ?? matcherOrHandler);
    return { catch: (caught: any) => catches.set(event, caught) };
  };
  register(on as unknown as On, {});
  const initial = { cwd: 'C:\\fixture' };
  const next = Object.assign(vi.fn(async () => initial), { signal: new AbortController().signal });
  expect(await handlers.get('session.start')!(f.$, { isInteractive: interactive, surface: interactive ? 'terminal' : null }, next)).toBe(initial);
  return { ...f, handlers, catches };
}

beforeEach(() => vi.clearAllMocks());

describe('native mod request bridge', () => {
  it('attests no-history only when active and refuses a prompt after it is disabled', async () => {
    const f = fixture();
    f.api.env.get.mockResolvedValue('1');
    await f.bridge.start(true, 'terminal');
    expect(f.outputs[0]).toMatchObject({ type: 'hello', capabilities: expect.arrayContaining(['session.ephemeral']) });
    f.api.env.get.mockResolvedValue('0');
    await f.bridge.receive(request('no-history-disabled', 'prompt.submit', { text: 'must not run' }));
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
    expect(f.outputs.at(-1)).toMatchObject({ type: 'response', ok: false });
  });

  it('rejects headless mode and advertises no unverified persistent-setting capability', async () => {
    const f = fixture();
    await expect(f.bridge.start(false, null)).rejects.toThrow('interactive');
    expect(f.transport.start).not.toHaveBeenCalled();
    expect(CAPABILITIES).not.toContain('config.set');
    expect(CAPABILITIES.some((entry) => entry.startsWith('config.session:'))).toBe(false);
  });

  it('sends hello first and deduplicates concurrent and replayed prompt requests', async () => {
    const f = fixture();
    const submitted = deferred<{ turnId: string }>();
    f.api.prompt.submit.mockReturnValue(submitted.promise);
    await f.bridge.start(true, 'terminal');
    const first = f.bridge.receive(request('same', 'prompt.submit', { text: 'hello', asUser: true }));
    const duplicate = f.bridge.receive(request('same', 'prompt.submit', { text: 'hello', asUser: true }));
    await tick();
    expect(f.api.prompt.submit).toHaveBeenCalledTimes(1);
    submitted.resolve({ turnId: 'turn-1' });
    await Promise.all([first, duplicate]);
    await f.bridge.receive(request('same', 'prompt.submit', { text: 'hello' }));
    expect(f.api.prompt.submit).toHaveBeenCalledTimes(1);
    expect(f.outputs[0]).toMatchObject({ type: 'hello', isInteractive: true, surface: 'terminal' });
    expect(f.outputs.filter((row) => row.type === 'response')).toHaveLength(3);
  });

  it('serializes normal requests but interrupt bypasses a prompt waiting to start', async () => {
    const f = fixture();
    const submitted = deferred<{ turnId: string }>();
    f.api.prompt.submit.mockReturnValue(submitted.promise);
    await f.bridge.start(true, 'terminal');
    f.bridge.setTurn('running');
    const first = f.bridge.receive(request('prompt', 'prompt.submit', { text: 'next' }));
    const second = f.bridge.receive(request('compact', 'session.compact'));
    await tick();
    expect(f.api.session.compact).not.toHaveBeenCalled();
    await f.bridge.receive(request('stop', 'turn.abort', { turnId: 'running' }));
    expect(f.api.turn.abort).toHaveBeenCalledWith({ turnId: 'running' });
    submitted.resolve({ turnId: 'next' });
    await Promise.all([first, second]);
    expect(f.api.session.compact).toHaveBeenCalledTimes(1);
  });

  it('denies canceled, invalid and over-capacity interactions but never on a wall clock', async () => {
    const f = fixture();
    await f.bridge.start(true, 'terminal');
    const canceled = new AbortController();
    const waiting = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} }, canceled.signal);
    canceled.abort();
    expect(await waiting).toMatchObject({ behavior: 'deny' });
    expect(f.outputs.some((row) => row.type === 'event' && row.event === 'interaction.cancel')).toBe(true);
    const unanswered = f.bridge.interact({ kind: 'permission', toolName: 'Write', input: {} });
    expect(f.api.clock.after).not.toHaveBeenCalled();
    await f.bridge.receive(request('answer-late', 'interaction.reply', { id: (interaction(f.outputs).data as { id: string }).id, result: { behavior: 'allow' } }));
    expect(await unanswered).toEqual({ behavior: 'allow' });
    const invalid = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} });
    const id = (interaction(f.outputs).data as { id: string }).id;
    await f.bridge.receive(request('bad', 'interaction.reply', { id, result: { behavior: 'allow', updatedPermissions: [{ destination: 'userSettings' }] } }));
    expect(await invalid).toMatchObject({ behavior: 'deny' });
    const occupied = Array.from({ length: MAX_PENDING_INTERACTIONS }, () => f.bridge.interact({ kind: 'permission', toolName: 'Read', input: {} }));
    expect(await f.bridge.interact({ kind: 'permission', toolName: 'Read', input: {} })).toMatchObject({ behavior: 'deny' });
    f.bridge.cancelInteractions('test ended');
    expect((await Promise.all(occupied)).every((row) => row.behavior === 'deny')).toBe(true);
  });

  it('rejects configuration writes, forged prompt metadata and unsupported methods without changing xhigh', async () => {
    const f = fixture();
    await f.bridge.start(true, 'terminal');
    await f.bridge.receive(request('config', 'config.set', { key: 'effort', value: 'low' }));
    await f.bridge.receive(request('resume', 'command.run', { command: '/resume', args: 'other-session' }));
    await f.bridge.receive(request('inject', 'prompt.submit', { text: 'test', context: ['hidden'] }));
    await f.bridge.receive(request('unknown', 'session.fork', {}));
    expect(f.api.config.set).not.toHaveBeenCalled();
    expect(f.api.command.run).not.toHaveBeenCalled();
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
    expect(f.outputs.filter((row) => row.type === 'response').every((row) => row.type === 'response' && !row.ok)).toBe(true);
    expect(await f.api.config.list()).toEqual([{ key: 'effort', value: 'xhigh' }]);
  });

  it('cancels pending interactions on disconnect and does not run queued work in a replacement session', async () => {
    const f = fixture();
    await f.bridge.start(true, 'terminal');
    const submitted = deferred<{ turnId: string }>();
    f.api.prompt.submit.mockReturnValue(submitted.promise);
    const first = f.bridge.receive(request('prompt', 'prompt.submit', { text: 'next' }));
    const second = f.bridge.receive(request('compact', 'session.compact'));
    await tick();
    f.setSession('replacement');
    await f.bridge.rebind();
    submitted.resolve({ turnId: 'old' });
    await Promise.all([first, second]);
    expect(f.api.session.compact).not.toHaveBeenCalled();
    const pending = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} });
    f.bridge.setTurn('new-turn');
    f.disconnect();
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(f.api.turn.abort).toHaveBeenCalledWith({ turnId: 'new-turn' });
  });
});

describe('read-only native bridge diagnostics', () => {
  const apiCalls = (f: ReturnType<typeof fixture>) => Object.values(f.api).flatMap((group) => Object.values(group)).map((call) => call.mock.calls.length);
  const inspect = async (f: ReturnType<typeof fixture>, id: string) => {
    const before = apiCalls(f);
    const completed = f.bridge.receive(request(id, 'bridge.diagnostics', {}));
    await tick();
    const reply = f.outputs.findLast((row): row is BridgeReply => row.type === 'response' && row.id === id);
    expect(reply, 'Diagnostic reply must not wait for commandTail').toBeDefined();
    await completed;
    expect(reply).toMatchObject({ ok: true });
    expect(apiCalls(f)).toEqual(before);
    return reply!.value as NativeBridgeDiagnostics;
  };

  it.each(['session.taskHistory', 'session.usage'] as const)('runs a held %s beside a held serialized request and then observes the actual running UI command', async (method) => {
    const f = fixture(), held = deferred<void>(), reader = deferred<void>(), modal = deferred<{ text: string }>();
    f.api.session.compact.mockImplementation(async () => { await held.promise; return { compacted: true }; });
    f.api.session.messages.mockImplementation(async () => { await reader.promise; return []; });
    f.api.session.usage.mockImplementation(async () => { await reader.promise; return { context: { percent: 13 }, rateLimits: [] }; });
    f.api.command.run.mockReturnValue(modal.promise);
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await f.bridge.start(true, 'terminal');
      expect(f.outputs[0]).toMatchObject({ capabilities: expect.arrayContaining(['bridge.diagnostics']) });
      const compacting = f.bridge.receive(request('private-compact-id', 'session.compact')); await tick();
      now = 1_050;
      const reading = f.bridge.receive(request('private-read-id', method)); await tick();
      now = 1_080;
      const control = f.bridge.receive(request('private-control-id', 'ui.command', { command: 'effort', args: '' })); await tick();
      now = 1_120;
      expect(await inspect(f, 'inspect-queued')).toEqual({ version: 1, modalActive: false, runningTurn: false, activeCount: 3, queuedCount: 1,
        entries: [{ method: 'session.compact', state: 'running', queuedMs: 0, runMs: 120 }, { method, state: 'running', queuedMs: 0, runMs: 70 },
          { method: 'ui.command', command: 'effort', state: 'queued', queuedMs: 40 }], truncated: false });
      expect(f.api.command.run).not.toHaveBeenCalled();
      now = 1_200; held.resolve(); await compacting; await tick();
      now = 1_250;
      expect(await inspect(f, 'inspect-modal')).toEqual({ version: 1, modalActive: true, runningTurn: false, activeCount: 2, queuedCount: 0,
        entries: [{ method, state: 'running', queuedMs: 0, runMs: 200 }, { method: 'ui.command', command: 'effort', state: 'running', queuedMs: 120, runMs: 50 }], truncated: false });
      reader.resolve(); await reading;
      modal.resolve({ text: 'private-completed-result' }); await control;
      expect(await inspect(f, 'inspect-empty')).toEqual({ version: 1, modalActive: false, runningTurn: false,
        activeCount: 0, queuedCount: 0, entries: [], truncated: false });
    } finally { held.resolve(); reader.resolve(); modal.resolve({ text: '' }); f.bridge.close('test finished'); clock.mockRestore(); }
  });

  it('exposes only exact method and native panel labels, never arguments, identities or results', async () => {
    const f = fixture(), blocker = deferred<void>();
    f.setSession('private-session-canary');
    f.api.session.compact.mockImplementation(async () => { await blocker.promise; return { compacted: true }; });
    f.api.session.messages.mockImplementation(async () => { await blocker.promise; return []; });
    await f.bridge.start(true, 'terminal');
    const jobs = [f.bridge.receive(request('private-compact-canary', 'session.compact')), f.bridge.receive(request('private-request-canary', 'session.taskHistory'))]; await tick();
    f.bridge.setTurn('private-turn-canary');
    jobs.push(f.bridge.receive(request('unknown', 'private-method-canary', { text: 'private-prompt-canary', path: 'private-path-canary', env: 'private-auth-canary' })),
      f.bridge.receive(request('slash', 'command.run', { command: 'private-command-canary', args: 'private-args-canary' })),
      f.bridge.receive(request('bad-ui', 'ui.command', { command: 'private-ui-canary', args: 'private-args-canary' })),
      f.bridge.receive(request('known-ui', 'ui.command', { command: 'effort', args: 'private-args-canary' })),
      f.bridge.receive(request('unsupported-setter', 'config.set', { key: 'private-config-canary', value: 'private-value-canary' })));
    try {
      const snapshot = await inspect(f, 'inspect-private');
      expect(snapshot.runningTurn).toBe(true);
      expect(snapshot.entries.map(({ method, command }) => ({ method, ...(command ? { command } : {}) }))).toEqual([
        { method: 'session.compact' }, { method: 'session.taskHistory' }, { method: 'other' }, { method: 'command.run' }, { method: 'ui.command' },
        { method: 'ui.command', command: 'effort' }, { method: 'other' },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain('private-');
      expect(Object.keys(snapshot).sort()).toEqual(['activeCount', 'entries', 'modalActive', 'queuedCount', 'runningTurn', 'truncated', 'version']);
      for (const entry of snapshot.entries) expect(Object.keys(entry).every((key) => ['method', 'command', 'state', 'queuedMs', 'runMs'].includes(key))).toBe(true);
      f.bridge.setTurn(undefined); blocker.resolve(); await Promise.all(jobs);
      expect((await inspect(f, 'inspect-after-completion')).entries).toEqual([]);
    } finally { f.bridge.setTurn(undefined); blocker.resolve(); f.bridge.close('test finished'); }
  });

  it('bounds snapshots at sixteen entries and responds even when ordinary request capacity is full', async () => {
    const f = fixture(), blocker = deferred<void>();
    f.api.session.compact.mockImplementation(async () => { await blocker.promise; return { compacted: true }; });
    await f.bridge.start(true, 'terminal');
    const jobs = [f.bridge.receive(request('blocking', 'session.compact'))]; await tick();
    for (let i = 1; i < MAX_ACTIVE_REQUESTS; i++) jobs.push(f.bridge.receive(request(`queued-${i}`, 'session.compact')));
    try {
      const snapshot = await inspect(f, 'inspect-at-capacity');
      expect(snapshot).toMatchObject({ activeCount: MAX_ACTIVE_REQUESTS, queuedCount: MAX_ACTIVE_REQUESTS - 1, truncated: true });
      expect(snapshot.entries).toHaveLength(MAX_DIAGNOSTIC_ENTRIES);
      await f.bridge.receive(request('ordinary-overflow', 'tool.list'));
      expect(f.outputs.at(-1)).toMatchObject({ ok: false, error: { code: 'CAPACITY' } });
      blocker.resolve(); await Promise.all(jobs);
      expect(await inspect(f, 'inspect-drained')).toMatchObject({ activeCount: 0, queuedCount: 0, entries: [], truncated: false });
    } finally { blocker.resolve(); f.bridge.close('test finished'); }
  });

  it('does not consume ordinary request capacity while an inspector is concurrently active', async () => {
    const f = fixture(), blocker = deferred<void>();
    f.api.session.compact.mockImplementation(async () => { await blocker.promise; return { compacted: true }; });
    await f.bridge.start(true, 'terminal');
    const jobs = [f.bridge.receive(request('blocking', 'session.compact'))]; await tick();
    for (let i = 1; i < MAX_ACTIVE_REQUESTS - 1; i++) jobs.push(f.bridge.receive(request(`queued-${i}`, 'session.compact')));
    const inspector = f.bridge.receive(request('concurrent-inspector', 'bridge.diagnostics'));
    const last = f.bridge.receive(request('last-ordinary', 'session.compact'));
    try {
      await tick();
      expect(f.outputs.find((row) => row.type === 'response' && row.id === 'last-ordinary')).toBeUndefined();
      await inspector;
      expect(f.outputs.find((row) => row.type === 'response' && row.id === 'concurrent-inspector'))
        .toMatchObject({ ok: true, value: { activeCount: MAX_ACTIVE_REQUESTS, queuedCount: MAX_ACTIVE_REQUESTS - 1, truncated: true } });
      blocker.resolve(); await Promise.all([...jobs, last]);
      expect(f.outputs.find((row) => row.type === 'response' && row.id === 'last-ordinary')).toMatchObject({ ok: true });
    } finally { blocker.resolve(); await Promise.all([...jobs, inspector, last]); f.bridge.close('test finished'); }
  });

  it('rejects diagnostic arguments without echoing them or invoking native APIs', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const before = apiCalls(f);
    for (const [index, args] of [null, [], 'private-argument-canary', { prompt: 'private-argument-canary' }].entries()) {
      await f.bridge.receive(request(`invalid-${index}`, 'bridge.diagnostics', args));
      expect(f.outputs.at(-1)).toMatchObject({ type: 'response', ok: false, error: { code: 'NATIVE_REQUEST_REJECTED' } });
      expect(JSON.stringify(f.outputs.at(-1))).not.toContain('private-argument-canary');
    }
    expect(apiCalls(f)).toEqual(before);
    expect(await inspect(f, 'valid-empty')).toMatchObject({ activeCount: 0, entries: [] });
    f.bridge.close('test finished');
  });

  it('clears old-epoch metadata, preserves a replacement request, and emits nothing after close', async () => {
    const f = fixture(), oldRead = deferred<void>(), replacement = deferred<{ compacted: boolean }>();
    f.api.session.compact.mockImplementationOnce(async () => { await oldRead.promise; return { compacted: true }; }).mockReturnValueOnce(replacement.promise);
    await f.bridge.start(true, 'terminal');
    const first = f.bridge.receive(request('reused-id', 'session.compact'));
    const oldQueued = f.bridge.receive(request('old-ui', 'ui.command', { command: 'effort' })); await tick();
    f.setSession('private-replacement-id'); await f.bridge.rebind();
    expect(await inspect(f, 'inspect-rebound')).toMatchObject({ activeCount: 0, queuedCount: 0, entries: [] });
    const current = f.bridge.receive(request('reused-id', 'session.compact'));
    expect(await inspect(f, 'inspect-new-queued')).toMatchObject({ activeCount: 1, queuedCount: 1, entries: [{ method: 'session.compact', state: 'queued' }] });
    oldRead.resolve(); await Promise.all([first, oldQueued]); await tick();
    expect(f.api.command.run).not.toHaveBeenCalled();
    expect(f.outputs.filter((row) => row.type === 'response' && row.id === 'old-ui')).toMatchObject([{ ok: false, error: { code: 'SESSION_CHANGED' } }]);
    expect(f.outputs.filter((row) => row.type === 'response' && row.id === 'reused-id')).toEqual([]);
    expect(await inspect(f, 'inspect-new-running')).toMatchObject({ activeCount: 1, queuedCount: 0, entries: [{ method: 'session.compact', state: 'running' }] });
    f.bridge.close('test finished'); const outputCount = f.outputs.length;
    await f.bridge.receive(request('inspect-closed', 'bridge.diagnostics'));
    replacement.resolve({ compacted: true }); await current;
    expect(f.outputs).toHaveLength(outputCount);
  });
});

describe('native event middleware', () => {
  it('reports transport setup failure without exposing its exception or enabling prompt submission', async () => {
    const f = await hooksFixture(true, () => {
      vi.mocked(createProcessTransport).mockRejectedValue(new Error('synthetic-secret-do-not-display'));
    });
    expect(f.api.ui.toast).toHaveBeenCalledWith(STARTUP_FAILURE_NOTICE, { timeoutMs: 30_000 });
    expect(f.outputs).toEqual([]);
    const next = vi.fn();
    expect(await f.handlers.get('prompt.submit')!(f.$, { text: 'not sent' }, next)).toMatchObject({ drop: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(f.api.ui.toast.mock.calls)).not.toContain('synthetic-secret');
  });

  it.each(['metadata', 'receiver'] as const)('closes partial initialization and emits a fixed startup fault on %s failure', async (stage) => {
    const f = await hooksFixture(true, (value) => {
      if (stage === 'metadata') value.api.session.model.mockRejectedValue(new Error('synthetic-secret'));
      else vi.mocked(value.transport.start).mockImplementation(() => { throw new Error('synthetic-secret'); });
    });
    expect(f.outputs).toEqual([{ type: 'startupError', protocol: 1, code: 'MOD_INIT_FAILED' }]);
    expect(f.transport.flush).toHaveBeenCalled();
    expect(f.transport.close).toHaveBeenCalled();
    expect(f.api.ui.toast).toHaveBeenCalledWith(STARTUP_FAILURE_NOTICE, { timeoutMs: 30_000 });
    const next = vi.fn();
    expect(await f.handlers.get('prompt.submit')!(f.$, { text: 'not sent' }, next)).toMatchObject({ drop: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not emit a late hello after a bridge was closed during metadata initialization', async () => {
    const f = fixture();
    const model = deferred<string>();
    f.api.session.model.mockReturnValue(model.promise);
    const starting = f.bridge.start(true, 'terminal');
    await tick();
    f.bridge.close('synthetic canceled startup');
    model.resolve('claude-opus-5-5');
    await expect(starting).rejects.toThrow('canceled');
    expect(f.outputs).toEqual([]);
    expect(f.transport.start).not.toHaveBeenCalled();
  });

  it('forwards every native chunk and the exact result once, including opaque and signed-thinking chunks', async () => {
    const f = await hooksFixture();
    const chunks = [{ kind: 'engine', ref: 1 }, { kind: 'thinking', index: 0, text: 'reason' },
      { kind: 'text', index: 1, text: 'answer' }, { kind: 'tool', index: 2, id: 'tool-1', name: 'Read' },
      { kind: 'input', index: 2, json: '{"file_path":"a"}' }, { kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 1 } }];
    const result = { turnId: 'turn', index: 0, answer: 'answer', toolUses: [], stopReason: 'tool_use', usage: null };
    const stream = (async function* () { for (const chunk of chunks) yield chunk; return result; })();
    Object.assign(stream, { result: Promise.resolve(result) });
    const next = vi.fn(() => stream);
    const output = f.handlers.get('turn.step')!(f.$, { turnId: 'turn', index: 0, agentId: 'agent' }, next);
    const forwarded: unknown[] = [];
    let step = await output.next();
    while (!step.done) { forwarded.push(step.value); step = await output.next(); }
    expect(step.value).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    chunks.forEach((chunk, index) => expect(forwarded[index]).toBe(chunk));
    const events = f.outputs.filter((row): row is BridgeEvent => row.type === 'event');
    expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0].data).toMatchObject({ agentId: 'agent', turnId: 'turn', stepId: 0 });
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it('preserves existing hook decisions and is inert outside interactive mode', async () => {
    const f = await hooksFixture();
    const prior = { decision: { behavior: 'allow' }, additionalContext: ['user rule'] };
    const next = Object.assign(vi.fn(async () => prior), { signal: new AbortController().signal });
    expect(await f.handlers.get('classic.PermissionRequest')!(f.$, { tool_name: 'Read', tool_input: {} }, next)).toBe(prior);
    expect(next).toHaveBeenCalledTimes(1);
    expect(interaction(f.outputs)).toBeUndefined();
    const headless = await hooksFixture(false);
    const unchanged = { allow: true };
    expect(await headless.handlers.get('classic.PreToolUse')!(headless.$, { tool: 'AskUserQuestion' }, async () => unchanged)).toBe(unchanged);
  });

  it('routes PermissionRequest through the canonical broker wire and keeps other user fields', async () => {
    const f = await hooksFixture();
    const next = Object.assign(vi.fn(async () => ({})), { signal: new AbortController().signal });
    const answer = f.handlers.get('classic.PermissionRequest')!(f.$, { tool_name: 'Bash', tool_input: { command: 'test' }, permission_suggestions: [] }, next);
    await tick();
    const event = interaction(f.outputs);
    expect(event.data).toMatchObject({ toolName: 'Bash', input: { command: 'test' }, kind: 'permission' });
    const id = (event.data as { id: string }).id;
    f.request(request('answer', 'interaction.reply', { id, result: { behavior: 'allow', updatedInput: { command: 'safe' } } }));
    expect(await answer).toMatchObject({ decision: { behavior: 'allow', updatedInput: { command: 'safe' } } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('answers AskUserQuestion only with questions plus answers and honors a prior deny', async () => {
    const f = await hooksFixture();
    const questions = [{ question: 'Which?', header: 'Pick', options: [{ label: 'One', description: 'first' }], multiSelect: false }];
    const next = Object.assign(vi.fn(async () => ({ additionalContext: ['user context'] })), { signal: new AbortController().signal });
    const waiting = f.handlers.get('classic.PreToolUse')!(f.$, { tool: 'AskUserQuestion', tool_use_id: 'tool-q', questions }, next);
    await tick();
    const event = interaction(f.outputs);
    expect(event.data).toMatchObject({ toolName: 'AskUserQuestion', toolUseId: 'tool-q', input: { questions } });
    f.request(request('question-reply', 'interaction.reply', { id: (event.data as { id: string }).id,
      result: { behavior: 'allow', updatedInput: { questions, answers: { 'Which?': 'One' } } } }));
    expect(await waiting).toMatchObject({ allow: true, updatedInput: { questions, answers: { 'Which?': 'One' } }, additionalContext: ['user context'] });
    const denied = { deny: 'policy denies this' };
    expect(await f.handlers.get('classic.PreToolUse')!(f.$, { tool: 'AskUserQuestion', questions }, async () => denied)).toBe(denied);
    expect(next).toHaveBeenCalledTimes(1);
    expect(f.catches.get('classic.PreToolUse')!(f.$, {}, { called: true })).toMatchObject({ deny: expect.any(String) });
    expect(f.catches.get('classic.PermissionRequest')!(f.$, {}, { called: true })).toMatchObject({ decision: { behavior: 'deny' } });
  });
});
