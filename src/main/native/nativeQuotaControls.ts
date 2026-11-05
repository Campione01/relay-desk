import type { AutoContinueState } from '@shared/types';
import { NATIVE_CLI_BUILDS, nativeCliBuild, type NativeCliBuild } from './cliBuilds';
import { NativeControlGate, type NativeUiController, type NativeUiSnapshot } from './controls';

const CANCELLED = 'Automatic continue cancelled \u00b7 /rate-limit-options to re-arm';
const emptyComposer = (text: string) => {
  if (/\[(?:Image|PDF|Pasted text)(?:\s|#)/i.test(text)) return false;
  const prompts = text.split('\n').filter(line => /^\s*[>\u276f\u203a]/.test(line));
  return prompts.length === 1 && /^\s*[>\u276f\u203a]\s*$/.test(prompts[0]);
};

export interface NativeQuotaView {
  phase: 'waiting' | 'stale';
  message: string;
  emptyComposer: boolean;
}

/** Pinned English native footer only. Relative/localized dates are never converted to invented timestamps. */
export function nativeQuotaView(snapshot: NativeUiSnapshot, admittedBuilds: readonly NativeCliBuild[] = NATIVE_CLI_BUILDS): NativeQuotaView | null {
  if (!nativeCliBuild(snapshot.cliSha256, admittedBuilds) || snapshot.source === 'command-result') return null;
  const lines = snapshot.text.split('\n').map(line => line.trim()).filter(Boolean).slice(-12);
  if (lines.some(line => /Enter to (?:select|confirm).*Esc to (?:back|cancel)/.test(line))) return null;
  const matches: NativeQuotaView[] = [];
  for (let index = 0; index < lines.length - 1; index++) {
    const status = lines[index], next = lines[index + 1];
    if (status === 'Your usage limit has reset' && next === 'Press enter to continue') {
      matches.push({ phase: 'stale', message: `${status} \u00b7 ${next}`, emptyComposer: emptyComposer(lines.join('\n')) });
    }
    // CLI 2.1.312 capitalises the key ("\u00b7 Esc to cancel"); 2.1.308 writes "\u00b7 esc to cancel".
    if (/^Usage limit reached(?: \u00b7 limit resets .+)?$/.test(status) &&
      /^(?:Continuing automatically (?:at .+|when it resets)|Continuing shortly) \u00b7 [Ee]sc to cancel$/.test(next)) {
      matches.push({ phase: 'waiting', message: `${status} \u00b7 ${next}`, emptyComposer: emptyComposer(lines.join('\n')) });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export interface NativeQuotaControlsOptions {
  ui: Pick<NativeUiController, 'run' | 'snapshot'>;
  /** Fixture-only, the controller's NativeUiControllerOptions.admittedBuilds; production never passes it. */
  admittedBuilds?: readonly NativeCliBuild[];
  /** Advances only on an actual main-loop turn.start, not a button press or terminal repaint. */
  turnEpoch(): number;
  onState?(state: AutoContinueState): void;
}

/** Observes native-owned scheduling; owns no timer, prompt, pricing or subscription request. */
export class NativeQuotaControls {
  private readonly sessionId: string;
  private revision = -1;
  private state: AutoContinueState = { phase: 'idle' };
  constructor(private readonly options: NativeQuotaControlsOptions) {
    const snapshot = options.ui.snapshot();
    // An unknown CLI build only leaves its banner unrecognized: the session itself must still start.
    if (!snapshot.sessionId) throw new NativeControlGate('quota', 'unverified native session/version.');
    this.sessionId = snapshot.sessionId;
  }

  observe(snapshot = this.options.ui.snapshot()): AutoContinueState {
    if (!this.belongs(snapshot) || snapshot.revision < this.revision) return this.read();
    this.revision = snapshot.revision;
    const view = nativeQuotaView(snapshot, this.options.admittedBuilds);
    this.publish(view ? { phase: 'native-waiting', message: view.message, canContinue: view.phase === 'stale' && view.emptyComposer,
      schedule: 'unreported' } : { phase: 'idle' });
    return this.read();
  }

  read(): AutoContinueState { return { ...this.state }; }

  cancel(): Promise<void> {
    return this.options.ui.run('quota.cancel', async tx => {
      const before = tx.snapshot();
      const view = this.view(before);
      if (!view?.emptyComposer || !tx.quotaKey) throw new NativeControlGate('quota.cancel', 'no verified native quota wait with an empty composer.');
      const count = (text: string) => text.split(CANCELLED).length - 1;
      const prior = count(before.text);
      const after = await tx.quotaKey('\x1b', snapshot => this.view(snapshot)?.emptyComposer === true,
        snapshot => this.belongs(snapshot) && !nativeQuotaView(snapshot, this.options.admittedBuilds) && count(snapshot.text) > prior);
      this.observe(after);
    });
  }

  continue(): Promise<void> {
    return this.options.ui.run('quota.continue', async tx => {
      const before = tx.snapshot();
      const view = this.view(before);
      if (view?.phase !== 'stale' || !view.emptyComposer || !tx.quotaKey) {
        throw new NativeControlGate('quota.continue', 'native Enter continuation is available only after the CLI reports a stale reset, with an empty composer.');
      }
      const epoch = this.options.turnEpoch();
      const after = await tx.quotaKey('\r', snapshot => {
        const current = this.view(snapshot);
        return current?.phase === 'stale' && current.emptyComposer;
      }, snapshot => this.belongs(snapshot) && !nativeQuotaView(snapshot, this.options.admittedBuilds) && this.options.turnEpoch() > epoch);
      this.observe(after);
    });
  }

  private belongs(snapshot: NativeUiSnapshot): boolean {
    return snapshot.sessionId === this.sessionId && Boolean(nativeCliBuild(snapshot.cliSha256, this.options.admittedBuilds)) && snapshot.source !== 'command-result';
  }
  private view(snapshot: NativeUiSnapshot): NativeQuotaView | null { return this.belongs(snapshot) ? nativeQuotaView(snapshot, this.options.admittedBuilds) : null; }
  private publish(state: AutoContinueState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.onState?.(this.read());
  }
}
