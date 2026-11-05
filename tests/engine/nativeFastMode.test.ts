import { describe, expect, it } from 'vitest';
import { nativeFastControl } from '../../src/main/native/fastMode';

const row = { key: 'fast', label: 'Fast mode (Opus 5.5)', kind: 'boolean', value: false, isLocked: false, provider: { plugin: 'engine', tier: 'core' } };
describe('genuine native Fast control projection', () => {
  it('exposes the initially-off native control without model capabilities or extra-usage guesses', () => {
    expect(nativeFastControl([row])).toEqual({ source: 'native-config', available: true, requested: false, locked: false, label: row.label, state: 'off' });
    expect(nativeFastControl([{ ...row, value: true }])).toEqual({ source: 'native-config', available: true, requested: true, locked: false, label: row.label });
    expect(nativeFastControl([{ ...row, isLocked: true }])).toMatchObject({ available: true, locked: true });
  });
  it('does not fabricate availability for missing, duplicate, malformed or plugin-owned rows', () => {
    for (const rows of [undefined, [], [row, row], [{ ...row, value: 'true' }], [{ ...row, key: 'fastMode' }], [{ ...row, provider: { plugin: 'other', tier: 'builtin' } }]]) {
      expect(nativeFastControl(rows)).toEqual({ source: 'native-config', available: false });
    }
  });
});
