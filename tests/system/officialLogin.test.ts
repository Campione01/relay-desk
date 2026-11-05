import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, Profile } from '@shared/types';
import type { TerminalLaunch } from '../../src/main/system/terminal';

// The owned login host is a fake: no process starts. The real host, which never relays the CLI's output, is covered by
// the native checks in ownedAuthTerminal.test.ts.
const hosts = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: hosts.spawn }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\synthetic-relay' } }));
vi.mock('../../src/main/system/cliProfile', () => ({ readCliProfilePlan: async () => undefined }));

const { authLoginArgs, createAuthService } = await import('../../src/main/system/auth');
const { MSG } = await import('../../src/main/system/messages');
const { createOfficialLoginOpener } = await import('../../src/main/system/officialLogin');
const { createOwnedAuthTerminalOpener } = await import('../../src/main/system/ownedAuthTerminal');
const { TerminalLaunchError } = await import('../../src/main/system/terminal');

class FakeHost extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: string[] = [];
  kill = vi.fn(() => { this.emit('close', null); return true; });
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.writes.push(chunk.toString()));
    // Like the real host: closing its lifetime pipe ends the owned job and the host.
    this.stdin.on('finish', () => setImmediate(() => this.emit('close', 130)));
  }
  start(): Record<string, unknown> { return JSON.parse(this.writes.join('')) as Record<string, unknown>; }
  frame(value: object): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  ready(): void { this.frame({ type: 'ready', protocol: 1, pid: 55 }); }
  finish(code = 0): void { this.frame({ type: 'exit', code }); this.emit('close', code); }
}

const HOST = 'C:\\synthetic-relay\\tools\\auth\\bin\\RelayAuthHost.exe';
const BIN = 'C:\\synthetic-relay\\claude.exe';
const HOME = 'C:\\Users\\me';
const work: Profile = { id: 'work', name: 'Work', configDir: 'C:\\Users\\me\\profiles\\work', createdAt: 1 };
const ENV = Object.freeze({
  PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', USERPROFILE: HOME,
  CLAUDE_CONFIG_DIR: work.configDir!, HTTPS_PROXY: 'http://127.0.0.1:9988',
});
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com' });
const launch = (): TerminalLaunch => ({ exe: BIN, args: authLoginArgs(), cwd: HOME, env: { ...ENV }, title: 'Relay Desk login' });

function service(answer = { exitCode: 1, stdout: LOGGED_OUT }) {
  const host = new FakeHost();
  hosts.spawn.mockImplementation(() => host as unknown as ChildProcess);
  const runs: Array<readonly string[]> = [];
  const auth = createAuthService({
    terminalHelperPath: () => HOST, resolveBinary: () => BIN, workDir: () => HOME, buildEnv: () => ({ ...ENV }),
    readProfilePlan: async () => undefined,
    runner: async (_file, args) => { runs.push(args); return { ...answer, stderr: '', timedOut: false }; },
  });
  return { host, auth, runs };
}

async function startLogin(f: ReturnType<typeof service>, method?: 'claudeai' | 'sso' | 'console', email?: string) {
  const login = f.auth.login(work, method, email);
  await vi.waitFor(() => expect(hosts.spawn).toHaveBeenCalledOnce());
  f.host.emit('spawn');
  const start = f.host.start();
  f.host.ready();
  return { result: await login, start };
}

beforeEach(() => { hosts.spawn.mockReset(); });

describe('public sign-in: the official login in a console-output host', () => {
  it.each([
    ['claudeai', undefined], ['sso', 'me@example.com'], ['console', 'me@example.com'],
  ] as const)('runs %s sign-in as the unmodified official command in a visible console-output host', async (method, email) => {
    const f = service();
    const { result, start } = await startLogin(f, method, email);
    expect(result).toEqual({ ok: true, message: MSG.loginConsoleOpened });
    expect(hosts.spawn).toHaveBeenCalledExactlyOnceWith(HOST, [], expect.objectContaining({ env: ENV, shell: false, windowsHide: true }));
    expect(start).toEqual({
      protocol: 1, exe: BIN, args: authLoginArgs(method, email), cwd: HOME, env: ENV,
      visible: true, relayOutput: false, title: 'Relay Desk login',
    });
    expect(f.auth.isLoginInProgress(work.id)).toBe(true);
    f.host.finish(0);
    await vi.waitFor(() => expect(f.runs).toEqual([['auth', 'status', '--json']]));
    expect(f.auth.isLoginInProgress(work.id)).toBe(false);
  });

  it('fails closed on any output frame from the host, before and after it is ready', async () => {
    const early = service();
    const pending = early.auth.login(work);
    early.host.emit('spawn');
    early.host.frame({ type: 'output', stream: 'stdout', data: Buffer.from('https://example.com/synthetic').toString('base64') });
    expect(early.host.stdin.writableEnded).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, message: MSG.loginFailed('Could not start the login console.') });
    expect(early.auth.isLoginInProgress(work.id)).toBe(false);

    hosts.spawn.mockReset();
    const late = service();
    const { result } = await startLogin(late);
    expect(result.ok).toBe(true);
    late.host.frame({ type: 'output', stream: 'stderr', data: Buffer.from('synthetic').toString('base64') });
    expect(late.host.stdin.writableEnded).toBe(true);
    await vi.waitFor(() => expect(late.auth.isLoginInProgress(work.id)).toBe(false));
    expect(late.host.kill).not.toHaveBeenCalled();
  });

  it('refuses an output observer before starting a host', async () => {
    const spawn = vi.fn();
    const onOutput = vi.fn();
    await expect(createOwnedAuthTerminalOpener({ helperPath: HOST, visible: false, spawn: spawn as never })(launch(), { onOutput } as never))
      .rejects.toThrow(TerminalLaunchError);
    await expect(createOfficialLoginOpener({ helperPath: HOST, spawn: spawn as never })(launch(), { onOutput } as never)).rejects.toThrow('never relays');
    expect(spawn).not.toHaveBeenCalled();
    expect(hosts.spawn).not.toHaveBeenCalled();
  });

  it('always asks for a visible console and never for the output', async () => {
    const host = new FakeHost();
    const spawn = vi.fn(() => host as unknown as ChildProcess);
    const pending = createOfficialLoginOpener({ helperPath: HOST, spawn: spawn as never, visible: false, relayOutput: true } as never)(launch());
    host.emit('spawn');
    expect(host.start()).toMatchObject({ visible: true, relayOutput: false });
    host.ready();
    const handle = await pending;
    await handle.close();
    expect(host.stdin.writableEnded).toBe(true);
  });

  it('cancel closes the owned host before it reports the login closed, then checks the status again', async () => {
    // The CLI saved the sign-in just as Cancel was pressed: the account shows as signed in.
    const f = service({ exitCode: 0, stdout: LOGGED_IN });
    const seen: AuthStatus[] = [];
    f.auth.onStatus((status) => seen.push(status));
    await startLogin(f);
    await expect(f.auth.cancelLogin!(work.id)).resolves.toMatchObject({ ok: true, noPending: false });
    expect(f.host.stdin.writableEnded).toBe(true);
    expect(f.host.kill).not.toHaveBeenCalled();
    expect(f.auth.isLoginInProgress(work.id)).toBe(false);
    expect(f.runs).toEqual([['auth', 'status', '--json']]);
    expect(seen).toEqual([expect.objectContaining({ profileId: work.id, loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com' })]);
  });

  it('a login cancelled while its host starts reports the cancel, not a failure, and runs no status check', async () => {
    const f = service();
    const login = f.auth.login(work);
    await vi.waitFor(() => expect(hosts.spawn).toHaveBeenCalledOnce());
    f.host.emit('spawn');
    const cancel = f.auth.cancelLogin!(work.id);
    await expect(login).resolves.toEqual({ ok: false, cancelled: true, message: 'Login canceled.' });
    await expect(cancel).resolves.toMatchObject({ ok: true, noPending: false });
    expect(f.host.stdin.writableEnded).toBe(true);
    expect(f.auth.isLoginInProgress(work.id)).toBe(false);
    expect(f.runs).toEqual([]);
  });

  it('shutdown closes the owned host and starts no status check or new login', async () => {
    const f = service();
    await startLogin(f);
    await f.auth.shutdown!();
    expect(f.host.stdin.writableEnded).toBe(true);
    expect(f.auth.isLoginInProgress(work.id)).toBe(false);
    await expect(f.auth.login(work)).resolves.toMatchObject({ ok: false });
    expect(hosts.spawn).toHaveBeenCalledOnce();
    expect(f.runs).toEqual([]);
  });

  it('without an owned host path the login fails closed and starts nothing', async () => {
    const auth = createAuthService({ resolveBinary: () => BIN, workDir: () => HOME, buildEnv: () => ({ ...ENV }) });
    await expect(auth.login(work)).resolves.toEqual({ ok: false, message: MSG.loginFailed('The owned login host is not configured.') });
    expect(hosts.spawn).not.toHaveBeenCalled();
    expect(auth.isLoginInProgress(work.id)).toBe(false);
  });
});
