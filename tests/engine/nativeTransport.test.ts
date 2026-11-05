import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeRuntime } from '../../src/main/native/transport';
import type { NativeEvent, NativeExitCause, NativeRuntime } from '../../src/main/native/contract';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(root, 'tools/native/bin/RelayNativeHost.exe');
const fixture = resolve(root, 'tools/native/bin/NativeConsoleFixture.exe');
const available = process.platform === 'win32' && existsSync(helper) && existsSync(fixture);
const runtimes: NativeRuntime[] = [];
function make(): NativeRuntime {
  const runtime = createNativeRuntime({ helperPath: helper, startupTimeoutMs: 8000 });
  runtimes.push(runtime); return runtime;
}
function launch(runtime: NativeRuntime, args: string[] = []) {
  return runtime.start({ exe: fixture, args, cwd: root, handleId: 'synthetic-only', cols: 100, rows: 32,
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', NODE_EXTRA_CA_CERTS: 'C:\\synthetic\\ca.pem', FIXTURE_UNICODE: 'fixture-\u4e2d\u6587', CLAUDE_CODE_ENTRYPOINT: undefined } });
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); });

// The owned child is plain Node, so the helper's sender clients have the real direct-parent relationship.
const senders = `const { spawn, spawnSync } = require('node:child_process');
const helper = process.env.RELAY_NATIVE_HELPER;
const event = (sequence, data) => JSON.stringify({ type: 'event', sessionId: 'order', sequence, event: 'fixture', data }) + '\\n';
const send = (input) => spawnSync(helper, ['send'], { input, windowsHide: true }).status;
const report = (value) => send(JSON.stringify({ type: 'response', id: 'result', ok: true, value }) + '\\n');
setTimeout(() => {}, 60000);
`;
function senderHost(script: string) {
  const child = spawn(helper, ['host'], { windowsHide: true, shell: false, stdio: 'pipe' });
  child.stderr.resume();
  const sequences: number[] = []; let result: unknown; let partial: Buffer[] = [];
  child.stdout.on('data', (bytes: Buffer) => {
    let start = 0, newline: number;
    while ((newline = bytes.indexOf(10, start)) >= 0) {
      partial.push(bytes.subarray(start, newline)); start = newline + 1;
      const message = JSON.parse(Buffer.concat(partial).toString('utf8')); partial = [];
      if (message.kind === 'bridge' && message.frame.type === 'event') sequences.push(message.frame.sequence);
      if (message.kind === 'bridge' && message.frame.type === 'response') result = message.frame.value;
    }
    if (start < bytes.length) partial.push(bytes.subarray(start));
  });
  const exited = new Promise<void>(resolveExit => child.once('close', () => resolveExit()));
  child.stdin.write(JSON.stringify({ op: 'start', id: 'start', launch: { exe: process.execPath, args: ['-e', senders + script], cwd: root,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, handleId: 'synthetic-senders', cols: 200, rows: 32 } }) + '\n');
  return { sequences, result: () => result,
    async close() { child.stdin.end(JSON.stringify({ op: 'close', id: 'close' }) + '\n'); await exited; } };
}

describe.skipIf(process.platform !== 'win32' || !existsSync(helper))('native helper sender batches, synthetic Node child only', () => {
  it('emits a large batch before a later small batch even though its client exits first', async () => {
    const host = senderHost(`report([send(event(1, 'x'.repeat(16 * 1024 * 1024))), send(event(2, 'small'))]);`);
    try {
      await expect.poll(host.result, { timeout: 20_000 }).toEqual([0, 0]);
      expect(host.sequences).toEqual([1, 2]);
    } finally { await host.close(); }
  }, 30_000);

  it('rejects a waiting batch after a bounded wait while an earlier batch stays open', async () => {
    const host = senderHost(`const stuck = spawn(helper, ['send'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
setTimeout(() => {
  const started = Date.now(); const rejected = send(event(2, 'rejected')); const waited = Date.now() - started;
  stuck.once('exit', (code) => report([rejected, waited, code, send(event(3, 'after'))]));
  stuck.stdin.end(event(1, 'held'));
}, 1000);`);
    try {
      await expect.poll(host.result, { timeout: 20_000 }).toBeDefined();
      const [rejected, waited, held, after] = host.result() as number[];
      expect({ rejected, held, after }).toEqual({ rejected: 3, held: 0, after: 0 });
      expect(waited).toBeGreaterThanOrEqual(3500); expect(waited).toBeLessThan(5000);
      expect(host.sequences).toEqual([1, 3]);
    } finally { await host.close(); }
  }, 30_000);
});

describe.skipIf(!available)('native Windows ConPTY transport, synthetic fixture only', () => {
  it('detects idle receiver death without another request and cleans only its owned job', async () => {
    const runtime = make(); const exits: Array<{ code: number | null; cause?: NativeExitCause }> = [];
    runtime.onExit((code, cause) => exits.push({ code, cause })); await launch(runtime);
    const inspect = await runtime.request('inspect') as { pid: number; receiverPid: number };
    const descendant = await runtime.request('descendant') as number;
    const survivor = make(); const survivorExits: Array<number | null> = [];
    survivor.onExit((code) => survivorExits.push(code)); await launch(survivor);
    await new Promise((resolveIdle) => setTimeout(resolveIdle, 500));
    expect(exits).toEqual([]);
    expect(await runtime.request('echo', 'healthy idle receiver')).toBe('healthy idle receiver');
    const killedAt = performance.now();
    process.kill(inspect.receiverPid);
    const expectedExit = { code: 0, cause: { kind: 'transport', message: 'Native transport: Mod receiver disconnected' } };
    await expect.poll(() => exits, { timeout: 2000 }).toEqual([expectedExit]);
    const detectedAfterMs = Math.round(performance.now() - killedAt);
    // No request or explicit close may be needed to observe loss and clean the owned job.
    await expect.poll(() => [inspect.pid, inspect.receiverPid, descendant].map(alive), { timeout: 5000 }).toEqual([false, false, false]);
    expect(await survivor.request('echo', 'other owned runtime survives')).toBe('other owned runtime survives');
    expect(survivorExits).toEqual([]);
    await expect(runtime.request('echo')).rejects.toThrow('not ready');
    await runtime.close();
    expect(exits).toEqual([expectedExit]);
    console.info(JSON.stringify({ syntheticIdleReceiverLossDetectedWithoutNewRequest: true, detectedAfterMs, exit: exits[0] }));
  }, 15_000);

  it('has genuine console handles, invisible window, exact args/environment and structured requests', async () => {
    const runtime = make();
    const args = ['space value', 'quote"value', 'trailing\\', '', '\u4e2d\u6587'];
    expect(await launch(runtime, args)).toMatchObject({ protocol: 1, isInteractive: true, surface: 'terminal' });
    const result = await runtime.request('inspect') as Record<string, unknown>;
    expect(result).toMatchObject({ inputTty: true, outputTty: true, visibleWindow: false,
      arguments: args, proxy: 'http://127.0.0.1:9', certificate: 'C:\\synthetic\\ca.pem', unicode: 'fixture-\u4e2d\u6587', entrypoint: null });
    expect(result.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(await runtime.request('echo', { nested: ['a', 1, false] })).toEqual({ nested: ['a', 1, false] });
    await runtime.resize(91, 27);
    expect(await runtime.request('inspect')).toMatchObject({ cols: 91, rows: 27 });
  }, 20_000);

  it('carries terminal I/O and filters stale sessions/sequences/reply IDs', async () => {
    const runtime = make(); let terminal = ''; const events: NativeEvent[] = [];
    runtime.onTerminal((data) => { terminal += data; }); runtime.onEvent((event) => events.push(event));
    await launch(runtime);
    await runtime.writeTerminal('synthetic terminal input\r');
    await expect.poll(() => terminal, { timeout: 5000 }).toContain('TERMINAL-ECHO:synthetic terminal input');
    await runtime.request('events');
    expect(events.map((event) => event.data)).toEqual(['first', 'second']);
    expect(await runtime.request('echo', 'correct')).toBe('correct');
  }, 20_000);

  it('bounds waiting, ignores late responses and cancels requests without recycling IDs', async () => {
    const runtime = make(); await launch(runtime);
    await expect(runtime.request('hang', null, { timeoutMs: 30 })).rejects.toThrow('timed out');
    const controller = new AbortController();
    const waiting = runtime.request('hang', null, { signal: controller.signal }); controller.abort();
    await expect(waiting).rejects.toThrow('aborted');
    await expect(runtime.request('late', null, { timeoutMs: 30 })).rejects.toThrow('timed out');
    expect(await runtime.request('echo', 'after late')).toBe('after late');
    await expect(runtime.request('echo', 'x'.repeat(32 * 1024 * 1024))).rejects.toThrow('32 MiB');
  }, 20_000);

  it('rejects noninteractive hello and headless flags', async () => {
    await expect(launch(make(), ['--bad-hello'])).rejects.toThrow('interactive hello');
    await expect(launch(make(), ['--print'])).rejects.toThrow('headless');
  }, 20_000);

  it('permits explicit terminal answers before hello without admitting structured requests', async () => {
    const runtime = make(); let answer: Promise<void> | undefined;
    runtime.onTerminal((text) => {
      if (text.includes('FIXTURE-EXPLICIT-TRUST') && !answer) answer = runtime.writeTerminal('ALLOW-FIXTURE\r');
    });
    const started = launch(runtime, ['--deferred-hello']);
    await expect(runtime.request('echo')).rejects.toThrow('not ready');
    expect(await started).toMatchObject({ isInteractive: true, surface: 'terminal' });
    await answer;
    expect(await runtime.request('echo', 'explicitly ready')).toBe('explicitly ready');
  }, 20_000);

  it('reports actual child exit and closes idempotently', async () => {
    const runtime = make(); const exits: Array<number | null> = [];
    runtime.onExit((code) => exits.push(code)); await launch(runtime);
    await runtime.request('exit');
    await expect.poll(() => exits, { timeout: 5000 }).toEqual([7]);
    await runtime.close(); await runtime.close();
    await expect(runtime.request('echo')).rejects.toThrow('not ready');
  }, 20_000);

  it('rejects startup-only input after hello in both the runtime and native host', async () => {
    const runtime = make(); await launch(runtime);
    await expect(runtime.writeStartup!('\r')).rejects.toThrow('no longer available');
    const child = spawn(helper, ['host'], { windowsHide: true, shell: false, stdio: 'pipe' });
    child.stderr.resume();
    let buffer = ''; const frames: Array<Record<string, any>> = [];
    child.stdout.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
    });
    const exited = new Promise<void>(resolveExit => child.once('close', () => resolveExit()));
    try {
      child.stdin.write(JSON.stringify({ op: 'start', id: 'start', launch: { exe: fixture, args: [], cwd: root,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, handleId: 'synthetic-host-gate', cols: 100, rows: 32 } }) + '\n');
      await expect.poll(() => frames.some(frame => frame.kind === 'bridge' && frame.frame.type === 'hello'), { timeout: 5000 }).toBe(true);
      child.stdin.write(JSON.stringify({ op: 'writeStartup', id: 'stale', data: '\r' }) + '\n');
      await expect.poll(() => frames.find(frame => frame.kind === 'ack' && frame.id === 'stale'), { timeout: 5000 }).toMatchObject({ ok: false });
    } finally {
      child.stdin.end(JSON.stringify({ op: 'close', id: 'close' }) + '\n');
      await exited;
    }
  }, 20_000);

  it('round-trips a 10 MiB payload without truncation', async () => {
    const runtime = make(); await launch(runtime);
    const text = 'native-large-frame:'.padEnd(10 * 1024 * 1024, 'x');
    expect(await runtime.request('echo', text, { timeoutMs: 60_000 })).toBe(text);
  }, 70_000);

  it('protects the pipe and rejects bad nonce and non-helper client image', async () => {
    const runtime = make(); await launch(runtime);
    expect(await runtime.request('security', null, { timeoutMs: 15_000 })).toEqual({
      protectedAcl: true, correctAllow: true, rejectsNetwork: true, rejectsWrongImage: true, rejectsBadNonce: true,
    });
    const capability = await runtime.request('inspect') as { pipe: string; nonce: string };
    const rejected = spawn(helper, ['send'], { windowsHide: true, shell: false, stdio: 'pipe',
      env: { ...process.env, RELAY_NATIVE_PIPE: capability.pipe, RELAY_NATIVE_NONCE: capability.nonce } });
    rejected.stdin.on('error', () => undefined);
    rejected.stdout.resume(); rejected.stderr.resume();
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => { rejected.kill(); reject(new Error('wrong-parent helper did not exit')); }, 5000);
      rejected.once('error', reject);
      rejected.once('close', (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
      rejected.stdin.end('{}\n');
    });
    expect(code).not.toBe(0);
    expect(await runtime.request('echo', 'still authenticated')).toBe('still authenticated');
  }, 20_000);

  it('uses GUI-subsystem helpers and cleans only its owned child job including descendants', async () => {
    const binary = readFileSync(helper);
    const pe = binary.readUInt32LE(0x3c);
    expect(binary.readUInt16LE(pe + 24 + 68)).toBe(2);
    const runtime = make(); const exits: Array<{ code: number | null; cause?: NativeExitCause }> = [];
    runtime.onExit((code, cause) => exits.push({ code, cause })); await launch(runtime);
    const inspect = await runtime.request('inspect') as { pid: number; receiverPid: number };
    const descendant = await runtime.request('descendant') as number;
    await runtime.close();
    expect(exits).toHaveLength(1); expect(exits[0]?.cause).toBeUndefined();
    for (const pid of [inspect.pid, inspect.receiverPid, descendant]) await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
  }, 20_000);
});
