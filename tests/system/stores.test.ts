import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_SHORTCUTS, seedShortcuts, type Shortcut } from '@shared/shortcuts';
import { defaultSettings } from '@shared/types';
import {
  LEGACY_SEED_IDS,
  addNewSeeds,
  createSettingsStore,
  createShortcutStore,
  sanitizeSettings,
} from '../../src/main/system/stores';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-stores-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
const tmpFiles = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f.endsWith('.tmp'));

describe('settings store', () => {
  it('seeds defaults on first run and writes them', async () => {
    expect(await createSettingsStore(dir).get()).toEqual(defaultSettings());
    expect(await readJson('settings.json')).toMatchObject({ version: 1, theme: 'system', language: 'en' });
  });

  it('applies a valid patch atomically and persists it', async () => {
    const store = createSettingsStore(dir);
    const next = await store.set({
      theme: 'dark',
      fontScale: 1.25,
      defaultEffort: 'high',
      defaultPermissionMode: 'acceptEdits',
      defaultModel: 'opus',
      recentFolders: ['D:\\a', 'd:\\A\\', 'C:/b'],
    });
    expect(next).toEqual({
      theme: 'dark',
      language: 'en',
      fontScale: 1.25,
      defaultEffort: 'high',
      defaultPermissionMode: 'acceptEdits',
      defaultModel: 'opus',
      recentFolders: ['D:\\a', 'C:\\b'],
    });
    expect(await createSettingsStore(dir).get()).toEqual(next);
    expect(await tmpFiles()).toEqual([]);
  });

  it('clears optional settings with undefined or null', async () => {
    const store = createSettingsStore(dir);
    await store.set({ defaultModel: 'opus', defaultEffort: 'low' });
    const cleared = await store.set({ defaultModel: undefined, defaultEffort: null as never });
    expect(cleared).not.toHaveProperty('defaultModel');
    expect(cleared).not.toHaveProperty('defaultEffort');
  });

  it('keeps the dynamic workflows choice, clears it back to the plan default and refuses other values', async () => {
    const store = createSettingsStore(dir);
    expect(await store.get()).not.toHaveProperty('workflows');
    expect((await store.set({ workflows: 'on' })).workflows).toBe('on');
    expect((await createSettingsStore(dir).get()).workflows).toBe('on');
    expect((await store.set({ workflows: 'off' })).workflows).toBe('off');
    await expect(store.set({ workflows: true as never })).rejects.toThrow();
    expect((await store.get()).workflows).toBe('off');
    expect(await store.set({ workflows: null as never })).not.toHaveProperty('workflows');
    expect(await createSettingsStore(dir).get()).not.toHaveProperty('workflows');
  });

  it('keeps the automatic continue choice as a boolean, clears it back to on and refuses other values', async () => {
    const store = createSettingsStore(dir);
    expect(await store.get()).not.toHaveProperty('autoContinue');
    expect((await store.set({ autoContinue: false })).autoContinue).toBe(false);
    expect((await createSettingsStore(dir).get()).autoContinue).toBe(false);
    expect((await store.set({ autoContinue: true })).autoContinue).toBe(true);
    for (const bad of ['off', 0, 1, {}]) await expect(store.set({ autoContinue: bad as never })).rejects.toThrow();
    expect((await store.get()).autoContinue).toBe(true);
    expect(await store.set({ autoContinue: null as never })).not.toHaveProperty('autoContinue');
    expect(await createSettingsStore(dir).get()).not.toHaveProperty('autoContinue');
    expect(sanitizeSettings({ autoContinue: false }).autoContinue).toBe(false);
    expect(sanitizeSettings({ autoContinue: 'false' })).not.toHaveProperty('autoContinue');
  });

  it('keeps the context refresh choice as a boolean, clears it back to off and refuses other values', async () => {
    const store = createSettingsStore(dir);
    expect(await store.get()).not.toHaveProperty('liveContext');
    expect((await store.set({ liveContext: true })).liveContext).toBe(true);
    expect((await createSettingsStore(dir).get()).liveContext).toBe(true);
    for (const bad of ['on', 1, {}]) await expect(store.set({ liveContext: bad as never })).rejects.toThrow();
    expect((await store.get()).liveContext).toBe(true);
    expect(await store.set({ liveContext: null as never })).not.toHaveProperty('liveContext');
    expect(sanitizeSettings({ liveContext: 'true' })).not.toHaveProperty('liveContext');
  });

  it('persists and clears activeProfileId while rejecting malformed identifiers', async () => {
    const store = createSettingsStore(dir);
    await store.set({ activeProfileId: 'work_2' });
    expect((await createSettingsStore(dir).get()).activeProfileId).toBe('work_2');
    await expect(store.set({ activeProfileId: '../default' })).rejects.toThrow();
    expect((await store.get()).activeProfileId).toBe('work_2');
    expect(await store.set({ activeProfileId: undefined })).not.toHaveProperty('activeProfileId');
  });

  it.each([
    ['unknown key', { colour: 'red' }],
    ['bad theme', { theme: 'neon' }],
    ['bad language', { language: 'fr' }],
    ['font too big', { fontScale: 5 }],
    ['font NaN', { fontScale: Number.NaN }],
    ['bad effort', { defaultEffort: 'ultra' }],
    ['bad mode', { defaultPermissionMode: 'yolo' }],
    ['UNC recent folder', { recentFolders: ['\\\\srv\\share'] }],
    ['required key cleared', { theme: undefined }],
    ['not an object', 'dark'],
  ])('rejects %s and writes nothing', async (_name, patch) => {
    const store = createSettingsStore(dir);
    await store.set({ theme: 'light' });
    await expect(store.set(patch as never)).rejects.toThrow();
    expect((await readJson('settings.json')).theme).toBe('light');
    expect(await store.get()).toMatchObject({ theme: 'light' });
  });

  it('falls back per field on a hand-edited file and to defaults on a corrupt one', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ theme: 'dark', language: 'xx', fontScale: 'big', recentFolders: ['C:\\ok', 7], extra: 1 }),
    );
    expect(await createSettingsStore(dir).get()).toEqual({ ...defaultSettings(), theme: 'dark' });

    await writeFile(join(dir, 'settings.json'), '{oops');
    expect(await createSettingsStore(dir).get()).toEqual(defaultSettings());
    expect((await readdir(dir)).some((f) => f.startsWith('settings.json.invalid-'))).toBe(true);
  });

  it('caps recent folders', () => {
    const folders = Array.from({ length: 30 }, (_, i) => `D:\\p${i}`);
    expect(sanitizeSettings({ recentFolders: folders }).recentFolders).toHaveLength(20);
  });

  it('reset returns fresh defaults', async () => {
    const store = createSettingsStore(dir);
    await store.set({ theme: 'dark' });
    expect(await store.reset()).toEqual(defaultSettings());
    expect(await createSettingsStore(dir).get()).toEqual(defaultSettings());
  });
});

const custom = (over: Partial<Shortcut> = {}): Shortcut => ({
  id: 'custom.1',
  label: 'Review',
  group: 'custom',
  kind: 'prompt',
  text: 'Please review\nthe diff',
  mode: 'fill',
  hotkey: 'Alt+1',
  ...over,
});

describe('shortcut store', () => {
  it('seeds from SEED_SHORTCUTS on first run', async () => {
    const list = await createShortcutStore(dir).get();
    expect(list).toEqual(seedShortcuts());
    expect(list.map((s) => s.id)).toContain('seed.handoff.toDesktop');
    const stored = await readJson('shortcuts.json');
    expect((stored.shortcuts as unknown[]).length).toBe(SEED_SHORTCUTS.length);
    expect(stored.seenSeeds).toEqual(SEED_SHORTCUTS.map((x) => x.id));
  });

  it('every seed passes its own validation', async () => {
    await expect(createShortcutStore(dir).set(seedShortcuts())).resolves.toEqual(seedShortcuts());
  });

  it('set stores a validated copy with only known keys and survives a reload', async () => {
    const store = createShortcutStore(dir);
    const saved = await store.set([{ ...custom(), extra: 'x' } as Shortcut, custom({ id: 'a', kind: 'action', action: 'session.interrupt', text: 'dropped', hotkey: undefined })]);
    expect(saved).toEqual([
      custom(),
      { id: 'a', label: 'Review', group: 'custom', kind: 'action', action: 'session.interrupt', mode: 'fill' },
    ]);
    expect(await createShortcutStore(dir).get()).toEqual(saved);
  });

  it.each([
    ['missing text', [custom({ text: '  ' })]],
    ['slash without /', [custom({ kind: 'slash', text: 'compact' })]],
    ['unknown action', [custom({ kind: 'action', action: 'shell.run' as never })]],
    ['bad group', [custom({ group: 'other' as never })]],
    ['bad mode', [custom({ mode: 'auto' as never })]],
    ['control chars', [custom({ text: 'a\u0007b' })]],
    ['bad hotkey', [custom({ hotkey: 'Alt+Enter' })]],
    ['bad id', [custom({ id: '../x' })]],
    ['duplicate id', [custom(), custom({ hotkey: 'Alt+2' })]],
    ['duplicate hotkey', [custom(), custom({ id: 'custom.2' })]],
    ['not an array', { list: [] }],
  ])('set rejects %s and keeps the stored list', async (_name, list) => {
    const store = createShortcutStore(dir);
    const before = await store.get();
    await expect(store.set(list as never)).rejects.toThrow();
    expect(await createShortcutStore(dir).get()).toEqual(before);
  });

  it('a hand-edited file keeps its valid entries; a corrupt one is replaced by the seed', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'shortcuts.json'),
      JSON.stringify({
        version: 1,
        seenSeeds: SEED_SHORTCUTS.map((x) => x.id),
        shortcuts: [custom(), { id: 'bad' }, custom({ label: 'dup' }), custom({ id: 'b' })],
      }),
    );
    // 'bad' is invalid, the second custom.1 is a duplicate id, and b loses the hotkey custom.1 already uses.
    const { hotkey: _taken, ...b } = custom({ id: 'b' });
    expect(await createShortcutStore(dir).get()).toEqual([custom(), b]);

    await writeFile(join(dir, 'shortcuts.json'), JSON.stringify({ shortcuts: 'nope' }));
    expect(await createShortcutStore(dir).get()).toEqual(seedShortcuts());
  });

  it('reset restores the seed', async () => {
    const store = createShortcutStore(dir);
    await store.set([custom()]);
    expect(await store.reset()).toEqual(seedShortcuts());
    expect(await createShortcutStore(dir).get()).toEqual(seedShortcuts());
  });

  describe('seenSeeds', () => {
    const NEW_IDS = ['seed.cmd.usage', 'seed.cmd.context', 'seed.cmd.usagePanel'];
    const legacyFile = (extra: Shortcut[] = []): unknown => ({
      version: 1,
      shortcuts: [...seedShortcuts().filter((x) => LEGACY_SEED_IDS.includes(x.id)), ...extra],
    });
    const writeShortcuts = async (value: unknown): Promise<void> => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'shortcuts.json'), JSON.stringify(value));
    };

    it('the legacy ids are the seeds that existed before the usage seeds', () => {
      expect(LEGACY_SEED_IDS).toHaveLength(22);
      expect(SEED_SHORTCUTS.map((x) => x.id).filter((id) => !LEGACY_SEED_IDS.includes(id))).toEqual(NEW_IDS);
    });

    it('a file without seenSeeds gets exactly the new seeds once, after its command group', async () => {
      await writeShortcuts(legacyFile([custom()]));
      const ids = (await createShortcutStore(dir).get()).map((x) => x.id);
      expect(ids.filter((id) => NEW_IDS.includes(id))).toEqual(NEW_IDS);
      expect(ids.indexOf('seed.cmd.usage')).toBe(ids.indexOf('seed.cmd.autocompact') + 1);
      expect(ids.indexOf('seed.handoff.toDesktop')).toBe(ids.indexOf('seed.cmd.usagePanel') + 1);
      expect(ids[ids.length - 1]).toBe('custom.1');
      expect([...((await readJson('shortcuts.json')).seenSeeds as string[])].sort()).toEqual(
        SEED_SHORTCUTS.map((x) => x.id).sort(),
      );
    });

    it('a deleted seed stays deleted and a second load adds nothing', async () => {
      await writeShortcuts(legacyFile());
      const first = await createShortcutStore(dir).get();
      const kept = first.filter((x) => x.id !== 'seed.cmd.usage' && x.id !== 'seed.reply.ok');
      const store = createShortcutStore(dir);
      await store.set(kept);
      const again = await createShortcutStore(dir).get();
      expect(again).toEqual(kept);
      expect(again.map((x) => x.id)).not.toContain('seed.cmd.usage');
      expect((await readJson('shortcuts.json')).shortcuts).toEqual(kept);
    });

    it('a legacy file that deleted a legacy seed does not get it back', async () => {
      await writeShortcuts({ version: 1, shortcuts: seedShortcuts().filter((x) => x.id !== 'seed.reply.ok' && LEGACY_SEED_IDS.includes(x.id)) });
      const ids = (await createShortcutStore(dir).get()).map((x) => x.id);
      expect(ids).not.toContain('seed.reply.ok');
      expect(ids).toContain('seed.cmd.usage');
    });

    it('does not duplicate a seed that already exists in the list', () => {
      const existing = seedShortcuts().filter((x) => x.id !== 'seed.cmd.context');
      const { list, added } = addNewSeeds(existing, []);
      expect(added).toEqual(['seed.cmd.context']);
      expect(list.filter((x) => x.id === 'seed.cmd.usage')).toHaveLength(1);
      expect(addNewSeeds([], []).list.map((x) => x.id)).toEqual(SEED_SHORTCUTS.map((x) => x.id));
    });

    it('reset writes all seeds and seenSeeds; set keeps seenSeeds', async () => {
      const store = createShortcutStore(dir);
      await store.set([custom()]);
      const stored = await readJson('shortcuts.json');
      expect(stored.seenSeeds).toEqual(SEED_SHORTCUTS.map((x) => x.id));
      await writeShortcuts({ ...stored, seenSeeds: ['x.old'] });
      const other = createShortcutStore(dir);
      await other.set([custom()]);
      expect((await readJson('shortcuts.json')).seenSeeds).toEqual(['x.old', ...SEED_SHORTCUTS.map((x) => x.id)]);
      expect(await other.reset()).toEqual(seedShortcuts());
      expect((await readJson('shortcuts.json')).seenSeeds).toEqual(SEED_SHORTCUTS.map((x) => x.id));
    });
  });
});
