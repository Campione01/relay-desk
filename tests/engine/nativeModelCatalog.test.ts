import { describe, expect, it } from 'vitest';
import { nativeModelCatalog } from '../../src/main/native/modelCatalog';
import { NATIVE_SESSION_MODELS } from '../../src/main/native/sessionSettings';

// The pinned CLI's config.list model enum.
const NATIVE_ENUM = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'];

describe('native config model catalog display metadata', () => {
  it('lists only the values setModel can apply, with readable identities from the attested registry', () => {
    const rows = nativeModelCatalog([...NATIVE_ENUM, 'provider/custom-model', 'claude-opus-99-1', 7, null]);
    expect(rows.map((row) => row.value)).toEqual(['default', 'sonnet', 'opus', 'haiku', 'fable']);
    expect(rows.every((row) => row.catalogSource === 'native-config')).toBe(true);
    expect(rows[0]).toEqual({ value: 'default', label: 'default', catalogSource: 'native-config' });
    for (const entry of NATIVE_SESSION_MODELS) {
      expect(rows.find((row) => row.value === entry.alias)).toEqual({
        value: entry.alias, label: entry.display, catalogSource: 'native-config', equivalentValues: [entry.alias, entry.model],
      });
    }
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
