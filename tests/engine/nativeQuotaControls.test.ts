import { describe, expect, it, vi } from 'vitest';
import { NativeControlGate, NATIVE_UI_PINNED_SHA256, type NativeUiController, type NativeUiSnapshot, type NativeUiTransaction } from '../../src/main/native/controls';
import { NativeQuotaControls, nativeQuotaView } from '../../src/main/native/nativeQuotaControls';

const WAIT = 'Usage limit reached \u00b7 limit resets 3pm\nContinuing automatically at 3pm \u00b7 esc to cancel\n\u276f';
const STALE = 'Your usage limit has reset\nPress enter to continue\n\u276f';
const CANCELLED = 'Automatic continue cancelled \u00b7 /rate-limit-options to re-arm\n\u276f';
const snapshot = (text: string, revision = 1): NativeUiSnapshot => ({ sessionId: 'one', cliSha256: NATIVE_UI_PINNED_SHA256, revision, text });

function harness(text = WAIT) {
  let current = snapshot(text), epoch = 0;
  let outcome = (bytes: string) => { current = snapshot(bytes === '\x1b' ? CANCELLED : 'Working', current.revision + 1); if (bytes === '\r') epoch++; };
  const keys: string[] = [], operations: string[] = [];
  const unused = vi.fn(async () => { throw new Error('No command or generic input is permitted.'); });
  const tx: NativeUiTransaction = {
    snapshot: () => current, wait: unused, open: unused, key: unused,
    quotaKey: async (bytes, guard, settled) => {
      if (!guard(current)) throw new NativeControlGate('quota', 'guard refused');
      keys.push(bytes); outcome(bytes);
      if (!settled(current)) throw new NativeControlGate('quota', 'native action not confirmed');
      return current;
    },
  };
  const ui: Pick<NativeUiController, 'snapshot' | 'run'> = {
    snapshot: () => current,
    async run<T>(operation: string, action: (transaction: NativeUiTransaction) => Promise<T>): Promise<T> {
      operations.push(operation); return action(tx);
    },
  };
  const onState = vi.fn();
  const controls = new NativeQuotaControls({ ui, turnEpoch: () => epoch, onState });
  return { controls, keys, operations, unused, onState,
    set: (text: string) => { current = snapshot(text, current.revision + 1); },
    outcome: (fn: (bytes: string) => void) => { outcome = fn; },
  };
}

describe('native quota projection and controls', () => {
  it('reports native-owned waiting text without invented reset time, jitter deadline or retry count', () => {
    const h = harness();
    expect(h.controls.observe()).toEqual({ phase: 'native-waiting', message: 'Usage limit reached \u00b7 limit resets 3pm \u00b7 Continuing automatically at 3pm \u00b7 esc to cancel',
      canContinue: false, schedule: 'unreported' });
    expect(h.controls.read()).not.toHaveProperty('fireAt');
    expect(h.controls.read()).not.toHaveProperty('attempt');
    h.controls.observe();
    expect(h.onState).toHaveBeenCalledTimes(1);
    expect(h.keys).toEqual([]);
  });

  it('reads the waiting footer as CLI 2.1.312 writes it, with a capital Esc', () => {
    for (const next of ['Continuing automatically at 3pm · Esc to cancel', 'Continuing automatically when it resets · Esc to cancel',
      'Continuing shortly · Esc to cancel', 'Continuing shortly · esc to cancel']) {
      expect(nativeQuotaView(snapshot(`Usage limit reached · limit resets 3pm\n${next}\n❯`))).toMatchObject({ phase: 'waiting',
        message: `Usage limit reached · limit resets 3pm · ${next}` });
    }
    expect(nativeQuotaView(snapshot('Usage limit reached\nContinuing shortly · ESC to cancel\n❯'))).toBeNull();
    expect(nativeQuotaView(snapshot('Usage limit reached\nContinuing shortly · Esc to stop\n❯'))).toBeNull();
  });

  it('allows native stale Enter only with an empty composer', () => {
    const h = harness(STALE);
    expect(h.controls.observe()).toMatchObject({ phase: 'native-waiting', canContinue: true, schedule: 'unreported' });
    h.set(STALE.replace('\u276f', '\u276f unsent user text'));
    expect(h.controls.observe()).toMatchObject({ canContinue: false });
    h.set(`${STALE}\n[Image #1]`);
    expect(h.controls.observe()).toMatchObject({ canContinue: false });
  });

  it('ignores other sessions, old revisions, unpinned binaries and command-result text', () => {
    const h = harness();
    const original = h.controls.observe();
    expect(h.controls.observe({ ...snapshot('no wait', 2), sessionId: 'another' })).toEqual(original);
    expect(h.controls.observe(snapshot('no wait', 0))).toEqual(original);
    expect(nativeQuotaView({ ...snapshot(STALE), cliSha256: 'other' })).toBeNull();
    expect(nativeQuotaView({ ...snapshot(STALE), source: 'command-result' })).toBeNull();
    expect(nativeQuotaView(snapshot(`${STALE}\nEnter to select \u00b7 Esc to back`))).toBeNull();
    expect(nativeQuotaView(snapshot('Usage limit reached\nUnknown translated layout\n\u276f'))).toBeNull();
    expect(nativeQuotaView(snapshot(`${WAIT}\n${STALE}`))).toBeNull();
    expect(nativeQuotaView(snapshot(`${STALE}\n\u276f user draft`))).toMatchObject({ emptyComposer: false });
  });

  it('cancels through genuine Esc and accepts only a new native cancellation acknowledgement', async () => {
    const h = harness(); h.controls.observe();
    await h.controls.cancel();
    expect(h.operations).toEqual(['quota.cancel']);
    expect(h.keys).toEqual(['\x1b']);
    expect(h.controls.read()).toEqual({ phase: 'idle' });
    expect(h.unused).not.toHaveBeenCalled();
    const unconfirmed = harness(); unconfirmed.controls.observe();
    unconfirmed.outcome(() => unconfirmed.set('\u276f'));
    await expect(unconfirmed.controls.cancel()).rejects.toThrow('not confirmed');
    expect(unconfirmed.controls.read()).toMatchObject({ phase: 'native-waiting' });
  });

  it('continues by empty Enter after native stale state and requires an actual new turn', async () => {
    const h = harness(STALE); h.controls.observe();
    await h.controls.continue();
    expect(h.operations).toEqual(['quota.continue']);
    expect(h.keys).toEqual(['\r']);
    expect(h.controls.read()).toEqual({ phase: 'idle' });
    expect(h.unused).not.toHaveBeenCalled();
    const unconfirmed = harness(STALE); unconfirmed.controls.observe();
    unconfirmed.outcome(() => unconfirmed.set('Working'));
    await expect(unconfirmed.controls.continue()).rejects.toThrow('not confirmed');
    expect(unconfirmed.controls.read()).toMatchObject({ phase: 'native-waiting' });
  });

  it('does not send Continue during an armed wait or overwrite a nonempty composer', async () => {
    const h = harness();
    await expect(h.controls.continue()).rejects.toThrow('only after');
    expect(h.keys).toEqual([]);
    h.set(STALE.replace('\u276f', '\u276f user draft'));
    await expect(h.controls.continue()).rejects.toThrow('empty composer');
    await expect(h.controls.cancel()).rejects.toThrow('empty composer');
    expect(h.keys).toEqual([]);
  });
});
