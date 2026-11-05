import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { NativeStartupKey } from '@shared/types';
import { PermissionBroker } from '../../src/main/engine/broker';
import { NativeInteractiveSession } from '../../src/main/native/session';
import type { NativeReady, NativeRuntime } from '../../src/main/native/contract';

function fixture(correlated = true) {
  const events: EngineEvent[] = [];
  const terminals = new Set<(text: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  let resolve!: (ready: NativeReady) => void;
  let reject!: (error: Error) => void;
  const hello = new Promise<NativeReady>((done, failed) => { resolve = done; reject = failed; });
  void hello.catch(() => undefined);
  const writeStartup = vi.fn(async (_text: string) => undefined);
  const writeTerminal = vi.fn(async (_text: string) => undefined);
  const runtime: NativeRuntime = {
    start: vi.fn(() => hello), request: vi.fn(async () => []), writeStartup, writeTerminal,
    close: vi.fn(async () => { reject(new Error('Native transport: runtime closed')); }), resize: vi.fn(async () => undefined),
    onEvent: () => () => undefined,
    onExit: callback => { exits.add(callback); return () => exits.delete(callback); },
    onTerminal: callback => { terminals.add(callback); return () => terminals.delete(callback); },
  };
  const session = new NativeInteractiveSession({
    handleId: 'owned', profile: { id: 'default', name: 'Synthetic', configDir: null, createdAt: 0 },
    request: { profileId: 'default', cwd: 'C:\\synthetic', ...(correlated ? { startupRequestId: 'request-1' } : {}) },
    launch: { exe: 'C:\\synthetic\\claude.exe', args: [], cwd: 'C:\\synthetic', env: {}, handleId: 'owned', cols: 140, rows: 48 },
    runtime, emit: event => events.push(event), broker: new PermissionBroker('owned', () => undefined),
  });
  const snapshots = () => events.filter((event): event is Extract<EngineEvent, { type: 'startup' }> => event.type === 'startup');
  return { session, events, runtime, writeStartup, writeTerminal, snapshots,
    terminal(text: string) { for (const callback of terminals) callback(text); },
    ready() { resolve({ protocol: 1, sessionId: 'synthetic-session', isInteractive: true, surface: 'terminal', capabilities: [] }); },
    fail(error: string, exitFirst = false) { if (exitFirst) for (const callback of exits) callback(0); reject(new Error(error)); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('native pre-hello user interaction', () => {
  it('publishes bounded correlated memory-only screens without transcript items or automatic input', async () => {
    const f = fixture(); const started = f.session.start();
    f.terminal('\x1b[2J\x1b[HWARNING: Bypass Permissions mode\r\nNo, exit\r\nYes, I accept\r\nBearer secret-value');
    await vi.advanceTimersByTimeAsync(30);
    expect(f.snapshots().at(-1)).toMatchObject({ requestId: 'request-1', handleId: 'owned', phase: 'waiting', revision: 1 });
    expect(f.snapshots().at(-1)?.text).toContain('Yes, I accept');
    expect(f.snapshots().at(-1)?.text).not.toContain('secret-value');
    expect(f.snapshots().at(-1)!.text.length).toBeLessThanOrEqual(32768);
    expect(f.events.some(event => event.type === 'item' || event.type === 'delta')).toBe(false);
    expect(f.writeStartup).not.toHaveBeenCalled(); expect(f.writeTerminal).not.toHaveBeenCalled();
    f.ready(); await started;
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'ready', text: '' });
    await expect(f.session.startupInput({ revision: 1, key: 'enter' })).rejects.toThrow('no longer');
    await f.session.close();
  });

  it('only forwards explicit enumerated keys and consumes each current revision once', async () => {
    const f = fixture(); const started = f.session.start();
    await expect(f.session.startupInput({ revision: 0, key: 'enter' })).rejects.toThrow('not available yet');
    f.terminal('Native menu'); await vi.advanceTimersByTimeAsync(30);
    const first = f.snapshots().at(-1)!.revision;
    const down = f.session.startupInput({ revision: first, key: 'down' });
    expect(f.writeStartup).toHaveBeenCalledExactlyOnceWith('\x1b[B');
    await expect(f.session.startupInput({ revision: first, key: 'enter' })).rejects.toThrow('screen changed');
    f.terminal('\rChanged menu');
    await expect(f.session.startupInput({ revision: first + 1, key: 'enter' })).rejects.toThrow('screen changed');
    await vi.advanceTimersByTimeAsync(150);
    await down;
    for (const [key, bytes] of [['enter', '\r'], ['up', '\x1b[A'], ['left', '\x1b[D'], ['right', '\x1b[C'], ['tab', '\t'], ['escape', '\x1b']] as const) {
      const pressed = f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key });
      expect(f.writeStartup).toHaveBeenLastCalledWith(bytes);
      await vi.advanceTimersByTimeAsync(1000);
      await pressed;
    }
    await expect(f.session.startupInput({ revision: f.snapshots().at(-1)!.revision, key: 'paste' as NativeStartupKey })).rejects.toThrow('screen changed');
    expect(f.writeTerminal).not.toHaveBeenCalled(); f.ready(); await started; await f.session.close();
  });

  it('invalidates input synchronously on close and clears the visible snapshot', async () => {
    const f = fixture(); const started = f.session.start().catch(error => error);
    f.terminal('Native startup'); await vi.advanceTimersByTimeAsync(30);
    const revision = f.snapshots().at(-1)!.revision;
    const closed = f.session.close();
    await expect(f.session.startupInput({ revision, key: 'enter' })).rejects.toThrow('no longer');
    await closed; await started;
    expect(f.snapshots().at(-1)).toMatchObject({ phase: 'closed', text: '' });
    expect(f.writeStartup).not.toHaveBeenCalled();
  });

  it('does not publish or admit startup interaction without UI correlation', async () => {
    const f = fixture(false); const started = f.session.start();
    f.terminal('No, exit\r\nYes, I accept'); await vi.advanceTimersByTimeAsync(30);
    expect(f.snapshots()).toEqual([]);
    await expect(f.session.startupInput({ revision: 0, key: 'enter' })).rejects.toThrow('no longer');
    f.ready(); await started; await f.session.close(); expect(f.snapshots()).toEqual([]);
  });

  it.each([
    ['WARNING: Bypass Permissions mode\r\nYes, I accept', 'explicit Bypass Permissions consent'],
    ['Quick safety check: do you trust this folder?', 'folder trust confirmation'],
    ['Detected a custom API key in your environment', 'waiting for an answer to the API key approval dialog'],
    ['MCP server example needs authentication (OAuth)', 'interactive hello timed out'],
    ['Relay native startup failed', 'Mod initialization failed'],
    ['relay-native-bridge: hooks module did not load: synthetic file', 'Mod initialization failed'],
    ['unrecognized screen', 'interactive hello timed out'],
  ])('classifies timeout without attaching terminal contents: %s', async (screen, expected) => {
    const f = fixture(); const started = f.session.start();
    const rejected = expect(started).rejects.toThrow(expected);
    f.terminal(screen + '\r\nBearer must-not-leak');
    f.fail('Native transport: interactive hello timed out', true);
    await rejected;
    expect(f.events.filter(event => event.type === 'error').every(event => !JSON.stringify(event).includes('must-not-leak'))).toBe(true);
  });
});
