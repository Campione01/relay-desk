import { describe, expect, it, vi } from 'vitest';
import { NativeSettings, NATIVE_AUTO_CONTINUE_CONSENT_DENIAL, nativeAutoContinueView, nativePermissionMode, nativeUltracodeOutput, nativeUltracodeResult } from '../../src/main/native/nativeSettings';
import { NativeUiController, NATIVE_UI_PINNED_SHA256, type NativeUiSnapshot, type NativeUiTransaction } from '../../src/main/native/controls';

describe('native remaining-settings adapters', () => {
  it('accepts only native ultracode confirmations and preserves the reported effort', () => {
    expect(nativeUltracodeResult({ text: 'Ultracode on (this session only): dynamic workflows on every task. Effort stays xhigh.' }, true)).toMatchObject({ enabled: true, effort: 'xhigh', scope: 'session' });
    expect(nativeUltracodeResult({ text: 'Ultracode off. Effort stays max.' }, false)).toMatchObject({ enabled: false, effort: 'max' });
    expect(() => nativeUltracodeResult({ text: 'Ultracode needs dynamic workflows enabled (see /config).' }, true)).toThrow('needs dynamic workflows');
    expect(() => nativeUltracodeResult({ text: 'Ultracode off. Effort stays xhigh.' }, true)).toThrow();
  });
  it('verifies physical scope before/after native writes and rejects native denial/mismatched scopes', async () => {
    const scope = vi.fn(), request = vi.fn(async () => ({ key: 'fast', enabled: true, scope: 'native-user', nativeValue: true }));
    const adapter = new NativeSettings({ port: { request }, hasCapability: () => true, assertPreferenceScope: scope });
    await expect(adapter.setFastMode(true)).resolves.toEqual({ key: 'fast', enabled: true, scope: 'native-user', nativeValue: true });
    expect(request).toHaveBeenCalledWith('fast.set', { enabled: true }); expect(scope).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce({ deny: 'Native organization policy' } as never);
    await expect(adapter.setFastMode(true)).rejects.toThrow('Native organization policy');
    request.mockResolvedValueOnce({ key: 'autoContinueAtUsageLimit', enabled: false, scope: 'session', nativeValue: false } as never);
    await expect(adapter.setAutoContinue(false)).rejects.toThrow('not confirmed');
  });
  it('does not call native operations without a capability or attested profile', async () => {
    const request = vi.fn();
    const missing = new NativeSettings({ port: { request }, hasCapability: () => false, assertPreferenceScope: vi.fn() });
    await expect(missing.setUltracode(true)).rejects.toThrow('not available');
    const shared = new NativeSettings({ port: { request }, hasCapability: () => true, assertPreferenceScope: () => { throw new Error('Shared profile'); } });
    await expect(shared.setAutoContinue(true)).rejects.toThrow('Shared profile'); expect(request).not.toHaveBeenCalled();
  });
  it('waits for a fresh shared native screen when local-JSX returns no text and verifies session-only postconditions', async () => {
    const snapshot = (text: string, revision = 10): NativeUiSnapshot => ({ text, revision, sessionId: 'owned', cliSha256: 'a'.repeat(64) });
    const confirmation = snapshot('Ultracode on (this session only): native description.\nEffort stays xhigh.', 11);
    const wait = vi.fn(async (predicate: (frame: NativeUiSnapshot) => boolean) => { expect(predicate(confirmation)).toBe(true); return confirmation; });
    const tx = { snapshot: () => snapshot(''), wait } as unknown as NativeUiTransaction;
    const run = vi.fn(async (_operation: string, action: (tx: NativeUiTransaction) => Promise<unknown>) => action(tx));
    const request = vi.fn(async () => ({}));
    const adapter = new NativeSettings({ port: { request }, hasCapability: () => true, assertPreferenceScope: vi.fn(), ultracode: {
      ui: { run } as never, readModel: async () => 'claude-opus-5-5', preferenceFingerprint: async () => 'f'.repeat(64),
    } });
    await expect(adapter.setUltracode(true)).resolves.toMatchObject({ enabled: true, effort: 'xhigh', scope: 'session' });
    expect(wait).toHaveBeenCalledWith(expect.any(Function), { afterRevision: 10 });
    expect(request).toHaveBeenCalledExactlyOnceWith('ultracode.set', { enabled: true });
    expect(nativeUltracodeOutput(snapshot('Ultracode off. Effort stays xhigh.\nUltracode needs dynamic workflows enabled (see /config).'))).toContain('needs dynamic');
  });
  it('uses the native consent panel only for its exact automatic-continuation denial', async () => {
    const frame = (selected: boolean, enabled: boolean): NativeUiSnapshot => ({ sessionId: 'owned', cliSha256: 'a'.repeat(64), revision: 4,
      text: `Settings  Status   Config   Usage   Stats\n${selected ? '  ' : '> '}Auto-compact                                true\n${selected ? '> ' : '  '}Continue automatically at usage limit       ${enabled}\nType to filter · Enter/↓ to select · ↑ to tabs · Esc to clear` });
    expect(nativeAutoContinueView(frame(false, false))).toEqual({ selected: 'Auto-compact', direction: 1, enabled: false });
    expect(nativeAutoContinueView({ ...frame(false, false), text: frame(false, false).text.replace('Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear', 'Enter/Space to change · / to search · Esc to close') }))
      .toEqual({ selected: 'Auto-compact', direction: 1, enabled: false });
    expect(nativeAutoContinueView(frame(true, false))).toEqual({ selected: 'Continue automatically at usage limit', direction: 0, enabled: false });
    // A Unicode console gets the same rows with the ❯ pointer.
    expect(nativeAutoContinueView({ ...frame(false, false), text: frame(false, false).text.replace('> Auto-compact', '❯ Auto-compact') }))
      .toEqual({ selected: 'Auto-compact', direction: 1, enabled: false });
    let current = frame(false, false), enabled = false;
    const request = vi.fn(async (method: string) => method === 'autoContinue.set' ? { deny: NATIVE_AUTO_CONTINUE_CONSENT_DENIAL } : [{ key: 'autoContinueAtUsageLimit', value: enabled, kind: 'boolean', isLocked: false, provider: { plugin: 'engine', tier: 'core' } }]);
    const key = vi.fn(async (bytes: string, guard: (s: NativeUiSnapshot) => boolean, settled: (s: NativeUiSnapshot) => boolean) => {
      expect(guard(current)).toBe(true);
      if (bytes === '\x1b[B') current = frame(true, false);
      else if (bytes === '\r') { enabled = true; current = frame(true, true); }
      else if (bytes === '\x1b') current = { ...current, text: '>\nmanual mode on' };
      else throw new Error('Unattested key');
      expect(settled(current)).toBe(true); return current;
    });
    const open = vi.fn(async () => current);
    const run = async <T,>(_label: string, action: (tx: NativeUiTransaction) => Promise<T>) => action({ snapshot: () => current, open, key } as unknown as NativeUiTransaction);
    const adapter = new NativeSettings({ port: { request }, hasCapability: () => true, assertPreferenceScope: vi.fn(), ui: { run } });
    await expect(adapter.setAutoContinue(true)).resolves.toMatchObject({ enabled: true, scope: 'native-user' });
    expect(open).toHaveBeenCalledWith('config', '', expect.any(Function));
    expect(key.mock.calls.map(call => call[0])).toEqual(['\x1b[B', '\r', '\x1b']);
    request.mockResolvedValueOnce({ deny: 'Organization disallows this setting' } as never);
    await expect(adapter.setAutoContinue(true)).rejects.toThrow('Organization disallows'); expect(open).toHaveBeenCalledTimes(1);
  });
  it('cycles only explicit native live footer modes and leaves unsupported startup-only targets untouched', async () => {
    const frame = (mode: string): NativeUiSnapshot => ({ sessionId: 'owned', cliSha256: 'a'.repeat(64), revision: 5, text: `native transcript\n>\n  ${mode} (shift+tab to cycle)` });
    expect(nativePermissionMode(frame('manual mode on'))).toBe('default');
    expect(nativePermissionMode(frame('accept edits on'))).toBe('acceptEdits');
    expect(nativePermissionMode(frame('plan mode on'))).toBe('plan');
    expect(nativePermissionMode({ ...frame(''), text: '>\n? for shortcuts' })).toBeUndefined();
    expect(nativePermissionMode({ ...frame('accept edits on'), text: frame('accept edits on').text.replace('\n>\n', '\n❯\n') })).toBe('acceptEdits');
    let current = frame('manual mode on');
    const cycle = vi.fn(async (guard: (s: NativeUiSnapshot) => boolean, settled: (s: NativeUiSnapshot) => boolean) => {
      expect(guard(current)).toBe(true); current = frame('accept edits on'); expect(settled(current)).toBe(true); return current;
    });
    const run = async <T,>(_label: string, action: (tx: NativeUiTransaction) => Promise<T>) => action({ snapshot: () => current, wait: async () => current, cyclePermissionMode: cycle } as unknown as NativeUiTransaction);
    const adapter = new NativeSettings({ port: { request: vi.fn() }, hasCapability: () => true, assertPreferenceScope: vi.fn(), permission: {
      ui: { run }, assertCycleBinding: vi.fn(), preferenceFingerprint: async () => 'f'.repeat(64),
    } });
    await expect(adapter.setPermissionMode('dontAsk')).rejects.toThrow('session unchanged'); expect(cycle).not.toHaveBeenCalled();
    await expect(adapter.setPermissionMode('acceptEdits')).resolves.toEqual({ mode: 'acceptEdits', scope: 'session' }); expect(cycle).toHaveBeenCalledTimes(1);
  });
  it('keeps idle-only cycle/quota keys separate from generic modal input and rejects operation/key mismatches', async () => {
    const writes: string[] = [];
    const ui = new NativeUiController({ sessionId: 'owned', cliSha256: NATIVE_UI_PINNED_SHA256, isIdle: () => true, port: { request: vi.fn() },
      writeTerminal: bytes => { writes.push(bytes); ui.observeTerminal(`\x1b[2J\x1b[H${bytes === '\x1b' ? 'cancelled' : 'after'}`); } });
    ui.observeTerminal('before');
    await ui.run('settings.permissionMode', tx => tx.cyclePermissionMode!(snapshot => snapshot.text === 'before', snapshot => snapshot.text === 'after', { stableMs: 0, timeoutMs: 30 }));
    expect(writes).toEqual(['\x1b[Z']);
    await expect(ui.run('quota.cancel', tx => tx.quotaKey!('\r', () => true, () => true))).rejects.toThrow('operation/key');
    expect(writes).toHaveLength(1);
    await ui.run('quota.cancel', tx => tx.quotaKey!('\x1b', snapshot => snapshot.text === 'after', snapshot => snapshot.text === 'cancelled', { stableMs: 0, timeoutMs: 30 }));
    expect(writes).toEqual(['\x1b[Z', '\x1b']); ui.close();
  });
});
