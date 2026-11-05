import { describe, expect, it, vi } from 'vitest';
import type { AuthStatus, Profile } from '@shared/types';

// No session is refused on an account's status: a session of a signed-out account closes with the sign-in message as
// soon as the CLI shows its sign-in (tests/engine/nativeSignInGuard.test.ts), so no status check runs in a session's
// folder and nothing depends on how old a status is. What is left is the age bound on the status that lets effort notes
// read the CLI's global config.
const h = vi.hoisted(() => ({
  registerEngineIpc: vi.fn((..._args: unknown[]) => ({
    close: async () => undefined, findBySession: () => undefined, findByCwd: () => [], findByProfile: () => [], closeAll: async () => undefined,
  })),
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true, setAppUserModelId: () => undefined, setAsDefaultProtocolClient: () => true,
    getAppPath: () => 'C:\\synthetic-relay', getPath: () => 'C:\\Users\\me\\AppData\\Roaming\\Relay Desk', getVersion: () => '0.0.0',
    isPackaged: false, on: () => undefined, quit: () => undefined,
    // The window is never created here: only the service wiring is under test.
    whenReady: () => new Promise(() => undefined),
  },
  ipcMain: { handle: () => undefined },
  nativeTheme: { on: () => undefined, themeSource: 'system', shouldUseDarkColors: false },
  dialog: {}, shell: {}, clipboard: {}, session: {}, Menu: {}, nativeImage: {}, BrowserWindow: class {}, Tray: class {},
}));
vi.mock('../../src/main/engine/ipc', () => ({ registerEngineIpc: h.registerEngineIpc }));
vi.mock('../../src/main/system/ipc', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/system/ipc')>(),
  registerSystemIpc: () => ({ pushLaunchRequest: () => undefined, isAccountBusy: () => false, claudeAiSignIn: () => false,
    shutdown: async () => undefined }),
}));
vi.mock('../../src/main/native/prototypeServices', () => ({ createNativeServices: () => ({ engine: {} }) }));

const { AUTH_GATE_MAX_AGE_MS } = await vi.importActual<typeof import('../../src/main/system/ipc')>('../../src/main/system/ipc');
const { AUTH_STATUS_THROTTLE_MS, createAuthService } = await import('../../src/main/system/auth');

const work: Profile = { id: 'work', name: 'Work', configDir: 'C:\\Users\\me\\profiles\\work', createdAt: 1 };
const SIGNED_IN = { loggedIn: true, authMethod: 'claude.ai' } as const;
const OLD = AUTH_GATE_MAX_AGE_MS + 1000;
/** A status of the work account, checked `age` ms ago. */
const checked = (status: Omit<AuthStatus, 'profileId' | 'checkedAt'>, age = 0): AuthStatus => ({ profileId: 'work', checkedAt: Date.now() - age, ...status });

describe('opening a session', () => {
  it('waits for no account status: the engine is given no status gate', async () => {
    await import('../../src/main/index');
    expect(h.registerEngineIpc).toHaveBeenCalledOnce();
    const deps = h.registerEngineIpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(typeof deps.isProfileBusy).toBe('function');
    expect(deps).not.toHaveProperty('isSignedOut');
  });

  it('checks an account\'s status only in Relay Desk\'s own folder, never in a session\'s', async () => {
    const runs: Array<{ args: readonly string[]; cwd?: string }> = [];
    const auth = createAuthService({
      runner: async (_file, args, options) => {
        runs.push({ args, cwd: options.cwd });
        return { exitCode: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '', timedOut: false };
      },
      resolveBinary: () => 'C:\\synthetic-relay\\claude.exe', buildEnv: () => ({}), workDir: () => 'C:\\Users\\me',
      readProfilePlan: async () => undefined,
    });
    expect(auth).not.toHaveProperty('checkStatus');
    await expect(auth.status(work, true)).resolves.toMatchObject({ loggedIn: false, authMethod: 'none' });
    expect(runs).toEqual([{ args: ['auth', 'status', '--json'], cwd: 'C:\\Users\\me' }]);
  });
});

async function system(cached: AuthStatus | undefined) {
  const { registerSystemIpc } = await vi.importActual<typeof import('../../src/main/system/ipc')>('../../src/main/system/ipc');
  const status = vi.fn(async (_profile: Profile, _force?: boolean): Promise<AuthStatus> => checked(SIGNED_IN));
  const stub = {} as never;
  const control = registerSystemIpc({ handle: () => undefined } as never, {
    engine: { findByProfile: () => [] } as never, profiles: stub, getWindow: () => null, initialLaunch: null,
    settings: stub, shortcuts: stub, handoff: stub, mcp: stub,
    auth: { isLoginInProgress: () => false, status, cachedStatus: () => cached, onStatus: () => () => undefined,
      login: async () => ({ ok: false, message: 'unused' }), logout: async () => ({ ok: false, message: 'unused' }) },
  });
  return { control, status };
}

describe('whether effort notes may read the CLI config', () => {
  it('decides nothing on a status older than the focus refresh, and refreshes that status in the background', async () => {
    expect(AUTH_GATE_MAX_AGE_MS).toBe(AUTH_STATUS_THROTTLE_MS);
    const old = await system(checked(SIGNED_IN, OLD));
    expect(old.control.claudeAiSignIn(work)).toBe(false);
    expect(old.status).toHaveBeenCalledExactlyOnceWith(work);
    const recent = await system(checked(SIGNED_IN, AUTH_GATE_MAX_AGE_MS - 1000));
    expect(recent.control.claudeAiSignIn(work)).toBe(true);
    expect(recent.status).not.toHaveBeenCalled();
  });

  it.each([
    ['no: it was never checked', work, undefined],
    ['no: it signed in with a Console API key', work, checked({ loggedIn: true, authMethod: 'api_key' })],
    ['no: it is signed out', work, checked({ loggedIn: false, authMethod: 'none' })],
    ['no: it uses the launch environment', { ...work, authenticationSource: 'launch-environment' as const }, checked(SIGNED_IN)],
  ] as const)('only on a recent claude.ai sign-in from the CLI config: %s', async (_name, profile, cached) => {
    const { control, status } = await system(cached);
    expect(control.claudeAiSignIn(profile)).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });
});
