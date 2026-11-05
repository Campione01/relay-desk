import { describe, expect, it, vi } from 'vitest';
import { guardNativeRuntime, assertFixtureLaunch } from '../../src/main/native/guardedRuntime';
import type { NativeLaunch, NativeRuntime } from '../../src/main/native/contract';

const fixture = { kind: 'local-fixture' as const, origin: 'http://127.0.0.1:41101', denyProxy: 'http://127.0.0.1:41102' };
function launch(): NativeLaunch {
  return { handleId: 'test', exe: 'C:\\fixture\\claude.exe', cwd: 'C:\\fixture', args: [], env: {
    ANTHROPIC_API_KEY: 'native-acceptance-fake-key-not-a-real-credential', ANTHROPIC_BASE_URL: fixture.origin,
    HTTP_PROXY: fixture.denyProxy, HTTPS_PROXY: fixture.denyProxy, ALL_PROXY: fixture.denyProxy, NO_PROXY: '127.0.0.1,localhost,[::1]',
  } };
}
function runtime() {
  const value = {
    start: vi.fn(async () => ({ sessionId: 'native', protocol: 1 as const, isInteractive: true, surface: 'terminal', capabilities: [] })),
    request: vi.fn(async () => true), close: vi.fn(async () => {}), writeTerminal: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), onTerminal: vi.fn(() => () => {}),
  } satisfies NativeRuntime;
  return value;
}

describe('native fixture network admission', () => {
  it('permits the explicitly synthetic loopback provider, not remote or real-auth substitutions', async () => {
    const base = runtime(); const guarded = guardNativeRuntime(base, fixture);
    await guarded.start(launch()); await guarded.request('session.messages'); await guarded.close();
    expect(base.request).toHaveBeenCalledOnce();
    for (const patch of [{ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, { ANTHROPIC_AUTH_TOKEN: 'synthetic-not-real' }, { NO_PROXY: '*' }, { https_proxy: 'http://other.invalid' }]) {
      const bad = launch(); Object.assign(bad.env, patch);
      expect(() => assertFixtureLaunch(bad, fixture.origin, fixture.denyProxy)).toThrow();
    }
  });
  it('refuses non-loopback fixture endpoints', () => {
    expect(() => assertFixtureLaunch(launch(), 'http://example.com:41101', fixture.denyProxy)).toThrow('numeric loopback');
    expect(() => assertFixtureLaunch(launch(), fixture.origin, 'https://127.0.0.1:41102')).toThrow('numeric loopback');
  });
  it('never starts a child for a substituted environment and closes the owned runtime', async () => {
    const base = runtime(); const bad = launch(); bad.env.ANTHROPIC_BASE_URL = 'https://api.example.com';
    const guarded = guardNativeRuntime(base, fixture);
    await expect(guarded.start(bad)).rejects.toThrow('isolated provider');
    expect(base.start).not.toHaveBeenCalled(); expect(base.close).toHaveBeenCalledOnce();
    await expect(guarded.request('prompt.submit', { text: 'never' })).rejects.toThrow('closed');
    await expect(guarded.writeTerminal('never')).rejects.toThrow('closed');
    expect(base.request).not.toHaveBeenCalled(); expect(base.writeTerminal).not.toHaveBeenCalled();
  });
  it('forwards nothing after close and closes the runtime once', async () => {
    const base = runtime(); const guarded = guardNativeRuntime(base, fixture);
    await guarded.start(launch()); await Promise.all([guarded.close(), guarded.close()]);
    expect(base.close).toHaveBeenCalledOnce();
    await expect(guarded.writeTerminal('late')).rejects.toThrow('closed');
    expect(base.writeTerminal).not.toHaveBeenCalled();
  });
});
