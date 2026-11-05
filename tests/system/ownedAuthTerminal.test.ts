import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOwnedAuthTerminalOpener } from '../../src/main/system/ownedAuthTerminal';
import type { OwnedAuthTerminalHandle } from '../../src/main/system/ownedAuthTerminal';
import type { TerminalLaunch, TerminalOpener } from '../../src/main/system/terminal';

const launch = (overrides: Partial<TerminalLaunch> = {}): TerminalLaunch => ({
  exe: 'C:\\fake\\synthetic.exe', args: ['auth', 'login'], cwd: 'C:\\fake', env: { SystemRoot: 'C:\\Windows' }, ...overrides,
});
const helperPath = 'C:\\fake\\RelayAuthHost.exe';

class FakeHost extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: string[] = [];
  kill = vi.fn(() => { this.emit('close', null); return true; });
  constructor() { super(); this.stdin.on('data', (chunk: Buffer) => this.writes.push(chunk.toString())); }
  frame(value: object): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  ready(): void { this.frame({ type: 'ready', protocol: 1, pid: 55 }); }
  finish(code = 0): void { this.frame({ type: 'exit', code }); this.emit('close', code); }
}

function fakeHost() {
  const child = new FakeHost();
  const fn = vi.fn(() => child as unknown as ChildProcess);
  const open = createOwnedAuthTerminalOpener({ helperPath, visible: false, spawn: fn as unknown as typeof spawn, closeTimeoutMs: 20 });
  return { child, fn, open };
}

describe('owned login terminal protocol', () => {
  it('is TerminalOpener-compatible and uses only a private lifetime pipe, not a detached shell', async () => {
    const { child, fn, open } = fakeHost();
    const compatible: TerminalOpener = open;
    const pending = compatible(launch(), { waitForExit: true, keepOpenOnError: true });
    child.emit('spawn');
    expect(fn).toHaveBeenCalledWith(helperPath, [], expect.objectContaining({ windowsHide: true, detached: false, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(JSON.parse(child.writes.join(''))).toMatchObject({ protocol: 1, visible: false, relayOutput: false, args: ['auth', 'login'] });
    child.ready();
    const handle = await pending;
    child.finish(7);
    await expect(handle.exited).resolves.toBe(7);
  });

  it('never relays the CLI output: an output observer is refused and an output frame fails the handle', async () => {
    const { child, fn, open } = fakeHost();
    await expect(open(launch(), { onOutput: () => undefined } as never)).rejects.toThrow('never relays');
    expect(fn).not.toHaveBeenCalled();
    const pending = open(launch());
    child.ready();
    const handle = await pending;
    child.frame({ type: 'output', stream: 'stdout', data: Buffer.from('https://example.com/synthetic').toString('base64') });
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 130);
    await expect(handle.exited).resolves.toBeNull();
  });

  it('waits for host closure, not merely the exit frame, and close is idempotent', async () => {
    const { child, open } = fakeHost();
    const pending = open(launch()); child.ready();
    const handle = await pending;
    let completed = false;
    void handle.exited.then(() => { completed = true; });
    child.frame({ type: 'exit', code: 0 });
    await Promise.resolve();
    expect(completed).toBe(false);
    const closes = [handle.close(), handle.close()];
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 0);
    await Promise.all(closes);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills only its own stuck helper handle after the bounded close grace period', async () => {
    const { child, open } = fakeHost();
    const pending = open(launch()); child.ready();
    const handle = await pending;
    await handle.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith();
    await expect(handle.exited).resolves.toBeNull();
  });

  it('rejects startup errors only after cleanup and does not expose sensitive native diagnostics', async () => {
    const { child, open } = fakeHost();
    const pending = open(launch());
    const rejection = expect(pending).rejects.toThrow('could not be started or monitored');
    child.frame({ type: 'error', message: 'NEVER surface token=secret' });
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 1);
    await rejection;
  });

  it('handles a spawn error without exposing launch arguments', async () => {
    const { child, open } = fakeHost();
    const pending = open(launch());
    const rejection = expect(pending).rejects.toThrow('Could not start the owned login host');
    child.emit('error', new Error('sensitive arguments'));
    child.emit('close', -1);
    await rejection;
  });

  it('supports cancellation before ready, after ready, and before spawning', async () => {
    for (const ready of [false, true]) {
      const { child, open } = fakeHost();
      const controller = new AbortController();
      const pending = open(launch(), { signal: controller.signal });
      const rejection = ready ? null : expect(pending).rejects.toThrow('cancelled');
      if (ready) child.ready();
      const handle = ready ? await pending : null;
      controller.abort();
      expect(child.stdin.writableEnded).toBe(true);
      child.emit('close', 130);
      if (handle) await expect(handle.exited).resolves.toBeNull();
      else await rejection;
    }
    const { open, fn } = fakeHost();
    await expect(open(launch(), { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(['not json\n', `${'x'.repeat(128 * 1024 + 1)}\n`, '{"type":"output","stream":"stdout","data":"!!"}\n'])('fails closed for malformed native frames', async (response) => {
    const { child, open } = fakeHost();
    const pending = open(launch());
    const rejection = expect(pending).rejects.toThrow(/login host response/);
    child.stdout.write(response);
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close', 1);
    await rejection;
  });

  it('bounds a silent startup', async () => {
    const child = new FakeHost();
    const open = createOwnedAuthTerminalOpener({ helperPath, spawn: (() => child) as unknown as typeof spawn, startupTimeoutMs: 10, closeTimeoutMs: 10 });
    await expect(open(launch())).rejects.toThrow('did not become ready');
  });

  it.each([
    { exe: 'relative.exe' }, { cwd: '\\\\server\\share' }, { args: ['bad\0arg'] },
    { env: { BAD: 'nul\0value' } }, { args: ['x'.repeat(32767)] },
  ])('rejects invalid launches without starting a process', async (invalid) => {
    const { open, fn } = fakeHost();
    await expect(open(launch(invalid))).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Synthetic process condition timed out');
    await sleep(15);
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => child.once('close', () => done()));
}

describe.skipIf(process.platform !== 'win32')('native Windows login ownership (synthetic only; visible test requires explicit opt-in)', () => {
  let root: string;
  let hostPath: string;
  let suspendedHostPath: string;
  let fakePath: string;
  let windowedPath: string;
  let sequence = 0;
  const ownedChildren: ChildProcess[] = [];
  const ownedHandles: OwnedAuthTerminalHandle[] = [];
  const fixtures = resolve('tools/auth-host-tests');
  const newDirectory = (): string => { const directory = join(root, `case-${++sequence}`); mkdirSync(directory); return directory; };
  const nativeLaunch = (directory: string, args: string[]): TerminalLaunch => ({ exe: fakePath, args, cwd: directory, env: { ...process.env, RELAY_FAKE_MARKER: 'isolated-marker' } });
  const records = (directory: string): Array<{ pid: number; console: number }> => readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')) as { pid: number; console: number });
  const waitTree = async (directory: string): Promise<void> => { await until(() => existsSync(join(directory, 'child.json')) && existsSync(join(directory, 'grandchild.json'))); expect(records(directory)).toHaveLength(2); expect(records(directory).every((record) => record.console === 0)).toBe(true); };
  const assertGone = async (directory: string): Promise<void> => {
    await until(() => records(directory).every((record) => !alive(record.pid)));
    const snapshot = readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), 'utf8')]);
    await sleep(100);
    expect(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), 'utf8')])).toEqual(snapshot);
  };
  const directHost = (directory: string, start: boolean, args = ['tree', directory, 'wait']): ChildProcess => {
    const child = spawn(hostPath, [], { windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
    ownedChildren.push(child);
    child.stdin!.on('error', () => {}); child.stdout!.resume(); child.stderr!.resume();
    if (start) child.stdin!.write(`${JSON.stringify({ ...nativeLaunch(directory, args), protocol: 1, title: 'Synthetic', visible: false, relayOutput: false })}\n`);
    return child;
  };
  /**
   * The synthetic CLI ("child") with a helper on a hidden console of its own ("grandchild"), one on its console
   * ("sharer"), one whose launcher has exited ("orphan"), one that started another on its console ("relay", "nested"),
   * and a windowed program ("windowed", the browser) that starts a program with a hidden console ("messaging") which
   * starts another on it ("nmh"), as a browser starts a native messaging host through cmd.exe.
   */
  const family = (directory: string, mode: 'early' | 'wait'): string[] => ['family', directory, mode, windowedPath];
  const FAMILY = ['child', 'grandchild', 'sharer', 'orphan', 'relay', 'nested', 'windowed', 'messaging', 'nmh'] as const;
  // The CLI writes its marker last, after the orphan's launcher has exited.
  const waitFamily = async (directory: string): Promise<Record<(typeof FAMILY)[number], number>> => {
    await until(() => FAMILY.every((role) => existsSync(join(directory, `${role}.json`))), 8000);
    return Object.fromEntries(FAMILY.map((role) => [role, (JSON.parse(readFileSync(join(directory, `${role}.json`), 'utf8')) as { pid: number }).pid])) as Record<(typeof FAMILY)[number], number>;
  };
  /** The login's console processes: the CLI and the helpers it started, also the one whose parent has exited. */
  const consoleSide = (pids: Record<(typeof FAMILY)[number], number>): number[] => [pids.child, pids.grandchild, pids.sharer, pids.orphan, pids.relay, pids.nested];
  /** The windowed program the login started and the console programs it started itself. */
  const windowedSide = (pids: Record<(typeof FAMILY)[number], number>): number[] => [pids.windowed, pids.messaging, pids.nmh];
  /**
   * A killed host (also when its parent dies: Node's own kill-on-close job ends the host) ends the CLI, the fixture's
   * "child", through kill-on-close; what the CLI had already started is no longer owned.
   */
  const cliGone = async (directory: string): Promise<void> => {
    const cli = join(directory, 'child.json');
    if (existsSync(cli)) await until(() => !alive((JSON.parse(readFileSync(cli, 'utf8')) as { pid: number }).pid));
  };
  /**
   * Ends what a test left running on purpose: a windowed program, or what outlives a killed host. The synthetic processes
   * stop at the stop file, so nothing is ended by an id that another process may have taken over meanwhile.
   */
  const release = async (directory: string): Promise<void> => {
    writeFileSync(join(directory, 'stop'), '');
    await assertGone(directory);
  };
  /** Runs the real host on one start request; its exit code and every frame it sent. */
  const hostFrames = async (start: Record<string, unknown>): Promise<{ code: number | null; frames: Array<Record<string, unknown>> }> => {
    const host = spawn(hostPath, [], { windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] }); ownedChildren.push(host);
    host.stdin!.on('error', () => {}); host.stderr!.resume();
    let output = '';
    host.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = new Promise<number | null>((done) => host.once('close', done));
    host.stdin!.write(`${JSON.stringify(start)}\n`);
    // A host that started a waiting child keeps running; ending it here lets the assertion, not the timeout, report that.
    const deadline = setTimeout(() => host.kill(), 3000);
    const exited = await code;
    clearTimeout(deadline);
    return { code: exited, frames: output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) };
  };
  const fixtureParent = async (directory: string, mode: string): Promise<{ child: ChildProcess; hostPid: number; frames: Array<Record<string, unknown>> }> => {
    const child = spawn(process.execPath, [join(fixtures, 'parent.mjs'), mode === 'suspended' ? suspendedHostPath : hostPath, fakePath, directory, mode, windowedPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    ownedChildren.push(child); child.stdout!.resume(); child.stderr!.resume();
    const frames: Array<Record<string, unknown>> = [];
    const hostPid = await new Promise<number>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic parent startup timed out')), 5000);
      child.on('message', (message: { event: string; pid?: number; frame?: Record<string, unknown> }) => {
        if (message.event === 'spawned' && message.pid) { clearTimeout(timer); done(message.pid); }
        if (message.event === 'frame' && message.frame) frames.push(message.frame);
      });
    });
    return { child, hostPid, frames };
  };
  const sentinel = async (): Promise<ChildProcess> => {
    const directory = newDirectory();
    const child = spawn(fakePath, ['sentinel', directory, 'wait'], { windowsHide: true, stdio: 'ignore' }); ownedChildren.push(child);
    await until(() => existsSync(join(directory, 'sentinel.json')));
    expect(records(directory)[0]!.console).toBe(0);
    return child;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-owned-auth-test-'));
    hostPath = join(root, 'RelayAuthHost.exe'); fakePath = join(root, 'FakeAuthProcess.exe');
    const build = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('tools/auth/build-host.ps1'), '-OutputPath', hostPath], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${fakePath}`, join(fixtures, 'FakeAuthProcess.cs')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    // The same fixture built as a windowed program stands in for the browser the CLI opens.
    windowedPath = join(root, 'FakeWindowed.exe');
    const windowed = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${windowedPath}`, join(fixtures, 'FakeAuthProcess.cs')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    expect(windowed.status, windowed.stdout + windowed.stderr).toBe(0);
    suspendedHostPath = join(root, 'RelayAuthHost.TestOnly.exe');
    const testHost = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/define:AUTH_HOST_TESTS', '/reference:System.Web.Extensions.dll', `/out:${suspendedHostPath}`, resolve('tools/auth/RelayAuthHost.cs')], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    expect(testHost.status, testHost.stdout + testHost.stderr).toBe(0);
  }, 45000);

  afterAll(async () => {
    for (const handle of ownedHandles) await handle.close();
    for (const child of ownedChildren) { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed(child); }
    if (!root) return;
    // A generated, exact per-run directory, never a workspace/cache/user-data root.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'relay-owned-auth-test-'))) throw new Error('Unsafe test cleanup path');
    // A failed test can leave synthetic programs running; each one stops at the stop file in its folder.
    const cases = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
    for (const directory of cases) writeFileSync(join(directory, 'stop'), '');
    for (const directory of cases) await assertGone(directory);
    rmSync(root, { recursive: true });
  }, 20000);

  it('passes hostile arguments and the environment through unchanged, without a console, and relays none of the output', async () => {
    const directory = newDirectory();
    const args = ['echo', 'a b', 'a"b', 'trail\\', 'x & echo never', '%PATH%', '!PATH!', '', '\u4e2d\u6587'];
    const handle = await createOwnedAuthTerminalOpener({ helperPath: hostPath, visible: false })(nativeLaunch(directory, args));
    ownedHandles.push(handle);
    await expect(handle.exited).resolves.toBe(7);
    expect(JSON.parse(readFileSync(join(directory, 'echo.json'), 'utf8'))).toMatchObject({ args, marker: 'isolated-marker', console: 0, stdinRedirected: true });
    // The synthetic CLI printed to stdout and stderr; the host sent none of it.
    const again = newDirectory();
    const result = await hostFrames({ ...nativeLaunch(again, args), protocol: 1, title: 'Synthetic', visible: false, relayOutput: false });
    expect(result).toEqual({ code: 7, frames: [{ type: 'ready', protocol: 1, pid: expect.any(Number) }, { type: 'exit', code: 7 }] });
    expect(JSON.parse(readFileSync(join(again, 'echo.json'), 'utf8'))).toMatchObject({ args });
  }, 10000);

  it('repeated normal cancellation removes only owned child and grandchild; a concurrent sentinel survives', async () => {
    const sentinelDirectory = newDirectory();
    const sentinel = spawn(fakePath, ['sentinel', sentinelDirectory, 'wait'], { windowsHide: true, stdio: 'ignore' }); ownedChildren.push(sentinel);
    await until(() => existsSync(join(sentinelDirectory, 'sentinel.json')));
    expect(records(sentinelDirectory)[0]!.console).toBe(0);
    for (let index = 0; index < 3; index++) {
      const directory = newDirectory();
      const handle = await createOwnedAuthTerminalOpener({ helperPath: hostPath, visible: false })(nativeLaunch(directory, ['tree', directory, 'wait'])); ownedHandles.push(handle);
      await waitTree(directory);
      await handle.close(); await handle.close();
      await assertGone(directory);
      expect(alive(sentinel.pid!)).toBe(true);
    }
    sentinel.kill(); await closed(sentinel);
  }, 15000);

  it('an abruptly killed parent ends the host and the CLI and leaves the windowed program the CLI started running', async () => {
    const independent = await sentinel();
    const directory = newDirectory();
    const { child, hostPid } = await fixtureParent(directory, 'family');
    const pids = await waitFamily(directory);
    child.kill(); await closed(child);
    await until(() => !alive(hostPid) && !alive(pids.child));
    expect(windowedSide(pids).filter(alive)).toEqual(windowedSide(pids));
    expect(alive(independent.pid!)).toBe(true);
    await release(directory);
    independent.kill(); await closed(independent);
  }, 10000);

  it('an abruptly killed helper ends the CLI through kill-on-close and leaves the windowed program it started running', async () => {
    const independent = await sentinel();
    const directory = newDirectory();
    const host = directHost(directory, true, family(directory, 'wait'));
    const pids = await waitFamily(directory);
    host.kill(); await closed(host);
    await until(() => !alive(pids.child));
    // Only the host tells console processes apart at the end of a login; once it is killed, what the CLI started stays.
    expect(windowedSide(pids).filter(alive)).toEqual(windowedSide(pids));
    expect(alive(independent.pid!)).toBe(true);
    await release(directory);
    independent.kill(); await closed(independent);
  }, 10000);

  it('a normally exiting CLI leaves no console process behind, on its console or a hidden one, but its windowed program and the console programs that one started run on', async () => {
    const directory = newDirectory();
    const handle = await createOwnedAuthTerminalOpener({ helperPath: hostPath, visible: false })(nativeLaunch(directory, family(directory, 'early'))); ownedHandles.push(handle);
    await expect(handle.exited).resolves.toBe(23);
    const pids = await waitFamily(directory);
    // The host reports the exit only after the console processes have ended.
    expect(consoleSide(pids).filter(alive)).toEqual([]);
    expect(windowedSide(pids).filter(alive)).toEqual(windowedSide(pids));
    await release(directory);
  }, 15000);

  it('cancel ends the console processes and leaves the windowed program the CLI started, and the console programs that one started, running', async () => {
    const directory = newDirectory();
    const handle = await createOwnedAuthTerminalOpener({ helperPath: hostPath, visible: false })(nativeLaunch(directory, family(directory, 'wait'))); ownedHandles.push(handle);
    const pids = await waitFamily(directory);
    await handle.close();
    expect(consoleSide(pids).filter(alive)).toEqual([]);
    expect(windowedSide(pids).filter(alive)).toEqual(windowedSide(pids));
    await release(directory);
  }, 15000);

  it.each(['idle', 'partial'])('parent death before the complete start handshake (%s) starts no child', async (mode) => {
    const directory = newDirectory();
    const { child, hostPid } = await fixtureParent(directory, mode);
    child.kill(); await closed(child);
    await until(() => !alive(hostPid));
    expect(records(directory)).toHaveLength(0);
  }, 10000);

  it('repeated parent/helper death during startup leaves no unowned process or delayed writes', async () => {
    for (const delay of [0, 1, 5, 20, 50]) {
      const directory = newDirectory();
      const { child, hostPid } = await fixtureParent(directory, 'tree');
      await sleep(delay);
      child.kill(); await closed(child);
      await until(() => !alive(hostPid)); await cliGone(directory); await release(directory);
      const otherDirectory = newDirectory();
      const host = directHost(otherDirectory, true);
      await sleep(delay);
      host.kill(); await closed(host);
      await cliGone(otherDirectory); await release(otherDirectory);
    }
  }, 20000);

  it('parent death after atomic creation kills the actual suspended child before it can write', async () => {
    const directory = newDirectory();
    const { child, hostPid, frames } = await fixtureParent(directory, 'suspended');
    await until(() => frames.some((frame) => frame.type === 'test-created'));
    const created = frames.find((frame) => frame.type === 'test-created')!;
    expect(created.console).toBe(0);
    expect(alive(created.pid as number)).toBe(true);
    expect(records(directory)).toHaveLength(0);
    child.kill(); await closed(child);
    await until(() => !alive(hostPid) && !alive(created.pid as number));
    await assertGone(directory);
    expect(records(directory)).toHaveLength(0);
  }, 10000);

  it('helper crash after atomic creation kills the actual suspended child without an assignment gap', async () => {
    const directory = newDirectory();
    const host = spawn(suspendedHostPath, [], { windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] }); ownedChildren.push(host);
    host.stdin!.on('error', () => {}); host.stderr!.resume();
    let output = '';
    host.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    host.stdin!.write(`${JSON.stringify({ ...nativeLaunch(directory, ['tree', directory, 'wait']), protocol: 1, title: 'Synthetic', visible: false, relayOutput: false, testPauseAfterCreate: true })}\n`);
    await until(() => output.includes('\n'));
    const created = JSON.parse(output.trim());
    expect(created.type).toBe('test-created'); expect(created.console).toBe(0);
    expect(alive(created.pid)).toBe(true);
    expect(records(directory)).toHaveLength(0);
    host.kill(); await closed(host);
    await until(() => !alive(created.pid));
    await assertGone(directory);
    expect(records(directory)).toHaveLength(0);
  }, 10000);

  it('refuses a start request that asks for the CLI output, or does not say, with an error frame before any child starts', async () => {
    const directory = newDirectory();
    for (const fields of [{}, { relayOutput: true }, { relayOutput: 'false' }, { relayOutput: 0 }, { relayOutput: null }]) {
      const result = await hostFrames({ ...nativeLaunch(directory, ['tree', directory, 'wait']), protocol: 1, title: 'Synthetic', visible: false, ...fields });
      expect(result).toEqual({ code: 1, frames: [{ type: 'error', code: 'host_failure' }] });
    }
    await sleep(100);
    expect(records(directory)).toHaveLength(0);
  }, 15000);

  it.skipIf(process.env.RELAY_RUN_VISIBLE_AUTH_TEST !== '1')('production visible console accepts owned native manual input and closes without affecting a sentinel', async () => {
    const independent = await sentinel();
    const directory = newDirectory();
    const title = `Relay Owned Auth Synthetic ${process.pid} ${sequence}`;
    const handle = await createOwnedAuthTerminalOpener({ helperPath: hostPath, visible: true })({
      ...nativeLaunch(directory, ['interactive', directory, title]), title,
    });
    ownedHandles.push(handle);
    // The synthetic CLI prints to its console; a relayed output frame would fail and end the handle at once.
    let settled = false;
    void handle.exited.then(() => { settled = true; });
    let evidence: { pid: number; console: number; visible: boolean; width: number; height: number } | undefined;
    try {
      await until(() => existsSync(join(directory, 'interactive.json')) && existsSync(join(directory, 'grandchild.json')));
      evidence = JSON.parse(readFileSync(join(directory, 'interactive.json'), 'utf8')) as typeof evidence;
      expect(evidence).toMatchObject({ visible: true, minimized: false, stdinRedirected: false, nativeInput: true, ownConsole: true, attachedCount: 2, inputMatched: true, inputEvents: 62 });
      expect(evidence!.console).not.toBe(0);
      expect(evidence!.width).toBeGreaterThan(0);
      expect(evidence!.height).toBeGreaterThan(0);
      expect(settled).toBe(false);
    } finally {
      await handle.close();
    }
    await assertGone(directory);
    expect(alive(independent.pid!)).toBe(true);
    const windowStatus = (): { exists: boolean; visible: boolean; ownConsole: number } => {
      const checked = spawnSync(fakePath, ['window-status', String(evidence!.console)], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
      return JSON.parse(checked.stdout) as { exists: boolean; visible: boolean; ownConsole: number };
    };
    await until(() => !windowStatus().exists);
    expect(windowStatus()).toEqual({ exists: false, visible: false, ownConsole: 0 });
    independent.kill(); await closed(independent);
  }, 12000);
});
