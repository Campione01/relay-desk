import { describe, expect, it, vi } from 'vitest';
import type { AuthStatus, CliProfilePlan, Profile } from '@shared/types';
import type { RunOptions, RunResult } from '../../src/main/system/run';
import type { TerminalHandle, TerminalLaunch, TerminalOpenOptions } from '../../src/main/system/terminal';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:\\dev' } }));
// The default plan reader would read the profile's global config from disk; tests that need a plan pass their own.
const readCliProfilePlan = vi.hoisted(() => vi.fn(async (_configDir: string | null): Promise<CliProfilePlan | undefined> => undefined));
vi.mock('../../src/main/system/cliProfile', () => ({ readCliProfilePlan }));

const { authLoginArgs, createAuthService, parseAuthStatus } = await import('../../src/main/system/auth');
const { MSG } = await import('../../src/main/system/messages');

const BIN = 'D:\\dev\\claude.exe';
const work: Profile = { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 1 };
const other: Profile = { id: 'other', name: 'Other', configDir: 'D:\\profiles\\other', createdAt: 2 };

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  configDirectory: 'D:\\profiles\\work',
  email: 'me@example.com',
  orgId: 'org-uuid',
  orgName: 'My Org',
  subscriptionType: 'max',
  apiKeySource: 'sk-ant-secret',
  oauthToken: 'sk-ant-oat-secret',
});
const LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
  configDirectory: 'D:\\profiles\\work',
});

describe('parseAuthStatus', () => {
  it('keeps only the allowed fields of a logged-in status', () => {
    const status = parseAuthStatus('work', LOGGED_IN, 0, 42);
    expect(status).toEqual({
      profileId: 'work',
      loggedIn: true,
      authMethod: 'claude.ai',
      configDirectory: 'D:\\profiles\\work',
      email: 'me@example.com',
      organization: 'My Org',
      subscriptionType: 'max',
      checkedAt: 42,
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|org-uuid/);
  });

  it('the exit code decides loggedIn (real CLI output when logged out, exit 1)', () => {
    expect(parseAuthStatus('work', LOGGED_OUT, 1, 1)).toEqual({
      profileId: 'work',
      loggedIn: false,
      authMethod: 'none',
      configDirectory: 'D:\\profiles\\work',
      checkedAt: 1,
    });
  });

  it('maps unknown methods to unknown and drops null fields', () => {
    const status = parseAuthStatus('work', JSON.stringify({ authMethod: 'magic', email: null, orgName: null }), 0, 1);
    expect(status).toEqual({ profileId: 'work', loggedIn: true, authMethod: 'unknown', checkedAt: 1 });
  });

  it('handles unreadable output without throwing', () => {
    expect(parseAuthStatus('work', 'not json', 0, 1)).toMatchObject({ loggedIn: true, authMethod: 'unknown' });
    expect(parseAuthStatus('work', '', 1, 1)).toMatchObject({ loggedIn: false, error: expect.stringContaining('exit 1') });
    expect(parseAuthStatus('work', '[]', null, 1)).toMatchObject({ loggedIn: false, error: expect.any(String) });
  });
});

describe('authLoginArgs', () => {
  it('builds the documented flags', () => {
    expect(authLoginArgs()).toEqual(['auth', 'login']);
    expect(authLoginArgs('claudeai')).toEqual(['auth', 'login']);
    expect(authLoginArgs('sso')).toEqual(['auth', 'login', '--sso']);
    expect(authLoginArgs('console', ' me@example.com ')).toEqual(['auth', 'login', '--console', '--email', 'me@example.com']);
  });

  it.each(['not-an-email', '-x@evil.com', 'a@b.c & calc', 'a"b@c.d', 'a@b.c\n--sso', '%USERPROFILE%@x.y'])(
    'rejects email %j',
    (email) => {
      expect(() => authLoginArgs('claudeai', email)).toThrow(/Email/);
    },
  );
});

function fakes(
  statusStdout = LOGGED_IN,
  statusCode: number | null = 0,
  readProfilePlan?: (profile: Profile) => Promise<CliProfilePlan | undefined>,
  profilePlanTimeoutMs?: number,
) {
  const runs: Array<{ file: string; args: readonly string[]; options: RunOptions }> = [];
  const terminals: Array<{ launch: TerminalLaunch; options?: TerminalOpenOptions }> = [];
  let clock = 1_000_000;
  let finishTerminal: (code: number | null) => void = () => {};
  const terminalFinishes: Array<(code: number | null) => void> = [];
  let logoutCode: number | null = 0;
  const runner = async (file: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
    runs.push({ file, args, options });
    if (args[1] === 'logout') return { exitCode: logoutCode, stdout: '', stderr: '', timedOut: false };
    return { exitCode: statusCode, stdout: statusStdout, stderr: '', timedOut: false };
  };
  const openTerminal = async (launch: TerminalLaunch, options?: TerminalOpenOptions): Promise<TerminalHandle> => {
    terminals.push({ launch, options });
    return { exited: new Promise<number | null>((resolve) => { finishTerminal = resolve; terminalFinishes.push(resolve); }) };
  };
  const service = createAuthService({
    runner,
    openTerminal,
    resolveBinary: () => BIN,
    buildEnv: (p) => ({ PATH: 'p', ...(p.configDir ? { CLAUDE_CONFIG_DIR: p.configDir } : {}) }),
    now: () => clock,
    workDir: () => 'C:\\Users\\me',
    ...(readProfilePlan ? { readProfilePlan } : {}),
    ...(profilePlanTimeoutMs ? { profilePlanTimeoutMs } : {}),
  });
  return {
    service,
    runs,
    terminals,
    advance: (ms: number) => (clock += ms),
    finishTerminal: (code: number | null) => finishTerminal(code),
    finishTerminalAt: (index: number, code: number | null) => terminalFinishes[index]?.(code),
    setLogoutCode: (code: number | null) => (logoutCode = code),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function controlledAuth() {
  const checks: Array<(result: RunResult) => void> = [];
  let finishTerminal: (code: number | null) => void = () => undefined;
  const runner = vi.fn(async (_file: string, args: readonly string[]): Promise<RunResult> => {
    if (args[1] === 'logout') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    return new Promise<RunResult>((resolve) => checks.push(resolve));
  });
  const service = createAuthService({
    runner, resolveBinary: () => BIN, buildEnv: () => ({}), workDir: () => 'D:\\synthetic',
    openTerminal: async () => ({ exited: new Promise<number | null>((resolve) => { finishTerminal = resolve; }) }),
  });
  return {
    service, checks, runner,
    finishTerminal: () => finishTerminal(0),
    resolveCheck: (index: number, loggedIn: boolean) => checks[index]?.({
      exitCode: loggedIn ? 0 : 1, stdout: loggedIn ? LOGGED_IN : LOGGED_OUT, stderr: '', timedOut: false,
    }),
  };
}

describe('auth service', () => {
  it('adds the plan of the profile Claude Code fetched later, for the same email only and never for a logged-out account', async () => {
    const read = vi.fn(async (_profile: Profile): Promise<CliProfilePlan | undefined> => ({
      email: 'ME@example.com',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    }));
    const f = fakes(LOGGED_IN, 0, read);
    const status = await f.service.status(work);
    expect(read).toHaveBeenCalledWith(work);
    expect(status.profilePlan).toEqual({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    read.mockResolvedValueOnce({ email: 'me@example.com', subscriptionType: 'pro' });
    expect((await f.service.status(work, true)).profilePlan).toEqual({ subscriptionType: 'pro' });
    // Another Claude Code process may have written another account's profile into the shared config.
    read.mockResolvedValueOnce({ email: 'desktop@example.com', subscriptionType: 'max' });
    expect(await f.service.status(work, true)).not.toHaveProperty('profilePlan');
    read.mockRejectedValueOnce(new Error('EACCES'));
    const unreadable = await f.service.status(work, true);
    expect(unreadable).toMatchObject({ loggedIn: true, email: 'me@example.com' });
    expect(unreadable).not.toHaveProperty('profilePlan');
    expect(unreadable).not.toHaveProperty('error');

    read.mockClear();
    const out = fakes(LOGGED_OUT, 1, read);
    expect(await out.service.status(work)).not.toHaveProperty('profilePlan');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the plan from the profile’s own config folder, only for a claude.ai sign-in, and never waits long for it', async () => {
    readCliProfilePlan.mockClear();
    await fakes().service.status(work);
    expect(readCliProfilePlan).toHaveBeenCalledWith('D:\\profiles\\work');

    // With a Console sign-in the CLI keeps the API key in that same file, so it is not read at all.
    const read = vi.fn(async (_profile: Profile): Promise<CliProfilePlan | undefined> => ({ email: 'me@example.com', subscriptionType: 'max' }));
    const consoleStatus = JSON.stringify({ ...JSON.parse(LOGGED_IN), authMethod: 'api_key' });
    const withKey = await fakes(consoleStatus, 0, read).service.status(work);
    expect(withKey).toMatchObject({ loggedIn: true, authMethod: 'api_key' });
    expect(withKey).not.toHaveProperty('profilePlan');
    expect(read).not.toHaveBeenCalled();

    const slow = fakes(LOGGED_IN, 0, () => new Promise<CliProfilePlan | undefined>(() => undefined), 20);
    const status = await slow.service.status(work);
    expect(status).toMatchObject({ loggedIn: true, email: 'me@example.com' });
    expect(status).not.toHaveProperty('profilePlan');
  });

  it('status runs `auth status --json` hidden with the profile env and a 15 s timeout', async () => {
    const f = fakes();
    const status = await f.service.status(work);
    expect(status).toMatchObject({ profileId: 'work', loggedIn: true, email: 'me@example.com' });
    expect(f.runs).toEqual([
      {
        file: BIN,
        args: ['auth', 'status', '--json'],
        options: { env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' }, cwd: 'C:\\Users\\me', timeoutMs: 15_000 },
      },
    ]);
  });

  it('throttles to one CLI call per profile per 60 s unless forced, and coalesces concurrent calls', async () => {
    const f = fakes();
    await Promise.all([f.service.status(work), f.service.status(work)]);
    expect(f.runs).toHaveLength(1);
    f.advance(59_000);
    await f.service.status(work);
    expect(f.runs).toHaveLength(1);
    await f.service.status(other);
    expect(f.runs).toHaveLength(2);
    await f.service.status(work, true);
    expect(f.runs).toHaveLength(3);
    f.advance(60_001);
    await f.service.status(work);
    expect(f.runs).toHaveLength(4);
  });

  it('gives the cached status of the current source without running the CLI; nothing before a check or after a source change', async () => {
    const f = fakes();
    expect(f.service.cachedStatus(work)).toBeUndefined();
    const checked = await f.service.status(work);
    const cached = f.service.cachedStatus(work);
    expect(cached).toEqual(checked);
    expect(cached).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
    cached!.loggedIn = false;
    expect(f.service.cachedStatus(work)).toMatchObject({ loggedIn: true });
    f.advance(120_000);
    expect(f.service.cachedStatus({ ...work, authenticationSource: 'cli-config' })).toEqual(checked);
    expect(f.service.cachedStatus(other)).toBeUndefined();
    const launched: Profile = { ...work, authenticationSource: 'launch-environment' };
    expect(f.service.cachedStatus(launched)).toBeUndefined();
    expect(f.runs).toHaveLength(1);
    await f.service.status(launched);
    expect(f.service.cachedStatus(launched)).toMatchObject({ loggedIn: true });
    expect(f.service.cachedStatus(work)).toBeUndefined();
    f.service.invalidate!(work.id);
    expect(f.service.cachedStatus(launched)).toBeUndefined();
    expect(f.runs).toHaveLength(2);

    const pending = controlledAuth();
    const running = pending.service.status(work);
    expect(pending.service.cachedStatus(work)).toBeUndefined();
    pending.resolveCheck(0, true);
    await running;
    expect(pending.service.cachedStatus(work)).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
    expect(pending.checks).toHaveLength(1);
  });

  it('logout waits for a genuinely fresh status when an older status is already running', async () => {
    const f = controlledAuth();
    const oldStatus = f.service.status(work);
    let finished = false;
    const logout = f.service.logout(work).then((result) => { finished = true; return result; });
    await flush();
    expect(f.checks).toHaveLength(1);
    f.resolveCheck(0, true);
    await oldStatus;
    await flush();
    expect(f.checks).toHaveLength(2);
    expect(finished).toBe(false);
    f.resolveCheck(1, false);
    await expect(logout).resolves.toMatchObject({ ok: true });
    await expect(f.service.status(work)).resolves.toMatchObject({ loggedIn: false });
    expect(f.checks).toHaveLength(2);
  });

  it('login completion refreshes after a pre-login check rather than caching its stale result', async () => {
    const f = controlledAuth();
    const oldStatus = f.service.status(work);
    await f.service.login(work);
    f.finishTerminal();
    await flush();
    expect(f.checks).toHaveLength(1);
    f.resolveCheck(0, false);
    await oldStatus;
    await flush();
    expect(f.checks).toHaveLength(2);
    f.resolveCheck(1, true);
    await flush();
    await expect(f.service.status(work)).resolves.toMatchObject({ loggedIn: true });
    expect(f.checks).toHaveLength(2);
  });

  it('coalesces waiting forced checks but serializes a later refresh behind an already-started check', async () => {
    const f = controlledAuth();
    const initial = f.service.status(work);
    const forcedA = f.service.status(work, true);
    const forcedB = f.service.status(work, true);
    const normalWaiting = f.service.status(work);
    expect(f.checks).toHaveLength(1);
    f.resolveCheck(0, true);
    await initial;
    await flush();
    expect(f.checks).toHaveLength(2);
    const forcedC = f.service.status(work, true);
    const forcedD = f.service.status(work, true);
    expect(f.checks).toHaveLength(2);
    f.resolveCheck(1, false);
    await expect(Promise.all([forcedA, forcedB, normalWaiting])).resolves.toEqual([
      expect.objectContaining({ loggedIn: false }), expect.objectContaining({ loggedIn: false }), expect.objectContaining({ loggedIn: false }),
    ]);
    await flush();
    expect(f.checks).toHaveLength(3);
    const latestNormal = f.service.status(work);
    expect(f.checks).toHaveLength(3);
    f.resolveCheck(2, true);
    await expect(Promise.all([forcedC, forcedD, latestNormal])).resolves.toEqual([
      expect.objectContaining({ loggedIn: true }), expect.objectContaining({ loggedIn: true }), expect.objectContaining({ loggedIn: true }),
    ]);
    await expect(f.service.status(work)).resolves.toMatchObject({ loggedIn: true });
    expect(f.checks).toHaveLength(3);
  });

  it('emits fresh statuses to onStatus subscribers until they unsubscribe', async () => {
    const f = fakes();
    const seen: AuthStatus[] = [];
    const off = f.service.onStatus((s) => seen.push(s));
    await f.service.status(work);
    await f.service.status(work);
    expect(seen).toHaveLength(1);
    off();
    await f.service.status(work, true);
    expect(seen).toHaveLength(1);
  });

  it('reports a timeout as an error status', async () => {
    const service = createAuthService({
      runner: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
      resolveBinary: () => BIN,
      buildEnv: () => ({}),
      workDir: () => 'C:\\',
    });
    await expect(service.status(work)).resolves.toMatchObject({ loggedIn: false, error: 'claude auth status timed out' });
  });

  it('login runs the official command unchanged in a visible, observable console and refreshes status when it exits', async () => {
    const f = fakes();
    const seen: AuthStatus[] = [];
    f.service.onStatus((s) => seen.push(s));
    await expect(f.service.login(work, 'sso', 'me@example.com')).resolves.toEqual({ ok: true, message: MSG.loginConsoleOpened });
    expect(f.terminals).toEqual([
      {
        launch: {
          exe: BIN,
          args: ['auth', 'login', '--sso', '--email', 'me@example.com'],
          cwd: 'C:\\Users\\me',
          env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' },
          title: 'Relay Desk login',
        },
        options: { signal: expect.any(AbortSignal) },
      },
    ]);
    expect(f.runs).toHaveLength(0);
    f.finishTerminal(0);
    await flush();
    expect(f.runs.map((r) => r.args)).toEqual([['auth', 'status', '--json']]);
    expect(seen).toHaveLength(1);
  });

  it('login with an invalid email or a failing terminal returns ok:false', async () => {
    const f = fakes();
    await expect(f.service.login(work, 'claudeai', 'bad')).resolves.toMatchObject({ ok: false });
    const failing = createAuthService({
      openTerminal: async () => {
        throw new Error('https://example.com/synthetic-sign-in?state=must-not-escape');
      },
      resolveBinary: () => BIN,
      buildEnv: () => ({}),
      workDir: () => 'C:\\',
    });
    const failure = await failing.login(work);
    expect(failure).toMatchObject({ ok: false, message: expect.stringContaining('Could not start') });
    expect(failure.message).not.toMatch(/https:|state=|must-not-escape/);
    await expect(failing.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Could not start') });
    expect(f.terminals).toHaveLength(0);
  });

  it('fails closed without an owned login host and releases the profile', async () => {
    const service = createAuthService({ resolveBinary: () => BIN, buildEnv: () => ({}), workDir: () => 'C:\\' });
    await expect(service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('not configured') });
    await expect(service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('not configured') });
    expect(service.isLoginInProgress(work.id)).toBe(false);
  });

  it('fails closed and keeps the account protected if the console has no observable lifetime', async () => {
    const service = createAuthService({
      openTerminal: async () => ({ exited: null }),
      resolveBinary: () => BIN, buildEnv: () => ({}), workDir: () => 'C:\\',
    });
    await expect(service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('observed') });
    expect(service.isLoginInProgress(work.id)).toBe(true);
  });

  it('refreshes status even if the terminal rejects', async () => {
    const runner = vi.fn(async () => ({ exitCode: 1, stdout: LOGGED_OUT, stderr: '', timedOut: false }));
    let rejectExit: (error: Error) => void = () => undefined;
    const exited = new Promise<number | null>((_resolve, reject) => { rejectExit = reject; });
    const service = createAuthService({
      openTerminal: async () => ({ exited }), runner,
      resolveBinary: () => BIN, buildEnv: () => ({}), workDir: () => 'C:\\',
    });
    await expect(service.login(work)).resolves.toMatchObject({ ok: true });
    rejectExit(new Error('console closed'));
    await flush();
    expect(runner).toHaveBeenCalledWith(BIN, ['auth', 'status', '--json'], expect.anything());
    await expect(service.login(work)).resolves.toMatchObject({ ok: true });
  });

  it('permits one pending login per profile, releases on exit, and does not block another profile', async () => {
    const f = fakes();
    expect(f.service.isLoginInProgress(work.id)).toBe(false);
    await expect(f.service.login(work)).resolves.toMatchObject({ ok: true });
    expect(f.service.isLoginInProgress(work.id)).toBe(true);
    expect(f.service.isLoginInProgress(other.id)).toBe(false);
    await expect(f.service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('already open') });
    expect(f.terminals).toHaveLength(1);
    f.finishTerminalAt(0, 1);
    await flush();
    expect(f.service.isLoginInProgress(work.id)).toBe(false);
    await expect(f.service.login(work)).resolves.toMatchObject({ ok: true });
    await expect(f.service.login(other)).resolves.toMatchObject({ ok: true });
    expect(f.service.isLoginInProgress(other.id)).toBe(true);
    expect(f.terminals).toHaveLength(3);
    f.finishTerminalAt(1, 0);
    f.finishTerminalAt(2, 0);
    await flush();
    expect(f.service.isLoginInProgress(work.id)).toBe(false);
    expect(f.service.isLoginInProgress(other.id)).toBe(false);
  });

  it('a missing owned login host fails closed and releases the profile for a corrected retry', async () => {
    const service = createAuthService({
      terminalHelperPath: () => 'D:\\synthetic-does-not-exist\\RelayAuthHost.exe',
      resolveBinary: () => BIN, buildEnv: () => ({}), workDir: () => 'C:\\',
    });
    await expect(service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Could not start') });
    await expect(service.login(work)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Could not start') });
    expect(service.isLoginInProgress(work.id)).toBe(false);
  });

  it('logout runs `auth logout` hidden with the profile env, then forces a status refresh', async () => {
    const f = fakes(LOGGED_OUT, 1);
    await f.service.status(work);
    const result = await f.service.logout(work);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(f.runs.map((r) => r.args)).toEqual([
      ['auth', 'status', '--json'],
      ['auth', 'logout'],
      ['auth', 'status', '--json'],
    ]);
    expect(f.runs[1]?.options.env).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' });
    f.setLogoutCode(1);
    await expect(f.service.logout(work)).resolves.toMatchObject({ ok: false, exitCode: 1 });
  });
});
