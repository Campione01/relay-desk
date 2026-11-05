import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { McpServerConfig, Options, Query, SDKControlGetContextUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { Effort, OpenSessionRequest, PermissionMode, Profile, PromptAttachment, TranscriptItem } from '@shared/types';
import { buildChildEnv } from '../../src/main/system/env';
import { NETWORK_ENV } from './fixtures/networkEnv';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
}));

const { PermissionBroker } = await import('../../src/main/engine/broker');
const { imageStore } = await import('../../src/main/engine/images');
const { AUTH_ERROR_MESSAGE, CONTEXT_REFRESH_MS, EngineSession, isAuthFailure, redactSecrets, toContextUsage } = await import(
  '../../src/main/engine/session'
);
const { AUTO_CONTINUE_PROMPT } = await import('../../src/main/engine/mapTranscript');
type ChildLike = import('../../src/main/engine/session').ChildLike;
type CodeContextSettings = import('../../src/main/engine/session').CodeContextSettings;
type EngineSessionOptions = import('../../src/main/engine/session').EngineSessionOptions;

const CWD = 'D:\\work\\demo';
const SID = 'sess-live';
const PROFILE: Profile = { id: 'default', name: 'Default', configDir: null, createdAt: 0 };
const ENV = { PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' };
const NOW = 5_000;

const PASTED_PNG: PromptAttachment = { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' };
const PASTED_JPEG: PromptAttachment = { kind: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQ==' };
const PASTED_PDF: PromptAttachment = { kind: 'pdf', mediaType: 'application/pdf', data: 'JVBERi0xLjcKJcfsj6I=', name: 'spec.pdf' };

const CONTEXT_RESPONSE = {
  categories: [
    { name: 'Messages', tokens: 100, color: '#abc', kind: 'used' },
    { name: 'Free space', tokens: 900, color: '#def', kind: 'free' },
  ],
  totalTokens: 100,
  maxTokens: 1000,
  rawMaxTokens: 1000,
  percentage: 10,
  gridRows: [],
  model: 'claude-test',
  memoryFiles: [] as SDKControlGetContextUsageResponse['memoryFiles'],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
};
const CONTEXT_USAGE = {
  usedTokens: 100,
  maxTokens: 1000,
  percent: 10,
  model: 'claude-test',
  memoryFiles: [],
  categories: [
    { name: 'Messages', tokens: 100, kind: 'used', color: '#abc' },
    { name: 'Free space', tokens: 900, kind: 'free', color: '#def' },
  ],
};

/** Scripted stand-in for the SDK Query: tests push SDK messages, the session consumes them. */
class FakeQuery {
  readonly sent: SDKUserMessage[] = [];
  private readonly pending: SDKMessage[] = [];
  private waiter: ((result: IteratorResult<SDKMessage, undefined>) => void) | undefined;
  private rejecter: ((error: Error) => void) | undefined;
  private finished = false;
  private failure: Error | undefined;

  initializationResult = vi.fn(async () => ({
    commands: [
      { name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' },
      { name: '/context', description: 'Show context usage', argumentHint: '', aliases: ['ctx'] },
    ],
    agents: [],
    output_style: 'default',
    available_output_styles: [],
    models: [],
    account: {},
  }));
  accountInfo = vi.fn(async () => ({
    email: 'user@example.com',
    subscriptionType: 'max',
    tokenSource: 'never-forwarded',
    apiKeySource: 'none',
  }));
  supportedModels = vi.fn(async () => [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Best model',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAutoMode: true,
    },
    { value: 'haiku', displayName: 'Haiku', description: '' },
  ]);
  getContextUsage = vi.fn(async () => CONTEXT_RESPONSE);
  rejectInit: (error: Error) => void = () => undefined;
  setModel = vi.fn(async () => undefined);
  setPermissionMode = vi.fn(async () => undefined);
  applyFlagSettings = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
  close = vi.fn(() => this.end());

  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, readInput = true) {
    if (readInput) void (async () => {
      for await (const message of params.prompt) this.sent.push(message);
    })();
  }

  push(...messages: unknown[]): void {
    for (const message of messages) {
      const waiter = this.waiter;
      this.waiter = undefined;
      if (waiter) waiter({ value: message as SDKMessage, done: false });
      else this.pending.push(message as SDKMessage);
    }
  }

  end(): void {
    this.finished = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  fail(error: Error): void {
    this.failure = error;
    this.rejecter?.(error);
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<SDKMessage, undefined>> {
    const message = this.pending.shift();
    if (message) return Promise.resolve({ value: message, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.finished) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.rejecter = reject;
    });
  }

  return(): Promise<IteratorResult<SDKMessage, undefined>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    queueMicrotask(() => {
      this.emit('exit', null, this.signalCode);
      this.stderr.end();
    });
    return true;
  });

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.stderr.end();
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

interface SetupOptions {
  request?: Partial<OpenSessionRequest>;
  spawnOnStart?: FakeChild;
  logDir?: string;
  closeTimeoutMs?: number;
  failInit?: Error;
  /** initializationResult() stays pending until the test calls query().rejectInit(). */
  holdInit?: boolean;
  readInput?: boolean;
  /** Extra fields merged into the initializationResult() answer. */
  initResult?: Record<string, unknown>;
  /** Gives the fake query mcpServerStatus/toggleMcpServer/reconnectMcpServer; status answers come from this list. */
  mcpStatus?: unknown[][];
  mcpServers?: Record<string, McpServerConfig>;
  profile?: Profile;
  codeContextSettings?: CodeContextSettings;
  onRateLimit?: EngineSessionOptions['onRateLimit'];
  buildEnv?(profile: Profile): NodeJS.ProcessEnv;
  /** A clock the test moves; NOW when absent. */
  clock?: { now: number };
  autoContinueTimers?: EngineSessionOptions['autoContinueTimers'];
  /** getContextUsage() fails until the test changes it. */
  contextFails?: boolean;
}

function setup(options: SetupOptions = {}) {
  const events: EngineEvent[] = [];
  let fake: FakeQuery | undefined;
  let counter = 0;
  const onClosed = vi.fn();
  const spawn = vi.fn(() => options.spawnOnStart as unknown as ChildLike);
  let session: InstanceType<typeof EngineSession> | undefined;
  const broker = new PermissionBroker('h1', (event) => events.push(event), {
    onPendingChange: (count) => session?.onPendingChange(count),
    onDecision: (info) => session?.onToolDecision(info),
  });
  session = new EngineSession({
    handleId: 'h1',
    request: { profileId: 'default', cwd: CWD, ...options.request },
    profile: options.profile ?? PROFILE,
    ...(options.codeContextSettings !== undefined ? { codeContextSettings: options.codeContextSettings } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.onRateLimit ? { onRateLimit: options.onRateLimit } : {}),
    emit: (event) => events.push(event),
    broker,
    onClosed,
    ...(options.logDir ? { logDir: options.logDir } : {}),
    query: (params) => {
      fake = new FakeQuery(params, options.readInput);
      if (options.failInit) fake.initializationResult.mockRejectedValue(options.failInit);
      if (options.mcpStatus) {
        const answers = options.mcpStatus;
        const mcp = fake as unknown as Record<string, unknown>;
        mcp.mcpServerStatus = vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0]));
        mcp.toggleMcpServer = vi.fn(async () => undefined);
        mcp.reconnectMcpServer = vi.fn(async () => {
          throw new Error('reconnect failed: Bearer synthetic-token-value');
        });
      }
      if (options.contextFails) fake.getContextUsage.mockRejectedValue(new Error('not ready'));
      if (options.initResult) {
        const base = fake.initializationResult.getMockImplementation();
        const extra = options.initResult;
        fake.initializationResult.mockImplementation(async () => ({ ...(await base!()), ...extra }));
      }
      if (options.holdInit) {
        const held = fake;
        held.initializationResult.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              held.rejectInit = reject;
            }),
        );
      }
      if (options.spawnOnStart) {
        params.options.spawnClaudeCodeProcess?.({
          command: 'C:\\fake\\claude.exe',
          args: ['--input-format', 'stream-json'],
          cwd: CWD,
          env: { PATH: 'C:\\Windows' },
          signal: new AbortController().signal,
        });
      }
      return fake as unknown as Query;
    },
    spawn,
    resolveBinary: () => 'C:\\fake\\claude.exe',
    buildEnv: options.buildEnv ?? (() => ({ ...ENV })),
    newId: () => `id-${++counter}`,
    now: () => options.clock?.now ?? NOW,
    ...(options.autoContinueTimers ? { autoContinueTimers: options.autoContinueTimers } : {}),
    random: () => 0,
    closeTimeoutMs: options.closeTimeoutMs ?? 1_000,
  });
  const query = (): FakeQuery => {
    if (!fake) throw new Error('query not started');
    return fake;
  };
  return { session, events, broker, query, onClosed, spawn };
}

let seq = 0;
const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  uuid: `init-${++seq}`,
  session_id: SID,
  model: 'claude-test',
  permissionMode: 'default',
  slash_commands: ['compact', '/context'],
  tools: ['Bash', 'Read'],
  cwd: CWD,
  apiKeySource: 'none',
  claude_code_version: '2.1.302',
  mcp_servers: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  ...extra,
});
const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  uuid: `se-${++seq}`,
  session_id: SID,
  ...extra,
});
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}, model = 'claude-test') => ({
  type: 'assistant',
  message: { id, model, role: 'assistant', content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  parent_tool_use_id: null,
  uuid: `as-${++seq}`,
  session_id: SID,
  ...extra,
});
const toolResult = (toolUseId: string, content: unknown, isError = false, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: null,
  session_id: SID,
  ...extra,
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  duration_ms: 1200,
  duration_api_ms: 1000,
  is_error: false,
  num_turns: 1,
  result: 'Done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 42, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 },
  modelUsage: {},
  permission_denials: [],
  uuid: `res-${++seq}`,
  session_id: SID,
  ...extra,
});
const system = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  uuid: `sys-${++seq}`,
  session_id: SID,
  ...extra,
});

function items(events: EngineEvent[]): TranscriptItem[] {
  return events.flatMap((event) => (event.type === 'item' ? [event.item] : []));
}

function permissionContext(toolUseID: string) {
  return { signal: new AbortController().signal, toolUseID, requestId: `cli-${toolUseID}` };
}

describe('EngineSession start', () => {
  it('uses the full Code preset for new, resumed and forked sessions without disabling prompt snapshots', async () => {
    for (const request of [{}, { resumeSessionId: 'resume-1' }, { resumeSessionId: 'source-1', forkSession: true }]) {
      const { session, query } = setup({ request });
      await session.start();
      expect(query().params.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
      expect(query().params.options.settingSources).toEqual(['user', 'project', 'local']);
      expect(query().params.options).not.toHaveProperty('settings');
      await session.close();
    }
  });

  it('inherits the native permission mode unless requested and reflects the CLI init mode', async () => {
    const inherited = setup();
    await inherited.session.start();
    expect(inherited.query().params.options).not.toHaveProperty('permissionMode');
    inherited.query().push(init({ permissionMode: 'plan' }));
    await settle();
    expect(inherited.events.filter((event) => event.type === 'init').at(-1)).toMatchObject({ permissionMode: 'plan' });
    await inherited.session.close();

    const explicit = setup({ request: { permissionMode: 'default' } });
    await explicit.session.start();
    expect(explicit.query().params.options.permissionMode).toBe('default');
    await explicit.session.close();
  });

  it('reports no permission mode until the CLI does, then takes the initialize or status report', async () => {
    const pending = setup();
    await pending.session.start();
    const first = pending.events.find((event) => event.type === 'init');
    expect(first).toBeDefined();
    expect(first).not.toHaveProperty('permissionMode');
    pending.query().push(system('status', { status: null, permissionMode: 'acceptEdits' }));
    await settle();
    expect(pending.events.filter((event) => event.type === 'init').at(-1)).toMatchObject({ permissionMode: 'acceptEdits' });
    await pending.session.close();

    const withMode = setup({ initResult: { current_permission_mode: 'plan' } });
    await withMode.session.start();
    expect(withMode.events.find((event) => event.type === 'init')).toMatchObject({ permissionMode: 'plan' });
    await withMode.session.close();

    const bogus = setup({ initResult: { current_permission_mode: 'yolo' } });
    await bogus.session.start();
    expect(bogus.events.find((event) => event.type === 'init')).not.toHaveProperty('permissionMode');
    await bogus.session.close();
  });

  it('forwards only approved Code settings without copying host auth, env or MCP configuration', async () => {
    const approved = {
      permissions: { allow: ['Read(C:\\synthetic\\shared/**)'], deny: ['Bash(curl:*)'], defaultMode: 'plan' as const },
      autoMemoryDirectory: 'C:\\synthetic\\shared-memory',
      autoMemoryEnabled: false,
      env: { ANTHROPIC_API_KEY: 'synthetic-must-not-forward' },
      apiKeyHelper: 'synthetic-helper-must-not-forward',
      mcpServers: { synthetic: { command: 'must-not-run' } },
      model: 'must-not-forward',
    };
    const { session, query } = setup({ codeContextSettings: approved });
    await session.start();
    expect(query().params.options.settings).toEqual({
      permissions: approved.permissions,
      autoMemoryDirectory: approved.autoMemoryDirectory,
      autoMemoryEnabled: false,
    });
    expect((query().params.options.settings as CodeContextSettings).permissions).not.toBe(approved.permissions);
    expect(query().params.options.env).toEqual(ENV);
    expect(query().params.options).not.toHaveProperty('permissionMode');
    expect(query().params.options).not.toHaveProperty('model');
    await session.close();
  });

  it('preserves proxy casing variants and custom certificate variables in the scrubbed SDK environment', async () => {
    const profile = { ...PROFILE, id: 'work', configDir: 'C:\\synthetic\\work-profile' };
    const base = {
      ...NETWORK_ENV,
      ANTHROPIC_API_KEY: 'synthetic-never-forwarded',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-token',
      CLAUDE_CONFIG_DIR: 'C:\\synthetic\\wrong-profile',
    };
    const { session, query } = setup({ profile, request: { profileId: profile.id }, buildEnv: (selected) => buildChildEnv(selected, base) });
    await session.start();
    expect(query().params.options.env).toEqual({ ...NETWORK_ENV, CLAUDE_CONFIG_DIR: profile.configDir });
    expect(base.ANTHROPIC_API_KEY).toBe('synthetic-never-forwarded');
    await session.close();
  });

  it('starts a resumed session with the documented SDK options and announces it', async () => {
    const { session, events, query, broker } = setup({
      request: { resumeSessionId: 'resume-1', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' },
    });
    const handle = await session.start();
    expect(handle).toEqual({ handleId: 'h1', sessionId: 'resume-1', profileId: 'default', cwd: CWD });

    const options = query().params.options;
    expect(options).toMatchObject({
      cwd: CWD,
      resume: 'resume-1',
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      env: ENV,
      pathToClaudeCodeExecutable: 'C:\\fake\\claude.exe',
    });
    expect(options.canUseTool).toBe(broker.canUseTool);
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    expect(options).not.toHaveProperty('forkSession');
    expect(options).not.toHaveProperty('sessionId');

    await settle();
    expect(events).toEqual([
      { type: 'state', handleId: 'h1', state: 'starting' },
      {
        type: 'commands',
        handleId: 'h1',
        commands: [
          { name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' },
          { name: 'context', description: 'Show context usage', aliases: ['ctx'] },
        ],
      },
      {
        type: 'init',
        handleId: 'h1',
        sessionId: 'resume-1',
        model: 'opus',
        permissionMode: 'acceptEdits',
        slashCommands: ['compact', 'context'],
        tools: [],
        cwd: CWD,
      },
      { type: 'state', handleId: 'h1', state: 'idle' },
      // Read at open, so the ring shows before the first turn ends.
      { type: 'context', handleId: 'h1', usage: toContextUsage(CONTEXT_RESPONSE as SDKControlGetContextUsageResponse) },
      { type: 'account', handleId: 'h1', email: 'user@example.com', subscriptionType: 'max' },
    ]);
    expect(query().getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
  });

  it('reads the context at open, after a model change, and during a turn after main replies at most every 10 s', async () => {
    // The ring once stayed empty for about ten minutes, until the first turn ended.
    const clock = { now: NOW };
    const { session, query } = setup({ clock, request: { liveContext: true } });
    await session.start();
    await settle();
    const calls = () => query().getContextUsage.mock.calls.length;
    expect(calls()).toBe(1);
    await session.send('Hello');
    query().push(assistant('msg_a', [{ type: 'text', text: 'One' }]));
    await settle();
    expect(calls()).toBe(1);
    clock.now += CONTEXT_REFRESH_MS;
    query().push(assistant('msg_b', [{ type: 'text', text: 'Two' }]));
    await settle();
    expect(calls()).toBe(2);
    clock.now += CONTEXT_REFRESH_MS - 1;
    query().push(assistant('msg_c', [{ type: 'text', text: 'Three' }]));
    await settle();
    expect(calls()).toBe(2);
    clock.now += 1;
    query().push(
      assistant('msg_d', [{ type: 'text', text: 'From a subagent' }], { parent_tool_use_id: 'tu_agent' }),
      assistant('msg_e', [{ type: 'text', text: "You've hit your session limit · resets 9:10pm" }], { error: 'rate_limit' }, '<synthetic>'),
      // A message the CLI writes itself: no API call, so the context did not change.
      assistant('msg_s', [{ type: 'text', text: 'No response requested.' }], {}, '<synthetic>'),
    );
    await settle();
    expect(calls()).toBe(2);
    query().push(assistant('msg_f', [{ type: 'text', text: 'Four' }]));
    await settle();
    expect(calls()).toBe(3);
    await session.setModel('sonnet');
    await settle();
    expect(calls()).toBe(4);
    await session.close();
  });

  it('moves the context total with each main reply from its token usage, without asking the CLI', async () => {
    const { session, events, query } = setup({ contextFails: true });
    await session.start();
    await settle();
    await session.send('Hello');
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 };
    // Without a full reading there is no window to measure against.
    query().push(stream({ type: 'message_start', message: { id: 'msg_0', usage } }));
    await settle();
    const contexts = () => events.flatMap((event) => (event.type === 'context' ? [event.usage] : []));
    expect(contexts()).toEqual([]);

    query().getContextUsage.mockResolvedValue(CONTEXT_RESPONSE as never);
    await session.contextUsage();
    const full = toContextUsage(CONTEXT_RESPONSE as SDKControlGetContextUsageResponse);
    expect(contexts()).toEqual([full]);
    const calls = query().getContextUsage.mock.calls.length;
    query().push(
      stream({ type: 'message_start', message: { id: 'msg_1', usage } }),
      stream({ type: 'message_delta', delta: {}, usage: { ...usage, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } } }),
      stream({ type: 'message_start', message: { id: 'msg_sub', usage: { input_tokens: 999 } } }, { parent_tool_use_id: 'tu_agent' }),
    );
    await settle();
    expect(contexts().slice(1)).toEqual([
      { ...full, usedTokens: 310, percent: 31, live: true },
      { ...full, usedTokens: 340, percent: 34, live: true },
    ]);
    expect(query().getContextUsage.mock.calls.length).toBe(calls);
    await session.close();
  });

  it('reads the context during a turn only while the setting is on (off by default)', async () => {
    const clock = { now: NOW };
    const { session, query } = setup({ clock });
    await session.start();
    await settle();
    const calls = () => query().getContextUsage.mock.calls.length;
    expect(calls()).toBe(1);
    await session.send('Hello');
    clock.now += CONTEXT_REFRESH_MS;
    query().push(assistant('msg_a', [{ type: 'text', text: 'One' }]));
    await settle();
    expect(calls()).toBe(1);
    await expect(session.setLiveContext('on' as unknown as boolean)).rejects.toThrow('Invalid context refresh setting.');
    await session.setLiveContext(true);
    query().push(assistant('msg_b', [{ type: 'text', text: 'Two' }]));
    await settle();
    expect(calls()).toBe(2);
    await session.setLiveContext(false);
    clock.now += CONTEXT_REFRESH_MS;
    query().push(assistant('msg_c', [{ type: 'text', text: 'Three' }]), result());
    await settle();
    // The turn end still reads it.
    expect(calls()).toBe(3);
    await session.close();
    await expect(session.setLiveContext(true)).rejects.toThrow('This session is closed.');
  });

  it('gives new and forked sessions a fresh session id', async () => {
    const fresh = setup();
    expect(await fresh.session.start()).toMatchObject({ sessionId: 'id-1' });
    expect(fresh.query().params.options).toMatchObject({ sessionId: 'id-1' });
    expect(fresh.query().params.options).not.toHaveProperty('permissionMode');
    expect(fresh.query().params.options).not.toHaveProperty('resume');

    const fork = setup({ request: { resumeSessionId: 'source-1', forkSession: true } });
    expect(await fork.session.start()).toMatchObject({ sessionId: 'id-1' });
    expect(fork.query().params.options).toMatchObject({ resume: 'source-1', forkSession: true, sessionId: 'id-1' });
  });

  it('starts a side chat as an unsaved fork and refuses an unsaved session that is not a fork', async () => {
    const side = setup({ request: { resumeSessionId: 'source-1', forkSession: true, ephemeral: true } });
    expect(await side.session.start()).toMatchObject({ sessionId: 'id-1' });
    expect(side.query().params.options).toMatchObject({ resume: 'source-1', forkSession: true, sessionId: 'id-1', persistSession: false });
    await side.session.close();

    const saved = setup({ request: { resumeSessionId: 'source-1', forkSession: true } });
    await saved.session.start();
    expect(saved.query().params.options).not.toHaveProperty('persistSession');
    await saved.session.close();

    for (const request of [{ resumeSessionId: 'source-1', ephemeral: true }, { ephemeral: true }, { forkSession: true, ephemeral: true }]) {
      const refused = setup({ request });
      await expect(refused.session.start()).rejects.toThrow('A side chat must fork a resumed session.');
      expect(() => refused.query()).toThrow('query not started');
    }
  });

  it('rejects start with a readable message and closes when the CLI fails to initialize', async () => {
    const { session, events, onClosed } = setup({ failInit: new Error('spawn failed: ENOENT') });
    await expect(session.start()).rejects.toThrow('spawn failed: ENOENT');
    expect(events.at(-1)).toEqual({ type: 'state', handleId: 'h1', state: 'closed' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('reports a not-logged-in start-up failure as the Accounts hint', async () => {
    const child = new FakeChild();
    const { session, query } = setup({ spawnOnStart: child, holdInit: true });
    const starting = session.start();
    await settle();
    child.stderr.write('Not logged in · Please run /login\n');
    child.exit(1);
    query().rejectInit(new Error('Claude Code process exited with code 1'));
    await expect(starting).rejects.toThrow(AUTH_ERROR_MESSAGE);
  });

  it('redacts diagnostics before truncating the stderr tail used in startup errors', async () => {
    const child = new FakeChild();
    const { session, query } = setup({ spawnOnStart: child, holdInit: true });
    const starting = session.start();
    await settle();
    child.stderr.write(`warning sk-ant-api03-${'x'.repeat(5_000)}SENSITIVE_SUFFIX`);
    child.exit(1);
    query().rejectInit(new Error('CLI failed to start'));
    const error = await starting.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('sk-ant-[redacted]');
    expect((error as Error).message).not.toContain('SENSITIVE_SUFFIX');
  });
});

describe('EngineSession turns', () => {
  it('streams thinking and text deltas, then finalizes the same items, result, idle state and context', async () => {
    const { session, events, query } = setup();
    await session.start();
    await settle();
    events.length = 0;

    await session.send('Hello');
    query().push(
      init(),
      stream({ type: 'message_start', message: { id: 'msg_1', usage: { output_tokens: 1 } } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo!' } }),
      stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
      stream({ type: 'message_stop' }),
      assistant('msg_1', [{ type: 'thinking', thinking: 'Plan more', signature: 's' }]),
      assistant('msg_1', [{ type: 'text', text: 'Hello!' }]),
      result({ uuid: 'res-1' }),
    );
    await settle();

    expect(query().sent).toHaveLength(1);
    expect(query().sent[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Hello' },
      parent_tool_use_id: null,
      uuid: 'id-2',
      origin: { kind: 'human' },
    });
    expect(query().sent[0]).not.toHaveProperty('priority');
    expect(query().getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
    expect(events).toEqual([
      { type: 'item', handleId: 'h1', item: { kind: 'user', id: 'id-2', text: 'Hello' } },
      { type: 'state', handleId: 'h1', state: 'running', startedAt: NOW, tokens: 0 },
      {
        type: 'init',
        handleId: 'h1',
        sessionId: SID,
        model: 'claude-test',
        permissionMode: 'default',
        slashCommands: ['compact', 'context'],
        tools: ['Bash', 'Read'],
        cwd: CWD,
      },
      { type: 'item', handleId: 'h1', item: { kind: 'thinking', id: 'msg_1:0', text: 'Plan', streaming: true } },
      { type: 'delta', handleId: 'h1', itemId: 'msg_1:0', text: ' more' },
      { type: 'item', handleId: 'h1', item: { kind: 'assistant', id: 'msg_1:1', text: 'Hel', streaming: true } },
      { type: 'delta', handleId: 'h1', itemId: 'msg_1:1', text: 'lo!' },
      { type: 'state', handleId: 'h1', state: 'running', startedAt: NOW, tokens: 30 },
      { type: 'item', handleId: 'h1', item: { kind: 'thinking', id: 'msg_1:0', text: 'Plan more' } },
      { type: 'item', handleId: 'h1', item: { kind: 'assistant', id: 'msg_1:1', text: 'Hello!' } },
      {
        type: 'item',
        handleId: 'h1',
        item: { kind: 'result', id: 'res-1', durationMs: 1200, costUsd: 0.01, inputTokens: 115, outputTokens: 42, isError: false },
      },
      { type: 'state', handleId: 'h1', state: 'idle', tokens: 42 },
      { type: 'context', handleId: 'h1', usage: CONTEXT_USAGE },
    ]);
    expect(session.handle.sessionId).toBe(SID);
  });


  it('pairs tool calls with results, shows awaiting while a permission is pending and marks broker denials', async () => {
    const { session, events, query, broker } = setup();
    await session.start();
    await session.send('Fix it');
    query().push(
      assistant('msg_2', [
        {
          type: 'tool_use',
          id: 'tu_edit',
          name: 'Edit',
          input: { file_path: 'D:\\work\\demo\\a.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
      toolResult('tu_edit', 'The file was updated.', false, {
        tool_use_result: { structuredPatch: [{ lines: [' x', '-a', '+b', '+c'] }] },
      }),
      assistant('msg_3', [{ type: 'tool_use', id: 'tu_task', name: 'Agent', input: { description: 'Look around' } }]),
      assistant('msg_sub', [{ type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: 'x' } }], {
        parent_tool_use_id: 'tu_task',
      }),
      assistant('msg_4', [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'rm -rf build' } }]),
    );
    await settle();

    const before = events.length;
    const decision = broker.canUseTool('Bash', { command: 'rm -rf build' }, permissionContext('tu_bash'));
    const permission = events[before];
    expect(permission?.type).toBe('permission');
    expect(events[before + 1]).toEqual({ type: 'state', handleId: 'h1', state: 'awaiting', startedAt: NOW, tokens: 0 });
    broker.respondPermission(permission?.type === 'permission' ? permission.request.requestId : '', {
      behavior: 'deny',
      message: 'not now',
    });
    await decision;
    query().push(toolResult('tu_bash', 'Rejected by the host.', true));
    await settle();
    expect(events.slice(before).map((e) => (e.type === 'state' ? e.state : e.type))).toEqual([
      'permission',
      'awaiting',
      'requestClosed',
      'running',
      'item',
    ]);

    const latest = (id: string) => items(events).filter((item) => item.id === id).at(-1);
    expect(items(events).find((item) => item.id === 'tu_edit')).toMatchObject({
      status: 'running',
      summary: 'Edited a.ts (+1 −1)',
    });
    expect(latest('tu_edit')).toEqual({
      kind: 'tool',
      id: 'tu_edit',
      toolUseId: 'tu_edit',
      name: 'Edit',
      input: { file_path: 'D:\\work\\demo\\a.ts', old_string: 'a', new_string: 'b' },
      summary: 'Edited a.ts (+2 −1)',
      status: 'done',
      output: 'The file was updated.',
      // Kept from the first running emission, for the elapsed time of the activity line.
      startedAt: NOW,
    });
    expect(latest('tu_grep')).toMatchObject({ status: 'running', parentToolUseId: 'tu_task', summary: 'Searched for `x`' });
    expect(latest('tu_bash')).toMatchObject({ status: 'denied', output: 'Rejected by the host.', summary: 'Ran `rm -rf build`' });
  });

  it('queues sends while a turn runs and clears the queued badge when a turn consumes them', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('first');
    await session.send('second', { queue: true });
    await session.send('third');
    await settle();
    expect(query().sent.map((m) => [m.message.content, m.priority])).toEqual([
      ['first', undefined],
      ['second', 'later'],
      ['third', 'next'],
    ]);
    expect(items(events).filter((item) => item.kind === 'user')).toEqual([
      { kind: 'user', id: 'id-2', text: 'first' },
      { kind: 'user', id: 'id-3', text: 'second', queued: true },
      { kind: 'user', id: 'id-4', text: 'third', queued: true },
    ]);

    query().push(result({ queued_turn_count: 1 }));
    await settle();
    expect(events.at(-2)).toEqual({ type: 'state', handleId: 'h1', state: 'running', startedAt: NOW, tokens: 0 });

    query().push(stream({ type: 'message_start', message: { id: 'msg_q', usage: { output_tokens: 1 } } }, { user_message_uuids: ['id-3'] }));
    await settle();
    expect(items(events).at(-1)).toEqual({ kind: 'user', id: 'id-3', text: 'second' });

    query().push(result());
    await settle();
    expect(items(events).filter((item) => item.kind === 'user').at(-1)).toEqual({ kind: 'user', id: 'id-4', text: 'third' });
    expect(session.currentState).toBe('idle');
  });

  it('sends pasted images and PDFs as SDK content blocks and echoes the images with refs under the history key', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('What is wrong here?', { attachments: [PASTED_PNG, PASTED_PDF, PASTED_JPEG] });
    await settle();
    expect(query().sent[0]?.message.content).toEqual([
      { type: 'text', text: 'What is wrong here?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PASTED_PNG.data } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PASTED_PDF.data }, title: 'spec.pdf' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PASTED_JPEG.data } },
    ]);
    const echo = {
      kind: 'user',
      id: 'id-2',
      text: 'What is wrong here?',
      images: 2,
      imageRefs: [
        { key: 'id-1:id-2:0', mediaType: 'image/png' },
        { key: 'id-1:id-2:1', mediaType: 'image/jpeg' },
      ],
    };
    expect(items(events)).toEqual([echo]);
    expect(imageStore.get('id-1:id-2:1')).toBe(`data:image/jpeg;base64,${PASTED_JPEG.data}`);
    expect(JSON.stringify(events)).not.toContain(PASTED_PNG.data);
    expect(JSON.stringify(events)).not.toContain(PASTED_PDF.data);
    await session.close();
  });

  it('sends attachments without text, but never an empty message', async () => {
    const { session, events, query } = setup();
    await session.start();
    await expect(session.send('  ')).rejects.toThrow('Nothing to send.');
    await expect(session.send('', { attachments: [] })).rejects.toThrow('Nothing to send.');
    await session.send('', { attachments: [PASTED_PDF] });
    await settle();
    expect(query().sent).toHaveLength(1);
    expect(query().sent[0]?.message.content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PASTED_PDF.data }, title: 'spec.pdf' },
    ]);
    expect(items(events)).toEqual([{ kind: 'user', id: 'id-2', text: '' }]);
    expect(session.currentState).toBe('running');
    await session.close();
  });

  it('keeps the images of a queued message when a turn consumes it', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('first');
    await session.send('', { queue: true, attachments: [PASTED_PNG] });
    await settle();
    expect(query().sent[1]).toMatchObject({
      priority: 'later',
      message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PASTED_PNG.data } }] },
    });
    const refs = [{ key: 'id-1:id-3:0', mediaType: 'image/png' }];
    expect(items(events).at(-1)).toEqual({ kind: 'user', id: 'id-3', text: '', images: 1, imageRefs: refs, queued: true });
    query().push(result());
    await settle();
    expect(items(events).filter((item) => item.id === 'id-3').at(-1)).toEqual({ kind: 'user', id: 'id-3', text: '', images: 1, imageRefs: refs });
    await session.close();
  });

  it('maps compaction, retries, rate limits, mode changes, denials and local command output', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('go');
    query().push(
      init(),
      system('status', { status: 'compacting', uuid: 'st-1' }),
      system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 150_000 } }),
      system('api_retry', { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' }),
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'rl-0', session_id: SID },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85 },
        uuid: 'rl-1',
        session_id: SID,
      },
      system('status', { status: null, permissionMode: 'plan' }),
      system('permission_denied', { tool_use_id: 'tu_unknown', tool_name: 'Bash', message: 'Denied by a rule' }),
      system('local_command_output', { content: 'Total cost: $0.00', uuid: 'lc-1' }),
      system('commands_changed', { commands: [{ name: 'review', description: 'Review', argumentHint: '' }] }),
      system('informational', { content: 'Just info', level: 'info' }),
    );
    await settle();

    const systems = items(events).filter((item) => item.kind === 'system');
    expect(systems).toEqual([
      { kind: 'system', id: 'compact:st-1', text: 'Compacting the conversation…', level: 'info' },
      {
        kind: 'system',
        id: 'compact:st-1',
        text: 'Conversation compacted (automatic, 150,000 tokens before)',
        level: 'info',
      },
      {
        kind: 'system',
        id: 'retry:1',
        text: 'API error 529 (overloaded); retrying in 2s (attempt 1 of 10)',
        level: 'warn',
      },
      { kind: 'system', id: 'ratelimit:five_hour', text: 'Approaching the five-hour limit (85% used).', level: 'warn' },
      { kind: 'system', id: expect.any(String), text: 'Bash was not allowed: Denied by a rule', level: 'warn' },
    ]);
    expect(items(events).at(-1)).toEqual({ kind: 'assistant', id: 'lc-1', text: 'Total cost: $0.00' });
    expect(events.filter((e) => e.type === 'init').at(-1)).toMatchObject({ permissionMode: 'plan' });
    expect(events.filter((e) => e.type === 'commands').at(-1)).toEqual({
      type: 'commands',
      handleId: 'h1',
      commands: [{ name: 'review', description: 'Review' }],
    });
    expect(query().getContextUsage).toHaveBeenCalled();
  });

  it('keeps tool-result screenshots in main and gives the tool item image refs under the history key', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('Take a screenshot');
    query().push(
      init(),
      assistant('msg_shot', [{ type: 'tool_use', id: 'tu_shot', name: 'mcp__browser__screenshot', input: {} }]),
      assistant('msg_read', [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: 'D:\\work\\demo\\a.txt' } }]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_shot',
              content: [
                { type: 'text', text: 'Captured' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                { type: 'image', source: { type: 'url', url: 'https://example.invalid/x.png' } },
              ],
            },
            { type: 'tool_result', tool_use_id: 'tu_read', content: 'plain text' },
          ],
        },
        parent_tool_use_id: null,
        session_id: SID,
      },
    );
    await settle();
    const shot = items(events).filter((item) => item.id === 'tu_shot').at(-1);
    expect(shot).toMatchObject({ status: 'done', output: 'Captured', images: 2, imageRefs: [{ key: `${SID}:tu_shot:0`, mediaType: 'image/png' }] });
    expect(imageStore.get(`${SID}:tu_shot:0`)).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(items(events).filter((item) => item.id === 'tu_read').at(-1)).not.toHaveProperty('imageRefs');
    expect(JSON.stringify(events)).not.toContain('iVBORw0KGgo=');
    await session.close();
  });

  it('emits the full background-task list when it changes and keeps the task notification item', async () => {
    const { session, events, query } = setup();
    await session.start();
    events.length = 0;
    query().push(
      system('task_started', { task_id: 'b1', task_type: 'local_bash', description: 'npm run watch', is_backgrounded: true }),
      system('task_progress', { task_id: 'b1', description: 'npm run watch', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 900 } }),
      system('task_progress', { task_id: 'b1', description: 'npm run watch', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 900 } }),
      system('task_started', { task_id: 'amb', task_type: 'monitor_ws', description: 'watcher', ambient: true }),
      system('task_notification', { task_id: 'b1', status: 'failed', summary: ' Watch\n  crashed ', output_file: '', uuid: 'tn-1' }),
    );
    await settle();
    const lists = events.flatMap((event) => (event.type === 'tasks' ? [event] : []));
    expect(lists.map((event) => event.tasks.map((task) => [task.taskId, task.status, task.durationMs]))).toEqual([
      [['b1', 'running', undefined]],
      [['b1', 'running', 900]],
      [['b1', 'failed', 900]],
    ]);
    expect(lists.at(-1)).toEqual({
      type: 'tasks',
      handleId: 'h1',
      tasks: [
        {
          taskId: 'b1',
          kind: 'shell',
          taskType: 'local_bash',
          description: 'npm run watch',
          status: 'failed',
          startedAt: NOW,
          endedAt: NOW,
          durationMs: 900,
          totalTokens: 0,
          toolUses: 0,
          // The tasks card keeps the CLI's text; only the transcript line folds whitespace.
          summary: 'Watch\n  crashed',
        },
      ],
    });
    expect(items(events)).toEqual([
      { kind: 'system', id: 'tn-1', text: 'Background task failed: Watch crashed', level: 'warn', tasks: [{ status: 'failed', summary: 'Watch crashed' }] },
    ]);
    await session.close();
  });

  it('hands every rate-limit event to the usage callback and asks the query for plan usage without the transcript scan', async () => {
    const onRateLimit = vi.fn();
    const { session, events, query } = setup({ onRateLimit });
    await session.start();
    const allowed = { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.07, resetsAt: 1_800_000_000 };
    const warning = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 };
    query().push(
      { type: 'rate_limit_event', rate_limit_info: allowed, uuid: 'rl-a', session_id: SID },
      { type: 'rate_limit_event', rate_limit_info: warning, uuid: 'rl-w', session_id: SID },
    );
    await settle();
    expect(onRateLimit.mock.calls).toEqual([[allowed], [warning]]);
    expect(items(events)).toEqual([{ kind: 'system', id: 'ratelimit:five_hour', text: 'Approaching the five-hour limit (90% used).', level: 'warn' }]);

    const answer = { rate_limits_available: false, rate_limits: null };
    const fake = query() as unknown as Record<string, unknown>;
    const usageCall = vi.fn(async () => answer);
    fake.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = usageCall;
    await expect(session.planUsage()).resolves.toBe(answer);
    expect(usageCall).toHaveBeenCalledWith({ skipBehaviors: true });
    await session.close();
    await expect(session.planUsage()).rejects.toThrow('closed');
  });

  it('turns not-logged-in replies into one readable, non-fatal error', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('hi');
    query().push(
      assistant('msg_auth', [{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed' }, '<synthetic>'),
      result({ is_error: true, result: 'Not logged in · Please run /login', uuid: 'res-auth' }),
    );
    await settle();
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', handleId: 'h1', message: AUTH_ERROR_MESSAGE, fatal: false },
    ]);
    expect(JSON.stringify(items(events))).not.toContain('Please run /login');
    expect(items(events).at(-1)).toMatchObject({ kind: 'result', id: 'res-auth', isError: true, text: AUTH_ERROR_MESSAGE });
    expect(session.currentState).toBe('idle');
  });

  it('shows an interrupted turn and keeps streamed text that never got a final frame', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.send('long task');
    await session.interrupt();
    expect(query().interrupt).toHaveBeenCalledTimes(1);
    query().push(
      stream({ type: 'message_start', message: { id: 'msg_i', usage: { output_tokens: 1 } } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial' } }),
      result({ subtype: 'error_during_execution', is_error: false, errors: [], terminal_reason: 'aborted_streaming' }),
    );
    await settle();
    expect(items(events).slice(-3)).toEqual([
      { kind: 'assistant', id: 'msg_i:0', text: 'Partial', streaming: true },
      { kind: 'assistant', id: 'msg_i:0', text: 'Partial' },
      expect.objectContaining({ kind: 'result', isError: false, text: 'Interrupted' }),
    ]);
  });
});

describe('EngineSession controls', () => {
  it('reports only actual SDK memory-file metadata, including an observed empty list', async () => {
    const { session, query, events } = setup();
    await session.start();
    expect((await session.contextUsage())?.memoryFiles).toEqual([]);
    const file = {
      path: 'C:\\synthetic\\shared\\CLAUDE.md',
      type: 'User',
      tokens: 17,
      content: 'synthetic body must not leave the engine',
      unknownFutureField: 'must not forward',
    };
    const memory = { path: 'C:\\synthetic\\memory\\MEMORY.md', type: 'AutoMem', tokens: 9 };
    query().getContextUsage.mockResolvedValueOnce({ ...CONTEXT_RESPONSE, memoryFiles: [file, memory] });
    const expected = [
      { path: file.path, type: 'User', tokens: 17 },
      memory,
    ];
    const observed = await session.contextUsage();
    expect(observed?.memoryFiles).toEqual(expected);
    expect(events.at(-1)).toEqual({ type: 'context', handleId: 'h1', usage: { ...CONTEXT_USAGE, memoryFiles: expected } });
    expect(JSON.stringify(observed)).not.toContain('must not');
    await session.close();
  });

  it('sets model, effort (applyFlagSettings) and permission mode, lists models and refreshes context', async () => {
    const { session, events, query } = setup();
    await session.start();
    await session.interrupt();
    expect(query().interrupt).not.toHaveBeenCalled();

    await session.setModel('sonnet');
    await session.setModel('default');
    expect(query().setModel.mock.calls).toEqual([['sonnet'], [undefined]]);
    await session.setEffort('xhigh');
    expect(query().applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });
    await expect(session.setEffort('turbo' as Effort)).rejects.toThrow('Unknown effort level');
    await session.setPermissionMode('plan');
    expect(query().setPermissionMode).toHaveBeenCalledWith('plan');
    await expect(session.setPermissionMode('yolo' as PermissionMode)).rejects.toThrow('Unknown permission mode');
    expect(events.filter((e) => e.type === 'init').at(-1)).toMatchObject({ model: 'default', permissionMode: 'plan' });

    await expect(session.models()).resolves.toEqual([
      {
        value: 'default',
        label: 'Default (recommended)',
        description: 'Best model',
        supportsEffort: true,
        effortLevels: ['low', 'medium', 'high'],
        supportsAutoMode: true,
      },
      { value: 'haiku', label: 'Haiku' },
    ]);
    await expect(session.contextUsage()).resolves.toEqual(CONTEXT_USAGE);
    expect(query().getContextUsage).toHaveBeenLastCalledWith({ detail: 'full' });
    expect(events.at(-1)).toEqual({ type: 'context', handleId: 'h1', usage: CONTEXT_USAGE });
    query().getContextUsage.mockRejectedValueOnce(new Error('not ready'));
    await expect(session.contextUsage()).resolves.toBeNull();
  });
});

describe('EngineSession ultracode', () => {
  it('turns ultracode on and off and keeps it on across effort changes', async () => {
    const { session, query } = setup();
    await session.start();
    const flags = query().applyFlagSettings;
    await session.setEffort('high');
    await session.setUltracode(true);
    await session.setEffort('low');
    await session.setUltracode(false);
    await session.setEffort('max');
    expect(flags.mock.calls).toEqual([
      [{ effortLevel: 'high' }],
      [{ ultracode: true }],
      [{ effortLevel: 'low', ultracode: true }],
      [{ ultracode: false }],
      [{ effortLevel: 'max' }],
    ]);
    await expect(session.setUltracode('on' as unknown as boolean)).rejects.toThrow('Invalid ultracode setting');
    expect(flags).toHaveBeenCalledTimes(5);
    await session.close();
    await expect(session.setUltracode(true)).rejects.toThrow('closed');
  });

  it('stays off when the CLI refuses to turn ultracode on', async () => {
    const { session, query } = setup();
    await session.start();
    const flags = query().applyFlagSettings;
    flags.mockRejectedValueOnce(new Error('ultracode is not available for this model'));
    await expect(session.setUltracode(true)).rejects.toThrow('not available');
    await session.setEffort('medium');
    expect(flags.mock.calls.at(-1)).toEqual([{ effortLevel: 'medium' }]);
    await session.close();
  });

  it('passes ultracode requested at open in the inline settings, merged with the approved Code settings', async () => {
    const approved = { permissions: { allow: ['Read(C:\\synthetic\\shared/**)'] }, autoMemoryDirectory: 'C:\\synthetic\\memory', autoMemoryEnabled: true };
    const shared = setup({ request: { ultracode: true }, codeContextSettings: approved });
    await shared.session.start();
    expect(shared.query().params.options.settings).toEqual({ ...approved, ultracode: true });
    await shared.session.setEffort('xhigh');
    expect(shared.query().applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh', ultracode: true });
    await shared.session.close();

    const alone = setup({ request: { ultracode: true } });
    await alone.session.start();
    expect(alone.query().params.options.settings).toEqual({ ultracode: true });
    await alone.session.close();

    const off = setup({ request: { ultracode: false }, codeContextSettings: approved });
    await off.session.start();
    expect(off.query().params.options.settings).toEqual(approved);
    await off.session.close();
  });
});

describe('EngineSession MCP', () => {
  const blender = { type: 'stdio' as const, command: 'uvx', args: ['blender-mcp'], env: { SYNTHETIC_KEY: 'synthetic-secret' } };
  const status = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: 'connected', ...extra });

  it('passes Relay servers as the SDK mcpServers option only when there are any', async () => {
    const none = setup({ mcpServers: {} });
    await none.session.start();
    expect(none.query().params.options).not.toHaveProperty('mcpServers');
    await none.session.close();

    const some = setup({ mcpServers: { blender } });
    await some.session.start();
    expect(some.query().params.options.mcpServers).toEqual({ blender });
    await some.session.close();
  });

  it('emits the live status after start and on init, marks Relay servers and reports a name Claude Code already configures once', async () => {
    const first = [
      status('blender', { scope: 'dynamic', tools: [{ name: 'a' }, { name: 'b' }] }),
      status('github', { status: 'failed', scope: 'user', source: 'user', error: 'auth failed: Bearer synthetic-token-value' }),
    ];
    const second = [first[0], status('blockbench', { status: 'pending', scope: 'project', source: 'project' })];
    const { session, events, query } = setup({ mcpServers: { blender, blockbench: blender }, mcpStatus: [first, first, second] });
    await session.start();
    await settle();
    const lists = () => events.flatMap((event) => (event.type === 'mcp' ? [event.servers] : []));
    expect(lists()).toEqual([
      [
        { name: 'blender', status: 'connected', toolCount: 2, scope: 'dynamic', relay: true },
        { name: 'github', status: 'failed', toolCount: 0, scope: 'user', source: 'user', error: 'auth failed: Bearer [redacted]', relay: false },
      ],
    ]);
    query().push(init());
    await settle();
    expect(lists()).toHaveLength(1);
    query().push(init());
    await settle();
    expect(lists().at(-1)).toEqual([
      { name: 'blender', status: 'connected', toolCount: 2, scope: 'dynamic', relay: true },
      { name: 'blockbench', status: 'pending', toolCount: 0, scope: 'project', source: 'project', relay: true },
    ]);
    query().push(init());
    await settle();
    const notes = items(events).filter((item) => item.kind === 'system');
    expect(notes).toEqual([
      {
        kind: 'system',
        id: 'mcp-collision:blockbench',
        text: `The MCP server "blockbench" from Relay Desk's list has the same name as one Claude Code already configures (project); only one of them runs in this session.`,
        level: 'info',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret');
    await session.close();
  });

  it('re-applies the remembered MCP choices right after start, even for servers not connected yet', async () => {
    const list = [status('blender', { scope: 'dynamic' })];
    const { session, query } = setup({ request: { mcpOverrides: { blender: false, ghost: true, later: false } }, mcpServers: { blender }, mcpStatus: [list] });
    const started = session.start();
    const fake = query() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    fake.toggleMcpServer!.mockImplementation(async (name: string) => {
      if (name === 'ghost') throw new Error('MCP server ghost refused');
    });
    await started;
    expect(fake.toggleMcpServer!.mock.calls).toEqual([['blender', false], ['ghost', true], ['later', false]]);
    expect(session.currentState).not.toBe('closed');
    await session.close();
    const plain = setup({ mcpServers: { blender }, mcpStatus: [list] });
    await plain.session.start();
    expect((plain.query() as unknown as Record<string, ReturnType<typeof vi.fn>>).toggleMcpServer).not.toHaveBeenCalled();
    await plain.session.close();
  });

  it('toggles and reconnects only servers in the current status list and returns the fresh list', async () => {
    const before = [status('blender', { scope: 'dynamic' })];
    const after = [status('blender', { status: 'disabled', scope: 'dynamic' })];
    const { session, query } = setup({ mcpServers: { blender }, mcpStatus: [before, before, after] });
    await session.start();
    await settle();
    const fake = query() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await expect(session.mcpToggle('blender', false)).resolves.toEqual([{ name: 'blender', status: 'disabled', toolCount: 0, scope: 'dynamic', relay: true }]);
    expect(fake.toggleMcpServer).toHaveBeenCalledWith('blender', false);
    await expect(session.mcpToggle('ghost', true)).rejects.toThrow('No MCP server named "ghost"');
    await expect(session.mcpReconnect('ghost')).rejects.toThrow('No MCP server named "ghost"');
    expect(fake.toggleMcpServer).toHaveBeenCalledTimes(1);
    expect(fake.reconnectMcpServer).not.toHaveBeenCalled();
    const failure = (await session.mcpReconnect('blender').catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe('reconnect failed: Bearer [redacted]');
    await session.close();
    await expect(session.mcpStatus()).rejects.toThrow('closed');
  });
});

describe('EngineSession close', () => {
  it('discards input still buffered locally instead of delivering it after close', async () => {
    const { session, query } = setup({ readInput: false });
    await session.start();
    await session.send('buffered first');
    await session.send('buffered later', { queue: true });
    await session.close();
    const input = query().params.prompt[Symbol.asyncIterator]();
    await expect(input.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('redacts stderr records split across chunks and the final unterminated record', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'relay-engine-split-log-'));
    tempDirs.push(logDir);
    const child = new FakeChild();
    const { session } = setup({ spawnOnStart: child, logDir });
    await session.start();
    child.stderr.write('warning sk-ant-');
    child.stderr.write('api03-SPLITSECRET\naccess_token="split-');
    child.stderr.write('token-secret"\nAuthorization: Bearer tail-');
    child.stderr.write('secret');
    child.exit(0);
    await session.close();
    const [file] = readdirSync(logDir);
    const log = readFileSync(join(logDir, file ?? ''), 'utf8');
    expect(log).not.toMatch(/SPLITSECRET|split-token-secret|tail-secret|token-secret/);
    expect(log).toContain('warning sk-ant-[redacted]');
    expect(log).toContain('access_token="[redacted]"');
    expect(log).toContain('Authorization: Bearer [redacted]');
  });

  it('resolves only after the CLI process exited, cancelling pending requests and logging redacted stderr', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'relay-engine-log-'));
    tempDirs.push(logDir);
    const child = new FakeChild();
    const { session, events, query, broker, onClosed, spawn } = setup({ spawnOnStart: child, logDir });
    await session.start();
    expect(spawn).toHaveBeenCalledWith('C:\\fake\\claude.exe', ['--input-format', 'stream-json'], {
      cwd: CWD,
      env: { PATH: 'C:\\Windows' },
      signal: expect.any(AbortSignal),
    });
    child.stderr.write('warning: retrying with key sk-ant-api03-SECRETSECRET\n');
    await settle();

    const pending = broker.canUseTool('Bash', {}, permissionContext('tu_1'));
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    await settle();
    expect(query().close).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    expect(events.some((e) => e.type === 'state' && e.state === 'closed')).toBe(false);

    child.exit(0);
    await closing;
    expect(closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'state', handleId: 'h1', state: 'closed' });
    expect(events.some((e) => e.type === 'requestClosed')).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
    await expect(session.send('more')).rejects.toThrow('closed');
    await session.close();
    expect(onClosed).toHaveBeenCalledTimes(1);

    const [logFile] = readdirSync(logDir);
    const log = readFileSync(join(logDir, logFile ?? ''), 'utf8');
    expect(log).toContain('[h1] warning: retrying with key sk-ant-[redacted]');
    expect(log).not.toContain('SECRETSECRET');
  });

  it('kills a CLI that does not exit within the close timeout', async () => {
    const child = new FakeChild();
    const { session } = setup({ spawnOnStart: child, closeTimeoutMs: 20 });
    await session.start();
    await session.close();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects an unconfirmed child exit without freeing the writer, and permits a close retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = new FakeChild();
      child.kill.mockImplementation(() => false);
      const { session, events, onClosed } = setup({ spawnOnStart: child, closeTimeoutMs: 5 });
      await session.start();
      const rejected = expect(session.close()).rejects.toThrow('Claude Code did not exit');
      await vi.advanceTimersByTimeAsync(1_505);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(onClosed).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'state' && event.state === 'closed')).toBe(false);
      await expect(session.send('second writer')).rejects.toThrow('closed');

      child.exit(0);
      await settle();
      await session.close();
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(session.currentState).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a crashed CLI as a fatal error and closes the handle', async () => {
    const { session, events, query, onClosed } = setup();
    await session.start();
    query().fail(new Error('Claude Code process exited with code 3'));
    await settle();
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', handleId: 'h1', message: 'Claude Code process exited with code 3', fatal: true },
    ]);
    expect(events.at(-1)).toEqual({ type: 'state', handleId: 'h1', state: 'closed' });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('session text helpers', () => {
  it('redactSecrets masks API keys, bearer tokens and token fields (R2)', () => {
    const text = [
      'key sk-ant-oat01-AbC_dEf-123',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      '{"accessToken":"secret-access","refresh_token": "secret-refresh"}',
      'plain line stays',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).not.toMatch(/AbC_dEf|eyJhbGci|secret-access|secret-refresh/);
    expect(out).toContain('sk-ant-[redacted]');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('plain line stays');
  });

  it('recognises the CLI not-logged-in wording only', () => {
    for (const text of ['Not logged in · Please run /login', 'Invalid API key · Fix external API key', 'OAuth token has expired']) {
      expect(isAuthFailure(text)).toBe(true);
    }
    expect(isAuthFailure('Rate limited, retry later')).toBe(false);
  });
});

describe('EngineSession fast mode and per-task controls', () => {
  const inits = (events: EngineEvent[]) => events.flatMap((event) => (event.type === 'init' ? [event] : []));

  it('opts in with the fastMode flag setting at open and on toggles, and keeps it across effort changes', async () => {
    const on = setup({ request: { fastMode: true, ultracode: true } });
    await on.session.start();
    expect(on.query().params.options.settings).toEqual({ ultracode: true, fastMode: true });
    await on.session.close();

    const { session, query } = setup();
    await session.start();
    expect(query().params.options.settings).toBeUndefined();
    const flags = query().applyFlagSettings;
    await session.setFastMode(true);
    await session.setEffort('low');
    await session.setFastMode(false);
    expect(flags.mock.calls).toEqual([[{ fastMode: true }], [{ effortLevel: 'low' }], [{ fastMode: false }]]);
    await expect(session.setFastMode('on' as unknown as boolean)).rejects.toThrow('Invalid fast mode setting');
    flags.mockRejectedValueOnce(new Error('refused'));
    await expect(session.setFastMode(true)).rejects.toThrow('refused');
    await session.close();
    await expect(session.setFastMode(true)).rejects.toThrow('closed');
  });

  it('passes dynamic workflows as the enableWorkflows flag setting at open and on changes', async () => {
    const on = setup({ request: { workflows: 'on' } });
    await on.session.start();
    expect(on.query().params.options.settings).toEqual({ enableWorkflows: true });
    await on.session.close();
    const off = setup({ request: { workflows: 'off', fastMode: true } });
    await off.session.start();
    expect(off.query().params.options.settings).toEqual({ fastMode: true, enableWorkflows: false });
    await off.session.close();

    const { session, query } = setup();
    await session.start();
    expect(query().params.options.settings).toBeUndefined();
    const flags = query().applyFlagSettings;
    await session.setWorkflows('on');
    await session.setEffort('low');
    await session.setWorkflows('off');
    // null clears the key, so the plan default applies again.
    await session.setWorkflows(null);
    expect(flags.mock.calls).toEqual([
      [{ enableWorkflows: true }],
      [{ effortLevel: 'low' }],
      [{ enableWorkflows: false }],
      [{ enableWorkflows: null }],
    ]);
    await expect(session.setWorkflows('yes' as unknown as 'on')).rejects.toThrow('Invalid workflows setting');
    expect(flags).toHaveBeenCalledTimes(4);
    flags.mockRejectedValueOnce(new Error('refused'));
    await expect(session.setWorkflows('on')).rejects.toThrow('refused');
    await session.close();
    await expect(session.setWorkflows('on')).rejects.toThrow('closed');
  });

  it('reports the fast mode state of the initialize answer, system/init and results in the init event', async () => {
    const { session, events, query } = setup({ initResult: { fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required' } });
    await session.start();
    expect(inits(events).at(-1)?.fast).toEqual({ state: 'off', reason: 'sdk_opt_in_required' });
    query().push(init({ fast_mode_state: 'on' }));
    await settle();
    expect(inits(events).at(-1)?.fast).toEqual({ state: 'on' });
    const count = inits(events).length;
    query().push(result({ fast_mode_state: 'on' }));
    await settle();
    expect(inits(events)).toHaveLength(count);
    query().push(result({ fast_mode_state: 'cooldown' }));
    await settle();
    expect(inits(events).at(-1)?.fast).toEqual({ state: 'cooldown' });
    query().push(result({ fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' }));
    await settle();
    expect(inits(events).at(-1)?.fast).toEqual({ state: 'off', reason: 'extra_usage_disabled' });
    query().push(result({ fast_mode_state: 'turbo' }));
    await settle();
    expect(inits(events).at(-1)?.fast).toEqual({ state: 'off', reason: 'extra_usage_disabled' });
    await session.close();
  });

  it('declares per-task stop buttons, stops one task and reads the output file the CLI reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-task-output-'));
    try {
      const file = join(dir, 'b1.output');
      writeFileSync(file, '\u001b[32mok\u001b[0m token=sk-ant-synthetic-secret-value-123456\n');
      const { session, query } = setup();
      await session.start();
      expect(query().params.options.perTaskStopAffordance).toBe(true);
      const stop = vi.fn(async () => undefined);
      (query() as unknown as { stopTask: typeof stop }).stopTask = stop;
      await session.stopTask('b1');
      expect(stop).toHaveBeenCalledWith('b1');
      await expect(session.stopTask('')).rejects.toThrow('Invalid task id');
      expect(await session.taskOutput('b1')).toBeNull();
      query().push(system('task_started', { task_id: 'b1', task_type: 'local_bash', description: 'npm test' }));
      query().push(system('task_notification', { task_id: 'b1', status: 'completed', summary: 'ok', output_file: file }));
      await settle();
      const output = await session.taskOutput('b1');
      expect(output).toContain('ok');
      expect(output).not.toContain('\u001b[');
      expect(output).not.toContain('sk-ant-synthetic-secret-value-123456');
      expect(await session.taskOutput('other')).toBeNull();
      await session.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EngineSession automatic continue at usage limit', () => {
  const HOUR = 60 * 60_000;
  const LIMIT_TEXT = "You've hit your session limit · resets 9:10pm (America/Los_Angeles)";
  const FIRED = 'Usage limit reset · Claude is continuing your task';
  const limitMessage = (extra: Record<string, unknown> = {}) =>
    assistant(`msg_limit_${++seq}`, [{ type: 'text', text: LIMIT_TEXT }], { error: 'rate_limit', ...extra }, '<synthetic>');
  const limitResult = (extra: Record<string, unknown> = {}) => result({ is_error: true, result: LIMIT_TEXT, ...extra });
  const rejectedEvent = (resetsAtMs: number, rateLimitType = 'five_hour') => ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType, resetsAt: resetsAtMs / 1000 },
    uuid: `rl-${++seq}`,
    session_id: SID,
  });
  const autoStates = (events: EngineEvent[]) => events.flatMap((event) => (event.type === 'autoContinue' ? [event.state] : []));
  const resumes = (query: FakeQuery) => query.sent.filter((message) => message.origin?.kind === 'auto-continuation');

  function timed(options: SetupOptions = {}) {
    const clock = { now: NOW };
    const intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const autoContinueTimers = {
      setInterval: (callback: () => void, ms: number) => {
        const interval = { callback, ms, cleared: false };
        intervals.push(interval);
        return interval;
      },
      clearInterval: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
    const parts = setup({ ...options, clock, autoContinueTimers });
    const check = (): void => {
      for (const interval of intervals.filter((entry) => !entry.cleared)) interval.callback();
    };
    /** Moves the clock to `time`, running the check every 15 s as on an awake computer. */
    const at = async (time: number): Promise<void> => {
      while (clock.now + 15_000 < time) {
        clock.now += 15_000;
        check();
      }
      clock.now = time;
      check();
      await settle();
    };
    /** A turn of the CLI's own (a background task's), stopped by the usage limit. */
    const limitTurn = async (reset?: number): Promise<void> => {
      parts.query().push(
        ...(reset !== undefined ? [rejectedEvent(reset)] : []),
        stream({ type: 'message_start', message: { id: `msg_bg_${++seq}`, usage: { output_tokens: 1 } } }),
        limitMessage(),
        limitResult(),
      );
      await settle();
    };
    return { ...parts, clock, intervals, at, limitTurn };
  }

  it('waits after a usage-limit stop and sends the hidden resume prompt at the reset, starting a turn when idle', async () => {
    const { session, events, query, intervals, at } = timed();
    await session.start();
    await session.send('Build the parser');
    const reset = NOW + HOUR;
    query().push(rejectedEvent(reset), limitMessage(), limitResult());
    await settle();
    expect(session.currentState).toBe('idle');
    expect(autoStates(events)).toEqual([{ phase: 'waiting', resetsAt: reset, fireAt: reset + 30_000, attempt: 1 }]);
    const idleAt = events.findLastIndex((event) => event.type === 'state' && event.state === 'idle');
    expect(events.findIndex((event) => event.type === 'autoContinue')).toBeGreaterThan(idleAt);
    expect(items(events).filter((item) => item.kind === 'system').map((item) => item.level)).toEqual(['error', 'error']);
    expect(intervals.map((interval) => interval.ms)).toEqual([15_000]);

    await at(reset + 29_000);
    expect(resumes(query())).toEqual([]);
    events.length = 0;
    await at(reset + 30_000);
    const [prompt] = resumes(query());
    expect(prompt).toEqual({
      type: 'user',
      message: { role: 'user', content: AUTO_CONTINUE_PROMPT },
      parent_tool_use_id: null,
      uuid: expect.any(String),
      origin: { kind: 'auto-continuation' },
    });
    expect(events).toEqual([
      { type: 'autoContinue', handleId: 'h1', state: { phase: 'idle' } },
      { type: 'item', handleId: 'h1', item: { kind: 'system', id: prompt?.uuid, text: FIRED, level: 'info' } },
      { type: 'state', handleId: 'h1', state: 'running', startedAt: reset + 30_000, tokens: 0 },
    ]);
    expect(intervals[0]?.cleared).toBe(true);
    await at(reset + HOUR);
    expect(resumes(query())).toHaveLength(1);
    await session.close();
  });

  it('queues the resume prompt with priority later behind a turn that is running', async () => {
    const { session, events, query, at } = timed();
    await session.start();
    await session.send('Build the parser');
    query().push(rejectedEvent(NOW + HOUR), limitMessage(), limitResult());
    await settle();
    query().push(stream({ type: 'message_start', message: { id: 'msg_bg', usage: { output_tokens: 1 } } }));
    await settle();
    expect(session.currentState).toBe('running');
    events.length = 0;
    await at(NOW + HOUR + 30_000);
    expect(resumes(query())).toEqual([expect.objectContaining({ priority: 'later', origin: { kind: 'auto-continuation' } })]);
    expect(events.filter((event) => event.type === 'state')).toEqual([]);
    expect(items(events).filter((item) => item.kind === 'user')).toEqual([]);
    await session.close();
  });

  it('counts the continues of one run: a limit again after a continue waits for the second, a message sent by hand starts over', async () => {
    const { session, events, query, clock, at, limitTurn } = timed();
    await session.start();
    await session.send('Build the parser');
    query().push(rejectedEvent(NOW + HOUR), limitMessage(), limitResult());
    await settle();
    await at(NOW + HOUR + 30_000);
    query().push(limitMessage(), limitResult());
    await settle();
    expect(autoStates(events).at(-1)).toEqual({ phase: 'waiting', resetsAt: NOW + HOUR, fireAt: clock.now + 60_000, attempt: 2 });

    events.length = 0;
    await session.send('Use the old parser instead');
    expect(autoStates(events)).toEqual([{ phase: 'idle' }]);
    expect(items(events).filter((item) => item.kind === 'system')).toEqual([]);
    await at(clock.now + HOUR);
    expect(resumes(query())).toHaveLength(1);

    await limitTurn(clock.now + HOUR);
    expect(autoStates(events).at(-1)).toMatchObject({ phase: 'waiting', attempt: 1 });
    await session.close();
  });

  it('starts a new run after a turn that ends without the limit, and decides nothing for a stopped turn', async () => {
    const { session, events, query, clock, at, limitTurn } = timed();
    await session.start();
    await session.send('Build the parser');
    query().push(rejectedEvent(NOW + HOUR), limitMessage(), limitResult());
    await settle();
    await at(NOW + HOUR + 30_000);
    query().push(result());
    await settle();
    await limitTurn(clock.now + HOUR);
    expect(autoStates(events).at(-1)).toMatchObject({ phase: 'waiting', attempt: 1 });

    const stopped = timed();
    await stopped.session.start();
    await stopped.session.send('Build the parser');
    stopped.query().push(
      rejectedEvent(NOW + HOUR),
      limitMessage(),
      result({ subtype: 'error_during_execution', is_error: false, errors: [], terminal_reason: 'aborted_streaming' }),
    );
    await settle();
    expect(autoStates(stopped.events)).toEqual([]);
    await stopped.session.close();
    await session.close();
  });

  it('marks a limit stop from the synthetic message or an error result, never from a subagent or a turn that hands over to a queued one', async () => {
    const fromMessage = timed();
    await fromMessage.session.start();
    await fromMessage.session.send('Build the parser');
    fromMessage.query().push(rejectedEvent(NOW + HOUR), limitMessage(), result());
    await settle();
    expect(autoStates(fromMessage.events)).toHaveLength(1);
    await fromMessage.session.close();

    const otherError = timed();
    await otherError.session.start();
    await otherError.session.send('Build the parser');
    otherError.query().push(
      rejectedEvent(NOW + HOUR),
      assistant('msg_api', [{ type: 'text', text: LIMIT_TEXT }], { error: 'server_error' }, '<synthetic>'),
      result(),
    );
    await settle();
    expect(autoStates(otherError.events)).toEqual([]);
    await otherError.session.close();

    const fromResult = timed();
    await fromResult.session.start();
    await fromResult.session.send('Build the parser');
    fromResult.query().push(rejectedEvent(NOW + HOUR), limitResult());
    await settle();
    expect(autoStates(fromResult.events)).toHaveLength(1);
    await fromResult.session.close();

    const { session, events, query } = timed();
    await session.start();
    await session.send('Build the parser');
    query().push(rejectedEvent(NOW + HOUR), limitMessage({ parent_tool_use_id: 'tu_agent' }), result());
    await settle();
    query().push(stream({ type: 'message_start', message: { id: 'msg_x', usage: { output_tokens: 1 } } }), limitMessage(), limitResult({ queued_turn_count: 1 }));
    await settle();
    expect(session.currentState).toBe('running');
    query().push(result());
    await settle();
    expect(autoStates(events)).toEqual([]);
    await session.close();
  });

  it('honours the setting: off at open does nothing, on later waits again, off during a wait ends it with a notice', async () => {
    const starting = timed();
    await starting.session.setAutoContinue(false);
    await starting.session.start();
    await starting.limitTurn(NOW + HOUR);
    expect(autoStates(starting.events)).toEqual([]);
    await starting.session.close();

    const { session, events, query, clock, limitTurn } = timed({ request: { autoContinue: false } });
    await session.start();
    await session.send('Build the parser');
    query().push(rejectedEvent(NOW + HOUR), limitMessage(), limitResult());
    await settle();
    expect(autoStates(events)).toEqual([]);
    expect(JSON.stringify(items(events))).not.toContain('autocontinue:');

    await expect(session.setAutoContinue('on' as unknown as boolean)).rejects.toThrow('Invalid auto-continue setting.');
    await session.setAutoContinue(true);
    await limitTurn(clock.now + HOUR);
    expect(autoStates(events)).toHaveLength(1);
    await session.setAutoContinue(false);
    expect(autoStates(events).at(-1)).toEqual({ phase: 'idle' });
    expect(items(events).at(-1)).toEqual({
      kind: 'system',
      id: expect.stringMatching(/^autocontinue:off:/),
      text: 'Automatic continue cancelled · turned off in Settings',
      level: 'info',
    });
    await session.close();
  });

  it('never continues a side chat on its own, and Stop ends a wait as Esc does in the CLI', async () => {
    const side = timed({ request: { resumeSessionId: SID, forkSession: true, ephemeral: true } });
    await side.session.start();
    await side.limitTurn(NOW + HOUR);
    await side.session.setAutoContinue(true);
    await side.limitTurn(NOW + HOUR);
    expect(autoStates(side.events)).toEqual([]);
    await side.session.close();

    const { session, events, query, limitTurn } = timed();
    await session.start();
    await limitTurn(NOW + HOUR);
    expect(autoStates(events)).toHaveLength(1);
    // A turn the CLI starts on its own during the wait; Stop ends the turn and the wait.
    query().push(stream({ type: 'message_start', message: { id: 'msg_bg_stop', usage: { output_tokens: 1 } } }));
    await settle();
    expect(session.currentState).toBe('running');
    await session.interrupt();
    expect(query().interrupt).toHaveBeenCalledTimes(1);
    expect(autoStates(events).at(-1)).toEqual({ phase: 'idle' });
    expect(items(events).at(-1)).toMatchObject({ kind: 'system', text: 'Automatic continue cancelled', level: 'info' });
    await session.close();
  });

  it('cancels a wait, refuses to continue when nothing waits, and continues at once on request', async () => {
    const { session, events, query, clock, limitTurn } = timed();
    await session.start();
    await expect(session.continueAfterLimit()).rejects.toThrow('Nothing is waiting to continue.');
    await session.cancelAutoContinue();
    expect(autoStates(events)).toEqual([]);
    await limitTurn(NOW + HOUR);
    await session.cancelAutoContinue();
    expect(autoStates(events).at(-1)).toEqual({ phase: 'idle' });
    expect(items(events).at(-1)).toMatchObject({ kind: 'system', text: 'Automatic continue cancelled', level: 'info' });

    await limitTurn(clock.now + HOUR);
    await session.continueAfterLimit();
    expect(resumes(query())).toHaveLength(1);
    expect(autoStates(events).at(-1)).toEqual({ phase: 'idle' });
    await session.close();
  });

  it('tells why it will not continue: weekly limit, reset beyond 24 hours, unknown reset', async () => {
    const { session, events, query, clock, limitTurn } = timed();
    await session.start();
    const weeklyReset = NOW + 50 * HOUR;
    query().push(rejectedEvent(weeklyReset, 'seven_day'));
    await limitTurn();
    expect(items(events).at(-1)).toEqual({
      kind: 'system',
      id: expect.stringMatching(/^autocontinue:weekly:/),
      text: `Weekly usage limit reached · resets ${new Date(weeklyReset).toLocaleString()}, so this task will not resume on its own`,
      level: 'warn',
    });
    await limitTurn(clock.now + 25 * HOUR);
    expect(items(events).at(-1)).toMatchObject({
      text: 'Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own',
      level: 'warn',
    });
    expect(autoStates(events)).toEqual([]);
    await session.close();

    const unknown = timed();
    await unknown.session.start();
    (unknown.query() as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = vi.fn(async () => {
      throw new Error('not available');
    });
    await unknown.limitTurn();
    expect(items(unknown.events).at(-1)).toMatchObject({
      text: "Automatic continue stopped · the usage limit's reset time is unknown, so this task will not resume on its own",
      level: 'warn',
    });
    await unknown.session.close();
  });

  it('asks the plan usage of the session for the reset when no rate-limit event told it', async () => {
    const { session, events, query, limitTurn } = timed();
    await session.start();
    const reset = new Date(NOW + 2 * HOUR).toISOString();
    const usage = vi.fn(async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: reset } } }));
    (query() as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = usage;
    await limitTurn();
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(autoStates(events)).toEqual([{ phase: 'waiting', resetsAt: Date.parse(reset), fireAt: Date.parse(reset) + 30_000, attempt: 1 }]);
    await session.close();
  });

  it('stops checking on close and never sends afterwards', async () => {
    const { session, events, query, intervals, at, limitTurn } = timed();
    await session.start();
    await limitTurn(NOW + HOUR);
    const interval = intervals[0]!;
    await session.close();
    expect(interval.cleared).toBe(true);
    const after = events.length;
    interval.callback();
    await at(NOW + 2 * HOUR);
    expect(events).toHaveLength(after);
    expect(resumes(query())).toEqual([]);
    for (const call of [() => session.continueAfterLimit(), () => session.cancelAutoContinue(), () => session.setAutoContinue(true)]) {
      await expect(call()).rejects.toThrow('closed');
    }
  });
});
