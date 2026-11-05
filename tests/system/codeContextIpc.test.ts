import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc';
import type { EngineHandle, Profile, SharedCodeContextReport } from '@shared/types';

const h = vi.hoisted(() => ({
  unshare: vi.fn(),
  electron: {
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: () => {} },
    app: { getPath: () => 'unused', getVersion: () => '0.1.0' },
    dialog: { showOpenDialog: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => '' },
    clipboard: { writeText: () => {} },
  },
}));
vi.mock('electron', () => h.electron);
vi.mock('../../src/main/system/sharedCodeContext', () => ({ inspectSharedCodeContext: vi.fn(), unshareSharedCodeContext: h.unshare }));

const { registerSystemIpc } = await import('../../src/main/system/ipc');
const { createSettingsStore, createShortcutStore } = await import('../../src/main/system/stores');

const work: Profile = { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 1 };
const report = (profile: Profile): SharedCodeContextReport => ({
  profileId: profile.id, mode: 'shared', configDirectory: profile.configDir!, globalRoot: 'C:\\fixture\\.claude',
  entries: [], memory: { shared: false }, warnings: ['Kept D:\\profiles\\work\\CLAUDE.md: it was not created by Relay Desk.'],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-context-ipc-'));
  h.unshare.mockReset().mockImplementation(async (profile: Profile) => report(profile));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const order: string[] = [];
  const profiles = {
    list: vi.fn(async () => [work]),
    get: vi.fn(async () => work),
    add: vi.fn(async () => work),
    rename: vi.fn(async () => work),
    remove: vi.fn(async () => ({ deletedDirectory: false })),
    setAuthenticationSource: vi.fn(async (_id: string, source: 'cli-config' | 'launch-environment') => ({ ...work, authenticationSource: source })),
    setSharedCodeContext: vi.fn(async (id: string, enabled: boolean) => {
      order.push(`flag:${enabled}`);
      if (id === 'default') throw new Error('The default account always uses its native Claude Code context.');
      return { ...work, sharedCodeContext: enabled };
    }),
  };
  h.unshare.mockImplementation(async (profile: Profile) => {
    order.push(`unshare:${profile.sharedCodeContext}`);
    return report(profile);
  });
  const findByProfile = vi.fn((): EngineHandle[] => []);
  const auth = {
    status: vi.fn(), login: vi.fn(), logout: vi.fn(), isLoginInProgress: vi.fn(() => false), onStatus: () => () => {},
  };
  const control = registerSystemIpc({ handle: (channel: string, fn: never) => handlers.set(channel, fn) } as never, {
    engine: { close: async () => {}, findBySession: () => undefined, findByCwd: () => [], findByProfile, closeAll: async () => {} },
    profiles,
    getWindow: () => null,
    initialLaunch: null,
    settings: createSettingsStore(dir),
    shortcuts: createShortcutStore(dir),
    auth: auth as never,
    handoff: {} as never,
    mcp: {} as never,
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args));
  return { invoke, profiles, findByProfile, auth, order, control };
}

describe('accounts shared code context channels (EC-2)', () => {
  it('switches sharing per account only while it is idle and with a boolean value', async () => {
    const t = setup();
    await expect(t.invoke(IPC.accounts.setSharedCodeContext, 'work', false)).resolves.toMatchObject({ id: 'work', sharedCodeContext: false });
    expect(t.profiles.setSharedCodeContext).toHaveBeenLastCalledWith('work', false);
    await expect(t.invoke(IPC.accounts.setSharedCodeContext, 'work', 'no')).rejects.toThrow(/Invalid/);
    await expect(t.invoke(IPC.accounts.setSharedCodeContext, 'default', false)).rejects.toThrow(/default account/);
    t.findByProfile.mockReturnValue([{ handleId: 'h', profileId: 'work', cwd: dir }]);
    await expect(t.invoke(IPC.accounts.setSharedCodeContext, 'work', true)).rejects.toThrow(/Close this account/);
    t.findByProfile.mockReturnValue([]);
    t.auth.isLoginInProgress.mockReturnValue(true);
    await expect(t.invoke(IPC.accounts.setSharedCodeContext, 'work', true)).rejects.toThrow(/login console/);
    expect(t.profiles.setSharedCodeContext).toHaveBeenCalledTimes(2);
  });

  it('unshare turns the switch off before removing files, returns the kept-items report and holds the account gate', async () => {
    const t = setup();
    let release!: () => void;
    h.unshare.mockImplementationOnce(async (profile: Profile) => {
      t.order.push(`unshare:${profile.sharedCodeContext}`);
      await new Promise<void>((resolve) => { release = resolve; });
      return report(profile);
    });
    const pending = t.invoke(IPC.accounts.unshareCodeContext, 'work');
    await vi.waitFor(() => expect(h.unshare).toHaveBeenCalled());
    expect(t.control.isAccountBusy('work')).toBe(true);
    release();
    await expect(pending).resolves.toMatchObject({ profileId: 'work', warnings: [expect.stringContaining('Kept')] });
    expect(t.order).toEqual(['flag:false', 'unshare:false']);
    expect(t.control.isAccountBusy('work')).toBe(false);
    await expect(t.invoke(IPC.accounts.unshareCodeContext, 'default')).rejects.toThrow(/default account/);
    t.findByProfile.mockReturnValue([{ handleId: 'h', profileId: 'work', cwd: dir }]);
    await expect(t.invoke(IPC.accounts.unshareCodeContext, 'work')).rejects.toThrow(/Close this account/);
    expect(h.unshare).toHaveBeenCalledTimes(1);
  });
});
