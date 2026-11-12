import { describe, expect, it } from 'vitest';
import type { EffortGuide } from '@shared/types';
import { withEffortGuides } from '../../src/main/native/effortGuide';
import { nativeModelCatalog } from '../../src/main/native/modelCatalog';
import { NATIVE_SESSION_MODELS } from '../../src/main/native/sessionSettings';
import { modelMenu } from '../../src/renderer/lib/models';

// The pinned CLI's config.list model enum.
const NATIVE_ENUM = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'];
const FABLE = ['fable', 'claude-fable-5-2', 'claude-fable-5-1'];

describe('native config model catalog display metadata', () => {
  it('lists only the values setModel can apply, with readable identities from the attested registry', () => {
    const rows = nativeModelCatalog([...NATIVE_ENUM, 'provider/custom-model', 'claude-opus-99-1', 7, null]);
    expect(rows.map((row) => row.value)).toEqual(['default', 'sonnet', 'opus', 'haiku', 'fable']);
    expect(rows.every((row) => row.catalogSource === 'native-config')).toBe(true);
    expect(rows[0]).toEqual({ value: 'default', label: 'default', catalogSource: 'native-config' });
    for (const entry of NATIVE_SESSION_MODELS.filter((item) => item.alias !== 'fable')) {
      expect(rows.find((row) => row.value === entry.alias)).toEqual({
        value: entry.alias, label: entry.display, catalogSource: 'native-config', equivalentValues: [entry.alias, entry.model],
      });
    }
  });

  it('names the fable alias by its family only, since 5.2 or 5.1 runs for it by build and account', () => {
    expect(NATIVE_SESSION_MODELS.filter((item) => item.alias === 'fable').map((item) => item.model)).toEqual(['claude-fable-5-2', 'claude-fable-5-1']);
    const fable = nativeModelCatalog(NATIVE_ENUM).find((row) => row.value === 'fable');
    expect(fable).toEqual({ value: 'fable', label: 'Fable', catalogSource: 'native-config', equivalentValues: FABLE });
    // A full ID names its own model.
    expect(nativeModelCatalog(['claude-fable-5-1'])).toEqual([{ value: 'claude-fable-5-1', label: 'Fable 5.1', catalogSource: 'native-config',
      equivalentValues: ['fable', 'claude-fable-5-1'] }]);
  });

  it('shows one Fable row named after the model the session getter reports, with that model’s effort notes', () => {
    const rows = nativeModelCatalog(NATIVE_ENUM);
    for (const [getter, name] of [['claude-fable-5-2', 'Fable 5.2'], ['claude-fable-5-1', 'Fable 5.1']] as const) {
      const menu = modelMenu(getter, rows, 'Default model');
      expect(menu.main.filter((row) => row.name.startsWith('Fable'))).toEqual([{ value: 'fable', name }]);
      expect(menu).toMatchObject({ current: name, currentValue: 'fable' });
    }
    expect(modelMenu('claude-opus-5-5', rows, 'Default model').main.find((row) => row.value === 'fable')).toEqual({ value: 'fable', name: 'Fable' });
    const notes = (description: string): EffortGuide => ({ description, levels: { high: { badge: { message: 'Recommended', tone: 'neutral' } } } });
    const guides = withEffortGuides(rows, { 'claude-fable-5-2': notes('Fable 5.2 notes'), 'claude-fable-5-1': notes('Fable 5.1 notes') });
    // The alias alone does not say which model runs: the row carries each model's notes and no single set
    // (tests/renderer/effortGuide.test.tsx reads them back by the session's model).
    const fable = guides.find((row) => row.value === 'fable')!;
    expect(fable.effortGuide).toBeUndefined();
    expect(fable.effortGuideByModel).toEqual({ 'claude-fable-5-2': notes('Fable 5.2 notes'), 'claude-fable-5-1': notes('Fable 5.1 notes') });
    expect(withEffortGuides(rows, { 'claude-fable-5-2': notes('Fable 5.2 notes') }).find((row) => row.value === 'fable')!.effortGuideByModel)
      .toEqual({ 'claude-fable-5-2': notes('Fable 5.2 notes') });
    expect(guides.find((row) => row.value === 'opus')).not.toHaveProperty('effortGuideByModel');
  });

  it('keeps a full model ID choice in its supplied order without rewriting or deduplicating it', () => {
    const opus = NATIVE_SESSION_MODELS.find((entry) => entry.alias === 'opus')!;
    const raw = ['opus', 'opus[1m]', opus.model, `${opus.model}[1m]`];
    const rows = nativeModelCatalog(raw);
    expect(rows.map((row) => row.value)).toEqual(['opus', opus.model]);
    expect(rows.map((row) => row.label)).toEqual([opus.display, opus.display]);
    expect(rows[1]?.equivalentValues).toEqual([opus.alias, opus.model]);
    expect(raw).toEqual(['opus', 'opus[1m]', opus.model, `${opus.model}[1m]`]);
  });
});
