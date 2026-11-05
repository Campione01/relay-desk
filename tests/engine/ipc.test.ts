import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import { IPC, isEventMethod } from '@shared/ipc';
import {
  MAX_HISTORY_CURSOR,
  SHARED_CONTEXT_ERROR_PREFIX,
  type EngineHandle,
  type McpServerState,
  type Profile,
  type SharedCodeContextReport,
} from '@shared/types';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\${name}` },
}));

const { registerEngineIpc } = await import('../../src/main/engine/ipc');
type EngineSessionOptions = import('../../src/main/engine/session').EngineSessionOptions;
type ListingClient = import('../../src/main/engine/listing').ListingClient;
type EngineIpcDeps = import('../../src/main/engine/ipc').EngineIpcDeps;

const CWD = 'D:\\work\\demo';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '66666666-7777-4888-9999-000000000000';
const PROFILES: Record<string, Profile> = {
  default: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
  work: { id: 'work', name: 'Work', configDir: 'C:\\Relay\\work', createdAt: 0 },
  solo: { id: 'solo', name: 'Solo', configDir: 'C:\\Relay\\solo', createdAt: 0, sharedCodeContext: false },
};
const CODE_REPORT: SharedCodeContextReport = {
  profileId: 'work',
  mode: 'shared',
  configDirectory: 'C:\\synthetic\\work',
  globalRoot: 'C:\\synthetic\\shared-code',
  entries: [],
  memory: { shared: true, directory: 'C:\\synthetic\\memory', enabled: true, indexExists: false },
  warnings: [],
};

const PNG_DATA = Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\rIHDR', 'latin1').toString('base64');
const PDF_DATA = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1').toString('base64');

const MCP_STATE: McpServerState ={ name: 'blender', status: 'connected', toolCount: 4, scope: 'dynamic', relay: true };

const USAGE_RESPONSE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'pro',
  rate_limits_available: true,
  // A fresh read always carries model_scoped (empty here); a header snapshot leaves it out (usage.ts isCompleteUsage).
  rate_limits: { five_hour: { utilization: 69, resets_at: '2026-10-17T00:30:00.000Z' }, seven_day: null, model_scoped: [] },
  behaviors: null,
};

class FakeSession {
  readonly handle: EngineHandle;
  private release: (() => void) | undefined;
  private rejectStart: ((reason: Error) => void) | undefined;
  readonly start = vi.fn(
    () =>
      new Promise<EngineHandle>((resolve, reject) => {
        this.rejectStart = reject;
        if (this.failStart) reject(new Error('Claude Code did not start in time.'));
        else if (this.holdStart) this.release = () => resolve(this.handle);
        else resolve(this.handle);
      }),
  );
  readonly send = vi.fn(async () => undefined);
  readonly interrupt = vi.fn(async () => undefined);
  readonly startupInput = vi.fn(async (_input: import('@shared/types').NativeStartupInput) => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setEffort = vi.fn(async () => undefined);
  readonly setUltracode = vi.fn(async (_enabled: boolean) => undefined);
  readonly setFastMode = vi.fn(async (_enabled: boolean) => undefined);
  readonly setWorkflows = vi.fn(async (_value: 'on' | 'off' | null) => undefined);
  readonly setAutoContinue = vi.fn(async (_enabled: boolean) => undefined);
  readonly cancelAutoContinue = vi.fn(async () => undefined);
  readonly continueAfterLimit = vi.fn(async () => undefined);
  readonly setLiveContext = vi.fn(async (_enabled: boolean) => undefined);
  readonly stopTask = vi.fn(async (_taskId: string) => undefined);
  readonly taskOutput = vi.fn(async (_taskId: string): Promise<string | null> => 'out');
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly models = vi.fn(async () => [{ value: 'opus', label: 'Opus' }]);
  readonly contextUsage = vi.fn(async () => null);
  readonly mcpStatus = vi.fn(async (): Promise<McpServerState[]> => [MCP_STATE]);
  readonly mcpToggle = vi.fn(async (_name: string, _enabled: boolean): Promise<McpServerState[]> => [{ ...MCP_STATE, status: 'disabled' }]);
  readonly mcpReconnect = vi.fn(async (_name: string): Promise<McpServerState[]> => [MCP_STATE]);
  readonly planUsage = vi.fn(async () => USAGE_RESPONSE);
  readonly onPendingChange = vi.fn();
  readonly onToolDecision = vi.fn();
  readonly panelInput = vi.fn(async (_input: import('@shared/types').NativePanelInput) => undefined);
  readonly panelClose = vi.fn(async () => undefined);
  readonly republish = vi.fn();
  readonly close = vi.fn(async () => {
    this.options.onClosed?.();
  });

  constructor(
    readonly options: EngineSessionOptions,
    readonly failStart = false,
    readonly holdStart = false,
  ) {
    const { request } = options;
    const sessionId = request.resumeSessionId && !request.forkSession ? request.resumeSessionId : `new-${options.handleId}`;
    this.handle = { handleId: options.handleId, sessionId, profileId: options.profile.id, cwd: request.cwd };
  }

  finishStart(): void {
    this.release?.();
  }

  failPendingStart(): void {
    this.rejectStart?.(new Error('Native hello failed.'));
  }
}

function setup(
  options: {
    failStart?: boolean;
    holdStart?: boolean;
    missingFolder?: boolean;
    throwingEmit?: boolean;
    prepareCodeContext?: EngineIpcDeps['prepareCodeContext'];
    getMcpServers?: EngineIpcDeps['getMcpServers'];
  } = {},
) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const duplicates: string[] = [];
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      if (handlers.has(channel)) duplicates.push(channel);
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;
  const events: EngineEvent[] = [];
  const sessions: FakeSession[] = [];
  let handles = 0;
  const listing = {
    list: vi.fn(async () => []),
    history: vi.fn(async () => ({ items: [{ kind: 'user' as const, id: 'u1', text: 'hi' }], older: 'cursor-1' })),
    rename: vi.fn(async () => undefined),
    tasks: vi.fn(async () => []),
    subagent: vi.fn(async () => [{ kind: 'assistant' as const, id: 's1', text: 'sub' }]),
    fork: vi.fn(async () => '9f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c99'),
    delete: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } satisfies ListingClient;
  const getProfile = vi.fn(async (id: string) => {
    const profile = PROFILES[id];
    if (!profile) throw new Error(`Unknown profile ${id}`);
    return profile;
  });
  const isDirectory = vi.fn(async () => !options.missingFolder);
  const isProfileBusy = vi.fn((_profileId: string) => false);
  const control = registerEngineIpc(ipcMain, {
    emit: (event) => {
      events.push(event);
      if (options.throwingEmit) throw new Error('Object has been destroyed');
    },
    getProfile,
    listingWorkerPath: 'D:\\app\\out\\main\\listingWorker.js',
    createSession: (sessionOptions) => {
      const session = new FakeSession(sessionOptions, options.failStart, options.holdStart);
      sessions.push(session);
      return session;
    },
    listing,
    newHandleId: () => `h${++handles}`,
    isDirectory,
    isProfileBusy,
    ...(options.prepareCodeContext ? { prepareCodeContext: options.prepareCodeContext } : {}),
    ...(options.getMcpServers ? { getMcpServers: options.getMcpServers } : {}),
  });
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve().then(() => handler({ sender: {} }, ...args));
  };
  return { control, handlers, duplicates, invoke, events, sessions, listing, getProfile, isDirectory, isProfileBusy };
}

function context(toolUseID: string): Parameters<CanUseTool>[2] {
  return { signal: new AbortController().signal, toolUseID, requestId: `cli-${toolUseID}` };
}

describe('registerEngineIpc', () => {
  it('re-sends the live state when the renderer asks for a writer that is already open (e.g. after a reload)', async () => {
    const h = setup();
    const first = await h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    expect(h.sessions[0]!.republish).not.toHaveBeenCalled();
    const again = await h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    expect(again).toEqual(first); expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.republish).toHaveBeenCalledOnce();
  });

  it('routes panel input and close to the open session only', async () => {
    const h = setup();
    await h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    await h.invoke(IPC.engine.panelInput, 'h1', { kind: 'key', key: 'down' });
    await h.invoke(IPC.engine.panelClose, 'h1');
    expect(h.sessions[0]!.panelInput).toHaveBeenCalledExactlyOnceWith({ kind: 'key', key: 'down' });
    expect(h.sessions[0]!.panelClose).toHaveBeenCalledOnce();
    await expect(h.invoke(IPC.engine.panelInput, 'missing', { kind: 'key', key: 'down' })).rejects.toThrow('not open');
  });

  it('validates startup correlation and binds prompt keys to the exact pending handle and revision', async () => {
    const h = setup({ holdStart: true });
    for (const startupRequestId of ['bad', 'x'.repeat(1000), 1, {}]) {
      await expect(h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, startupRequestId })).rejects.toThrow('Invalid startup request id');
    }
    const opening = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, startupRequestId: S1 });
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1));
    const session = h.sessions[0]!;
    session.options.emit({ type: 'startup', handleId: 'h1', requestId: S1, revision: 2, text: 'Choose', phase: 'waiting' });
    await expect(h.invoke(IPC.engine.startupInput, 'h1', S1, { revision: 2, key: 'enter' })).resolves.toBeUndefined();
    expect(session.startupInput).toHaveBeenCalledWith({ revision: 2, key: 'enter' });
    for (const input of [{ revision: 0, key: 'enter' }, { revision: 1.5, key: 'enter' }, { revision: 2, key: 'text' }, { revision: '2', key: 'enter' }]) {
      await expect(h.invoke(IPC.engine.startupInput, 'h1', S1, input)).rejects.toThrow('Invalid startup input');
    }
    await expect(h.invoke(IPC.engine.startupInput, 'h1', S2, { revision: 2, key: 'enter' })).rejects.toThrow('no longer active');
    await expect(h.invoke(IPC.engine.startupInput, 'h1', S1, { revision: 1, key: 'enter' })).rejects.toThrow('no longer active');
    await expect(h.invoke(IPC.engine.startupInput, 'missing', S1, { revision: 2, key: 'enter' })).rejects.toThrow('not open');
    session.options.emit({ type: 'startup', handleId: 'h1', requestId: S1, revision: 2, text: '', phase: 'ready' });
    await expect(h.invoke(IPC.engine.startupInput, 'h1', S1, { revision: 2, key: 'enter' })).rejects.toThrow('no longer active');
    session.finishStart();
    await opening;
    await expect(h.invoke(IPC.engine.startupInput, 'h1', S1, { revision: 2, key: 'enter' })).rejects.toThrow('no longer active');
    expect(session.startupInput).toHaveBeenCalledTimes(1);
  });

  it('cancels an exact preflight request before a handle is returned and publishes its retirement', async () => {
    const h = setup();
    let release = (): void => {};
    h.getProfile.mockImplementationOnce(() => new Promise<Profile>((resolve) => { release = () => resolve(PROFILES.default!); }));
    const opening = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, startupRequestId: S1 });
    const rejected = expect(opening).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(h.getProfile).toHaveBeenCalledTimes(1));
    await h.invoke(IPC.engine.cancelStartup, S2);
    expect(h.control.findByProfile('default')).toHaveLength(1);
    await h.invoke(IPC.engine.cancelStartup, S1);
    await h.invoke(IPC.engine.cancelStartup, S1);
    expect(h.control.findByProfile('default')).toEqual([]);
    release();
    await rejected;
    expect(h.sessions).toEqual([]);
    expect(h.events).toEqual([{ type: 'startup', handleId: 'h1', requestId: S1, revision: 0, text: '', phase: 'closed' }]);
  });

  it('rejects late completion after startup cancellation and ignores retired cancellation on a new writer', async () => {
    const h = setup({ holdStart: true });
    const opening = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S1 });
    const rejected = expect(opening).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1));
    await h.invoke(IPC.engine.cancelStartup, S1);
    h.sessions[0]!.finishStart();
    await rejected;
    expect(h.sessions[0]!.close).toHaveBeenCalledTimes(1);
    const retry = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S2 });
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    await h.invoke(IPC.engine.cancelStartup, S1);
    expect(h.sessions[1]!.close).not.toHaveBeenCalled();
    h.sessions[1]!.finishStart();
    await expect(retry).resolves.toMatchObject({ handleId: 'h2' });
  });

  it('does not transfer cancellation ownership to a concurrent or later open of the same writer', async () => {
    const h = setup({ holdStart: true });
    const first = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S1 });
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1));
    const second = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S2 });
    await h.invoke(IPC.engine.cancelStartup, S2);
    expect(h.sessions[0]!.close).not.toHaveBeenCalled();
    h.sessions[0]!.finishStart();
    expect(await first).toEqual(await second);
    await h.invoke(IPC.engine.cancelStartup, S1);
    await h.invoke(IPC.engine.cancelStartup, S2);
    expect(h.sessions[0]!.close).not.toHaveBeenCalled();
    await expect(h.invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, startupRequestId: S1 })).rejects.toThrow('already in use');
  });

  it('lets an explicit retry clean a failed start while concurrent retries reserve only one replacement', async () => {
    const h = setup({ holdStart: true });
    const first = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S1 });
    const failed = expect(first).rejects.toThrow('Exit not confirmed');
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1));
    const old = h.sessions[0]!;
    old.close.mockRejectedValueOnce(new Error('Exit not confirmed'));
    old.failPendingStart();
    await failed;
    expect(h.control.findBySession(S1)?.handleId).toBe('h1');
    let finishClose = (): void => {};
    old.close.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishClose = () => { old.options.onClosed?.(); resolve(); };
    }));
    const retry = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S2 });
    const concurrent = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledTimes(2));
    expect(h.sessions).toHaveLength(1);
    expect(h.control.findBySession(S1)?.handleId).toBe('h1');
    finishClose();
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    h.sessions[1]!.finishStart();
    expect(await retry).toEqual(await concurrent);
    expect(h.control.findBySession(S1)?.handleId).toBe('h2');
    expect(old.close).toHaveBeenCalledTimes(2);
  });

  it('keeps failed cleanup retryable and lets cancellation retire a retry during cleanup without a replacement', async () => {
    const h = setup({ holdStart: true });
    const first = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    const failed = expect(first).rejects.toThrow('Exit not confirmed');
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1));
    const old = h.sessions[0]!;
    old.close.mockRejectedValueOnce(new Error('Exit not confirmed')).mockRejectedValueOnce(new Error('Still running'));
    old.failPendingStart();
    await failed;
    await expect(h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S1 })).rejects.toThrow('Still running');
    expect(old.close).toHaveBeenCalledTimes(2);
    expect(h.control.findBySession(S1)?.handleId).toBe('h1');
    let finishClose = (): void => {};
    old.close.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishClose = () => { old.options.onClosed?.(); resolve(); };
    }));
    const retry = h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, startupRequestId: S2 });
    const cancelled = expect(retry).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledTimes(3));
    await h.invoke(IPC.engine.cancelStartup, S2);
    finishClose();
    await cancelled;
    expect(h.sessions).toHaveLength(1);
    expect(h.control.findBySession(S1)).toBeUndefined();
    expect(h.events.flatMap((event) => event.type === 'startup' && event.phase === 'closed' ? [event.requestId] : [])).toEqual([S1, S2]);
  });

  it('retires a startup request when preflight fails without constructing a session', async () => {
    const h = setup();
    h.getProfile.mockRejectedValueOnce(new Error('Profile unavailable'));
    await expect(h.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, startupRequestId: S1 })).rejects.toThrow('Profile unavailable');
    expect(h.sessions).toEqual([]);
    expect(h.events).toEqual([{ type: 'startup', handleId: 'h1', requestId: S1, revision: 0, text: '', phase: 'closed' }]);
    await expect(h.invoke(IPC.engine.cancelStartup, 'invalid')).rejects.toThrow('Invalid startup request id');
  });

  it('prepares shared Code context only after validation and forwards its approved settings', async () => {
    const settings = { permissions: { allow: ['Read(C:\\synthetic\\shared/**)'] }, autoMemoryEnabled: false };
    const prepare = vi.fn<NonNullable<EngineIpcDeps['prepareCodeContext']>>(async () => ({ settings, report: CODE_REPORT }));
    const { invoke, sessions, getProfile, isDirectory } = setup({ prepareCodeContext: prepare });
    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD });
    expect(prepare).toHaveBeenCalledWith(PROFILES.work, CWD);
    expect(getProfile.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
    expect(isDirectory.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
    expect(sessions[0]?.options.codeContextSettings).toBe(settings);
    expect(sessions[0]?.options).not.toHaveProperty('report');
    prepare.mockResolvedValueOnce({ report: { ...CODE_REPORT, profileId: 'default', mode: 'default' } });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    expect(sessions[1]?.options).not.toHaveProperty('codeContextSettings');

    const invalid = setup({ missingFolder: true, prepareCodeContext: prepare });
    await expect(invalid.invoke(IPC.engine.open, { profileId: 'work', cwd: CWD })).rejects.toThrow('Folder not found');
    await expect(invalid.invoke(IPC.engine.open, { profileId: 'missing', cwd: CWD })).rejects.toThrow('Unknown profile');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(invalid.sessions).toEqual([]);
  });

  it('fails closed without constructing a writer when Code context preparation rejects', async () => {
    const prepare = vi.fn(async () => { throw new Error('Shared Code context conflict'); });
    const { invoke, control, sessions } = setup({ prepareCodeContext: prepare });
    await expect(invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S1 })).rejects.toThrow('Shared Code context conflict');
    expect(sessions).toEqual([]);
    expect(control.findByProfile('work')).toEqual([]);
    expect(control.findBySession(S1, 'work')).toBeUndefined();
  });

  it('keeps Code preparation reserved and honors cancellation before constructing its SDK writer', async () => {
    let release = (): void => {};
    const prepare = vi.fn(() => new Promise<{ report: SharedCodeContextReport }>((resolve) => {
      release = () => resolve({ report: CODE_REPORT });
    }));
    const { invoke, control, sessions } = setup({ prepareCodeContext: prepare });
    const opening = invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S1 });
    const cancelled = expect(opening).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(control.findByProfile('work')).toEqual([expect.objectContaining({ handleId: 'h1', sessionId: S1 })]);
    await control.close('h1');
    release();
    await cancelled;
    expect(sessions).toEqual([]);
    expect(control.findByProfile('work')).toEqual([]);

    let releaseMcp = (): void => {};
    const getMcpServers = vi.fn(() => new Promise<Record<string, never>>((resolve) => {
      releaseMcp = () => resolve({});
    }));
    const late = setup({ getMcpServers });
    const lateOpening = late.invoke(IPC.engine.open, { profileId: 'work', cwd: CWD });
    const lateCancelled = expect(lateOpening).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(getMcpServers).toHaveBeenCalledTimes(1));
    await late.control.close('h1');
    releaseMcp();
    await lateCancelled;
    expect(late.sessions).toEqual([]);
  });

  it('skips shared Code context for accounts that turned it off and for a one-time request, and prefixes its failures', async () => {
    const prepare = vi.fn<NonNullable<EngineIpcDeps['prepareCodeContext']>>(async () => ({ settings: { autoMemoryEnabled: false }, report: CODE_REPORT }));
    const { invoke, sessions } = setup({ prepareCodeContext: prepare });
    await invoke(IPC.engine.open, { profileId: 'solo', cwd: CWD });
    expect(prepare).not.toHaveBeenCalled();
    expect(sessions[0]?.options).not.toHaveProperty('codeContextSettings');

    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, skipSharedContext: true });
    expect(prepare).not.toHaveBeenCalled();
    expect(sessions[1]?.options.request.skipSharedContext).toBe(true);
    expect(sessions[1]?.options).not.toHaveProperty('codeContextSettings');

    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, skipSharedContext: 'yes' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sessions[2]?.options.request).not.toHaveProperty('skipSharedContext');

    prepare.mockRejectedValueOnce(new Error('C:\\synthetic\\work\\CLAUDE.md is not managed by Relay Desk'));
    const failure = await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(`${SHARED_CONTEXT_ERROR_PREFIX}C:\\synthetic\\work\\CLAUDE.md is not managed by Relay Desk`);
    expect(sessions).toHaveLength(3);
  });

  it('accepts only local drive folders for sessions, history and tasks', async () => {
    const { invoke, sessions, listing } = setup();
    for (const cwd of ['\\\\server\\share\\demo', '\\work\\demo', 'D:work', '\\\\?\\D:\\work', `${CWD}\\..\\other`]) {
      await expect(invoke(IPC.engine.open, { profileId: 'default', cwd })).rejects.toThrow('absolute local path');
      await expect(invoke(IPC.sessions.history, 'default', S1, cwd)).rejects.toThrow('absolute local path');
      await expect(invoke(IPC.sessions.tasks, 'default', S1, cwd)).rejects.toThrow('absolute local path');
    }
    await expect(invoke(IPC.sessions.history, 'default', S1, 42)).rejects.toThrow('absolute local path');
    expect(sessions).toEqual([]);
    expect(listing.history).not.toHaveBeenCalled();
    expect(listing.tasks).not.toHaveBeenCalled();

    await invoke(IPC.engine.open, { profileId: 'default', cwd: 'd:/work/demo/' });
    expect(sessions[0]?.options.request.cwd).toBe('d:\\work\\demo');
    await invoke(IPC.sessions.history, 'default', S1, 'd:/work/demo/');
    expect(listing.history).toHaveBeenLastCalledWith(PROFILES.default, S1, 'd:\\work\\demo', undefined);
    await invoke(IPC.sessions.tasks, 'default', S1, '');
    expect(listing.tasks).toHaveBeenLastCalledWith(PROFILES.default, S1, undefined);
    await invoke(IPC.sessions.tasks, 'default', S1, CWD);
    expect(listing.tasks).toHaveBeenLastCalledWith(PROFILES.default, S1, CWD);
  });

  it('passes the enabled Relay MCP servers to each new session and starts without them when the list fails', async () => {
    const servers = { blender: { type: 'stdio' as const, command: 'uvx', args: ['blender-mcp'], env: { SYNTHETIC_KEY: 'synthetic-secret' } } };
    const getMcpServers = vi.fn<NonNullable<EngineIpcDeps['getMcpServers']>>(async () => servers);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { invoke, sessions } = setup({ getMcpServers });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    expect(sessions[0]?.options.mcpServers).toEqual(servers);
    getMcpServers.mockResolvedValueOnce({});
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    expect(sessions[1]?.options).not.toHaveProperty('mcpServers');
    getMcpServers.mockRejectedValueOnce(new Error('mcp.json: SYNTHETIC_KEY=synthetic-secret'));
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    expect(sessions[2]?.options).not.toHaveProperty('mcpServers');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('synthetic-secret');
    errors.mockRestore();
  });

  it('serves MCP status, toggle and reconnect for open sessions with validated server names', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const session = sessions[0]!;
    await expect(invoke(IPC.engine.mcpStatus, 'h1')).resolves.toEqual([MCP_STATE]);
    await expect(invoke(IPC.engine.mcpToggle, 'h1', 'blender', false)).resolves.toEqual([{ ...MCP_STATE, status: 'disabled' }]);
    expect(session.mcpToggle).toHaveBeenCalledWith('blender', false);
    await expect(invoke(IPC.engine.mcpReconnect, 'h1', 'blender')).resolves.toEqual([MCP_STATE]);
    expect(session.mcpReconnect).toHaveBeenCalledWith('blender');
    for (const name of ['', '   ', 'x'.repeat(201), 7, null]) {
      await expect(invoke(IPC.engine.mcpToggle, 'h1', name, true)).rejects.toThrow('Invalid MCP server name');
      await expect(invoke(IPC.engine.mcpReconnect, 'h1', name)).rejects.toThrow('Invalid MCP server name');
    }
    await expect(invoke(IPC.engine.mcpToggle, 'h1', 'blender', 'yes')).rejects.toThrow('Invalid MCP toggle');
    await expect(invoke(IPC.engine.mcpReconnect, 'h1', 'x'.repeat(200))).resolves.toEqual([MCP_STATE]);
    expect(session.mcpToggle).toHaveBeenCalledTimes(1);
    expect(session.mcpReconnect).toHaveBeenCalledTimes(2);
    await expect(invoke(IPC.engine.mcpStatus, 'nope')).rejects.toThrow('not open');
  });

  it('answers usage.get from a started session of the account and forwards its rate-limit events', async () => {
    const { invoke, sessions, events, control } = setup({ holdStart: true });
    const opening = invoke(IPC.engine.open, { profileId: 'work', cwd: CWD });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]?.finishStart();
    await opening;
    const usage = await invoke(IPC.usage.get, 'work');
    expect(sessions[0]?.planUsage).toHaveBeenCalledTimes(1);
    expect(usage).toMatchObject({
      profileId: 'work',
      available: true,
      subscriptionType: 'pro',
      windows: [{ id: 'five_hour', percent: 69, resetsAt: Date.parse('2026-10-17T00:30:00.000Z') }],
    });
    expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', usage }]);
    await invoke(IPC.usage.get, 'work');
    expect(sessions[0]?.planUsage).toHaveBeenCalledTimes(1);
    await invoke(IPC.usage.get, 'work', true);
    expect(sessions[0]?.planUsage).toHaveBeenCalledTimes(2);

    sessions[0]?.options.onRateLimit?.({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1_800_000_000 });
    expect(events.at(-1)).toMatchObject({
      type: 'usage',
      usage: { profileId: 'work', windows: [{ id: 'five_hour', percent: 100, resetsAt: 1_800_000_000_000, status: 'rejected' }] },
    });
    await expect(invoke(IPC.usage.get, '')).rejects.toThrow('Missing profile');
    await control.closeAll();
  });

  it('registers exactly one handler per engine.*, sessions.* and usage.* invoke method', () => {
    const { handlers, duplicates } = setup();
    const expected = (['engine', 'sessions', 'usage'] as const).flatMap((ns) =>
      Object.entries(IPC[ns])
        .filter(([method]) => !isEventMethod(method))
        .map(([, channel]) => channel),
    );
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
    expect(duplicates).toEqual([]);
  });

  it('opens a session with its profile, broker and log folder and returns the handle', async () => {
    const { invoke, sessions, control } = setup();
    const handle = await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, model: 'opus', effort: 'high', extra: 'dropped' });
    expect(handle).toEqual({ handleId: 'h1', sessionId: 'new-h1', profileId: 'work', cwd: CWD });
    const options = sessions[0]?.options;
    expect(options?.request).toEqual({ profileId: 'work', cwd: CWD, model: 'opus', effort: 'high' });
    expect(options?.profile).toBe(PROFILES.work);
    expect(options?.broker.handleId).toBe('h1');
    expect(options?.logDir).toBe('C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\userData\\logs');
    expect(control.findBySession('new-h1')).toEqual(handle);

    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, model: '', effort: null, resumeSessionId: undefined });
    expect(sessions[1]?.options.request).toEqual({ profileId: 'default', cwd: CWD });
  });

  it('keeps one writer per session: reopening returns the existing handle, also while it is starting', async () => {
    const { invoke, sessions, control } = setup({ holdStart: true });
    const first = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const second = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    sessions[0]?.finishStart();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(sessions).toHaveLength(1);
    expect(control.findBySession(S1)).toMatchObject({ handleId: 'h1', sessionId: S1 });

    const fork = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]?.finishStart();
    await expect(fork).resolves.toMatchObject({ handleId: 'h2' });
  });

  it('accepts a side chat only as a fork of a resumed session', async () => {
    const { invoke, sessions } = setup();
    for (const request of [
      { ephemeral: true },
      { ephemeral: true, resumeSessionId: S1 },
      { ephemeral: true, forkSession: true },
      { ephemeral: true, resumeSessionId: S1, forkSession: 'yes' },
    ]) {
      await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, ...request })).rejects.toThrow('A side chat must fork a resumed session.');
    }
    await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: 'yes' })).rejects.toThrow(
      'Invalid side chat request.',
    );
    expect(sessions).toHaveLength(0);

    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: true });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: true });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: false });
    expect(sessions[1]?.options.request).not.toHaveProperty('ephemeral');
  });

  it('passes remembered MCP choices through only as a small map of server names to booleans', async () => {
    const { invoke, sessions } = setup();
    for (const mcpOverrides of [['Blender'], { Blender: 'off' }, { '': false }, { [' '.repeat(3)]: true }, 'Blender', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, true]))]) {
      await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, mcpOverrides })).rejects.toThrow(/Invalid MCP server (choices|name)\./);
    }
    expect(sessions).toHaveLength(0);
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, mcpOverrides: JSON.parse('{"Blender":false,"__proto__":true}') });
    const request = sessions[0]?.options.request;
    expect(Object.getPrototypeOf(request?.mcpOverrides)).toBe(Object.prototype);
    expect(Object.entries(request?.mcpOverrides ?? {})).toEqual([['Blender', false], ['__proto__', true]]);
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, mcpOverrides: {} });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, mcpOverrides: null });
    expect(sessions[1]?.options.request).not.toHaveProperty('mcpOverrides');
    expect(sessions[2]?.options.request).not.toHaveProperty('mcpOverrides');
  });

  it('never treats a side chat as a writer of the original or of its folder, and closes it like any handle', async () => {
    const { invoke, control, sessions } = setup({ holdStart: true });
    const sideRequest = { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: true };
    const startingSide = invoke(IPC.engine.open, sideRequest);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    // The original opens as its own writer while the side chat is still starting.
    const original = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions.forEach((session) => session.finishStart());
    const side = (await startingSide) as EngineHandle;
    const writer = (await original) as EngineHandle;
    expect(side.handleId).toBe('h1');
    expect(writer).toMatchObject({ handleId: 'h2', sessionId: S1 });

    const again = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await expect(again).resolves.toEqual(writer);
    expect(sessions).toHaveLength(2);
    expect(control.findBySession(S1, 'default')).toEqual(writer);
    expect(control.findBySession(side.sessionId!, 'default')).toBeUndefined();
    expect(control.findByCwd(CWD, 'default')).toEqual([writer]);
    expect(control.findByProfile('default')).toEqual([side, writer]);

    await invoke(IPC.engine.close, side.handleId);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(control.findByProfile('default')).toEqual([writer]);
    await expect(invoke(IPC.engine.send, side.handleId, 'hi')).rejects.toThrow('not open');
    expect(sessions[1]?.close).not.toHaveBeenCalled();
  });

  it('resuming the original while only a side chat is open starts a new writer', async () => {
    const { invoke, control, sessions } = setup();
    const side = (await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true, ephemeral: true })) as EngineHandle;
    expect(control.findBySession(S1, 'default')).toBeUndefined();
    const writer = (await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 })) as EngineHandle;
    expect(writer.handleId).not.toBe(side.handleId);
    expect(sessions).toHaveLength(2);
    expect(control.findBySession(S1, 'default')).toEqual(writer);
  });

  it('rejects invalid requests, missing folders and failed starts without keeping a handle', async () => {
    const bad = setup();
    for (const request of [
      null,
      { profileId: 'default', cwd: 'relative\\path' },
      { profileId: 'default', cwd: CWD, resumeSessionId: '--dangerous-flag' },
      { profileId: 'default', cwd: CWD, effort: 'turbo' },
      { profileId: 'default', cwd: CWD, permissionMode: 'yolo' },
      { profileId: 'default', cwd: CWD, model: '-p' },
      { profileId: '', cwd: CWD },
    ]) {
      await expect(bad.invoke(IPC.engine.open, request)).rejects.toThrow();
    }
    await expect(bad.invoke(IPC.engine.open, { profileId: 'ghost', cwd: CWD })).rejects.toThrow('Unknown profile ghost');
    expect(bad.sessions).toHaveLength(0);

    const missing = setup({ missingFolder: true });
    await expect(missing.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD })).rejects.toThrow('Folder not found');

    const failing = setup({ failStart: true });
    await expect(failing.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S2 })).rejects.toThrow(
      'did not start in time',
    );
    expect(failing.control.findBySession(S2)).toBeUndefined();
    expect(failing.sessions[0]?.close).toHaveBeenCalled();
  });

  it('finds all and only open writers for the normalized Windows folder and profile', async () => {
    const { invoke, control } = setup();
    const first = await invoke(IPC.engine.open, { profileId: 'default', cwd: `${CWD}\\.\\` });
    const second = await invoke(IPC.engine.open, { profileId: 'default', cwd: 'd:/WORK/DEMO' });
    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: `${CWD}-other` });

    expect(control.findByCwd(CWD, 'default')).toEqual([first, second]);
    expect(control.findByCwd('d:/work/demo/', 'work')).toEqual([
      expect.objectContaining({ handleId: 'h3', profileId: 'work' }),
    ]);
    expect(control.findByCwd(CWD, 'missing')).toEqual([]);
    await control.close('h1');
    expect(control.findByCwd(CWD, 'default')).toEqual([second]);
  });

  it('finds every writer for an account, including starting handles, until confirmed close', async () => {
    const { invoke, control, sessions } = setup({ holdStart: true });
    const opening = [
      invoke(IPC.engine.open, { profileId: 'default', cwd: CWD }),
      invoke(IPC.engine.open, { profileId: 'default', cwd: `${CWD}-other` }),
      invoke(IPC.engine.open, { profileId: 'work', cwd: CWD }),
    ];
    await vi.waitFor(() => expect(sessions).toHaveLength(3));
    expect(control.findByProfile('default')).toEqual([sessions[0]?.handle, sessions[1]?.handle]);
    expect(control.findByProfile('work')).toEqual([sessions[2]?.handle]);
    expect(control.findByProfile('missing')).toEqual([]);
    sessions.forEach((session) => session.finishStart());
    await Promise.all(opening);
    sessions[0]?.close.mockRejectedValueOnce(new Error('CLI is still running'));
    await expect(control.close('h1')).rejects.toThrow('CLI is still running');
    expect(control.findByProfile('default')).toHaveLength(2);
    await control.close('h1');
    expect(control.findByProfile('default')).toEqual([sessions[1]?.handle]);
  });

  it('reserves preflight opens and cancels them before constructing any SDK session', async () => {
    for (const stage of ['profile', 'directory'] as const) {
      const { invoke, control, sessions, getProfile, isDirectory } = setup();
      let release = (): void => {};
      if (stage === 'profile') {
        getProfile.mockImplementationOnce(() => new Promise<Profile>((resolve) => { release = () => resolve(PROFILES.default!); }));
      } else {
        isDirectory.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
      }
      const first = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
      const second = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
      const firstCancelled = expect(first).rejects.toThrow('closed before it started');
      const secondCancelled = expect(second).rejects.toThrow('closed before it started');
      await vi.waitFor(() => expect(stage === 'profile' ? getProfile : isDirectory).toHaveBeenCalledTimes(1));
      const reserved = { handleId: 'h1', sessionId: S1, profileId: 'default', cwd: CWD };
      expect(control.findByProfile('default')).toEqual([reserved]);
      expect(control.findByCwd('d:/WORK/demo/', 'default')).toEqual([reserved]);
      expect(control.findBySession(S1, 'default')).toEqual(reserved);
      expect(control.findBySession(S1, 'work')).toBeUndefined();
      await control.close('h1');
      expect(control.findByProfile('default')).toEqual([]);
      release();
      await Promise.all([firstCancelled, secondCancelled]);
      expect(sessions).toEqual([]);
      expect(getProfile).toHaveBeenCalledTimes(1);
      if (stage === 'profile') expect(isDirectory).not.toHaveBeenCalled();
    }
  });

  it('cleans failed preflight reservations and cancels all pending opens during shutdown', async () => {
    const failed = setup();
    failed.getProfile.mockRejectedValueOnce(new Error('Profile unavailable'));
    await expect(failed.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD })).rejects.toThrow('Profile unavailable');
    expect(failed.control.findByProfile('default')).toEqual([]);
    failed.isDirectory.mockRejectedValueOnce(new Error('Folder unavailable'));
    await expect(failed.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD })).rejects.toThrow('Folder unavailable');
    expect(failed.control.findByCwd(CWD, 'default')).toEqual([]);
    expect(failed.sessions).toEqual([]);

    const { invoke, control, isDirectory, sessions } = setup();
    const release: Array<() => void> = [];
    isDirectory.mockImplementation(() => new Promise<boolean>((resolve) => release.push(() => resolve(true))));
    const first = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const second = invoke(IPC.engine.open, { profileId: 'work', cwd: CWD });
    const firstCancelled = expect(first).rejects.toThrow('closed before it started');
    const secondCancelled = expect(second).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(isDirectory).toHaveBeenCalledTimes(2));
    await control.closeAll();
    expect(control.findByProfile('default')).toEqual([]);
    expect(control.findByProfile('work')).toEqual([]);
    release.forEach((resolve) => resolve());
    await Promise.all([firstCancelled, secondCancelled]);
    expect(sessions).toEqual([]);
  });

  it('keeps identical resumed session ids isolated by account, including concurrent opens', async () => {
    const { invoke, control, sessions, getProfile } = setup({ holdStart: true });
    let releaseWork = (): void => {};
    getProfile.mockImplementationOnce(async () => PROFILES.default!);
    getProfile.mockImplementationOnce(() => new Promise<Profile>((resolve) => { releaseWork = () => resolve(PROFILES.work!); }));
    const first = invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    const work = invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S1 });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    releaseWork();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const repeatedWork = invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S1 });
    sessions.forEach((session) => session.finishStart());
    const [a, b, c] = await Promise.all([first, work, repeatedWork]);
    expect(a).toMatchObject({ profileId: 'default' });
    expect(b).toMatchObject({ profileId: 'work' });
    expect(c).toEqual(b);
    expect(control.findBySession(S1, 'default')).toEqual(a);
    expect(control.findBySession(S1, 'work')).toEqual(b);
    expect(control.findBySession(S1, 'missing')).toBeUndefined();
  });

  it('canonicalizes resumed UUIDs and matches observed or pending writer ids case-insensitively', async () => {
    const upper = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
    const lower = upper.toLowerCase();
    const live = setup();
    const handle = await live.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: upper });
    expect(live.sessions[0]?.options.request.resumeSessionId).toBe(lower);
    live.sessions[0]!.handle.sessionId = upper;
    await expect(live.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: lower })).resolves.toBe(handle);
    expect(live.sessions).toHaveLength(1);
    expect(live.control.findBySession(lower, 'default')).toEqual(handle);
    expect(live.control.findBySession(upper, 'default')).toEqual(handle);

    const pending = setup();
    let release = (): void => {};
    pending.getProfile.mockImplementationOnce(() => new Promise<Profile>((resolve) => { release = () => resolve(PROFILES.default!); }));
    const opening = pending.invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: upper });
    const cancelled = expect(opening).rejects.toThrow('closed before it started');
    await vi.waitFor(() => expect(pending.getProfile).toHaveBeenCalledTimes(1));
    const reserved = pending.control.findBySession(lower, 'default');
    expect(reserved).toMatchObject({ handleId: 'h1', sessionId: lower });
    expect(pending.control.findBySession(upper, 'default')).toEqual(reserved);
    await pending.control.close('h1');
    release();
    await cancelled;
  });

  it('rejects an open for a busy account before reserving or consulting profile state', async () => {
    const { invoke, control, isProfileBusy, getProfile, isDirectory, sessions } = setup();
    isProfileBusy.mockImplementation((profileId) => profileId === 'work');
    await expect(invoke(IPC.engine.open, { profileId: 'work', cwd: CWD })).rejects.toThrow('account is busy');
    expect(control.findByProfile('work')).toEqual([]);
    expect(getProfile).not.toHaveBeenCalled();
    expect(isDirectory).not.toHaveBeenCalled();
    expect(sessions).toEqual([]);
    await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD })).resolves.toMatchObject({ handleId: 'h1' });
    isProfileBusy.mockReturnValue(false);
    await expect(invoke(IPC.engine.open, { profileId: 'work', cwd: CWD })).resolves.toMatchObject({ handleId: 'h2' });
  });

  it('retains a writer after a failed close until a retry confirms shutdown', async () => {
    const { invoke, control, sessions } = setup();
    const handle = await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    sessions[0]?.close.mockRejectedValueOnce(new Error('CLI is still running'));
    await expect(control.close('h1')).rejects.toThrow('CLI is still running');
    expect(control.findBySession(S1)).toEqual(handle);
    expect(control.findByCwd(CWD, 'default')).toEqual([handle]);
    await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 })).resolves.toEqual(handle);
    expect(sessions).toHaveLength(1);
    await control.close('h1');
    expect(control.findBySession(S1)).toBeUndefined();
  });

  it('delegates session controls and rejects unknown handles', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const session = sessions[0];
    await invoke(IPC.engine.send, 'h1', 'hello', { queue: true });
    await invoke(IPC.engine.send, 'h1', 'again');
    expect(session?.send.mock.calls).toEqual([
      ['hello', { queue: true }],
      ['again', { queue: false }],
    ]);
    await invoke(IPC.engine.interrupt, 'h1');
    await invoke(IPC.engine.setModel, 'h1', 'sonnet');
    await invoke(IPC.engine.setEffort, 'h1', 'max');
    await invoke(IPC.engine.setPermissionMode, 'h1', 'acceptEdits');
    await expect(invoke(IPC.engine.models, 'h1')).resolves.toEqual([{ value: 'opus', label: 'Opus' }]);
    await expect(invoke(IPC.engine.refreshContext, 'h1')).resolves.toBeNull();
    expect(session?.interrupt).toHaveBeenCalledTimes(1);
    expect(session?.setModel).toHaveBeenCalledWith('sonnet');
    expect(session?.setEffort).toHaveBeenCalledWith('max');
    expect(session?.setPermissionMode).toHaveBeenCalledWith('acceptEdits');

    await expect(invoke(IPC.engine.setEffort, 'h1', 'turbo')).rejects.toThrow('Invalid effort');
    await expect(invoke(IPC.engine.send, 'h1', '   ')).rejects.toThrow('Missing message');
    await expect(invoke(IPC.engine.send, 'nope', 'hi')).rejects.toThrow('not open');
    await expect(invoke(IPC.engine.models, 'nope')).rejects.toThrow('not open');
  });

  it('validates pasted files before a send and accepts empty text only together with files', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const session = sessions[0]!;
    const png = { kind: 'image', mediaType: 'image/png', data: PNG_DATA, name: 'shot.png', path: 'C:\\dropped' };
    await invoke(IPC.engine.send, 'h1', '', { attachments: [png] });
    await invoke(IPC.engine.send, 'h1', 'see', { queue: true, attachments: [{ kind: 'pdf', mediaType: 'application/pdf', data: PDF_DATA }] });
    expect(session.send.mock.calls).toEqual([
      ['', { queue: false, attachments: [{ kind: 'image', mediaType: 'image/png', data: PNG_DATA, name: 'shot.png' }] }],
      ['see', { queue: true, attachments: [{ kind: 'pdf', mediaType: 'application/pdf', data: PDF_DATA }] }],
    ]);

    await expect(invoke(IPC.engine.send, 'h1', '', {})).rejects.toThrow('Missing message');
    await expect(invoke(IPC.engine.send, 'h1', ' ', { attachments: [] })).rejects.toThrow('Missing message');
    await expect(invoke(IPC.engine.send, 'h1', 42, { attachments: [png] })).rejects.toThrow('Missing message');
    const wrongType = await invoke(IPC.engine.send, 'h1', 'hi', { attachments: [{ ...png, mediaType: 'image/jpeg' }] }).catch((error: unknown) => error);
    expect((wrongType as Error).message).toBe('Attachment 1 is not a JPEG file.');
    await expect(invoke(IPC.engine.send, 'h1', 'hi', { attachments: Array.from({ length: 11 }, () => png) })).rejects.toThrow('At most 10 files');
    await expect(invoke(IPC.engine.send, 'h1', 'hi', { attachments: 'C:\\a.png' })).rejects.toThrow('Invalid attachments');
    expect(session.send).toHaveBeenCalledTimes(2);
    await expect(invoke(IPC.engine.send, 'nope', '', { attachments: [png] })).rejects.toThrow('not open');
  });

  it('passes ultracode at open only for a literal true and toggles it on open sessions', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, ultracode: true, effort: 'low' });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, effort: 'low', ultracode: true });
    for (const ultracode of ['true', 1, false, null]) {
      await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, ultracode });
      expect(sessions.at(-1)?.options.request).not.toHaveProperty('ultracode');
    }

    await invoke(IPC.engine.setUltracode, 'h1', true);
    await invoke(IPC.engine.setUltracode, 'h1', false);
    expect(sessions[0]?.setUltracode.mock.calls).toEqual([[true], [false]]);
    await expect(invoke(IPC.engine.setUltracode, 'h1', 'on')).rejects.toThrow('Invalid ultracode setting');
    await expect(invoke(IPC.engine.setUltracode, 'nope', true)).rejects.toThrow('not open');
    expect(sessions[0]?.setUltracode).toHaveBeenCalledTimes(2);
  });

  it('routes permission and question answers to the broker that asked', async () => {
    const { invoke, sessions, events } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const second = sessions[1]?.options.broker;
    const permission = second?.canUseTool('Bash', { command: 'ls' }, context('t1'));
    const asked = events.find((e) => e.type === 'permission');
    expect(asked).toMatchObject({ type: 'permission', request: { handleId: 'h2', toolName: 'Bash' } });
    expect(sessions[1]?.onPendingChange).toHaveBeenCalledWith(1);

    await expect(invoke(IPC.engine.respondPermission, 'x', { behavior: 'maybe' })).rejects.toThrow('Invalid permission decision');
    const requestId = asked?.type === 'permission' ? asked.request.requestId : '';
    await invoke(IPC.engine.respondPermission, requestId, { behavior: 'allow', scope: 'once' });
    await expect(permission).resolves.toMatchObject({ behavior: 'allow' });

    const question = second?.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Pick?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] },
      context('t2'),
    );
    const q = events.find((e) => e.type === 'question');
    const questionId = q?.type === 'question' ? q.request.requestId : '';
    await expect(invoke(IPC.engine.respondQuestion, questionId, { 'Pick?': 3 })).rejects.toThrow('Invalid answer');
    await invoke(IPC.engine.respondQuestion, questionId, { 'Pick?': 'A' });
    await expect(question).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Pick?': 'A' } } });
    await expect(invoke(IPC.engine.respondQuestion, 'already-gone', null)).resolves.toBeUndefined();
  });

  it('keeps a permission answerable when delivering its event to the window fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { invoke, sessions, events } = setup({ throwingEmit: true });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    const permission = sessions[0]?.options.broker.canUseTool('Bash', {}, context('t1'));
    const asked = events.find((e) => e.type === 'permission');
    const requestId = asked?.type === 'permission' ? asked.request.requestId : '';
    await invoke(IPC.engine.respondPermission, requestId, { behavior: 'deny' });
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('close waits for the session, frees the session id and ignores unknown handles', async () => {
    const { invoke, control, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await invoke(IPC.engine.close, 'h1');
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(control.findBySession(S1)).toBeUndefined();
    await expect(invoke(IPC.engine.send, 'h1', 'hi')).rejects.toThrow('not open');
    await expect(control.close('h1')).resolves.toBeUndefined();

    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    expect(sessions).toHaveLength(2);
    sessions[1]?.options.onClosed?.();
    expect(control.findBySession(S1)).toBeUndefined();
  });

  it('closeAll closes every handle, disposes the listing workers and refuses new sessions', async () => {
    const { invoke, control, sessions, listing } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S2 });
    await invoke(IPC.sessions.list, 'default');
    await control.closeAll();
    expect(sessions.map((s) => s.close.mock.calls.length)).toEqual([1, 1]);
    expect(listing.dispose).toHaveBeenCalledTimes(1);
    expect(control.findBySession(S1)).toBeUndefined();
    await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD })).rejects.toThrow('shutting down');
  });

  it('reports closeAll failures while retaining the failed writer and finishing other closures', async () => {
    const { invoke, control, sessions, listing } = setup();
    const handle = await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await invoke(IPC.engine.open, { profileId: 'work', cwd: CWD, resumeSessionId: S2 });
    await invoke(IPC.sessions.list, 'default');
    sessions[0]?.close.mockRejectedValueOnce(new Error('CLI is still running'));
    await expect(control.closeAll()).rejects.toThrow('Could not close all engine sessions');
    expect(control.findBySession(S1, 'default')).toEqual(handle);
    expect(control.findBySession(S2, 'work')).toBeUndefined();
    expect(listing.dispose).toHaveBeenCalledTimes(1);
    await control.closeAll();
    expect(control.findBySession(S1, 'default')).toBeUndefined();
  });

  it('serves sessions.list, history and rename through the listing client with the profile', async () => {
    const { invoke, listing } = setup();
    await expect(invoke(IPC.sessions.list, 'work')).resolves.toEqual([]);
    expect(listing.list).toHaveBeenCalledWith(PROFILES.work);
    await expect(invoke(IPC.sessions.history, 'default', S1, CWD)).resolves.toEqual({
      items: [{ kind: 'user', id: 'u1', text: 'hi' }],
      older: 'cursor-1',
    });
    expect(listing.history).toHaveBeenCalledWith(PROFILES.default, S1, CWD, undefined);
    await invoke(IPC.sessions.history, 'default', S1);
    expect(listing.history).toHaveBeenLastCalledWith(PROFILES.default, S1, undefined, undefined);
    await invoke(IPC.sessions.rename, 'default', S1, '  New title  ');
    expect(listing.rename).toHaveBeenCalledWith(PROFILES.default, S1, 'New title');
    await expect(invoke(IPC.sessions.rename, 'default', S1, '   ')).rejects.toThrow('Missing title');
    await expect(invoke(IPC.sessions.history, 'default', 'not-a-uuid')).rejects.toThrow('Invalid session id');
    expect(listing.rename).toHaveBeenCalledTimes(1);
  });

  it('passes a history page cursor of 1 to MAX_HISTORY_CURSOR characters and refuses anything else', async () => {
    const { invoke, listing } = setup();
    const longest = 'c'.repeat(MAX_HISTORY_CURSOR);
    await invoke(IPC.sessions.history, 'default', S1, CWD, longest);
    expect(listing.history).toHaveBeenLastCalledWith(PROFILES.default, S1, CWD, longest);
    await invoke(IPC.sessions.history, 'default', S1, undefined, 'x');
    expect(listing.history).toHaveBeenLastCalledWith(PROFILES.default, S1, undefined, 'x');
    await invoke(IPC.sessions.history, 'default', S1, CWD, null);
    expect(listing.history).toHaveBeenLastCalledWith(PROFILES.default, S1, CWD, undefined);
    expect(listing.history).toHaveBeenCalledTimes(3);
    for (const before of ['', `${longest}c`, 42, { cursor: 'x' }, ['x'], true]) {
      await expect(invoke(IPC.sessions.history, 'default', S1, CWD, before)).rejects.toThrow('Invalid history cursor.');
    }
    expect(listing.history).toHaveBeenCalledTimes(3);
  });
});

describe('engine IPC fast mode, task controls and subagent transcripts', () => {
  it('preserves both literal fast-mode choices at open and toggles it on open sessions', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, fastMode: true });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, fastMode: true });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, fastMode: false });
    expect(sessions.at(-1)?.options.request).toMatchObject({ fastMode: false });
    for (const fastMode of ['true', 1, null]) {
      await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, fastMode });
      expect(sessions.at(-1)?.options.request).not.toHaveProperty('fastMode');
    }
    await invoke(IPC.engine.setFastMode, 'h1', true);
    await invoke(IPC.engine.setFastMode, 'h1', false);
    expect(sessions[0]?.setFastMode.mock.calls).toEqual([[true], [false]]);
    await expect(invoke(IPC.engine.setFastMode, 'h1', 'on')).rejects.toThrow('Invalid fast mode setting');
    await expect(invoke(IPC.engine.setFastMode, 'nope', true)).rejects.toThrow('not open');
  });

  it('passes the dynamic workflows choice at open and to open sessions, and refuses anything else', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, workflows: 'on' });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, workflows: 'on' });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, workflows: 'off' });
    expect(sessions[1]?.options.request).toMatchObject({ workflows: 'off' });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, workflows: null });
    expect(sessions[2]?.options.request).not.toHaveProperty('workflows');
    await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, workflows: true })).rejects.toThrow('Invalid workflows setting');
    await invoke(IPC.engine.setWorkflows, 'h1', 'off');
    await invoke(IPC.engine.setWorkflows, 'h1', null);
    expect(sessions[0]?.setWorkflows.mock.calls).toEqual([['off'], [null]]);
    await expect(invoke(IPC.engine.setWorkflows, 'h1', 'yes')).rejects.toThrow('Invalid workflows setting');
    await expect(invoke(IPC.engine.setWorkflows, 'nope', 'on')).rejects.toThrow('not open');
    expect(sessions[0]?.setWorkflows).toHaveBeenCalledTimes(2);
  });

  it('passes the context refresh choice at open only when on, as a boolean, and serves its switch for open sessions', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, liveContext: true });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, liveContext: true });
    for (const liveContext of [false, undefined, null]) {
      await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, liveContext });
      expect(sessions.at(-1)?.options.request).not.toHaveProperty('liveContext');
    }
    for (const liveContext of ['true', 1, {}]) {
      await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, liveContext })).rejects.toThrow('Invalid context refresh setting.');
    }
    const session = sessions[0]!;
    await invoke(IPC.engine.setLiveContext, 'h1', false);
    await invoke(IPC.engine.setLiveContext, 'h1', true);
    expect(session.setLiveContext.mock.calls).toEqual([[false], [true]]);
    for (const bad of ['on', 1, null, undefined]) {
      await expect(invoke(IPC.engine.setLiveContext, 'h1', bad)).rejects.toThrow('Invalid context refresh setting.');
    }
    expect(session.setLiveContext).toHaveBeenCalledTimes(2);
    await expect(invoke(IPC.engine.setLiveContext, 'nope', true)).rejects.toThrow('not open');
  });

  it('passes the automatic continue choice at open only as a boolean and serves its controls for open sessions', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, autoContinue: false });
    expect(sessions[0]?.options.request).toEqual({ profileId: 'default', cwd: CWD, autoContinue: false });
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, autoContinue: true });
    expect(sessions[1]?.options.request).toEqual({ profileId: 'default', cwd: CWD, autoContinue: true });
    for (const autoContinue of [undefined, null]) {
      await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, autoContinue });
      expect(sessions.at(-1)?.options.request).not.toHaveProperty('autoContinue');
    }
    for (const autoContinue of ['false', 0, 1, '', {}]) {
      await expect(invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, autoContinue })).rejects.toThrow('Invalid auto-continue setting.');
    }
    expect(sessions).toHaveLength(4);

    const session = sessions[0]!;
    await invoke(IPC.engine.setAutoContinue, 'h1', false);
    await invoke(IPC.engine.setAutoContinue, 'h1', true);
    expect(session.setAutoContinue.mock.calls).toEqual([[false], [true]]);
    for (const bad of ['off', 0, null, undefined]) {
      await expect(invoke(IPC.engine.setAutoContinue, 'h1', bad)).rejects.toThrow('Invalid auto-continue setting.');
    }
    expect(session.setAutoContinue).toHaveBeenCalledTimes(2);
    await invoke(IPC.engine.cancelAutoContinue, 'h1');
    expect(session.cancelAutoContinue).toHaveBeenCalledTimes(1);
    session.continueAfterLimit.mockRejectedValueOnce(new Error('Nothing is waiting to continue.'));
    await expect(invoke(IPC.engine.continueAfterLimit, 'h1')).rejects.toThrow('Nothing is waiting to continue.');
    await invoke(IPC.engine.continueAfterLimit, 'h1');
    expect(session.continueAfterLimit).toHaveBeenCalledTimes(2);
    for (const channel of [IPC.engine.setAutoContinue, IPC.engine.cancelAutoContinue, IPC.engine.continueAfterLimit]) {
      await expect(invoke(channel, 'nope', true)).rejects.toThrow('not open');
    }
    expect(sessions.slice(1).every((other) => other.cancelAutoContinue.mock.calls.length === 0)).toBe(true);
  });

  it('stops a task and reads its output only with a well-formed task id', async () => {
    const { invoke, sessions } = setup();
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD });
    await invoke(IPC.engine.stopTask, 'h1', 'a0201cf8574775420');
    expect(sessions[0]?.stopTask).toHaveBeenCalledWith('a0201cf8574775420');
    expect(await invoke(IPC.engine.taskOutput, 'h1', 'bhyokrws2')).toBe('out');
    expect(sessions[0]?.taskOutput).toHaveBeenCalledWith('bhyokrws2');
    for (const bad of ['', '../x', 'a b', 'x'.repeat(101), 42, null]) {
      await expect(invoke(IPC.engine.stopTask, 'h1', bad)).rejects.toThrow('Invalid task id');
      await expect(invoke(IPC.engine.taskOutput, 'h1', bad)).rejects.toThrow('Invalid task id');
    }
    expect(sessions[0]?.stopTask).toHaveBeenCalledTimes(1);
    await expect(invoke(IPC.engine.stopTask, 'nope', 'b1')).rejects.toThrow('not open');
  });

  it('reads a subagent transcript of a checked session, agent id and folder', async () => {
    const { invoke, listing } = setup();
    expect(await invoke(IPC.sessions.subagent, 'default', S1, 'a0201cf8574775420', CWD)).toEqual([{ kind: 'assistant', id: 's1', text: 'sub' }]);
    expect(listing.subagent).toHaveBeenLastCalledWith(PROFILES.default, S1, 'a0201cf8574775420', CWD);
    await invoke(IPC.sessions.subagent, 'default', S1, 'a1', '');
    expect(listing.subagent).toHaveBeenLastCalledWith(PROFILES.default, S1, 'a1', undefined);
    await expect(invoke(IPC.sessions.subagent, 'default', 'not-a-uuid', 'a1')).rejects.toThrow('Invalid session id');
    await expect(invoke(IPC.sessions.subagent, 'default', S1, '../a1')).rejects.toThrow('Invalid agent id');
    await expect(invoke(IPC.sessions.subagent, 'default', S1, 'a1', '\\\\server\\share')).rejects.toThrow('absolute local path');
    expect(listing.subagent).toHaveBeenCalledTimes(2);
  });
});

describe('sessions fork and delete (sidebar session menu)', () => {
  it('forks and deletes only checked sessions, and never one Relay has open', async () => {
    const { invoke, listing } = setup();
    expect(await invoke(IPC.sessions.fork, 'default', S1, CWD)).toBe('9f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c99');
    expect(listing.fork).toHaveBeenLastCalledWith(PROFILES.default, S1, CWD);
    await invoke(IPC.sessions.delete, 'default', S1, '');
    expect(listing.delete).toHaveBeenLastCalledWith(PROFILES.default, S1, undefined);
    for (const call of [IPC.sessions.fork, IPC.sessions.delete]) {
      await expect(invoke(call, 'default', 'not-a-uuid')).rejects.toThrow('Invalid session id');
      await expect(invoke(call, 'default', S1, '\\\\server\\share')).rejects.toThrow('absolute local path');
    }
    await invoke(IPC.engine.open, { profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await expect(invoke(IPC.sessions.delete, 'default', S1, CWD)).rejects.toThrow('Close this session in Relay Desk before deleting it.');
    expect(listing.delete).toHaveBeenCalledTimes(1);
    // Another account's copy of the same id is not Relay's open one.
    await invoke(IPC.sessions.delete, 'work', S1, CWD);
    expect(listing.delete).toHaveBeenCalledTimes(2);
  });
});
