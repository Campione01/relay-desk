import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Timer } from 'claude-code';
import { HELPER_ENV, MAX_FRAME_BYTES, NONCE_ENV, PIPE_ENV, type BridgeOutput, type BridgeRequest } from './protocol';

export const MAX_QUEUED_BYTES = MAX_FRAME_BYTES;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_BATCH_FRAMES = 128;
export const MAX_REQUEST_ID_LENGTH = 256;
export const SEND_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
export const SEND_FAILURE_MESSAGE = 'Relay could not deliver native events: the send helper failed repeatedly.';

/** 5 s plus 2 s per MiB of the batch, within $.process.run's ten-minute ceiling. */
export function sendTimeoutMs(bytes: number): number {
  return Math.min(600_000, 5_000 + Math.round(bytes / (1024 * 1024) * 2_000));
}

export interface BridgeTransport {
  send(output: BridgeOutput): void;
  start(receive: (request: BridgeRequest) => void, failed: (reason: string) => void): void;
  close(): void;
  flush(): Promise<void>;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.type === 'request' && typeof request.id === 'string' &&
    request.id.length > 0 && request.id.length <= MAX_REQUEST_ID_LENGTH &&
    typeof request.method === 'string' && request.method.length > 0 && request.method.length <= 128;
}

export async function createProcessTransport($: EngineInterface): Promise<BridgeTransport> {
  const pipe = await $.env.get('RELAY_NATIVE_PIPE');
  const nonce = await $.env.get('RELAY_NATIVE_NONCE');
  const helper = await $.env.get('RELAY_NATIVE_HELPER');
  if (!pipe || !/^relay-native-[0-9a-f]{64}$/.test(pipe) || !nonce || nonce.length < 16 ||
      !helper || !/^[A-Za-z]:[\\/]/.test(helper)) {
    throw new Error('Relay native pipe configuration is missing or invalid');
  }
  const childEnv = { [PIPE_ENV]: pipe, [NONCE_ENV]: nonce, [HELPER_ENV]: helper };
  const pipeCleared = await $.env.set('RELAY_NATIVE_PIPE', '');
  const nonceCleared = await $.env.set('RELAY_NATIVE_NONCE', '');
  const helperCleared = await $.env.set('RELAY_NATIVE_HELPER', '');
  if (pipeCleared.deny || nonceCleared.deny || helperCleared.deny) {
    throw new Error('Relay native capability environment could not be cleared');
  }
  const encoder = new TextEncoder();
  const queue: { text: string; bytes: number; startup: boolean }[] = [];
  let queuedBytes = 0;
  let closed = false;
  let started = false;
  let flushing: Promise<void> | undefined;
  let timer: Timer | undefined;
  let backoff: { timer: Timer; wake(): void } | undefined;
  let lastEvent: { sessionId: string; sequence: number } | undefined;
  let receiver: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined;
  let onFailure: (reason: string) => void = () => undefined;

  function stop(): void {
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    timer?.cancel();
    backoff?.timer.cancel(); backoff?.wake(); backoff = undefined;
    void receiver?.return({ code: null, signal: 'bridge-closed' }).catch(() => undefined);
  }

  function fail(reason: string): void {
    if (closed) return;
    stop();
    onFailure(reason);
  }

  // $.process.run kills the child at timeoutMs before it rejects, so a rejected helper writes no more;
  // what it wrote is a prefix of the same batch, which main drops by sequence and request id.
  async function deliver(stdin: string, bytes: number): Promise<boolean> {
    try { return (await $.process.run([helper!, 'send'], { stdin, env: childEnv, timeoutMs: sendTimeoutMs(bytes) })).exitCode === 0; }
    catch { return false; }
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => { backoff = { timer: $.clock.after(ms, resolve), wake: resolve }; });
  }

  async function drain(): Promise<void> {
    if (closed || queue.length === 0) return;
    const batch: string[] = [];
    let bytes = 0, startup = false;
    while (queue.length && batch.length < MAX_BATCH_FRAMES && (batch.length === 0 || bytes + queue[0].bytes <= MAX_BATCH_BYTES)) {
      const entry = queue.shift()!;
      batch.push(entry.text);
      bytes += entry.bytes;
      queuedBytes -= entry.bytes;
      startup ||= entry.startup;
    }
    const stdin = batch.join('');
    // Main refuses a second hello, so startup frames are never resent.
    if (startup) { if (!await deliver(stdin, bytes)) fail('Named-pipe send helper failed'); return; }
    for (let attempt = 0; ; attempt++) {
      if (await deliver(stdin, bytes) || closed) return;
      if (attempt === SEND_RETRY_DELAYS_MS.length) break;
      await wait(SEND_RETRY_DELAYS_MS[attempt]);
      backoff = undefined;
      if (closed) return;
    }
    if (lastEvent) {
      const notice = JSON.stringify({ type: 'event', event: 'error', sessionId: lastEvent.sessionId, sequence: lastEvent.sequence + 1,
        data: { message: SEND_FAILURE_MESSAGE, fatal: true } }) + '\n';
      await deliver(notice, encoder.encode(notice).length);
    }
    fail('Named-pipe send helper failed repeatedly');
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = drain().finally(() => { flushing = undefined; });
    return flushing;
  }

  return {
    send(output) {
      if (closed) throw new Error('Relay native transport is closed');
      const text = JSON.stringify(output) + '\n';
      const bytes = encoder.encode(text).length;
      if (bytes > MAX_FRAME_BYTES || queuedBytes + bytes > MAX_QUEUED_BYTES) {
        fail('Relay native outbound queue exceeded its bounded capacity');
        throw new Error('Relay native outbound capacity exceeded');
      }
      queue.push({ text, bytes, startup: output.type === 'hello' || output.type === 'startupError' });
      queuedBytes += bytes;
      if (output.type === 'event') lastEvent = { sessionId: output.sessionId, sequence: output.sequence };
      else if (output.type === 'hello') lastEvent = { sessionId: output.sessionId, sequence: 0 };
    },
    start(receive, failed) {
      if (started || closed) throw new Error('Relay native transport cannot be started twice');
      started = true;
      onFailure = failed;
      timer = $.clock.every(25, () => { void flush(); });
      void (async () => {
        let buffered = '';
        let bufferedBytes = 0;
        try {
          receiver = $.process.spawn({ argv: [helper!, 'recv'], env: childEnv });
          for await (const chunk of receiver) {
            if (closed) break;
            if (chunk.stream !== 'stdout') continue;
            buffered += chunk.text;
            bufferedBytes += encoder.encode(chunk.text).length;
            if (bufferedBytes > MAX_FRAME_BYTES) {
              fail('Relay native inbound frame exceeded its bounded capacity');
              break;
            }
            let newline = buffered.indexOf('\n');
            while (newline >= 0 && !closed) {
              const line = buffered.slice(0, newline).trim();
              bufferedBytes -= encoder.encode(buffered.slice(0, newline + 1)).length;
              buffered = buffered.slice(newline + 1);
              if (line) {
                const request: unknown = JSON.parse(line);
                if (!isBridgeRequest(request)) throw new Error('Invalid bridge request');
                receive(request);
              }
              newline = buffered.indexOf('\n');
            }
          }
          if (!closed) fail('Relay native receive helper ended');
        } catch {
          fail('Relay native receive helper failed or sent an invalid frame');
        }
      })();
    },
    close() {
      if (!closed) stop();
    },
    flush,
  };
}
