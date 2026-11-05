import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '@shared/types';
import type { TerminalLaunch, TerminalOpenOptions } from '../../src/main/system/terminal';
import type { RunResult } from '../../src/main/system/run';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:\\synthetic-relay' } }));
vi.mock('../../src/main/system/cliProfile', () => ({ readCliProfilePlan: async () => undefined }));
const { createAuthService } = await import('../../src/main/system/auth');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const profile: Profile = { id: 'synthetic', name: 'Synthetic', configDir: 'D:\\synthetic-relay\\account', createdAt: 1 };
const statusResult: RunResult = { exitCode: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ authMethod: 'claude.ai' }) };
function fixture() {
  const exited = deferred<number | null>();
  const close = vi.fn(async () => { exited.resolve(0); });
  const terminal = vi.fn(async (_launch: TerminalLaunch, _options?: TerminalOpenOptions) => ({ exited: exited.promise, close }));
  const runner = vi.fn(async () => statusResult);
  const service = createAuthService({
    runner, openTerminal: terminal, resolveBinary: () => 'D:\\synthetic-relay\\claude.exe',
    buildEnv: () => ({ TEST_ONLY: '1' }), workDir: () => 'D:\\synthetic-relay',
  });
  return { service, exited, close, terminal, runner };
}

describe('owned authentication lifetime', () => {
  it('closes the login writer before shutdown resolves, and starts no status probe', async () => {
    const f = fixture();
    await expect(f.service.login(profile)).resolves.toMatchObject({ ok: true });
    expect(f.service.isLoginInProgress(profile.id)).toBe(true);
    await f.service.shutdown!();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.service.isLoginInProgress(profile.id)).toBe(false);
    expect(f.runner).not.toHaveBeenCalled();
    await expect(f.service.login(profile)).resolves.toMatchObject({ ok: false });
    await expect(f.service.logout(profile)).resolves.toMatchObject({ ok: false });
    expect(f.terminal).toHaveBeenCalledOnce();
  });

  it('cancel is idempotent and the same account can log in again after confirmed closure', async () => {
    const f = fixture();
    await expect(f.service.cancelLogin!(profile.id)).resolves.toMatchObject({ ok: true, noPending: true });
    await f.service.login(profile);
    await expect(f.service.cancelLogin!(profile.id)).resolves.toMatchObject({ ok: true, noPending: false });
    expect(f.service.isLoginInProgress(profile.id)).toBe(false);
    await expect(f.service.cancelLogin!(profile.id)).resolves.toMatchObject({ noPending: true });
    expect(f.close).toHaveBeenCalledOnce();
    const next = deferred<number | null>();
    f.terminal.mockResolvedValueOnce({ exited: next.promise, close: vi.fn(async () => next.resolve(0)) });
    await expect(f.service.login(profile)).resolves.toMatchObject({ ok: true });
    await f.service.shutdown!();
    expect(f.terminal).toHaveBeenCalledTimes(2);
  });

  it('holds shutdown until a racing owned host is returned and closed', async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.terminal>>>();
    f.terminal.mockReturnValueOnce(pending.promise);
    const login = f.service.login(profile);
    await vi.waitFor(() => expect(f.terminal).toHaveBeenCalledOnce());
    const shutdown = f.service.shutdown!();
    pending.resolve({ exited: f.exited.promise, close: f.close });
    await shutdown;
    await expect(login).resolves.toMatchObject({ ok: false });
    expect(f.close).toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('keeps an account protected when owned cancellation fails', async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error('synthetic host failure'));
    await f.service.login(profile);
    await expect(f.service.cancelLogin!(profile.id)).resolves.toMatchObject({ ok: false });
    expect(f.service.isLoginInProgress(profile.id)).toBe(true);
    await expect(f.service.logout(profile)).resolves.toMatchObject({ ok: false });
    await expect(f.service.shutdown!()).rejects.toThrow('synthetic host failure');
    f.close.mockImplementation(async () => f.exited.resolve(0));
    await f.service.shutdown!();
  });

  it('gives the login console no output observer and aborts its signal on cancel', async () => {
    const f = fixture();
    await f.service.login(profile);
    const options = f.terminal.mock.calls[0][1] as TerminalOpenOptions & { signal: AbortSignal };
    expect(options).toEqual({ signal: expect.any(AbortSignal) });
    expect(options).not.toHaveProperty('onOutput');
    expect(options.signal.aborted).toBe(false);
    await f.service.cancelLogin!(profile.id);
    expect(options.signal.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('does not cache or emit an old-source status after source invalidation', async () => {
    const f = fixture();
    const pending = deferred<RunResult>();
    f.runner.mockReturnValueOnce(pending.promise);
    const listener = vi.fn();
    f.service.onStatus(listener);
    const prior = f.service.status(profile);
    f.service.invalidate!(profile.id);
    pending.resolve(statusResult);
    await prior;
    expect(listener).not.toHaveBeenCalled();
    await f.service.status(profile);
    expect(f.runner).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('never joins an old source or executes its queued forced check after a source switch', async () => {
    const f = fixture();
    const old = deferred<RunResult>();
    f.runner.mockReturnValueOnce(old.promise);
    const events: unknown[] = [];
    f.service.onStatus((event) => events.push(event));
    const first = f.service.status(profile);
    const queued = f.service.status(profile, true);
    f.service.invalidate!(profile.id);
    const newProfile: Profile = { ...profile, authenticationSource: 'launch-environment' };
    f.runner.mockResolvedValueOnce({ ...statusResult, stdout: JSON.stringify({ authMethod: 'api_key' }) });
    const fresh = await f.service.status(newProfile);
    expect(fresh.authMethod).toBe('api_key');
    expect(f.runner).toHaveBeenCalledTimes(2);
    old.resolve({ ...statusResult, stdout: JSON.stringify({ authMethod: 'claude.ai', email: 'old@example.invalid' }) });
    expect((await first).loggedIn).toBe(false);
    expect((await queued).loggedIn).toBe(false);
    expect(f.runner).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('old@example');
    expect((await f.service.status(newProfile)).authMethod).toBe('api_key');
    expect(f.runner).toHaveBeenCalledTimes(2);
  });
});
