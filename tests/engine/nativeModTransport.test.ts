import type { EngineInterface } from 'claude-code';
import { describe, expect, it, vi } from 'vitest';
import { createProcessTransport, isBridgeRequest, MAX_BATCH_BYTES, MAX_BATCH_FRAMES, SEND_FAILURE_MESSAGE, sendTimeoutMs } from '../../native-mod/hooks/transport';
import { MAX_FRAME_BYTES, type BridgeEvent, type BridgeOutput, type BridgeRequest } from '../../native-mod/hooks/protocol';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const BACKOFF_MS = [250, 1_000, 3_000];
const ran = (code: number) => ({ exitCode: code, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false });

function mockHost(chunks: string[] = []) {
  const env = { RELAY_NATIVE_PIPE: 'relay-native-' + 'a'.repeat(64), RELAY_NATIVE_NONCE: 'n'.repeat(32), RELAY_NATIVE_HELPER: 'C:\\fixture\\helper.exe' };
  let poll: (() => void) | undefined;
  let cancel!: () => void;
  const ended = new Promise<void>((resolve) => { cancel = resolve; });
  const stream = (async function* () {
    for (const text of chunks) yield { stream: 'stdout' as const, text };
    await ended;
    return { code: 0, signal: null };
  })();
  const returnReceiver = vi.spyOn(stream, 'return');
  const cancelTimer = vi.fn(cancel);
  Object.assign(stream, { result: Promise.resolve({ code: 0, signal: null }) });
  const timers: Array<{ ms: number; callback: () => void; canceled: boolean }> = [];
  const host = {
    env: { get: vi.fn(async (key: keyof typeof env) => env[key]),
      set: vi.fn(async (key: keyof typeof env, value: string) => { env[key] = value; return {}; }) },
    process: {
      run: vi.fn(async (_argv: readonly string[], _options?: { stdin?: string; timeoutMs?: number }) => ran(0)),
      spawn: vi.fn(() => stream),
    },
    clock: {
      every: vi.fn((_ms, callback) => { poll = callback; return { cancel: cancelTimer }; }),
      after: vi.fn((ms: number, callback: () => void) => { const timer = { ms, callback, canceled: false }; timers.push(timer); return { cancel: () => { timer.canceled = true; } }; }),
    },
  };
  const fire = async () => { const timer = timers.shift()!; if (!timer.canceled) timer.callback(); await settle(); };
  const stdins = () => host.process.run.mock.calls.map(([, options]) => options!.stdin!);
  return { host, env, $: host as unknown as EngineInterface, tick: () => poll?.(), cancel, cancelTimer, returnReceiver, timers, fire, stdins };
}

function event(sequence: number, data: unknown): BridgeEvent {
  return { type: 'event', event: 'turn.step', sessionId: 's', sequence, data };
}

describe('native mod helper transport', () => {
  it('batches many deltas into one bounded send invocation and keeps credentials out of argv', async () => {
    const f = mockHost();
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, () => undefined);
    for (let i = 0; i < 100; i++) transport.send(event(i, { text: 'token' }));
    await transport.flush();
    expect(f.host.process.run).toHaveBeenCalledTimes(1);
    const [argv, options] = f.host.process.run.mock.calls[0] as unknown as [string[], { stdin: string; env: unknown }];
    expect(argv).toEqual(['C:\\fixture\\helper.exe', 'send']);
    expect(options.stdin.trim().split('\n')).toHaveLength(100);
    expect(new TextEncoder().encode(options.stdin).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(f.host.env.set.mock.calls).toEqual([
      ['RELAY_NATIVE_PIPE', ''], ['RELAY_NATIVE_NONCE', ''], ['RELAY_NATIVE_HELPER', ''],
    ]);
    expect(Object.values(f.env)).toEqual(['', '', '']);
    expect(options.env).toMatchObject({ RELAY_NATIVE_NONCE: 'n'.repeat(32), RELAY_NATIVE_PIPE: 'relay-native-' + 'a'.repeat(64) });
    transport.close();
  });

  it('parses requests spanning helper chunks without losing order', async () => {
    const first = JSON.stringify({ type: 'request', id: 'one', method: 'session.model' });
    const second = JSON.stringify({ type: 'request', id: 'two', method: 'config.list' });
    const f = mockHost([first.slice(0, 12), first.slice(12) + '\n' + second + '\n']);
    const transport = await createProcessTransport(f.$);
    const requests: BridgeRequest[] = [];
    transport.start((request) => requests.push(request), () => undefined);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(requests.map((row) => row.id)).toEqual(['one', 'two']);
    transport.close();
  });

  it('splits a burst at the native helper frame limit without disconnecting, dropping or reordering frames', async () => {
    const f = mockHost(); const failed = vi.fn();
    const batches: number[][] = [];
    f.host.process.run.mockImplementation(async (_argv, options) => {
      const frames = options!.stdin!.trim().split('\n').map((line) => JSON.parse(line) as BridgeEvent);
      batches.push(frames.map((frame) => frame.sequence));
      return { exitCode: frames.length > MAX_BATCH_FRAMES ? 4 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false };
    });
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, failed);
    const total = MAX_BATCH_FRAMES * 2 + 7;
    for (let index = 0; index < total; index++) transport.send(event(index, { synthetic: true }));
    await transport.flush(); await transport.flush(); await transport.flush();
    expect(batches.map((batch) => batch.length)).toEqual([128, 128, 7]);
    expect(batches.flat()).toEqual(Array.from({ length: total }, (_, index) => index));
    expect(failed).not.toHaveBeenCalled();
    transport.send(event(total, {})); await transport.flush();
    expect(batches.at(-1)).toEqual([total]);
    transport.close();
  });

  it('fails closed on malformed input', async () => {
    const invalid = mockHost(['not json\n']);
    const transport = await createProcessTransport(invalid.$);
    const failed = vi.fn();
    transport.start(vi.fn(), failed);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => transport.send(event(1, {}))).toThrow('closed');
  });

  it('validates request shape and refuses outbound frame overflow', async () => {
    expect(isBridgeRequest({ type: 'request', id: '', method: 'x' })).toBe(false);
    expect(isBridgeRequest({ type: 'request', id: 'x', method: 'session.model' })).toBe(true);
    const f = mockHost();
    const transport = await createProcessTransport(f.$);
    const failed = vi.fn();
    transport.start(() => undefined, failed);
    const megabyte = 'x'.repeat(1024 * 1024);
    expect(() => { for (let index = 0; index < 40; index++) transport.send(event(index, megabyte)); }).toThrow('capacity');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(f.host.process.run).not.toHaveBeenCalled();
  });
});

describe('native mod send-helper resilience', () => {
  it('retries a failed or timed-out batch at the head of the queue with 250 ms and 1 s backoff, keeping order', async () => {
    const f = mockHost(); const failed = vi.fn();
    f.host.process.run.mockResolvedValueOnce(ran(1)).mockRejectedValueOnce(new Error('timed out'));
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, failed);
    for (let index = 1; index <= 3; index++) transport.send(event(index, {}));
    const flushing = transport.flush(); await settle();
    expect(f.host.process.run).toHaveBeenCalledTimes(1);
    expect(f.timers.map((timer) => timer.ms)).toEqual([BACKOFF_MS[0]]);
    transport.send(event(4, {}));
    await f.fire();
    expect(f.host.process.run).toHaveBeenCalledTimes(2);
    expect(f.timers.map((timer) => timer.ms)).toEqual([BACKOFF_MS[1]]);
    await f.fire(); await flushing;
    expect(f.stdins()).toHaveLength(3);
    expect(new Set(f.stdins()).size).toBe(1);
    expect(f.stdins()[0].trim().split('\n').map((line) => (JSON.parse(line) as BridgeEvent).sequence)).toEqual([1, 2, 3]);
    await transport.flush();
    expect(f.stdins().at(-1)!.trim().split('\n').map((line) => (JSON.parse(line) as BridgeEvent).sequence)).toEqual([4]);
    expect(failed).not.toHaveBeenCalled();
    transport.close();
  });

  it('scales the helper timeout with the batch size', async () => {
    expect([0, 1024 * 1024, MAX_FRAME_BYTES].map(sendTimeoutMs)).toEqual([5_000, 7_000, 69_000]);
    const f = mockHost();
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, () => undefined);
    transport.send(event(1, 'x'.repeat(1024 * 1024))); await transport.flush();
    transport.send(event(2, 'small')); await transport.flush();
    const [large, small] = f.host.process.run.mock.calls.map(([, options]) => options!);
    expect(large.timeoutMs).toBe(sendTimeoutMs(new TextEncoder().encode(large.stdin!).length));
    expect(large.timeoutMs).toBeGreaterThanOrEqual(7_000);
    expect(small.timeoutMs).toBe(5_000);
    transport.close();
  });

  it('fails only after three backed-off retries, first reporting a fatal error event through a fresh helper run', async () => {
    const f = mockHost(); const failed = vi.fn();
    f.host.process.run.mockResolvedValue(ran(1));
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, failed);
    transport.send(event(7, {}));
    const flushing = transport.flush(); await settle();
    for (const delay of BACKOFF_MS) {
      expect(failed).not.toHaveBeenCalled();
      expect(f.timers.map((timer) => timer.ms)).toEqual([delay]);
      await f.fire();
    }
    await flushing;
    expect(f.timers).toEqual([]);
    expect(f.stdins()).toHaveLength(1 + BACKOFF_MS.length + 1);
    expect(new Set(f.stdins().slice(0, -1)).size).toBe(1);
    expect(JSON.parse(f.stdins().at(-1)!)).toEqual({ type: 'event', event: 'error', sessionId: 's', sequence: 8, data: { message: SEND_FAILURE_MESSAGE, fatal: true } });
    expect(failed).toHaveBeenCalledExactlyOnceWith('Named-pipe send helper failed repeatedly');
    expect(f.cancelTimer).toHaveBeenCalledTimes(1);
    expect(f.returnReceiver).toHaveBeenCalledWith({ code: null, signal: 'bridge-closed' });
    expect(() => transport.send(event(9, {}))).toThrow('closed');
    await transport.flush(); f.tick();
    expect(f.stdins()).toHaveLength(1 + BACKOFF_MS.length + 1);
  });

  it.each([
    { type: 'hello', protocol: 1, sessionId: 's', isInteractive: true, surface: 'terminal', capabilities: [] },
    { type: 'startupError', protocol: 1, code: 'MOD_INIT_FAILED' },
  ] satisfies BridgeOutput[])('never resends a batch holding a $type frame', async (frame) => {
    const f = mockHost(); const failed = vi.fn();
    f.host.process.run.mockResolvedValue(ran(1));
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, failed);
    transport.send(frame); transport.send(event(1, {}));
    await transport.flush();
    expect(f.host.process.run).toHaveBeenCalledTimes(1);
    expect(f.host.clock.after).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith('Named-pipe send helper failed');
  });

  it('stops retrying without failing when the bridge closes during a backoff', async () => {
    const f = mockHost(); const failed = vi.fn();
    f.host.process.run.mockResolvedValue(ran(1));
    const transport = await createProcessTransport(f.$);
    transport.start(() => undefined, failed);
    transport.send(event(1, {}));
    const flushing = transport.flush(); await settle();
    transport.close(); await flushing;
    expect(f.timers[0].canceled).toBe(true);
    expect(f.host.process.run).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });
});
