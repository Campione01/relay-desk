import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle, Profile } from '@shared/types';
import type { EngineSessionOptions } from '../../src/main/engine/session';
import type { HandoffDeps } from '../../src/main/system/handoff';
import type { RunOptions } from '../../src/main/system/run';
import type { TerminalLaunch, TerminalOpenOptions } from '../../src/main/system/terminal';

const forbidden = vi.hoisted(() => ({
  spawn: vi.fn(() => { throw new Error('No subprocess is allowed in this contract test.'); }),
  query: vi.fn(() => { throw new Error('No SDK query is allowed in this contract test.'); }),
}));
vi.mock('node:child_process', () => ({ spawn: forbidden.spawn }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: forbidden.query }));
vi.mock('electron', () => ({ app: {} }));

const { createAuthService } = await import('../../src/main/system/auth');
const { createHandoffService } = await import('../../src/main/system/handoff');
const { buildChildEnv } = await import('../../src/main/system/env');
const { buildNativeLaunch } = await import('../../src/main/native/launch');

const ROOT = 'C:\\synthetic-native-auth';
const BIN = `${ROOT}\\claude.exe`;
const HOME = `${ROOT}\\home`;
const CWD = `${ROOT}\\project`;
const SESSION = '11111111-2222-4333-8444-555555555555';
const WORK: Profile = { id: 'work', name: 'Work', configDir: `${ROOT}\\profiles\\work`, createdAt: 0 };
const OTHER: Profile = { id: 'other', name: 'Other', configDir: `${ROOT}\\profiles\\other`, createdAt: 0 };
const DEFAULT: Profile = { id: 'default', name: 'Default', configDir: null, createdAt: 0 };
const BASE = Object.freeze({
  HOME, USERPROFILE: HOME, PATH: 'synthetic-path',
  HTTPS_PROXY: 'http://127.0.0.1:9988', ALL_PROXY: 'socks5://127.0.0.1:9989', NO_PROXY: 'localhost',
  NODE_EXTRA_CA_CERTS: `${ROOT}\\ca.pem`, CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
  anthropic_api_key: 'synthetic-inherited-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-inherited-token',
  ANTHROPIC_BASE_URL: 'https://synthetic.invalid', claude_config_dir: `${ROOT}\\wrong-account`,
  CLAUDE_SECURESTORAGE_CONFIG_DIR: `${ROOT}\\wrong-storage`, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'synthetic-sdk', CLAUDECODE: '1', CLAUDE_PID: '123',
});

function fixture(prepareCodeContext?: HandoffDeps['prepareCodeContext']) {
  const order: string[] = [];
  const terminals: Array<{ launch: TerminalLaunch; options?: TerminalOpenOptions; finish: (code: number) => void }> = [];
  const runs: Array<{ file: string; args: readonly string[]; options: RunOptions }> = [];
  let admitted = true;
  const assertAdmitted = () => { if (!admitted) throw new Error('Native process admission denied.'); };
  const runner = vi.fn(async (file: string, args: readonly string[], options: RunOptions) => {
    assertAdmitted();
    runs.push({ file, args, options });
    return {
      exitCode: 0, stderr: '', timedOut: false,
      stdout: args[0] === 'agents' ? '[]' : JSON.stringify({ authMethod: 'claude.ai', email: 'synthetic@example.invalid' }),
    };
  });
  const openTerminal = vi.fn(async (launch: TerminalLaunch, options?: TerminalOpenOptions) => {
    assertAdmitted();
    order.push(`terminal:${launch.args.join(' ')}`);
    const exit = Promise.withResolvers<number>();
    terminals.push({ launch, options, finish: exit.resolve });
    return { exited: exit.promise };
  });
  const buildEnv = (profile: Profile) => buildChildEnv(profile, BASE);
  const processDeps = { runner, openTerminal, resolveBinary: () => BIN, buildEnv };
  const auth = createAuthService({
    ...processDeps, workDir: () => HOME, readProfilePlan: async () => undefined,
  });
  const writers: EngineHandle[] = [WORK, OTHER].map((profile) => ({
    handleId: `native-${profile.id}`, profileId: profile.id, sessionId: SESSION, cwd: CWD,
  }));
  const engine = {
    close: vi.fn(async (id: string) => { order.push(`close:${id}`); }),
    findBySession: (id: string, profileId: string) => writers.find((writer) => writer.sessionId === id && writer.profileId === profileId),
    findByCwd: (cwd: string, profileId: string) => writers.filter((writer) => writer.cwd === cwd && writer.profileId === profileId),
  };
  const handoff = createHandoffService({
    ...processDeps, engine, homeDir: () => HOME, prepareCodeContext,
    getProfile: async (id) => {
      const profile = [DEFAULT, WORK, OTHER].find((candidate) => candidate.id === id);
      if (!profile) throw new Error('Unknown synthetic profile.');
      return profile;
    },
  });
  const nativeLaunch = (profile: Profile) => buildNativeLaunch({
    profile, handleId: `native-${profile.id}`, request: { profileId: profile.id, cwd: CWD }, buildEnv,
    emit: () => undefined, broker: {} as EngineSessionOptions['broker'],
    codeContextSettings: { permissions: { deny: ['Read(secret)'] }, autoMemoryDirectory: `${ROOT}\\shared-memory`, autoMemoryEnabled: true },
  }, { binary: BIN, pluginDirectory: `${ROOT}\\native-mod`, sessionId: SESSION });
  return { auth, handoff, nativeLaunch, engine, runner, openTerminal, runs, terminals, order,
    deny: () => { admitted = false; } };
}

afterEach(() => {
  expect(forbidden.spawn).not.toHaveBeenCalled();
  expect(forbidden.query).not.toHaveBeenCalled();
});

describe('native composition of existing auth and handoff services', () => {
  it('constructs services without starting a CLI, SDK query or account read', () => {
    const f = fixture();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.openTerminal).not.toHaveBeenCalled();
  });

  it('uses the same isolated account and unchanged transport environment for native sessions, auth and handoff', async () => {
    const f = fixture();
    for (const profile of [DEFAULT, WORK, OTHER]) {
      const launch = f.nativeLaunch(profile);
      await f.auth.status(profile);
      await f.handoff.openInTerminal({ profileId: profile.id, cwd: CWD, fork: true, sessionId: SESSION });
      await f.handoff.backgroundAgents(profile.id);
      expect(f.runs.at(-2)?.options.env).toEqual(launch.env);
      expect(f.runs.at(-1)?.options.env).toEqual(launch.env);
      expect(f.terminals.at(-1)?.launch.env).toEqual(launch.env);
      expect(launch.env).toEqual({
        HOME, USERPROFILE: HOME, PATH: BASE.PATH, HTTPS_PROXY: BASE.HTTPS_PROXY, ALL_PROXY: BASE.ALL_PROXY,
        NO_PROXY: BASE.NO_PROXY, NODE_EXTRA_CA_CERTS: BASE.NODE_EXTRA_CA_CERTS, CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
        ...(profile.configDir ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
      });
      const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]!);
      expect(settings).toMatchObject({
        permissions: { deny: ['Read(secret)'] }, autoMemoryDirectory: `${ROOT}\\shared-memory`, autoMemoryEnabled: true,
      });
      expect(settings).not.toHaveProperty('env');
    }
    expect(f.runs.every((run) => run.file === BIN)).toBe(true);
    expect(f.terminals.every(({ launch }) => launch.exe === BIN)).toBe(true);
    expect(BASE.claude_config_dir).toBe(`${ROOT}\\wrong-account`);
    expect(f.engine.close).not.toHaveBeenCalled();
  });

  it('preserves the native session shared-settings whitelist when the existing preparer is wired to handoff', async () => {
    const shared = {
      permissions: { deny: ['Read(secret)'] }, autoMemoryDirectory: `${ROOT}\\shared-memory`, autoMemoryEnabled: true,
    };
    const prepareCodeContext = vi.fn(async () => ({ settings: shared }));
    const f = fixture(prepareCodeContext);
    const native = f.nativeLaunch(WORK);
    const nativeSettings = JSON.parse(native.args[native.args.indexOf('--settings') + 1]!);
    await f.handoff.openInTerminal({ profileId: WORK.id, cwd: CWD, sessionId: SESSION });
    const terminal = f.terminals[0]!.launch;
    expect(prepareCodeContext).toHaveBeenCalledExactlyOnceWith(WORK, CWD);
    expect(terminal.args).toEqual(['--settings', JSON.stringify(shared), '--resume', SESSION]);
    expect(nativeSettings).toMatchObject(JSON.parse(terminal.args[1]!));
    expect(terminal.env).toEqual(native.env);
    expect(terminal.env.CLAUDE_CONFIG_DIR).toBe(WORK.configDir);
  });

  it.each(['claudeai', 'sso', 'console'] as const)('runs %s login as the unmodified official command in an observable console', async (method) => {
    const f = fixture();
    await expect(f.auth.login(WORK, method, 'synthetic@example.invalid')).resolves.toMatchObject({ ok: true });
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.auth.isLoginInProgress(WORK.id)).toBe(true);
    await expect(f.auth.login(WORK, method)).resolves.toMatchObject({ ok: false });
    expect(f.terminals).toHaveLength(1);
    const terminal = f.terminals[0]!;
    expect(terminal.options).toEqual({ signal: expect.any(AbortSignal) });
    expect(terminal.launch.env).toEqual(f.nativeLaunch(WORK).env);
    expect(terminal.launch.args).toEqual([
      'auth', 'login', ...(method === 'sso' ? ['--sso'] : method === 'console' ? ['--console'] : []),
      '--email', 'synthetic@example.invalid',
    ]);
    terminal.finish(0);
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    expect(f.runs[0]?.args).toEqual(['auth', 'status', '--json']);
    expect(f.runs[0]?.options.env).toEqual(f.nativeLaunch(WORK).env);
    expect(f.auth.isLoginInProgress(WORK.id)).toBe(false);
  });

  it('awaits the native writer close before resuming, without closing the other account writer', async () => {
    const f = fixture();
    const closed = Promise.withResolvers<void>();
    f.engine.close.mockImplementation(async (id) => { f.order.push(`close:${id}`); await closed.promise; });
    const pending = f.handoff.openInTerminal({ profileId: WORK.id, cwd: CWD, sessionId: SESSION });
    await vi.waitFor(() => expect(f.engine.close).toHaveBeenCalledExactlyOnceWith('native-work'));
    expect(f.openTerminal).not.toHaveBeenCalled();
    closed.resolve();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(f.order).toEqual(['close:native-work', `terminal:--resume ${SESSION}`]);
  });

  it('routes every remaining handoff and logout through injected process services, not an SDK session', async () => {
    const f = fixture();
    await f.auth.logout(WORK);
    expect(f.runs.map((run) => run.args)).toEqual([['auth', 'logout'], ['auth', 'status', '--json']]);
    expect(f.runs.every((run) => run.options.env.CLAUDE_CONFIG_DIR === WORK.configDir)).toBe(true);
    await expect(f.handoff.toDesktop({ profileId: WORK.id, cwd: CWD, sessionId: SESSION })).resolves.toMatchObject({ ok: false });
    expect(f.terminals).toHaveLength(0);
    await f.handoff.toCloud({ profileId: WORK.id, cwd: CWD, task: 'synthetic task' });
    await f.handoff.teleport({ profileId: WORK.id, cwd: CWD, cloudSessionId: 'synthetic_cloud' });
    await f.handoff.remoteControl({ profileId: WORK.id, cwd: CWD, sessionId: SESSION });
    await f.handoff.attachBackground({ profileId: WORK.id, id: 'synthetic_job' });
    await f.handoff.openInTerminal({ profileId: WORK.id, cwd: CWD, continueLatest: true });
    expect(f.terminals.map(({ launch }) => launch.args)).toEqual([
      ['--cloud', 'synthetic task'], ['--teleport', 'synthetic_cloud'], ['--remote-control', '--resume', SESSION],
      ['attach', 'synthetic_job'], ['--continue'],
    ]);
    expect(f.terminals.every(({ launch }) => launch.env.CLAUDE_CONFIG_DIR === WORK.configDir)).toBe(true);
    const desktop = f.handoff.openFolderInDesktop({ profileId: DEFAULT.id, cwd: CWD });
    await vi.waitFor(() => expect(f.terminals).toHaveLength(6));
    expect(f.terminals[5]?.options).toEqual({ waitForExit: true, keepOpenOnError: true });
    expect(f.terminals[5]?.launch.args).toEqual(['--desktop']);
    expect(f.terminals[5]?.launch.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    f.terminals[5]!.finish(0);
    await expect(desktop).resolves.toMatchObject({ ok: true, exitCode: 0 });
  });

  it('does not retry denied injected process operations through a default launcher', async () => {
    const f = fixture();
    f.deny();
    await expect(f.auth.status(WORK)).resolves.toMatchObject({ loggedIn: false, error: 'Native process admission denied.' });
    await expect(f.auth.login(WORK)).resolves.toMatchObject({ ok: false });
    expect(f.auth.isLoginInProgress(WORK.id)).toBe(false);
    await expect(f.auth.logout(WORK)).resolves.toMatchObject({ ok: false });
    await expect(f.handoff.openInTerminal({ profileId: WORK.id, cwd: CWD })).resolves.toMatchObject({ ok: false });
    await expect(f.handoff.backgroundAgents(WORK.id)).rejects.toThrow('Native process admission denied.');
    expect(f.runs).toHaveLength(0);
    expect(f.terminals).toHaveLength(0);
  });
});
