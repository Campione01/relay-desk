import { join } from 'node:path';
import { SEED_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_GROUPS, SHORTCUT_KINDS, seedShortcuts, type Shortcut } from '@shared/shortcuts';
import { EFFORT_LEVELS, PERMISSION_MODES, defaultSettings, isWorkflowsSetting, type AppSettings } from '@shared/types';
import { createSerialQueue, quarantineFile, readJsonFile, writeJsonFileAtomic } from './jsonFile';
import { toLocalAbsolutePath } from './paths';

/** settings.json under userData: atomic write, schema validation, defaults on first run. */
export interface SettingsStore {
  get(): Promise<AppSettings>;
  /** Rejects (and writes nothing) when a key is unknown or a value invalid; undefined/null clears an optional key. */
  set(patch: Partial<AppSettings>): Promise<AppSettings>;
  reset(): Promise<AppSettings>;
}

/** shortcuts.json under userData: seeded from SEED_SHORTCUTS on first run. */
export interface ShortcutStore {
  get(): Promise<Shortcut[]>;
  /** Rejects (and writes nothing) when any entry is invalid. */
  set(list: Shortcut[]): Promise<Shortcut[]>;
  reset(): Promise<Shortcut[]>;
}

const FILE_VERSION = 1;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
export const MAX_RECENT_FOLDERS = 20;
export const FONT_SCALE_RANGE = [0.75, 2] as const;
export const MAX_SHORTCUTS = 200;

class ValidationError extends Error {
  override name = 'ValidationError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !CONTROL.test(trimmed) ? trimmed : null;
}

// ---------- settings ----------

type SettingKey = keyof AppSettings;
const SETTING_KEYS: readonly SettingKey[] = [
  'theme',
  'language',
  'fontScale',
  'defaultModel',
  'defaultEffort',
  'defaultPermissionMode',
  'workflows',
  'autoContinue',
  'liveContext',
  'recentFolders',
  'activeProfileId',
];
const OPTIONAL_SETTINGS: readonly SettingKey[] = [
  'defaultModel',
  'defaultEffort',
  'defaultPermissionMode',
  'workflows',
  'autoContinue',
  'liveContext',
  'activeProfileId',
];

function normalizeFolders(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const path = toLocalAbsolutePath(item);
    if (!path) return null;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result.slice(0, MAX_RECENT_FOLDERS);
}

/** Pure: validated value for one setting, or undefined when invalid. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): AppSettings[K] | undefined {
  switch (key) {
    case 'activeProfileId':
      return (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
        ? value : undefined) as AppSettings[K] | undefined;
    case 'theme':
      return (['system', 'light', 'dark'].includes(value as string) ? value : undefined) as AppSettings[K] | undefined;
    case 'language':
      return (['zh-TW', 'en'].includes(value as string) ? value : undefined) as AppSettings[K] | undefined;
    case 'fontScale':
      return (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= FONT_SCALE_RANGE[0] &&
      value <= FONT_SCALE_RANGE[1]
        ? value
        : undefined) as AppSettings[K] | undefined;
    case 'defaultModel':
      return (shortText(value, 128) ?? undefined) as AppSettings[K] | undefined;
    case 'defaultEffort':
      return (EFFORT_LEVELS.includes(value as never) ? value : undefined) as AppSettings[K] | undefined;
    case 'defaultPermissionMode':
      return (PERMISSION_MODES.includes(value as never) ? value : undefined) as AppSettings[K] | undefined;
    case 'workflows':
      return (isWorkflowsSetting(value) ? value : undefined) as AppSettings[K] | undefined;
    case 'autoContinue':
    case 'liveContext':
      return (typeof value === 'boolean' ? value : undefined) as AppSettings[K] | undefined;
    case 'recentFolders':
      return (normalizeFolders(value) ?? undefined) as AppSettings[K] | undefined;
    default:
      return undefined;
  }
}

/** Pure: stored JSON -> settings; every invalid or missing field falls back to its default. */
export function sanitizeSettings(value: unknown): AppSettings {
  const result = defaultSettings();
  if (!isRecord(value)) return result;
  for (const key of SETTING_KEYS) {
    if (!(key in value)) continue;
    const valid = validateSetting(key, value[key]);
    if (valid !== undefined) (result as unknown as Record<string, unknown>)[key] = valid;
  }
  return result;
}

/** Pure: applies a renderer patch; throws ValidationError on unknown keys or invalid values. */
export function applySettingsPatch(current: AppSettings, patch: unknown): AppSettings {
  if (!isRecord(patch)) throw new ValidationError('Settings patch must be an object');
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.includes(key as SettingKey)) throw new ValidationError(`Unknown setting: ${key}`);
    if ((value === undefined || value === null) && OPTIONAL_SETTINGS.includes(key as SettingKey)) {
      delete next[key];
      continue;
    }
    const valid = validateSetting(key as SettingKey, value);
    if (valid === undefined) throw new ValidationError(`Invalid value for setting ${key}`);
    next[key] = valid;
  }
  return next as unknown as AppSettings;
}

export function createSettingsStore(userDataDir: string): SettingsStore {
  const file = join(userDataDir, 'settings.json');
  const serial = createSerialQueue();
  let cache: AppSettings | undefined;

  const save = async (settings: AppSettings): Promise<AppSettings> => {
    await writeJsonFileAtomic(file, { version: FILE_VERSION, ...settings });
    cache = settings;
    return structuredClone(settings);
  };

  const load = async (): Promise<AppSettings> => {
    if (cache) return cache;
    const read = await readJsonFile(file);
    if (read.state === 'missing') return save(defaultSettings()).then(() => cache!);
    if (read.state === 'invalid' || !isRecord(read.value)) {
      await quarantineFile(file);
      return save(defaultSettings()).then(() => cache!);
    }
    cache = sanitizeSettings(read.value);
    return cache;
  };

  return {
    get: () => serial(async () => structuredClone(await load())),
    set: (patch) => serial(async () => save(applySettingsPatch(await load(), patch))),
    reset: () => serial(() => save(defaultSettings())),
  };
}

// ---------- shortcuts ----------

const ID = /^[A-Za-z0-9._:-]{1,100}$/;
const HOTKEY = /^((Ctrl|Alt|Shift)\+){1,3}([A-Z0-9]|F([1-9]|1[0-2]))$/;

/** Pure: one validated shortcut with only the known keys, or a reason why it is invalid. */
export function validateShortcut(value: unknown): Shortcut | string {
  if (!isRecord(value)) return 'not an object';
  const { id, label, group, kind, text, action, mode, hotkey, hint } = value;
  if (typeof id !== 'string' || !ID.test(id)) return 'invalid id';
  const cleanLabel = shortText(label, 60);
  if (!cleanLabel) return `${id}: invalid label`;
  if (!SHORTCUT_GROUPS.includes(group as never)) return `${id}: invalid group`;
  if (!SHORTCUT_KINDS.includes(kind as never)) return `${id}: invalid kind`;
  if (mode !== 'send' && mode !== 'fill') return `${id}: invalid mode`;
  const shortcut: Shortcut = {
    id,
    label: cleanLabel,
    group: group as Shortcut['group'],
    kind: kind as Shortcut['kind'],
    mode,
  };
  if (kind === 'action') {
    if (!SHORTCUT_ACTIONS.includes(action as never)) return `${id}: invalid action`;
    shortcut.action = action as Shortcut['action'];
  } else {
    if (typeof text !== 'string' || !text.trim() || text.length > 10_000 || CONTROL_EXCEPT_NEWLINE_TAB.test(text)) {
      return `${id}: invalid text`;
    }
    if (kind === 'slash' && !text.startsWith('/')) return `${id}: slash text must start with /`;
    shortcut.text = text;
  }
  if (hotkey !== undefined && hotkey !== null && hotkey !== '') {
    if (typeof hotkey !== 'string' || !HOTKEY.test(hotkey)) return `${id}: invalid hotkey`;
    shortcut.hotkey = hotkey;
  }
  if (hint !== undefined && hint !== null && hint !== '') {
    const cleanHint = shortText(hint, 200);
    if (!cleanHint) return `${id}: invalid hint`;
    shortcut.hint = cleanHint;
  }
  return shortcut;
}

/** Pure, strict (renderer input): throws on the first invalid entry, duplicate id or duplicate hotkey. */
export function validateShortcutList(list: unknown): Shortcut[] {
  if (!Array.isArray(list)) throw new ValidationError('Shortcut list must be an array');
  if (list.length > MAX_SHORTCUTS) throw new ValidationError(`At most ${MAX_SHORTCUTS} shortcuts`);
  const result: Shortcut[] = [];
  const ids = new Set<string>();
  const hotkeys = new Set<string>();
  for (const item of list) {
    const checked = validateShortcut(item);
    if (typeof checked === 'string') throw new ValidationError(`Invalid shortcut: ${checked}`);
    if (ids.has(checked.id)) throw new ValidationError(`Duplicate shortcut id: ${checked.id}`);
    ids.add(checked.id);
    if (checked.hotkey) {
      if (hotkeys.has(checked.hotkey)) throw new ValidationError(`Duplicate hotkey: ${checked.hotkey}`);
      hotkeys.add(checked.hotkey);
    }
    result.push(checked);
  }
  return result;
}

/** Pure, lenient (stored file): keeps the valid entries, drops invalid and duplicate ones; null when unusable. */
export function sanitizeShortcutFile(value: unknown): Shortcut[] | null {
  if (!isRecord(value) || !Array.isArray(value.shortcuts)) return null;
  const result: Shortcut[] = [];
  const ids = new Set<string>();
  const hotkeys = new Set<string>();
  for (const item of value.shortcuts.slice(0, MAX_SHORTCUTS)) {
    const checked = validateShortcut(item);
    if (typeof checked === 'string' || ids.has(checked.id)) continue;
    ids.add(checked.id);
    if (checked.hotkey) {
      if (hotkeys.has(checked.hotkey)) delete checked.hotkey;
      else hotkeys.add(checked.hotkey);
    }
    result.push(checked);
  }
  return result;
}

/** Seed ids shipped before the seenSeeds list existed (0.1.1); a shortcuts.json without the list is treated as having seen these. */
export const LEGACY_SEED_IDS: readonly string[] = [
  'seed.reply.ok',
  'seed.reply.continue',
  'seed.reply.tryAgain',
  'seed.reply.anythingLeft',
  'seed.reply.changeSummary',
  'seed.reply.goalProgress',
  'seed.reply.testList',
  'seed.cmd.compact',
  'seed.cmd.compactWith',
  'seed.cmd.model',
  'seed.cmd.effort',
  'seed.cmd.permission',
  'seed.cmd.goal',
  'seed.cmd.autocompact',
  'seed.handoff.toDesktop',
  'seed.handoff.openFolderInDesktop',
  'seed.handoff.openInTerminal',
  'seed.handoff.openInTerminalFork',
  'seed.handoff.continueLatestInTerminal',
  'seed.handoff.toCloud',
  'seed.handoff.teleport',
  'seed.handoff.remoteControl',
];

const currentSeedIds = (): string[] => SEED_SHORTCUTS.map((s) => s.id);

/** Pure: the stored seenSeeds list, or null when absent or malformed. */
export function readSeenSeeds(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.seenSeeds)) return null;
  return [...new Set(value.seenSeeds.filter((id): id is string => typeof id === 'string' && ID.test(id)))];
}

/** Pure: appends the seeds whose id is not in `seen` (after the last shortcut of their group, else at the end). */
export function addNewSeeds(list: Shortcut[], seen: readonly string[]): { list: Shortcut[]; added: string[] } {
  const next = list.map((s) => ({ ...s }));
  const seenSet = new Set(seen);
  const ids = new Set(next.map((s) => s.id));
  const hotkeys = new Set(next.flatMap((s) => (s.hotkey ? [s.hotkey] : [])));
  const added: string[] = [];
  for (const seed of seedShortcuts()) {
    if (seenSet.has(seed.id) || ids.has(seed.id) || next.length >= MAX_SHORTCUTS) continue;
    if (seed.hotkey) {
      if (hotkeys.has(seed.hotkey)) delete seed.hotkey;
      else hotkeys.add(seed.hotkey);
    }
    let at = next.length;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]!.group === seed.group) {
        at = i + 1;
        break;
      }
    }
    next.splice(at, 0, seed);
    ids.add(seed.id);
    added.push(seed.id);
  }
  return { list: next, added };
}

export function createShortcutStore(userDataDir: string): ShortcutStore {
  const file = join(userDataDir, 'shortcuts.json');
  const serial = createSerialQueue();
  let cache: Shortcut[] | undefined;
  let seen: string[] = [];

  const save = async (list: Shortcut[], seenSeeds: string[]): Promise<Shortcut[]> => {
    const all = [...new Set([...seenSeeds, ...currentSeedIds()])];
    await writeJsonFileAtomic(file, { version: FILE_VERSION, seenSeeds: all, shortcuts: list });
    cache = list;
    seen = all;
    return structuredClone(list);
  };

  const load = async (): Promise<Shortcut[]> => {
    if (cache) return cache;
    const read = await readJsonFile(file);
    if (read.state === 'missing') return save(seedShortcuts(), []).then(() => cache!);
    const list = read.state === 'ok' ? sanitizeShortcutFile(read.value) : null;
    if (read.state !== 'ok' || !list) {
      await quarantineFile(file);
      return save(seedShortcuts(), []).then(() => cache!);
    }
    const stored = readSeenSeeds(read.value);
    const known = stored ?? [...LEGACY_SEED_IDS];
    const { list: merged, added } = addNewSeeds(list, known);
    if (added.length > 0 || !currentSeedIds().every((id) => known.includes(id))) {
      await save(merged, known);
    } else {
      cache = merged;
      seen = known;
    }
    return cache!;
  };

  return {
    get: () => serial(async () => structuredClone(await load())),
    set: (list) =>
      serial(async () => {
        const valid = validateShortcutList(list);
        await load();
        return save(valid, seen);
      }),
    reset: () => serial(() => save(seedShortcuts(), [])),
  };
}
