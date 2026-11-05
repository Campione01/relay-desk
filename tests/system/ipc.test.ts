import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, isEventMethod } from '@shared/ipc';
import type { AuthStatus, HandoffResult, LaunchRequest, Profile, AuthenticationEnvironmentMetadata } from '@shared/types';
import type { SharedCodeContextReport } from '@shared/types';

const electron = vi.hoisted(() => {
  const theme = {
    themeSource: 'system' as 'system' | 'light' | 'dark',
    systemDark: false,
    get shouldUseDarkColors(): boolean {
      return this.themeSource === 'dark' || (this.themeSource === 'system' && this.systemDark);
    },
    listeners: [] as Array<() => void>,
    on(event: string, cb: () => void) {
      if (event === 'updated') this.listeners.push(cb);
    },
  };
  return {
    nativeTheme: theme,
    app: { getPath: () => 'unused', getVersion: () => '0.1.0' },
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => '') },
  };
});
vi.mock('electron', () => electron);
const authEnvironment = vi.hoisted(() => vi.fn((): AuthenticationEnvironmentMetadata => ({ available: false, variableNames: [] })));
vi.mock('../../src/main/system/authenticationEnvironment', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/system/authenticationEnvironment')>(),
  getAuthenticationEnvironmentMetadata: authEnvironment,
}));

const { registerSystemIpc, isAllowedExternalUrl, readSdkVersion } = await import('../../src/main/system/ipc');
const { createSettingsStore, createShortcutStore } = await import('../../src/main/system/stores');

const work: Profile = { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 1 };
const SID = '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-ipc-'));
  electron.nativeTheme.themeSource = 'system';
  electron.nativeTheme.systemDark = false;
  electron.nativeTheme.listeners = [];
  electron.dialog.showOpenDialog.mockReset();
  electron.shell.openExternal.mockClear();
  electron.shell.openPath.mockReset().mockResolvedValue('');
  authEnvironment.mockReset().mockReturnValue({ available: false, variableNames: [] });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(initialLaunch: LaunchRequest | null = null, overrides: { cliVersion?: () => Promise<string> } = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const duplicates: string[] = [];
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      if (handlers.has(channel)) duplicates.push(channel);
      handlers.set(channel, listener);
    },
  };
  const sent: unknown[][] = [];
  const win = {
    loading: false,
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => sent.push(args), isLoading: () => win.loading },
    setTitleBarOverlay: vi.fn(),
    setBackgroundColor: vi.fn(),
  };
  let statusListener: ((s: AuthStatus) => void) | undefined;
  const auth = {
    status: vi.fn(async (profile: Profile, force?: boolean) => ({
      profileId: profile.id,
      loggedIn: !!force,
      authMethod: 'none' as const,
      checkedAt: 1,
    })),
    cachedStatus: vi.fn((_profile: Profile): AuthStatus | undefined => undefined),
    login: vi.fn(async (): Promise<HandoffResult> => ({ ok: true, message: 'opened' })),
    logout: vi.fn(async (): Promise<HandoffResult> => ({ ok: true, message: 'out' })),
    isLoginInProgress: vi.fn(() => false),
    cancelLogin: vi.fn(async () => ({ ok: true, noPending: false, message: 'Canceled' })),
    shutdown: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    onStatus: (cb: (s: AuthStatus) => void) => {
      statusListener = cb;
      return () => {};
    },
  };
  const profiles = {
    list: vi.fn(async () => [work]),
    get: vi.fn(async (id: string) => {
      if (id !== 'work') throw new Error(`Unknown profile: ${id}`);
      return work;
    }),
    add: vi.fn(async () => work),
    rename: vi.fn(async () => work),
    remove: vi.fn(async () => ({ deletedDirectory: false })),
    setSharedCodeContext: vi.fn(async (_id: string, enabled: boolean) => ({ ...work, sharedCodeContext: enabled })),
    setAuthenticationSource: vi.fn(async (_id: string, source: 'cli-config' | 'launch-environment') => ({ ...work, authenticationSource: source })),
  };
  const handoff = {
    toDesktop: vi.fn(async () => ({ ok: true, message: 'desktop' })),
    openFolderInDesktop: vi.fn(async () => ({ ok: true, message: '' })),
    openInTerminal: vi.fn(async () => ({ ok: true, message: '' })),
    toCloud: vi.fn(async () => ({ ok: true, message: '' })),
    teleport: vi.fn(async () => ({ ok: true, message: '' })),
    remoteControl: vi.fn(async () => ({ ok: true, message: '' })),
    backgroundAgents: vi.fn(async () => []),
    attachBackground: vi.fn(async () => ({ ok: true, message: '' })),
  };
  const findByProfile = vi.fn((): import('@shared/types').EngineHandle[] => []);
  const inspectCodeContext = vi.fn(async (profile: Profile, cwd?: string): Promise<SharedCodeContextReport> => ({
    profileId: profile.id,
    mode: 'shared',
    configDirectory: profile.configDir!,
    globalRoot: 'C:\\Users\\fixture\\.claude',
    entries: [],
    memory: { shared: true, ...(cwd ? { directory: `${cwd}\\fixture-memory` } : {}) },
    warnings: [],
  }));
  const control = registerSystemIpc(ipcMain as never, {
    engine: { close: async () => {}, findBySession: () => undefined, findByCwd: () => [], findByProfile, closeAll: async () => {} },
    profiles,
    getWindow: () => win as never,
    initialLaunch,
    settings: createSettingsStore(dir),
    shortcuts: createShortcutStore(dir),
    auth,
    handoff,
    cliVersion: async () => '2.1.302',
    sdkVersion: () => '0.3.302',
    inspectCodeContext,
    ...overrides,
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler({}, ...args));
  };
  return { handlers, duplicates, invoke, win, sent, auth, profiles, handoff, control, findByProfile, inspectCodeContext, pushStatus: (s: AuthStatus) => statusListener?.(s) };
}

describe('registerSystemIpc', () => {
  it('exposes names-only auth metadata and changes a source only on an idle account', async () => {
    const t = setup();
    await expect(t.invoke(IPC.accounts.authenticationEnvironment)).resolves.toEqual({ available: false, variableNames: [] });
    await expect(t.invoke(IPC.accounts.setAuthenticationSource, 'work', 'launch-environment')).rejects.toThrow('No usable');
    expect(t.profiles.setAuthenticationSource).not.toHaveBeenCalled();
    authEnvironment.mockReturnValue({ available: true, variableNames: ['ANTHROPIC_API_KEY'] });
    t.auth.isLoginInProgress.mockReturnValue(true);
    await expect(t.invoke(IPC.accounts.setAuthenticationSource, 'work', 'launch-environment')).rejects.toThrow('login console');
    t.auth.isLoginInProgress.mockReturnValue(false);
    await expect(t.invoke(IPC.accounts.setAuthenticationSource, 'work', 'launch-environment')).resolves.toMatchObject({ authenticationSource: 'launch-environment' });
    expect(t.auth.invalidate).toHaveBeenCalledExactlyOnceWith('work');
    expect(t.auth.status).not.toHaveBeenCalled();
    await expect(t.invoke(IPC.accounts.setAuthenticationSource, 'work', 'forged')).rejects.toThrow('Invalid authentication source');
  });

  it('can cancel the active login without allowing unrelated account mutation, and seals actions on shutdown', async () => {
    const t = setup();
    t.auth.isLoginInProgress.mockReturnValue(true);
    await expect(t.invoke(IPC.accounts.cancelLogin, 'work')).resolves.toMatchObject({ ok: true, noPending: false });
    expect(t.auth.cancelLogin).toHaveBeenCalledExactlyOnceWith('work');
    await expect(t.invoke(IPC.accounts.cancelLogin, 'ghost')).resolves.toMatchObject({ ok: false });
    await t.control.shutdown();
    expect(t.auth.shutdown).toHaveBeenCalledOnce();
    t.auth.isLoginInProgress.mockReturnValue(false);
    expect(t.control.isAccountBusy('work')).toBe(true);
    await expect(t.invoke(IPC.accounts.login, 'work')).resolves.toMatchObject({ ok: false });
    expect(t.auth.login).not.toHaveBeenCalled();
  });
  it('takes only a checked claude.ai sign-in from the CLI config as one, without checking the account again', () => {
    const t = setup();
    const signedIn: AuthStatus = { profileId: 'work', loggedIn: true, authMethod: 'claude.ai', checkedAt: Date.now() };
    expect(t.control.claudeAiSignIn(work)).toBe(false);
    t.auth.cachedStatus.mockReturnValue(signedIn);
    expect(t.control.claudeAiSignIn(work)).toBe(true);
    expect(t.auth.cachedStatus).toHaveBeenLastCalledWith(work);
    expect(t.control.claudeAiSignIn({ ...work, authenticationSource: 'cli-config' })).toBe(true);
    expect(t.control.claudeAiSignIn({ ...work, authenticationSource: 'launch-environment' })).toBe(false);
    for (const authMethod of ['api_key', 'api_key_helper', 'oauth_token', 'third_party', 'unknown'] as const) {
      t.auth.cachedStatus.mockReturnValue({ ...signedIn, authMethod });
      expect(t.control.claudeAiSignIn(work)).toBe(false);
    }
    t.auth.cachedStatus.mockReturnValue({ ...signedIn, loggedIn: false });
    expect(t.control.claudeAiSignIn(work)).toBe(false);
    t.auth.cachedStatus.mockReturnValue(signedIn);
    Reflect.deleteProperty(t.auth, 'cachedStatus');
    expect(t.control.claudeAiSignIn(work)).toBe(false);
    expect(t.auth.status).not.toHaveBeenCalled();
  });

  it('registers every invoke channel of app, handoff, accounts, shortcuts and mcp exactly once', () => {
    const { handlers, duplicates } = setup();
    const expected = (['app', 'handoff', 'accounts', 'shortcuts', 'mcp'] as const).flatMap((ns) =>
      Object.entries(IPC[ns])
        .filter(([method]) => !isEventMethod(method))
        .map(([, channel]) => channel),
    );
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
    expect(duplicates).toEqual([]);
  });

  it('serves the initial launch request once', async () => {
    const t = setup({ action: 'resume', sessionId: SID, cwd: 'D:\\x' });
    await expect(t.invoke(IPC.app.getLaunchRequest)).resolves.toEqual({ action: 'resume', sessionId: SID, cwd: 'D:\\x' });
    await expect(t.invoke(IPC.app.getLaunchRequest)).resolves.toBeNull();
  });

  it('pushes launch requests to a loaded renderer and queues them while it loads', async () => {
    const t = setup();
    t.control.pushLaunchRequest({ action: 'new', cwd: 'D:\\a' });
    expect(t.sent).toEqual([['relay:app:onLaunchRequest', { action: 'new', cwd: 'D:\\a' }]]);
    t.win.loading = true;
    t.control.pushLaunchRequest({ action: 'open' });
    expect(t.sent).toHaveLength(1);
    await expect(t.invoke(IPC.app.getLaunchRequest)).resolves.toEqual({ action: 'open' });
  });

  it('setSettings applies the theme to nativeTheme and recolours the title bar overlay', async () => {
    const t = setup();
    await expect(t.invoke(IPC.app.setSettings, { theme: 'dark' })).resolves.toMatchObject({ theme: 'dark' });
    expect(electron.nativeTheme.themeSource).toBe('dark');
    expect(t.win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#1f1f1f', symbolColor: '#d0d0d0', height: 36 });
    expect(t.win.setBackgroundColor).toHaveBeenLastCalledWith('#1f1f1f');

    await t.invoke(IPC.app.setSettings, { theme: 'light' });
    expect(electron.nativeTheme.themeSource).toBe('light');
    expect(t.win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#fcfcfb', symbolColor: '#2b2b2b', height: 36 });

    await t.invoke(IPC.app.setSettings, { theme: 'system' });
    electron.nativeTheme.systemDark = true;
    for (const cb of electron.nativeTheme.listeners) cb();
    expect(t.win.setBackgroundColor).toHaveBeenLastCalledWith('#1f1f1f');
    await expect(t.invoke(IPC.app.getSettings)).resolves.toMatchObject({ theme: 'system' });
  });

  it('rejects invalid settings without touching the theme', async () => {
    const t = setup();
    await expect(t.invoke(IPC.app.setSettings, { theme: 'neon' })).rejects.toThrow();
    expect(electron.nativeTheme.themeSource).toBe('system');
    expect(t.win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('openExternal opens https links only', async () => {
    const t = setup();
    await t.invoke(IPC.app.openExternal, 'https://code.claude.com/docs');
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://code.claude.com/docs');
    for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///C:/Windows', 'https://user:pw@example.com', 'relaydesk://new', 42]) {
      await expect(t.invoke(IPC.app.openExternal, url)).rejects.toThrow(/https/);
    }
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(isAllowedExternalUrl('https://x.y/a?b=c')).toBe(true);
  });

  it('pickFolder returns the chosen local folder, null when cancelled, and refuses network folders', async () => {
    const t = setup();
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['D:\\demos\\app'] });
    await expect(t.invoke(IPC.app.pickFolder)).resolves.toBe('D:\\demos\\app');
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(t.win, { properties: ['openDirectory', 'createDirectory'] });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(t.invoke(IPC.app.pickFolder)).resolves.toBeNull();
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['\\\\server\\share'] });
    await expect(t.invoke(IPC.app.pickFolder)).rejects.toThrow(/Network folders/);
  });

  it('versions reports app, cli and sdk; a failing cli read becomes "unknown"', async () => {
    const t = setup();
    await expect(t.invoke(IPC.app.versions)).resolves.toEqual({ app: '0.1.0', cli: '2.1.302', sdk: '0.3.302' });
    const failing = setup(null, {
      cliVersion: async () => {
        throw new Error('missing');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(failing.invoke(IPC.app.versions)).resolves.toEqual({ app: '0.1.0', cli: 'unknown', sdk: '0.3.302' });
    expect(readSdkVersion()).toBe('0.3.302');
  });

  it('pickFiles returns all local files, handles cancellation and rejects network paths', async () => {
    const t = setup();
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['D:\\a.txt', 'C:\\b.png'] });
    await expect(t.invoke(IPC.app.pickFiles)).resolves.toEqual(['D:\\a.txt', 'C:\\b.png']);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(t.win, { properties: ['openFile', 'multiSelections'] });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(t.invoke(IPC.app.pickFiles)).resolves.toEqual([]);
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['\\\\server\\share\\a.txt'] });
    await expect(t.invoke(IPC.app.pickFiles)).rejects.toThrow();
  });

  it('revealPath opens existing local directories, never executes a file and reports shell failure', async () => {
    const t = setup();
    await t.invoke(IPC.app.revealPath, dir);
    expect(electron.shell.openPath).toHaveBeenCalledWith(dir);
    const file = join(dir, 'not-a-directory.exe');
    await writeFile(file, 'not executable');
    await expect(t.invoke(IPC.app.revealPath, file)).rejects.toThrow();
    await expect(t.invoke(IPC.app.revealPath, '\\\\server\\share')).rejects.toThrow();
    expect(electron.shell.openPath).toHaveBeenCalledTimes(1);
    electron.shell.openPath.mockResolvedValueOnce('Windows rejected the request');
    await expect(t.invoke(IPC.app.revealPath, dir)).rejects.toThrow();
  });

  it('accounts: status forwards force, onStatus is pushed to the renderer, login/logout resolve profiles', async () => {
    const t = setup();
    await expect(t.invoke(IPC.accounts.status, 'work', true)).resolves.toMatchObject({ profileId: 'work', loggedIn: true });
    expect(t.auth.status).toHaveBeenLastCalledWith(work, true);
    await t.invoke(IPC.accounts.status, 'work');
    expect(t.auth.status).toHaveBeenLastCalledWith(work, false);

    t.pushStatus({ profileId: 'work', loggedIn: true, authMethod: 'claude.ai', checkedAt: 5 });
    expect(t.sent).toContainEqual([
      'relay:accounts:onStatus',
      { profileId: 'work', loggedIn: true, authMethod: 'claude.ai', checkedAt: 5 },
    ]);

    await expect(t.invoke(IPC.accounts.login, 'work', 'sso', 'me@example.com')).resolves.toMatchObject({ ok: true });
    expect(t.auth.login).toHaveBeenCalledWith(work, 'sso', 'me@example.com');
    await expect(t.invoke(IPC.accounts.login, 'work', 'token')).resolves.toMatchObject({ ok: false });
    await expect(t.invoke(IPC.accounts.login, 'ghost')).resolves.toMatchObject({ ok: false, message: expect.stringContaining('ghost') });
    await expect(t.invoke(IPC.accounts.logout, 'work')).resolves.toMatchObject({ ok: true });
    expect(t.auth.login).toHaveBeenCalledTimes(1);
  });

  it('accounts: list/add/rename delegate; directory deletion requires an explicit validated option', async () => {
    const t = setup();
    await t.invoke(IPC.accounts.list);
    await t.invoke(IPC.accounts.add, 'Work', 'D:\\p');
    expect(t.profiles.add).toHaveBeenCalledWith('Work', 'D:\\p');
    await t.invoke(IPC.accounts.rename, 'work', 'W');
    expect(t.profiles.rename).toHaveBeenCalledWith('work', 'W');
    await expect(t.invoke(IPC.accounts.remove, 'work', { deleteDirectory: true })).resolves.toBeUndefined();
    expect(t.profiles.remove).toHaveBeenLastCalledWith('work', { deleteDirectory: true });
    await t.invoke(IPC.accounts.remove, 'work');
    expect(t.profiles.remove).toHaveBeenLastCalledWith('work', { deleteDirectory: false });
    await expect(t.invoke(IPC.accounts.remove, 'work', { deleteDirectory: 'yes' })).rejects.toThrow();
    await expect(t.invoke(IPC.accounts.remove, 'work', { unexpected: true })).rejects.toThrow();
    expect(t.profiles.remove).toHaveBeenCalledTimes(2);
  });

  it('handoff and shortcuts channels delegate to their services', async () => {
    const t = setup();
    const a = { profileId: 'default', sessionId: SID, cwd: 'D:\\x' };
    await expect(t.invoke(IPC.handoff.toDesktop, a)).resolves.toEqual({ ok: true, message: 'desktop' });
    expect(t.handoff.toDesktop).toHaveBeenCalledWith(a);
    const seeded = (await t.invoke(IPC.shortcuts.get)) as unknown[];
    expect(seeded.length).toBeGreaterThan(10);
    await expect(t.invoke(IPC.shortcuts.set, [])).resolves.toEqual([]);
    await expect(t.invoke(IPC.shortcuts.reset)).resolves.toHaveLength(seeded.length);
  });

  it('blocks login, logout and deletion while the account still owns a starting or active writer', async () => {
    const t = setup();
    t.findByProfile.mockReturnValue([{ handleId: 'starting', profileId: 'work', cwd: dir }]);
    await expect(t.invoke(IPC.accounts.login, 'work')).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Close this account') });
    await expect(t.invoke(IPC.accounts.logout, 'work')).resolves.toMatchObject({ ok: false });
    await expect(t.invoke(IPC.accounts.remove, 'work', { deleteDirectory: true })).rejects.toThrow(/Close this account/);
    expect(t.auth.login).not.toHaveBeenCalled();
    expect(t.auth.logout).not.toHaveBeenCalled();
    expect(t.profiles.remove).not.toHaveBeenCalled();
    t.findByProfile.mockReturnValue([]);
    await expect(t.invoke(IPC.accounts.login, 'work')).resolves.toMatchObject({ ok: true });
  });

  it('retains the account and blocks logout while its visible login console is still pending', async () => {
    const t = setup();
    t.auth.isLoginInProgress.mockReturnValue(true);
    await expect(t.invoke(IPC.accounts.logout, 'work')).resolves.toMatchObject({ ok: false, message: expect.stringContaining('login console') });
    await expect(t.invoke(IPC.accounts.remove, 'work', { deleteDirectory: true })).rejects.toThrow(/login console/);
    expect(t.auth.logout).not.toHaveBeenCalled();
    expect(t.profiles.remove).not.toHaveBeenCalled();
    t.auth.isLoginInProgress.mockReturnValue(false);
    await expect(t.invoke(IPC.accounts.logout, 'work')).resolves.toMatchObject({ ok: true });
  });

  it('holds the engine-open gate for the whole asynchronous account change and releases on failure', async () => {
    const t = setup();
    let release!: () => void;
    t.profiles.remove.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { deletedDirectory: false };
    });
    const removal = t.invoke(IPC.accounts.remove, 'work');
    expect(t.control.isAccountBusy('work')).toBe(true);
    expect(t.control.isAccountBusy('default')).toBe(false);
    await expect(t.invoke(IPC.accounts.login, 'work')).resolves.toMatchObject({ ok: false });
    release();
    await removal;
    expect(t.control.isAccountBusy('work')).toBe(false);
    t.profiles.remove.mockRejectedValueOnce(new Error('synthetic removal failure'));
    await expect(t.invoke(IPC.accounts.remove, 'work')).rejects.toThrow(/synthetic removal/);
    expect(t.control.isAccountBusy('work')).toBe(false);
    t.auth.isLoginInProgress.mockReturnValue(true);
    expect(t.control.isAccountBusy('work')).toBe(true);
  });

  it('inspects only the selected profile and normalized optional local folder without login or session work', async () => {
    const t = setup();
    await expect(t.invoke(IPC.app.inspectCodeContext, 'work', 'D:/demos/demo')).resolves.toMatchObject({ profileId: 'work', mode: 'shared' });
    expect(t.inspectCodeContext).toHaveBeenLastCalledWith(work, 'D:\\demos\\demo');
    await t.invoke(IPC.app.inspectCodeContext, 'work');
    expect(t.inspectCodeContext).toHaveBeenLastCalledWith(work, undefined);
    expect(t.auth.login).not.toHaveBeenCalled();
    expect(t.auth.status).not.toHaveBeenCalled();
  });

  it('rejects unsafe inheritance-inspection folders and unknown accounts before invoking the inspector', async () => {
    const t = setup();
    for (const cwd of ['\\\\host\\share', 'D:relative', 'D:\\a\\..\\b', 42, null]) {
      await expect(t.invoke(IPC.app.inspectCodeContext, 'work', cwd)).rejects.toThrow();
    }
    await expect(t.invoke(IPC.app.inspectCodeContext, 'unknown', 'D:\\safe')).rejects.toThrow(/Unknown profile/);
    expect(t.inspectCodeContext).not.toHaveBeenCalled();
  });

  it('does not turn failed inheritance inspection into a successful empty report', async () => {
    const t = setup();
    t.inspectCodeContext.mockRejectedValueOnce(new Error('Synthetic safe inspection failure'));
    await expect(t.invoke(IPC.app.inspectCodeContext, 'work')).rejects.toThrow(/safe inspection failure/);
  });
});
