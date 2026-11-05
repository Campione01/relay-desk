import { NATIVE_POINTER, NATIVE_PROMPT_LINE, NativeControlGate, type NativeControlPort, type NativeUiController, type NativeUiSnapshot } from './controls.ts';

export interface NativeSettingsOptions {
  port: NativeControlPort;
  hasCapability(capability: string): boolean;
  assertPreferenceScope(): void | Promise<void>;
  ui?: Pick<NativeUiController, 'run'>;
  permission?: {
    ui: Pick<NativeUiController, 'run'>;
    preferenceFingerprint(): Promise<string>;
    /** Verify the owned native keybindings still use the pinned Shift+Tab cycle binding. */
    assertCycleBinding?(): void | Promise<void>;
  };
  ultracode?: {
    ui: Pick<NativeUiController, 'run'>;
    readModel(): Promise<string>;
    preferenceFingerprint(): Promise<string>;
  };
}
export interface NativeSavedBoolean {
  key: 'fast' | 'autoContinueAtUsageLimit';
  enabled: boolean;
  scope: 'native-user';
  nativeValue: boolean;
}
export interface NativeUltracodeResult { enabled: boolean; scope: 'session'; effort: string; nativeText: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const NATIVE_AUTO_CONTINUE_CONSENT_DENIAL = 'Continue automatically at usage limit can only be turned on from the /config panel.';
export interface NativeAutoContinueView { selected: string; direction: -1 | 0 | 1; enabled: boolean }
export type NativeLivePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
const LIVE_PERMISSION_TARGETS = new Set<NativeLivePermissionMode>(['default', 'acceptEdits', 'plan']);

/** Only explicit native footer modes count; an absent indicator is not guessed to mean Manual. */
export function nativePermissionMode(snapshot: NativeUiSnapshot): NativeLivePermissionMode | undefined {
  if (/Settings\s+Status\s+Config|Select model|^\s*Effort\s*$|Manage MCP servers|What do you want to do\?/m.test(snapshot.text)) return undefined;
  const tail = snapshot.text.split('\n').slice(-7);
  if (!tail.some(line => NATIVE_PROMPT_LINE.test(line.trim()))) return undefined;
  const labels: Array<[NativeLivePermissionMode, RegExp]> = [
    ['default', /\bmanual(?: mode on)?\b/i], ['acceptEdits', /\baccept edits(?: on)?\b/i],
    ['plan', /\bplan mode on\b|^\s*plan\s*(?:\(|·|$)/i], ['auto', /\bauto mode on\b|^\s*auto\s*(?:\(|·|$)/i],
    ['dontAsk', /\bdon't ask(?: on)?\b/i], ['bypassPermissions', /\bbypass permissions(?: on)?\b/i],
  ];
  const modes = labels.filter(([, pattern]) => tail.some(line => pattern.test(line)));
  return modes.length === 1 ? modes[0][0] : undefined;
}

const SELECTED_SETTING = new RegExp(`^\\s*${NATIVE_POINTER}\\s*(.+?)\\s{2,}(\\S.*)$`);
const AUTO_CONTINUE_ROW = new RegExp(`^\\s*(?:${NATIVE_POINTER}\\s*)?Continue automatically at usage limit\\s{2,}(true|false)\\s*$`);

/** Exact pinned Config labels on the shared screen; ambiguous or hidden rows are not actionable. */
export function nativeAutoContinueView(snapshot: NativeUiSnapshot): NativeAutoContinueView | undefined {
  const lines = snapshot.text.split('\n');
  if (!lines.some(line => /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(line)) ||
    !/(?:Type to filter.*Enter\/↓ to select.*Esc to clear|Enter\/Space to change.*\/ to search.*Esc to close)/.test(snapshot.text)) return undefined;
  const selected = lines.map((line, index) => ({ match: SELECTED_SETTING.exec(line), index })).filter(entry => entry.match);
  const target = lines.map((line, index) => ({ match: AUTO_CONTINUE_ROW.exec(line), index })).filter(entry => entry.match);
  if (selected.length !== 1 || target.length !== 1) return undefined;
  return { selected: selected[0].match![1], enabled: target[0].match![1] === 'true', direction: Math.sign(target[0].index - selected[0].index) as -1 | 0 | 1 };
}

/** Parse the pinned command's own outcome; never turn a native refusal into an applied flag. */
export function nativeUltracodeResult(value: unknown, enabled: boolean): NativeUltracodeResult {
  if (!record(value) || typeof value.text !== 'string') throw new NativeControlGate('ultracode.set', 'native command returned no text outcome.');
  const text = value.text.trim();
  const prefix = enabled ? /^Ultracode on \(this session only\):/ : /^Ultracode off\./;
  const effort = /\bEffort stays ([A-Za-z0-9]+)\./.exec(text)?.[1];
  if (!prefix.test(text) || !effort) throw new NativeControlGate('ultracode.set', text || 'native ultracode action was not confirmed.');
  return { enabled, scope: 'session', effort, nativeText: text };
}

/** Local-JSX commands can finish without CommandRunResult.text; their native output is still drawn. */
export function nativeUltracodeOutput(snapshot: NativeUiSnapshot): string | undefined {
  const text = snapshot.text.replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/\bUltracode (?:on \(this session only\):.*?\bEffort stays [A-Za-z0-9]+\.|off\.\s*Effort stays [A-Za-z0-9]+\.|needs dynamic workflows enabled[^.]*\.|isn't available on[^.]*\.)/g)];
  return matches.at(-1)?.[0];
}

/** Scoped wrappers for native operations, not a settings engine or permission-mode emulator. */
export class NativeSettings {
  private readonly options: NativeSettingsOptions;
  constructor(options: NativeSettingsOptions) { this.options = options; }
  setFastMode(enabled: boolean): Promise<NativeSavedBoolean> { return this.setSaved('fast.set', 'fast', enabled); }
  setAutoContinue(enabled: boolean): Promise<NativeSavedBoolean> { return this.setSaved('autoContinue.set', 'autoContinueAtUsageLimit', enabled); }
  setPermissionMode(mode: NativeLivePermissionMode): Promise<{ mode: NativeLivePermissionMode; scope: 'session' }> {
    if (!LIVE_PERMISSION_TARGETS.has(mode)) return Promise.reject(new NativeControlGate('permissionMode', 'not available through the native live mode cycle; session unchanged. Select this native mode at startup.'));
    const controls = this.options.permission;
    if (!controls) return Promise.reject(new NativeControlGate('permissionMode', 'the native permission-cycle controller is not available; session unchanged.'));
    return controls.ui.run('settings.permissionMode', async tx => {
      await this.options.assertPreferenceScope();
      const before = await controls.preferenceFingerprint();
      if (!/^[a-f0-9]{64}$/i.test(before)) throw new NativeControlGate('permissionMode', 'persistent preference fingerprint is not verified.');
      let frame = await tx.wait(snapshot => nativePermissionMode(snapshot) !== undefined, { timeoutMs: 5_000 }), current = nativePermissionMode(frame);
      const assertBinding = async (snapshot: NativeUiSnapshot) => {
        if (/\(shift\+tab to cycle\)/i.test(snapshot.text.split('\n').slice(-7).join('\n'))) return;
        if (controls.assertCycleBinding) { await controls.assertCycleBinding(); return; }
        throw new NativeControlGate('permissionMode', 'the active native Shift+Tab cycle binding is not attested; session unchanged.');
      };
      await assertBinding(frame);
      if (!current) throw new NativeControlGate('permissionMode', 'the actual native idle permission mode is not observable; session unchanged.');
      if (!tx.cyclePermissionMode) throw new NativeControlGate('permissionMode', 'native permission cycle operation is unavailable; session unchanged.');
      const visited = new Set<NativeLivePermissionMode>();
      for (let count = 0; current !== mode && count < 8; count++) {
        if (visited.has(current)) throw new NativeControlGate('permissionMode', 'requested mode is not reachable through the native live cycle.');
        visited.add(current);
        const previous = current;
        frame = await tx.cyclePermissionMode(snapshot => nativePermissionMode(snapshot) === previous,
          snapshot => nativePermissionMode(snapshot) !== undefined && nativePermissionMode(snapshot) !== previous);
        current = nativePermissionMode(frame)!;
      }
      if (current !== mode) throw new NativeControlGate('permissionMode', 'native cycle did not confirm the requested permission mode.');
      await assertBinding(frame); await this.options.assertPreferenceScope();
      if (await controls.preferenceFingerprint() !== before) throw new NativeControlGate('permissionMode', 'native live permission cycle changed saved defaults.');
      return { mode, scope: 'session' };
    });
  }
  async setUltracode(enabled: boolean): Promise<NativeUltracodeResult> {
    this.require('ultracode.set', enabled);
    const controls = this.options.ultracode;
    if (!controls) throw new NativeControlGate('ultracode.set', 'the shared native UI controller is required to verify local-JSX command completion.');
    return controls.ui.run('settings.ultracode', async (tx) => {
      await this.options.assertPreferenceScope();
      const before = await controls.preferenceFingerprint(), model = await controls.readModel();
      if (!/^[a-f0-9]{64}$/i.test(before)) throw new NativeControlGate('ultracode.set', 'persistent preference fingerprint is not verified.');
      const revision = tx.snapshot().revision;
      const value = await this.options.port.request('ultracode.set', { enabled });
      let result: NativeUltracodeResult;
      if (record(value) && typeof value.text === 'string') result = nativeUltracodeResult(value, enabled);
      else {
        const frame = await tx.wait(snapshot => nativeUltracodeOutput(snapshot) !== undefined, { afterRevision: revision });
        result = nativeUltracodeResult({ text: nativeUltracodeOutput(frame) }, enabled);
      }
      await this.options.assertPreferenceScope();
      if (await controls.readModel() !== model || await controls.preferenceFingerprint() !== before) throw new NativeControlGate('ultracode.set', 'native session-only action changed the model or persistent defaults.');
      return result;
    });
  }
  private async setSaved(method: 'fast.set' | 'autoContinue.set', key: NativeSavedBoolean['key'], enabled: boolean): Promise<NativeSavedBoolean> {
    this.require(method, enabled);
    await this.options.assertPreferenceScope();
    const value = await this.options.port.request(method, { enabled });
    await this.options.assertPreferenceScope();
    if (method === 'autoContinue.set' && enabled && record(value) && value.deny === NATIVE_AUTO_CONTINUE_CONSENT_DENIAL) return this.enableAutoContinueFromNativePanel();
    if (record(value) && typeof value.deny === 'string') throw new NativeControlGate(method, value.deny);
    if (!record(value) || value.key !== key || value.enabled !== enabled || value.scope !== 'native-user' || typeof value.nativeValue !== 'boolean') {
      throw new NativeControlGate(method, 'native preference write/readback was not confirmed.');
    }
    return { key, enabled, scope: 'native-user', nativeValue: value.nativeValue };
  }
  private async enableAutoContinueFromNativePanel(): Promise<NativeSavedBoolean> {
    const ui = this.options.ui ?? this.options.ultracode?.ui;
    if (!ui || !this.options.hasCapability('config.open')) throw new NativeControlGate('autoContinue.set', NATIVE_AUTO_CONTINUE_CONSENT_DENIAL);
    return ui.run('settings.autoContinue.consent', async tx => {
      await this.options.assertPreferenceScope();
      const read = async () => {
        const rows = await this.options.port.request('config.list');
        const row = Array.isArray(rows) ? rows.find(row => record(row) && row.key === 'autoContinueAtUsageLimit') : undefined;
        if (!record(row) || row.kind !== 'boolean' || typeof row.value !== 'boolean' || row.isLocked || !record(row.provider) || row.provider.plugin !== 'engine' || row.provider.tier !== 'core') throw new NativeControlGate('autoContinue.set', 'native automatic-continuation row is unavailable or locked.');
        return row.value;
      };
      await read();
      let frame = await tx.open('config', '', snapshot => nativeAutoContinueView(snapshot) !== undefined);
      for (let count = 0; count < 48; count++) {
        const view = nativeAutoContinueView(frame);
        if (!view) throw new NativeControlGate('autoContinue.set', 'native Config row is ambiguous.');
        if (view.direction === 0) break;
        frame = await tx.key(view.direction > 0 ? '\x1b[B' : '\x1b[A', snapshot => {
          const observed = nativeAutoContinueView(snapshot); return observed?.selected === view.selected && observed.enabled === view.enabled;
        }, snapshot => nativeAutoContinueView(snapshot) !== undefined);
      }
      const selected = nativeAutoContinueView(frame);
      if (!selected || selected.direction !== 0) throw new NativeControlGate('autoContinue.set', 'native automatic-continuation row was not selected.');
      if (!selected.enabled) frame = await tx.key('\r', snapshot => {
        const view = nativeAutoContinueView(snapshot); return view?.direction === 0 && !view.enabled;
      }, snapshot => nativeAutoContinueView(snapshot)?.enabled === true);
      await tx.key('\x1b', snapshot => nativeAutoContinueView(snapshot)?.enabled === true, snapshot => nativeAutoContinueView(snapshot) === undefined);
      await this.options.assertPreferenceScope();
      if (!await read()) throw new NativeControlGate('autoContinue.set', 'native Config panel did not confirm automatic continuation.');
      return { key: 'autoContinueAtUsageLimit', enabled: true, scope: 'native-user', nativeValue: true };
    });
  }
  private require(method: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Native setting requires a boolean.');
    if (!this.options.hasCapability(method)) throw new NativeControlGate(method, 'native operation is not available.');
  }
}
