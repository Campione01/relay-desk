import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NativeEvent, NativeExitCause, NativeLaunch, NativeReady, NativeRequestOptions, NativeRuntime } from './contract';

const MAX_FRAME = 32 * 1024 * 1024;
const MAX_QUEUE = 64 * 1024 * 1024;
const MAX_PENDING = 128;
const MAX_SEQUENCE_GAPS = 64;
export const NATIVE_UI_STARTUP_TIMEOUT_MS = 5 * 60_000;
const STARTUP_KEYS = new Set(['\r', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\t', '\x1b']);
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function failure(message: string): Error { return new Error(`Native transport: ${message}`); }

export interface NativeTransportOptions {
  helperPath: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Owns only the helper it spawns; the helper owns its ConPTY child job. */
export function createNativeRuntime(options: NativeTransportOptions): NativeRuntime {
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready: NativeReady | undefined;
  let starting = false;
  let stopped = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let exitCause: NativeExitCause | undefined;
  let input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let lastSequence = -1;
  const sequenceGaps: Array<[number, number]> = [];
  let readyResolve: ((value: NativeReady) => void) | undefined;
  let readyReject: ((reason: Error) => void) | undefined;
  let exitResolve: (() => void) | undefined;
  const helperExited = new Promise<void>((resolve) => { exitResolve = resolve; });
  const pending = new Map<string, Pending>();
  const controls = new Map<string, Pending>();
  const eventListeners = new Set<(event: NativeEvent) => void>();
  const exitListeners = new Set<(code: number | null, cause?: NativeExitCause) => void>();
  const terminalListeners = new Set<(data: string) => void>();

  function rejectAll(error: Error): void {
    readyReject?.(error); readyReject = undefined; readyResolve = undefined;
    for (const group of [pending, controls]) {
      for (const entry of group.values()) { entry.cleanup(); entry.reject(error); }
      group.clear();
    }
  }
  function publishExit(code: number | null): void {
    if (stopped) return;
    stopped = true;
    rejectAll(failure('owned child exited'));
    for (const listener of exitListeners) { try { listener(code, exitCause); } catch { /* Isolate observers. */ } }
  }
  function poison(message: string): void {
    if (stopped || closed || closePromise) return;
    const error = failure(message);
    // Owned-job cleanup may exit with zero; retain the fault independently of pending requests and cleanup noise.
    exitCause ??= Object.freeze({ kind: 'transport', message: error.message });
    rejectAll(error);
    void close().catch(() => undefined);
  }
  function put(command: RecordValue): void {
    if (!child || child.stdin.destroyed || closed) throw failure('helper is not running');
    const line = `${JSON.stringify(command)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes - 1 > MAX_FRAME) throw failure('frame exceeds 32 MiB');
    if (child.stdin.writableLength + bytes > MAX_QUEUE) throw failure('control queue is full');
    child.stdin.write(line, (error) => { if (error && !closed) poison('helper input failed'); });
  }
  function command(op: string, args: RecordValue = {}, timeoutMs = 10_000): Promise<unknown> {
    if (controls.size >= MAX_PENDING) return Promise.reject(failure('control queue is full'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controls.delete(id); reject(failure(`${op} timed out`));
        if (op !== 'close') poison('unconfirmed native operation');
      }, timeoutMs);
      const entry: Pending = { resolve, reject, cleanup: () => clearTimeout(timer) };
      controls.set(id, entry);
      try { put({ ...args, op, id }); }
      catch (error) { controls.delete(id); entry.cleanup(); reject(error); }
    });
  }
  function bridge(frame: unknown): void {
    if (!record(frame)) return poison('invalid bridge frame');
    if (frame.type === 'startupError') {
      if (ready || !starting || frame.protocol !== 1 || frame.code !== 'MOD_INIT_FAILED'
        || Object.keys(frame).some((key) => !['type', 'protocol', 'code'].includes(key))) return poison('invalid startup error');
      return poison('native Mod initialization failed; reopen the session after checking the installed bridge');
    }
    if (frame.type === 'hello') {
      if (ready || !starting || frame.protocol !== 1 || frame.isInteractive !== true || frame.surface !== 'terminal'
        || typeof frame.sessionId !== 'string' || !frame.sessionId || !Array.isArray(frame.capabilities)
        || !frame.capabilities.every((capability) => typeof capability === 'string')) return poison('invalid interactive hello');
      ready = frame as unknown as NativeReady;
      readyResolve?.(ready); readyResolve = undefined; readyReject = undefined;
      return;
    }
    if (!ready || stopped) return;
    if (frame.type === 'response') {
      if (typeof frame.id !== 'string' || typeof frame.ok !== 'boolean') return poison('invalid response');
      const entry = pending.get(frame.id);
      if (!entry) return; // Late/cancelled/foreign IDs cannot settle a newer request.
      pending.delete(frame.id); entry.cleanup();
      if (frame.ok) entry.resolve(frame.value);
      else entry.reject(failure(record(frame.error) && typeof frame.error.message === 'string' ? frame.error.message : 'bridge request failed'));
      return;
    }
    if (frame.type === 'event') {
      if (frame.sessionId !== ready.sessionId || !Number.isSafeInteger(frame.sequence)) return;
      const sequence = frame.sequence as number;
      if (sequence <= lastSequence) {
        // Exact replays stay silent; a skipped sequence arriving late means an event was already lost to its listeners.
        if (sequenceGaps.some(([from, to]) => sequence >= from && sequence <= to)) poison('native events arrived out of order');
        return;
      }
      if (typeof frame.event !== 'string') return poison('invalid event');
      if (sequence > lastSequence + 1 && sequenceGaps.push([lastSequence + 1, sequence - 1]) > MAX_SEQUENCE_GAPS) sequenceGaps.shift();
      lastSequence = sequence;
      for (const listener of eventListeners) { try { listener(frame as unknown as NativeEvent); } catch { /* Isolate observers. */ } }
      return;
    }
    poison('unsupported bridge frame');
  }
  function host(message: unknown): void {
    if (!record(message)) return poison('invalid host frame');
    if (message.kind === 'ack' && typeof message.id === 'string') {
      const entry = controls.get(message.id);
      if (!entry) return;
      controls.delete(message.id); entry.cleanup();
      if (message.ok === true) entry.resolve(undefined);
      else entry.reject(failure('native operation rejected'));
    } else if (message.kind === 'bridge') bridge(message.frame);
    else if (message.kind === 'terminal' && typeof message.data === 'string') {
      for (const listener of terminalListeners) { try { listener(message.data); } catch { /* Isolate observers. */ } }
    } else if (message.kind === 'exit' && Number.isInteger(message.code)) {
      publishExit(message.code as number); void close().catch(() => undefined);
    } else if (message.kind === 'disconnected') {
      poison('Mod receiver disconnected');
    } else if (message.kind === 'error') {
      poison('native terminal read failed');
    } else poison('unsupported host frame');
  }
  function data(chunk: Buffer): void {
    input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
    let newline: number;
    while ((newline = input.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME) return poison('frame exceeds 32 MiB');
      const line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      try { host(JSON.parse(utf8.decode(line))); }
      catch { return poison('malformed host JSON'); }
    }
    if (input.length > MAX_FRAME) poison('unterminated oversized frame');
  }
  async function start(launch: NativeLaunch): Promise<NativeReady> {
    if (starting || child || closed) throw failure('runtime is single use');
    if (process.platform !== 'win32') throw failure('native Windows is required');
    if (!isAbsolute(options.helperPath) || !isAbsolute(launch.exe) || !isAbsolute(launch.cwd)) throw failure('absolute paths are required');
    if (launch.args.some((arg) => arg === '-p' || arg === '--print' || arg.startsWith('--input-format') || arg.startsWith('--output-format'))) throw failure('headless launch flags are prohibited');
    starting = true;
    const hello = new Promise<NativeReady>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // Register immediately, so a launch failure cannot become an unhandled rejection.
    void hello.catch(() => undefined);
    const timer = setTimeout(() => poison('interactive hello timed out'), options.startupTimeoutMs ?? 20_000);
    try {
      child = spawn(options.helperPath, ['host'], { windowsHide: true, shell: false, stdio: 'pipe' });
      child.stdout.on('data', data);
      child.stdout.on('end', () => { if (!closed && !stopped) poison(input.length ? 'truncated host EOF' : 'host EOF before confirmed exit'); });
      child.stderr.on('data', () => { /* Never forward native diagnostics containing launch environment. */ });
      child.stdin.on('error', () => { if (!closed) poison('helper input closed'); });
      child.once('error', () => { rejectAll(failure('helper could not start')); exitResolve?.(); });
      child.once('close', () => {
        exitResolve?.();
        if (!stopped) publishExit(null);
      });
      await command('start', { launch: { ...launch, args: [...launch.args], env: { ...launch.env } } });
      return await hello;
    } catch (error) {
      await close(); throw error;
    } finally { clearTimeout(timer); }
  }
  function request(method: string, args?: unknown, requestOptions: NativeRequestOptions = {}): Promise<unknown> {
    if (!ready || stopped || closed) return Promise.reject(failure('session is not ready'));
    if (!method || pending.size >= MAX_PENDING) return Promise.reject(failure('request queue is full or method is empty'));
    if (requestOptions.signal?.aborted) return Promise.reject(failure('request aborted'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = (reason: string): void => {
        const entry = pending.get(id); if (!entry) return;
        pending.delete(id); entry.cleanup(); entry.reject(failure(reason));
        void command('cancel', { requestId: id }).catch(() => undefined);
      };
      const abort = (): void => cancel('request aborted');
      const timer = requestOptions.timeoutMs === null ? undefined
        : setTimeout(() => cancel('request timed out'), requestOptions.timeoutMs ?? options.requestTimeoutMs ?? 30_000);
      const entry: Pending = {
        resolve, reject,
        cleanup: () => { if (timer !== undefined) clearTimeout(timer); requestOptions.signal?.removeEventListener('abort', abort); },
      };
      pending.set(id, entry);
      requestOptions.signal?.addEventListener('abort', abort, { once: true });
      void command('send', { frame: { type: 'request', id, method, ...(args !== undefined ? { args } : {}) } }).catch((error: unknown) => {
        if (!pending.delete(id)) return;
        entry.cleanup(); entry.reject(error instanceof Error ? error : failure('send failed'));
      });
    });
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      rejectAll(failure('runtime closed'));
      const owned = child;
      if (!owned) { closed = true; return; }
      if (owned.exitCode === null && !owned.killed) {
        try { await command('close', {}, 7000); } catch { /* Job handle closure is the last-resort child cleanup. */ }
      }
      closed = true; owned.stdin.end();
      const exited = await Promise.race([helperExited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
      if (!exited && owned.exitCode === null) {
        owned.kill(); // Exact ChildProcess handle created above, never a discovered/user PID.
        const confirmed = await Promise.race([helperExited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
        if (!confirmed) throw failure('owned helper exit was not confirmed');
      }
    })().catch((error: unknown) => {
      // Keep the closed runtime and exact owned child; allow explicit cleanup retry.
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  }
  return {
    start, request, close,
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    onTerminal(listener) { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    // Native trust/auth prompts precede Mod hello; only explicit terminal input may answer them.
    writeTerminal: async (text) => { if (!starting || !child || stopped || closed) throw failure('session is not running'); await command('write', { data: text }); },
    writeStartup: async (text) => {
      if (!STARTUP_KEYS.has(text)) throw failure('invalid startup menu key');
      if (!starting || !child || ready || stopped || closed || closePromise) throw failure('startup input is no longer available');
      await command('writeStartup', { data: text });
    },
    resize: async (cols, rows) => { await command('resize', { cols, rows }); },
  };
}
