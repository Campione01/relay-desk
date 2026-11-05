import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeRuntime, NATIVE_UI_STARTUP_TIMEOUT_MS } from '../../src/main/native/transport';
import type { NativeExitCause } from '../../src/main/native/contract';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));

const launch = { exe: 'C:\\fixture\\cli.exe', cwd: 'C:\\fixture', args: [], env: {}, handleId: 'fixture' };
const hello = { type: 'hello', protocol: 1, sessionId: 'fixture', isInteractive: true, surface: 'terminal', capabilities: [] };

function fixture(startupTimeoutMs?: number, holdClose = false, holdSend = false) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: undefined as unknown as Writable, exitCode: null as number | null, killed: false, kill: vi.fn() });
  const commands: Record<string, unknown>[] = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const command = JSON.parse(String(chunk)); commands.push(command);
    queueMicrotask(() => {
      if (command.op !== 'send' || !holdSend) child.stdout.write(JSON.stringify({ kind: 'ack', id: command.id, ok: true }) + '\n');
      if (command.op === 'close' && !holdClose) { child.exitCode = 0; child.emit('close', 0); }
    });
    done();
  } });
  mocked.spawn.mockReturnValue(child);
  const runtime = createNativeRuntime({ helperPath: 'C:\\fixture\\host.exe', startupTimeoutMs });
  const host = (frame: unknown) => child.stdout.write(JSON.stringify(frame) + '\n');
  child.kill.mockImplementation(() => { child.killed = true; });
  return { runtime, commands, host,
    hostBatch(frames: unknown[]) { child.stdout.write(frames.map((frame) => JSON.stringify(frame) + '\n').join('')); },
    exit() { child.exitCode = 0; child.emit('close', 0); } };
}

beforeEach(() => { vi.useFakeTimers(); mocked.spawn.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('completion-owned native command requests', () => {
  it('retains the exact command reply after 106 seconds without removing ordinary read deadlines', async () => {
    const f = fixture(); const started = f.runtime.start(launch);
    f.host({ kind: 'bridge', frame: hello }); await started;
    const completed = vi.fn(), failed = vi.fn();
    const command = f.runtime.request('command.run', { command: 'compact', args: '' }, { timeoutMs: null });
    void command.then(completed, failed);
    const frame = f.commands.find((entry) => entry.op === 'send')!.frame as { id: string };
    const read = expect(f.runtime.request('session.usage', {})).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(30_000); await read;
    await vi.advanceTimersByTimeAsync(76_000);
    expect(completed).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    expect(f.commands.some((entry) => entry.op === 'cancel' && entry.requestId === frame.id)).toBe(false);
    f.host({ kind: 'bridge', frame: { type: 'response', id: frame.id, ok: true, value: {} } });
    await expect(command).resolves.toEqual({});
    expect(f.commands.filter((entry) => entry.op === 'send' && (entry.frame as { method: string }).method === 'command.run')).toHaveLength(1);
    await f.runtime.close();
  });

  it.each(['abort', 'close', 'disconnect', 'exit'] as const)('still rejects a completion-owned request on %s without replaying it', async (ending) => {
    const f = fixture(); const started = f.runtime.start(launch);
    f.host({ kind: 'bridge', frame: hello }); await started;
    const controller = new AbortController();
    const command = f.runtime.request('command.run', { command: 'compact', args: '' }, { timeoutMs: null, signal: controller.signal });
    const rejected = expect(command).rejects.toThrow(ending === 'abort' ? 'aborted' : ending === 'close' ? 'runtime closed' : ending === 'disconnect' ? 'Mod receiver disconnected' : 'owned child exited');
    const frame = f.commands.find((entry) => entry.op === 'send')!.frame as { id: string };
    if (ending === 'abort') controller.abort();
    else if (ending === 'close') await f.runtime.close();
    else f.host(ending === 'disconnect' ? { kind: 'disconnected' } : { kind: 'exit', code: 0 });
    await rejected;
    f.host({ kind: 'bridge', frame: { type: 'response', id: frame.id, ok: true, value: {} } });
    expect(f.commands.filter((entry) => entry.op === 'send')).toHaveLength(1);
    expect(f.commands.some((entry) => entry.op === 'writeTerminal')).toBe(false);
    await f.runtime.close();
  });

  it('still bounds an unconfirmed helper send acknowledgement to ten seconds', async () => {
    const f = fixture(undefined, false, true); const started = f.runtime.start(launch);
    f.host({ kind: 'bridge', frame: hello }); await started;
    const rejected = expect(f.runtime.request('command.run', { command: 'compact' }, { timeoutMs: null })).rejects.toThrow('unconfirmed native operation');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.commands.some((entry) => entry.op === 'close')).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(f.commands.filter((entry) => entry.op === 'close')).toHaveLength(1);
    await f.runtime.close();
  });
});

describe('native event sequence ordering', () => {
  async function ordered() {
    const f = fixture(); const sequences: number[] = []; const exited = vi.fn();
    f.runtime.onEvent((event) => sequences.push(event.sequence)); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    const deliver = async (...values: number[]) => {
      f.hostBatch(values.map((sequence) => ({ kind: 'bridge', frame: { type: 'event', sessionId: 'fixture', sequence, event: 'fixture', data: sequence } })));
      await vi.advanceTimersByTimeAsync(0);
    };
    return { f, sequences, exited, deliver };
  }
  const outOfOrder = { kind: 'transport', message: 'Native transport: native events arrived out of order' };

  it('keeps exact duplicate sequences silent', async () => {
    const { f, sequences, exited, deliver } = await ordered();
    await deliver(1, 2, 2, 1, 3, 3);
    expect(sequences).toEqual([1, 2, 3]);
    expect(f.commands.some((command) => command.op === 'close')).toBe(false);
    await f.runtime.close();
    expect(exited.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('fails closed when a skipped sequence arrives after a later one', async () => {
    const { f, sequences, exited, deliver } = await ordered();
    const pendingRequest = expect(f.runtime.request('pending')).rejects.toThrow('native events arrived out of order');
    await deliver(1, 3, 3); expect(f.commands.some((command) => command.op === 'close')).toBe(false);
    await deliver(2); await pendingRequest;
    expect(sequences).toEqual([1, 3]);
    expect(f.commands.filter((command) => command.op === 'close')).toHaveLength(1);
    expect(exited).toHaveBeenCalledExactlyOnceWith(null, outOfOrder);
  });

  it('bounds skipped-sequence tracking to the most recent gaps', async () => {
    const { f, exited, deliver } = await ordered();
    await deliver(...Array.from({ length: 70 }, (_, index) => 2 * index + 1));
    // 70 gaps: 0, 2, ..., 138. Only the newest 64 (12 to 138) remain tracked.
    await deliver(0, 2, 10);
    expect(f.commands.some((command) => command.op === 'close')).toBe(false);
    await deliver(12);
    expect(exited).toHaveBeenCalledExactlyOnceWith(null, outOfOrder);
  });
});

describe('bounded native startup transport', () => {
  it('preserves an idle transport failure when cleanup reports child exit zero', async () => {
    const f = fixture(); const exits: Array<{ code: number | null; cause?: NativeExitCause }> = [];
    f.runtime.onExit((code, cause) => exits.push({ code, cause }));
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    f.hostBatch([{ kind: 'disconnected' }, { kind: 'exit', code: 0 }]);
    await f.runtime.close();
    expect(exits).toEqual([{ code: 0, cause: { kind: 'transport', message: 'Native transport: Mod receiver disconnected' } }]);
    expect(f.commands.filter((command) => command.op === 'close')).toHaveLength(1);
  });

  it('keeps the cause when a pending request rejects in the same host chunk as exit zero', async () => {
    const f = fixture(); const exited = vi.fn(); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    const rejected = expect(f.runtime.request('pending')).rejects.toThrow('Mod receiver disconnected');
    f.hostBatch([{ kind: 'disconnected' }, { kind: 'exit', code: 0 }]);
    await rejected; await f.runtime.close();
    expect(exited).toHaveBeenCalledExactlyOnceWith(0, { kind: 'transport', message: 'Native transport: Mod receiver disconnected' });
  });

  it('retains the first failure instead of replacing it with cleanup errors or late noise', async () => {
    const f = fixture(); const exited = vi.fn(); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    f.hostBatch([{ kind: 'error' }, { kind: 'disconnected' }, { kind: 'unsupported-cleanup-frame' }, { kind: 'exit', code: 0 }]);
    await f.runtime.close(); f.host({ kind: 'disconnected' });
    expect(exited).toHaveBeenCalledExactlyOnceWith(0, { kind: 'transport', message: 'Native transport: native terminal read failed' });
  });

  it('retains the original cause across an unconfirmed cleanup and a later owned-child exit', async () => {
    const f = fixture(undefined, true); const exited = vi.fn(); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    f.host({ kind: 'disconnected' });
    const failed = expect(f.runtime.close()).rejects.toThrow('owned helper exit was not confirmed');
    await vi.advanceTimersByTimeAsync(6000); await failed;
    f.hostBatch([{ kind: 'error' }, { kind: 'exit', code: 0 }]); f.exit();
    await f.runtime.close();
    expect(exited).toHaveBeenCalledExactlyOnceWith(0, { kind: 'transport', message: 'Native transport: Mod receiver disconnected' });
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not invent a transport failure from noise during an explicit close', async () => {
    const f = fixture(); const exited = vi.fn(); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    const closed = f.runtime.close();
    f.hostBatch([{ kind: 'disconnected' }, { kind: 'error' }, { kind: 'exit', code: 0 }]);
    await closed;
    expect(exited).toHaveBeenCalledOnce();
    expect(exited.mock.calls[0]?.[0]).toBe(0); expect(exited.mock.calls[0]?.[1]).toBeUndefined();
    expect(f.commands.filter((command) => command.op === 'close')).toHaveLength(1);
  });

  it('leaves the cause unknown for a bare child exit and ignores later cleanup noise', async () => {
    const f = fixture(); const exited = vi.fn(); f.runtime.onExit(exited);
    const started = f.runtime.start(launch); f.host({ kind: 'bridge', frame: hello }); await started;
    f.hostBatch([{ kind: 'exit', code: 0 }, { kind: 'disconnected' }, { kind: 'error' }]);
    await f.runtime.close();
    expect(exited).toHaveBeenCalledOnce();
    expect(exited.mock.calls[0]?.[0]).toBe(0); expect(exited.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('keeps the legacy 20 second deadline despite continuing terminal output', async () => {
    const f = fixture(); const started = f.runtime.start(launch);
    const rejected = expect(started).rejects.toThrow('interactive hello timed out');
    for (let index = 0; index < 4; index++) { f.host({ kind: 'terminal', data: 'still waiting' }); await vi.advanceTimersByTimeAsync(5000); }
    await rejected; expect(f.commands.some(command => command.op === 'close')).toBe(true);
  });

  it('provides one fixed five-minute UI deadline, not a sliding deadline', async () => {
    expect(NATIVE_UI_STARTUP_TIMEOUT_MS).toBe(300000);
    const f = fixture(NATIVE_UI_STARTUP_TIMEOUT_MS); const started = f.runtime.start(launch);
    const rejected = expect(started).rejects.toThrow('interactive hello timed out');
    await vi.advanceTimersByTimeAsync(299999);
    expect(f.commands.some(command => command.op === 'close')).toBe(false);
    f.host({ kind: 'terminal', data: 'new output cannot reset the deadline' });
    await vi.advanceTimersByTimeAsync(1); await rejected;
  });

  it('uses a dedicated menu-only operation and rejects it before start, after hello or during close', async () => {
    const f = fixture();
    await expect(f.runtime.writeStartup!('\r')).rejects.toThrow('no longer');
    const started = f.runtime.start(launch);
    await f.runtime.writeStartup!('\x1b[B');
    expect(f.commands.some(command => command.op === 'writeStartup' && command.data === '\x1b[B')).toBe(true);
    await expect(f.runtime.writeStartup!('arbitrary prompt')).rejects.toThrow('invalid startup menu key');
    f.host({ kind: 'bridge', frame: hello }); await started;
    await expect(f.runtime.writeStartup!('\r')).rejects.toThrow('no longer');
    const closed = f.runtime.close();
    await expect(f.runtime.writeStartup!('\r')).rejects.toThrow('no longer');
    await closed;
    expect(f.commands.filter(command => command.op === 'writeStartup')).toHaveLength(1);
  });

  it('fails promptly on a strict Mod initialization failure without forwarding raw details', async () => {
    const f = fixture(); const started = f.runtime.start(launch);
    const rejected = expect(started).rejects.toThrow('native Mod initialization failed');
    f.host({ kind: 'bridge', frame: { type: 'startupError', protocol: 1, code: 'MOD_INIT_FAILED' } });
    await rejected;
    expect(f.commands.some(command => command.op === 'close')).toBe(true);
  });

  it('retries cleanup of the same owned child after an initially unconfirmed exit', async () => {
    const f = fixture(undefined, true); const started = f.runtime.start(launch);
    f.host({ kind: 'bridge', frame: hello }); await started;
    const failed = expect(f.runtime.close()).rejects.toThrow('owned helper exit was not confirmed');
    await vi.advanceTimersByTimeAsync(6000); await failed;
    await expect(f.runtime.start(launch)).rejects.toThrow('single use');
    await expect(f.runtime.writeStartup!('\r')).rejects.toThrow('no longer');
    f.exit();
    await expect(f.runtime.close()).resolves.toBeUndefined();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(f.commands.filter(command => command.op === 'close')).toHaveLength(1);
  });

  it.each([
    { type: 'startupError', protocol: 1, code: 'MOD_INIT_FAILED', message: 'Bearer must-not-leak' },
    { type: 'startupError', protocol: 2, code: 'MOD_INIT_FAILED' },
    { type: 'startupError', protocol: 1, code: 'other' },
  ])('rejects malformed startup errors with a fixed diagnostic', async (frame) => {
    const f = fixture(); const started = f.runtime.start(launch);
    const rejected = expect(started).rejects.toThrow('invalid startup error');
    f.host({ kind: 'bridge', frame }); await rejected;
  });
});
