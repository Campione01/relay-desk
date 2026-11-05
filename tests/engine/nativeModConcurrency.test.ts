import type { EngineInterface } from 'claude-code';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_COMMANDS as SHARED_ACCOUNT_COMMANDS, SIGN_IN_COMMANDS as SHARED_SIGN_IN_COMMANDS, signInCommandRefusal } from '@shared/signIn';
import { SLASH_ALIASES } from '../../src/renderer/lib/slash';
import { ACCOUNT_COMMANDS, CAPABILITIES, COMMAND_ALIASES, COMMAND_BUSY_MESSAGE, commandRefusal, CONCURRENT_METHODS, createNativeBridge, GUARDED_COMMANDS,
  MAX_ACTIVE_REQUESTS, PERSISTENT_CAPABILITIES, SIGN_IN_COMMANDS, type NativeBridgeDiagnostics } from '../../native-mod/hooks/bridge';
import type { BridgeEvent, BridgeHello, BridgeOutput, BridgeReply, BridgeRequest } from '../../native-mod/hooks/protocol';
import type { BridgeTransport } from '../../native-mod/hooks/transport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const request = (id: string, method: string, args?: unknown): BridgeRequest => ({ type: 'request', id, method, args });
const image = { type: 'image', mediaType: 'image/png', filename: 'attachment-1.png' };

function fixture(options: { omit?: string[]; env?: Record<string, string> } = {}) {
  const outputs: BridgeOutput[] = [];
  let sessionId = 'native-session';
  const transport: BridgeTransport = { send: vi.fn((output) => { outputs.push(output); }), start: vi.fn(), close: vi.fn(), flush: vi.fn(async () => undefined) };
  const holds: Array<{ argv: readonly string[]; next: ReturnType<typeof vi.fn>; return: ReturnType<typeof vi.fn> }> = [];
  const api = {
    env: { get: vi.fn(async (key: string): Promise<string | undefined> => options.env?.[key]) },
    session: {
      id: vi.fn(async () => sessionId), model: vi.fn(async () => 'claude-opus-5-5'), cwd: vi.fn(async () => 'C:\\fixture'),
      usage: vi.fn(async (): Promise<unknown> => ({ context: { percent: 13 } })), messages: vi.fn(async () => []), compact: vi.fn(async (): Promise<unknown> => ({ compacted: true })),
    },
    prompt: { submit: vi.fn(async () => ({ turnId: 'turn' })), read: vi.fn(async () => ({ text: '', cursor: 0 })), fill: vi.fn(async () => ({ isFilled: true })) },
    turn: { abort: vi.fn(async () => undefined) },
    config: { list: vi.fn(async () => []), set: vi.fn(async () => ({ value: true })) },
    command: { list: vi.fn(async () => []), run: vi.fn(async (): Promise<unknown> => ({ text: 'ran' })) },
    tool: { list: vi.fn(async () => []), call: vi.fn(async () => ({ result: 'stopped' })) },
    agent: { list: vi.fn(async () => []) },
    clock: { after: vi.fn(() => ({ cancel: vi.fn() })) },
    process: { spawn: vi.fn((spawned: { argv: readonly string[] }) => {
      const hold = { argv: spawned.argv, next: vi.fn(() => new Promise(() => undefined)), return: vi.fn(async () => ({ done: true, value: { code: null, signal: null } })) };
      holds.push(hold); return hold;
    }) },
  };
  for (const name of options.omit ?? []) { const [noun, method] = name.split('.'); delete (api as unknown as Record<string, Record<string, unknown>>)[noun][method]; }
  const bridge = createNativeBridge(api as unknown as EngineInterface, transport);
  const replies = (id: string) => outputs.filter((row): row is BridgeReply => row.type === 'response' && row.id === id);
  let number = 0;
  const rpc = async (method: string, args?: unknown) => { const id = `rpc-${++number}`; await bridge.receive(request(id, method, args)); return replies(id).at(-1); };
  const events = (name: string) => outputs.filter((row): row is BridgeEvent => row.type === 'event' && row.event === name);
  return { api, bridge, transport, outputs, holds, replies, reply: (id: string) => replies(id).at(-1), rpc, events, setSession: (value: string) => { sessionId = value; } };
}

describe('native bridge concurrent reads (B1, B2)', () => {
  it.each([...CONCURRENT_METHODS])('answers %s while a slash command waits for its native dialog', async (method) => {
    const f = fixture(), dialog = deferred<unknown>();
    f.api.command.run.mockReturnValue(dialog.promise);
    await f.bridge.start(true, 'terminal');
    const slash = f.bridge.receive(request('slash', 'command.run', { command: '/config' })); await tick();
    expect(f.api.command.run).toHaveBeenCalledTimes(1);
    const read = f.bridge.receive(request('read', method)); await tick();
    expect(f.reply('read')).toMatchObject({ ok: true });
    expect(f.reply('slash')).toBeUndefined();
    dialog.resolve({ text: 'closed' }); await Promise.all([slash, read]);
    expect(f.reply('slash')).toMatchObject({ ok: true, value: { text: 'closed' } });
  });

  it('stops a task during a pending slash command, but keeps other tool calls and writers serialized', async () => {
    const f = fixture(), dialog = deferred<unknown>();
    f.api.command.run.mockReturnValue(dialog.promise);
    await f.bridge.start(true, 'terminal');
    const jobs = [f.bridge.receive(request('slash', 'command.run', { command: 'compact' }))]; await tick();
    jobs.push(f.bridge.receive(request('stop', 'tool.call', { tool: 'TaskStop', task_id: 'background-1' })),
      f.bridge.receive(request('other-tool', 'tool.call', { tool: 'Bash', command: 'never' })),
      f.bridge.receive(request('submit', 'prompt.submit', { text: 'next' })),
      f.bridge.receive(request('compact', 'session.compact')),
      f.bridge.receive(request('ui', 'ui.command', { command: 'model' })),
      f.bridge.receive(request('read-composer', 'prompt.read')));
    await tick();
    expect(f.reply('stop')).toMatchObject({ ok: true, value: { result: 'stopped' } });
    expect(f.api.tool.call).toHaveBeenCalledExactlyOnceWith({ tool: 'TaskStop', task_id: 'background-1' });
    for (const id of ['other-tool', 'submit', 'compact', 'ui', 'read-composer']) expect(f.reply(id)).toBeUndefined();
    expect(f.api.prompt.submit).not.toHaveBeenCalled(); expect(f.api.session.compact).not.toHaveBeenCalled(); expect(f.api.prompt.read).not.toHaveBeenCalled();
    dialog.resolve({ text: 'done' }); await Promise.all(jobs);
    expect(f.api.prompt.submit).toHaveBeenCalledTimes(1); expect(f.api.session.compact).toHaveBeenCalledTimes(1);
    expect(f.api.command.run).toHaveBeenCalledTimes(2);
  });

  it('counts concurrent reads toward request capacity and keeps their diagnostics', async () => {
    const f = fixture(), held = deferred<void>();
    f.api.session.usage.mockImplementation(async () => { await held.promise; return { context: { percent: 13 } }; });
    await f.bridge.start(true, 'terminal');
    const jobs = Array.from({ length: MAX_ACTIVE_REQUESTS }, (_, index) => f.bridge.receive(request(`usage-${index}`, 'session.usage'))); await tick();
    expect(f.api.session.usage).toHaveBeenCalledTimes(MAX_ACTIVE_REQUESTS);
    await f.bridge.receive(request('overflow', 'config.list'));
    expect(f.reply('overflow')).toMatchObject({ ok: false, error: { code: 'CAPACITY' } });
    await f.bridge.receive(request('inspect', 'bridge.diagnostics'));
    const snapshot = f.reply('inspect')!.value as NativeBridgeDiagnostics;
    expect(snapshot).toMatchObject({ activeCount: MAX_ACTIVE_REQUESTS, queuedCount: 0, truncated: true });
    expect(snapshot.entries.every((entry) => entry.method === 'session.usage' && entry.state === 'running')).toBe(true);
    held.resolve(); await Promise.all(jobs);
  });
});

describe('native turn.abort outcome (B3)', () => {
  it('answers not-running without cancelling pending interactions or the armed attachment', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    expect(await f.rpc('attachment.arm', { id: 'owned', text: 'safe text', expected: [image], references: [] })).toMatchObject({ ok: true });
    let settled = false;
    const waiting = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} }).then((value) => { settled = true; return value; });
    expect(await f.rpc('turn.abort')).toMatchObject({ ok: true, value: { interrupted: false, reason: 'not-running' } });
    f.bridge.setTurn('current');
    expect(await f.rpc('turn.abort', { turnId: 'stale' })).toMatchObject({ ok: true, value: { interrupted: false, reason: 'not-running' } });
    await tick();
    expect(settled).toBe(false);
    expect(f.events('interaction.cancel')).toEqual([]);
    expect(f.api.turn.abort).not.toHaveBeenCalled();
    expect(await f.rpc('attachment.status', { id: 'owned' })).toMatchObject({ ok: true, value: { state: 'armed' } });
    f.bridge.cancelInteractions('test finished'); await waiting;
  });

  it('cancels and aborts a matching turn, reporting not-running when the native turn already ended', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    f.bridge.setTurn('current');
    const first = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} });
    f.api.turn.abort.mockRejectedValueOnce(new Error('turn current is not the running turn'));
    expect(await f.rpc('turn.abort', { turnId: 'current' })).toMatchObject({ ok: true, value: { interrupted: false, reason: 'not-running' } });
    expect(await first).toMatchObject({ behavior: 'deny', message: 'The native turn was interrupted' });
    const second = f.bridge.interact({ kind: 'question', toolName: 'AskUserQuestion', input: {} });
    expect(await f.rpc('turn.abort')).toMatchObject({ ok: true, value: { interrupted: true } });
    expect(await second).toMatchObject({ behavior: 'deny' });
    expect(f.api.turn.abort.mock.calls).toEqual([[{ turnId: 'current' }], [{ turnId: 'current' }]]);
  });
});

describe('native interactions without a wall-clock deny (B4)', () => {
  it('keeps a permission open through an hour of clock time and settles it on the reply', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); await f.bridge.start(true, 'terminal');
      let result: unknown;
      const waiting = f.bridge.interact({ kind: 'permission', toolName: 'Write', input: {} }).then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(result).toBeUndefined();
      expect(f.api.clock.after).not.toHaveBeenCalled();
      expect(f.events('interaction.cancel')).toEqual([]);
      const id = (f.events('interaction.request').at(-1)!.data as { id: string }).id;
      await f.bridge.receive(request('late-answer', 'interaction.reply', { id, result: { behavior: 'allow' } }));
      await waiting;
      expect(result).toEqual({ behavior: 'allow' });
    } finally { vi.useRealTimers(); }
  });

  it('holds an idle native process open while the person decides and releases it on every settlement', async () => {
    const f = fixture({ env: { SystemRoot: 'C:\\Windows' } }); await f.bridge.start(true, 'terminal');
    const ask = () => f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} });
    const answered = ask();
    expect(f.holds).toHaveLength(1);
    expect(f.holds[0].argv).toEqual(['C:\\Windows\\System32\\waitfor.exe', '/t', '99999', expect.stringMatching(/^RelayHold\d+x[0-9a-z]+$/)]);
    expect(f.holds[0].next).toHaveBeenCalledTimes(1);
    await tick(); expect(f.holds[0].return).not.toHaveBeenCalled();
    await f.bridge.receive(request('answer', 'interaction.reply', { id: (f.events('interaction.request').at(-1)!.data as { id: string }).id, result: { behavior: 'allow' } }));
    expect(await answered).toEqual({ behavior: 'allow' });
    const controller = new AbortController();
    const aborted = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} }, controller.signal); controller.abort(); await aborted;
    const canceled = ask(); f.bridge.cancelInteractions('session ended'); await canceled;
    const closed = ask(); f.bridge.close('bridge closed'); await closed;
    await tick();
    expect(f.holds).toHaveLength(4);
    for (const hold of f.holds) expect(hold.return).toHaveBeenCalledExactlyOnceWith({ code: null, signal: 'relay-settled' });
    expect(new Set(f.holds.map((hold) => hold.argv[3])).size).toBe(4);
  });

  it.each<{ omit: string[]; env: Record<string, string> }>([
    { omit: ['process.spawn'], env: { SystemRoot: 'C:\\Windows' } },
    { omit: [], env: { SystemRoot: '\\\\server\\share' } },
    { omit: [], env: {} },
  ])('waits without a hold when the host cannot provide one: %j', async (options) => {
    const f = fixture(options); await f.bridge.start(true, 'terminal');
    const waiting = f.bridge.interact({ kind: 'permission', toolName: 'Bash', input: {} });
    expect(f.holds).toEqual([]);
    await f.bridge.receive(request('answer', 'interaction.reply', { id: (f.events('interaction.request').at(-1)!.data as { id: string }).id, result: { behavior: 'deny', message: 'no' } }));
    expect(await waiting).toEqual({ behavior: 'deny', message: 'no' });
  });
});

describe('native replies across a session rebind (B5)', () => {
  it('sends the reply of a request that crossed a rebind without remembering it, and drops it once closed', async () => {
    const f = fixture(), dialog = deferred<unknown>();
    f.api.command.run.mockReturnValueOnce(dialog.promise);
    await f.bridge.start(true, 'terminal');
    const running = f.bridge.receive(request('running', 'command.run', { command: 'config' }));
    const queued = f.bridge.receive(request('queued', 'session.compact')); await tick();
    f.setSession('replacement'); await f.bridge.rebind();
    dialog.resolve({ text: 'closed' }); await Promise.all([running, queued]);
    expect(f.reply('queued')).toEqual({ type: 'response', id: 'queued', ok: false, error: { code: 'SESSION_CHANGED', message: 'The native session changed before this request ran' } });
    expect(f.reply('running')).toMatchObject({ ok: true, value: { text: 'closed' } });
    expect(f.api.session.compact).not.toHaveBeenCalled();
    await f.bridge.receive(request('queued', 'session.compact'));
    expect(f.api.session.compact).toHaveBeenCalledTimes(1);
    expect(f.replies('queued').map((row) => row.ok)).toEqual([false, true]);
    const late = deferred<unknown>();
    f.api.session.compact.mockReturnValueOnce(late.promise);
    const lateRequest = f.bridge.receive(request('late', 'session.compact')); await tick();
    f.bridge.close('test finished'); late.resolve({ compacted: true }); await lateRequest;
    expect(f.reply('late')).toBeUndefined();
  });
});

describe('native slash command policy (B6)', () => {
  const relayOwned = ['login', 'logout', 'clear', 'new', 'reset', 'resume', 'continue', 'fork', 'branch', 'exit', 'quit', 'upgrade',
    'migrate-installer', 'tui', 'focus', 'background', 'bg', 'cd', 'terminal-setup', 'remote-control', 'rc', 'design-login', 'teleport', 'tp',
    'usage-credits', 'extra-usage', 'rate-limit-options', 'pro-trial-expired', 'install-github-app', 'setup-bedrock'];
  const aliasPairs = Object.entries(COMMAND_ALIASES).flatMap(([name, aliases]) => aliases.map((alias) => [alias, name] as const));
  const signIn = new Set([...SHARED_SIGN_IN_COMMANDS, 'rc', 'tp']);
  const refusal = (name: string) => signIn.has(name) ? signInCommandRefusal(name) : `/${name} is handled by Relay, not the native CLI.`;
  it('guards exactly the commands that break the Relay session model', () => {
    expect([...GUARDED_COMMANDS].sort()).toEqual([...relayOwned].sort());
  });

  it('keeps its copy of the sign-in commands and their wording identical to src/shared/signIn.ts', () => {
    expect([...SIGN_IN_COMMANDS].sort()).toEqual([...SHARED_SIGN_IN_COMMANDS].sort());
    expect([...ACCOUNT_COMMANDS].sort()).toEqual([...SHARED_ACCOUNT_COMMANDS].sort());
    for (const name of relayOwned) expect(commandRefusal(name)).toBe(refusal(name));
    for (const name of ['upgrade', 'rc', 'tp', 'install-github-app']) expect(commandRefusal(name)).not.toMatch(/not signed in|handled by Relay/);
  });

  it.each(relayOwned)('refuses /%s as Relay-owned without reaching the native CLI', async (name) => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    expect(await f.rpc('command.run', { command: ` /${name.toUpperCase()} `, args: 'anything' })).toEqual({ type: 'response', id: 'rpc-1', ok: false,
      error: { code: 'NATIVE_REQUEST_REJECTED', message: refusal(name) } });
    expect(f.api.command.run).not.toHaveBeenCalled();
  });

  it('keeps the CLI 2.1.308 alias table and the renderer copy identical', () => {
    expect(COMMAND_ALIASES).toEqual({ clear: ['reset', 'new'], resume: ['continue'], exit: ['quit'], background: ['bg'], 'remote-control': ['rc'], teleport: ['tp'] });
    expect(COMMAND_ALIASES).toEqual(SLASH_ALIASES);
  });

  it.each(aliasPairs)('refuses the alias /%s exactly like /%s', async (alias, name) => {
    expect(GUARDED_COMMANDS.has(alias)).toBe(GUARDED_COMMANDS.has(name));
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const refuse = async (typed: string) => (await f.rpc('command.run', { command: `/${typed} now`, args: '' }) as BridgeReply & { error: { message: string } }).error;
    expect(await refuse(alias)).toEqual({ code: 'NATIVE_REQUEST_REJECTED', message: refusal(alias) });
    expect((await refuse(name)).code).toBe('NATIVE_REQUEST_REJECTED');
    expect(f.api.command.run).not.toHaveBeenCalled();
  });

  it.each(aliasPairs)("runs a user's own /%s, which the CLI runs before the alias of /%s, and refuses the alias when none is listed", async (alias, name) => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const own = (...names: string[]) => names.map((entry) => ({ name: entry, description: 'A synthetic user command', source: 'user' })) as never;
    f.api.command.list.mockResolvedValue(own(alias, name));
    expect(await f.rpc('command.run', { command: `/${alias}`, args: 'synthetic' })).toMatchObject({ ok: true, value: { text: 'ran' } });
    expect(f.api.command.run).toHaveBeenCalledExactlyOnceWith({ command: alias, args: 'synthetic' });
    const refused = { ok: false, error: { code: 'NATIVE_REQUEST_REJECTED' } };
    // The guarded command itself stays Relay's; the CLI's exact lookup is case-sensitive.
    expect(await f.rpc('command.run', { command: name, args: '' })).toMatchObject(refused);
    expect(await f.rpc('command.run', { command: alias.toUpperCase(), args: '' })).toMatchObject(refused);
    f.api.command.list.mockResolvedValue(own(`${alias}-x`, `x-${alias}`));
    expect(await f.rpc('command.run', { command: alias, args: '' })).toMatchObject(refused);
    f.api.command.list.mockRejectedValue(new Error('Synthetic list failure'));
    expect(await f.rpc('command.run', { command: alias, args: '' })).toMatchObject(refused);
    expect(f.api.command.run).toHaveBeenCalledTimes(1);
  });

  it.each(['tp', 'rc'])('compares a user\'s own /%s with the typed name letter for letter, as the CLI and the main process do', async (alias) => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const own = (name: string) => [{ name, description: 'A synthetic user command', source: 'user' }] as never;
    const refused = { ok: false, error: { code: 'NATIVE_REQUEST_REJECTED', message: refusal(alias) } };
    f.api.command.list.mockResolvedValue(own(alias.toUpperCase()));
    expect(await f.rpc('command.run', { command: `/${alias}`, args: '' })).toMatchObject(refused);
    expect(await f.rpc('prompt.submit', { text: `/${alias}` })).toMatchObject(refused);
    f.api.command.list.mockResolvedValue(own(alias));
    expect(await f.rpc('command.run', { command: `/${alias.toUpperCase()}`, args: '' })).toMatchObject(refused);
    expect(await f.rpc('prompt.submit', { text: `/${alias.toUpperCase()}` })).toMatchObject(refused);
    expect(await f.rpc('prompt.submit', { text: `/${alias} synthetic` })).toMatchObject({ ok: true });
    expect(f.api.command.run).not.toHaveBeenCalled();
    expect(f.api.prompt.submit).toHaveBeenCalledExactlyOnceWith({ text: `/${alias} synthetic`, asUser: true });
  });

  it('refuses a user\'s own command of a guarded name in any letter case, as the window and the main process do', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    f.api.command.list.mockResolvedValue([{ name: 'UPGRADE', description: 'A synthetic user command', source: 'user' }] as never);
    const refused = { ok: false, error: { code: 'NATIVE_REQUEST_REJECTED', message: refusal('upgrade') } };
    expect(await f.rpc('command.run', { command: '/UPGRADE', args: '' })).toMatchObject(refused);
    expect(await f.rpc('prompt.submit', { text: '/UPGRADE' })).toMatchObject(refused);
    expect(f.api.command.run).not.toHaveBeenCalled();
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it.each(relayOwned)('refuses a prompt that the CLI would run as /%s', async (name) => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    expect(await f.rpc('prompt.submit', { text: ` /${name.toUpperCase()} anything` })).toEqual({ type: 'response', id: 'rpc-1', ok: false,
      error: { code: 'NATIVE_REQUEST_REJECTED', message: refusal(name) } });
    expect(f.api.prompt.submit).not.toHaveBeenCalled();
  });

  it('sends a prompt that only mentions a guarded command, or starts with another one', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    for (const text of ['why does /login fail?', '/config', '/backgrounds', 'please /upgrade later']) {
      expect(await f.rpc('prompt.submit', { text })).toMatchObject({ ok: true });
    }
    expect((f.api.prompt.submit.mock.calls as unknown as Array<[{ text: string }]>).map(([args]) => args.text))
      .toEqual(['why does /login fail?', '/config', '/backgrounds', 'please /upgrade later']);
  });

  it.each(['backgrounds', 'r', 'continues', 'newest', 'context'])('does not guard /%s, which is no alias', async (name) => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    expect(await f.rpc('command.run', { command: name, args: '' })).toMatchObject({ ok: true });
    expect(f.api.command.run).toHaveBeenCalledWith({ command: name, args: '' });
  });

  it('passes native panels and argument commands through command.run', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const allowed = [['/config', ''], ['settings', ''], ['plugin', ''], ['plugins', ''], ['hooks', ''], ['statusline', ''], ['model', 'sonnet'],
      ['effort', 'high'], ['permissions', ''], ['mcp', ''], ['fast', 'on'], ['trust', ''], ['init', '']] as const;
    for (const [command, args] of allowed) expect(await f.rpc('command.run', { command, args })).toMatchObject({ ok: true, value: { text: 'ran' } });
    expect(f.api.command.run.mock.calls).toEqual(allowed.map(([command, args]) => [{ command: command.replace(/^\//, ''), args }]));
  });

  it('refuses a second slash command at once while the first still runs, and keeps the ui.command allow-list', async () => {
    const f = fixture(), dialog = deferred<unknown>();
    f.api.command.run.mockReturnValueOnce(dialog.promise);
    await f.bridge.start(true, 'terminal');
    const first = f.bridge.receive(request('first', 'command.run', { command: 'config' })); await tick();
    const write = f.bridge.receive(request('write', 'session.compact'));
    const second = f.bridge.receive(request('second', 'command.run', { command: 'model', args: 'sonnet' })); await tick();
    expect(f.reply('second')).toEqual({ type: 'response', id: 'second', ok: false, error: { code: 'NATIVE_REQUEST_REJECTED', message: COMMAND_BUSY_MESSAGE } });
    expect(f.reply('write')).toBeUndefined();
    expect(f.api.command.run).toHaveBeenCalledTimes(1);
    dialog.resolve({ text: 'closed' }); await Promise.all([first, write, second]);
    expect(await f.rpc('command.run', { command: 'model', args: 'sonnet' })).toMatchObject({ ok: true });
    expect(await f.rpc('ui.command', { command: 'config' })).toMatchObject({ ok: false, error: { message: 'Only named native control dialogs are allowed' } });
    expect(await f.rpc('ui.command', { command: 'rate-limit-options' })).toMatchObject({ ok: false, error: { message: 'Only named native control dialogs are allowed' } });
    expect(await f.rpc('ui.command', { command: 'model', args: 'sonnet' })).toMatchObject({ ok: false, error: { message: 'Only named native control dialogs are allowed' } });
    f.bridge.setTurn('running');
    expect(await f.rpc('ui.command', { command: 'model' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('idle session') } });
    f.bridge.setTurn(undefined);
    expect(await f.rpc('ui.command', { command: 'model' })).toMatchObject({ ok: true });
    expect(f.api.command.run).toHaveBeenCalledTimes(3);
  });
});

describe('native capability gate (B7)', () => {
  it('refuses every method it did not advertise before reaching its handler', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    const hello = f.outputs[0] as BridgeHello;
    expect(hello.capabilities).toEqual([...CAPABILITIES]);
    const reads = f.api.env.get.mock.calls.length;
    const unadvertised = [['workflow.set', { enabled: false }], ['fast.set', { enabled: true }], ['autoContinue.set', { enabled: false }],
      ['ultracode.set', { enabled: true }], ['mcp.nativeAction', { operation: 'disable', name: 'fixture' }], ['config.open', undefined],
      ['config.set', { key: 'effort', value: 'low' }], ['session.fork', {}]] as const;
    for (const [method, args] of unadvertised) {
      expect(hello.capabilities).not.toContain(method);
      expect(await f.rpc(method, args)).toMatchObject({ ok: false, error: { code: 'NATIVE_REQUEST_REJECTED', message: 'Unsupported native bridge method' } });
    }
    expect(f.api.env.get.mock.calls.length).toBe(reads);
    expect(f.api.config.set).not.toHaveBeenCalled(); expect(f.api.command.run).not.toHaveBeenCalled();
    const opted = fixture({ env: { RELAY_NATIVE_PERSISTENT_CONTROLS: '1' } }); await opted.bridge.start(true, 'terminal');
    expect((opted.outputs[0] as BridgeHello).capabilities).toEqual([...CAPABILITIES, ...PERSISTENT_CAPABILITIES]);
    expect(await opted.rpc('config.open')).toMatchObject({ ok: true });
  });

  it.each(['session.id', 'session.model', 'session.cwd', 'env.get'])('still fails startup when the hello cannot call $.%s', async (missing) => {
    const f = fixture({ omit: [missing] });
    await expect(f.bridge.start(true, 'terminal')).rejects.toThrow();
    expect(f.transport.start).not.toHaveBeenCalled();
    expect(f.outputs).toEqual([]);
  });
});
