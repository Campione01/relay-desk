import { randomUUID } from 'node:crypto';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC, type RelayApi } from '@shared/ipc';
import type { EngineHandle, OpenSessionRequest, Profile, SessionSummary } from '@shared/types';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\${name}` },
}));

const { registerEngineIpc } = await import('../../src/main/engine/ipc');
const { createHandoffService } = await import('../../src/main/system/handoff');
const { toSessionSummary } = await import('../../src/main/engine/listingOps');
const { createMockApi } = await import('../../src/renderer/mock/api');
const { MOCK_PROFILES, WORK_PROFILE_ID } = await import('../../src/renderer/mock/fixtures');
type EngineSessionOptions = import('../../src/main/engine/session').EngineSessionOptions;
type EngineSessionLike = import('../../src/main/engine/ipc').EngineSessionLike;

// The renderer is tested against the mock; these scenarios keep the mock's single-writer rules equal to main's.
const CWD = 'D:\\work\\demo';
const S1 = '11111111-2222-4333-8444-555555555555';
const PROFILES: Record<string, Profile> = Object.fromEntries(MOCK_PROFILES.map((p) => [p.id, { ...p }]));

interface Backend {
  open(req: OpenSessionRequest): Promise<EngineHandle>;
  handoff: RelayApi['handoff'];
  /** True while the handle is a usable writer (read-only probe). */
  isLive(handleId: string): Promise<boolean>;
  list(profileId: string): Promise<SessionSummary[]>;
}

function mainBackend(): Backend {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, listener) } as unknown as IpcMain;
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve().then(() => handlers.get(channel)!({ sender: {} }, ...args));
  let handles = 0;
  const getProfile = async (id: string): Promise<Profile> => {
    const profile = PROFILES[id];
    if (!profile) throw new Error(`Unknown profile ${id}`);
    return profile;
  };
  const control = registerEngineIpc(ipcMain, {
    emit: () => undefined,
    getProfile,
    listingWorkerPath: 'D:\\app\\out\\main\\listingWorker.js',
    createSession: (options: EngineSessionOptions): EngineSessionLike => {
      const { request } = options;
      // A new session learns its id at start (session.ts); the fake knows it at once.
      const sessionId = request.resumeSessionId && !request.forkSession ? request.resumeSessionId : randomUUID();
      const handle: EngineHandle = { handleId: options.handleId, sessionId, profileId: options.profile.id, cwd: request.cwd };
      return {
        handle,
        start: async () => handle,
        send: async () => undefined,
        interrupt: async () => undefined,
        setModel: async () => undefined,
        setEffort: async () => undefined,
        setPermissionMode: async () => undefined,
        models: async () => [],
        contextUsage: async () => null,
        close: async () => options.onClosed?.(),
        onPendingChange: () => undefined,
        onToolDecision: () => undefined,
      } as unknown as EngineSessionLike;
    },
    listing: {
      list: async () => [],
      history: async () => ({ items: [] }),
      rename: async () => undefined,
      tasks: async () => [],
      subagent: async () => [],
      fork: async () => 'forked',
      delete: async () => undefined,
      dispose: () => undefined,
    },
    newHandleId: () => `h${++handles}`,
    isDirectory: async () => true,
  });
  const handoff = createHandoffService({
    engine: control,
    getProfile,
    openTerminal: async () => ({ exited: Promise.resolve(0) }),
    resolveBinary: () => 'C:\\synthetic\\claude.exe',
    buildEnv: () => ({}),
  });
  const info = (sessionId: string): SDKSessionInfo => ({ sessionId, summary: 'Synthetic', lastModified: 1, cwd: CWD } as SDKSessionInfo);
  return {
    open: (req) => invoke(IPC.engine.open, req) as Promise<EngineHandle>,
    handoff,
    isLive: (handleId) => invoke(IPC.engine.models, handleId).then(() => true, () => false),
    list: async () => [toSessionSummary(info(S1))],
  };
}

function mockBackend(): Backend {
  const api = createMockApi();
  return {
    open: (req) => api.engine.open(req),
    handoff: api.handoff,
    isLive: (handleId) => api.engine.models(handleId).then(() => true, () => false),
    list: (profileId) => api.sessions.list(profileId),
  };
}

const backends: Array<[string, () => Backend]> = [
  ['main', mainBackend],
  ['mock', mockBackend],
];

describe.each(backends)('single-writer contract (%s)', (_name, create) => {
  it('resuming a live session returns its writer, including Relay’s own new session', async () => {
    const backend = create();
    const fresh = await backend.open({ profileId: 'default', cwd: CWD });
    expect(fresh.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const again = await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: fresh.sessionId });
    expect(again).toMatchObject({ handleId: fresh.handleId, sessionId: fresh.sessionId });

    const resumed = await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    expect(await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: S1.toUpperCase() })).toMatchObject({ handleId: resumed.handleId });
    const otherAccount = await backend.open({ profileId: WORK_PROFILE_ID, cwd: CWD, resumeSessionId: S1 });
    expect(otherAccount.handleId).not.toBe(resumed.handleId);
    const fork = await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: S1, forkSession: true });
    expect(fork.handleId).not.toBe(resumed.handleId);
  });

  it('a hand-off without a handle id closes the writer found by session id; a fork keeps it', async () => {
    const backend = create();
    const writer = await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    await backend.handoff.openInTerminal({ profileId: 'default', cwd: CWD, sessionId: S1, fork: true });
    expect(await backend.isLive(writer.handleId)).toBe(true);
    await backend.handoff.toDesktop({ profileId: 'default', cwd: CWD, sessionId: S1 });
    expect(await backend.isLive(writer.handleId)).toBe(false);

    const second = await backend.open({ profileId: 'default', cwd: CWD, resumeSessionId: S1 });
    const work = await backend.open({ profileId: WORK_PROFILE_ID, cwd: CWD, resumeSessionId: S1 });
    await backend.handoff.openInTerminal({ profileId: 'default', cwd: CWD, sessionId: S1 });
    expect(await backend.isLive(second.handleId)).toBe(false);
    expect(await backend.isLive(work.handleId)).toBe(true);
    await backend.handoff.remoteControl({ profileId: WORK_PROFILE_ID, cwd: CWD, sessionId: S1 });
    expect(await backend.isLive(work.handleId)).toBe(false);
  });

  it('continue latest closes every writer of the account in the normalised folder', async () => {
    const backend = create();
    const a = await backend.open({ profileId: 'default', cwd: CWD });
    const b = await backend.open({ profileId: 'default', cwd: 'd:\\WORK\\Demo\\', resumeSessionId: S1 });
    const otherFolder = await backend.open({ profileId: 'default', cwd: `${CWD}-other` });
    const otherAccount = await backend.open({ profileId: WORK_PROFILE_ID, cwd: CWD });
    await backend.handoff.openInTerminal({ profileId: 'default', cwd: CWD, continueLatest: true });
    expect(await backend.isLive(a.handleId)).toBe(false);
    expect(await backend.isLive(b.handleId)).toBe(false);
    expect(await backend.isLive(otherFolder.handleId)).toBe(true);
    expect(await backend.isLive(otherAccount.handleId)).toBe(true);
  });

  it('listed sessions carry no origin', async () => {
    const listed = await create().list('default');
    expect(listed.length).toBeGreaterThan(0);
    for (const session of listed) expect(session).not.toHaveProperty('origin');
  });
});
