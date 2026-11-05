import type { FastModeStatus, ModelOption, NativeFastControl } from '@shared/types';

/** One row of the model menu: the value sent to the CLI and the name shown. */
export interface ModelChoice {
  value: string;
  name: string;
}

// The desktop's "More models" submenu. With the user's settings loaded, supportedModels() lists these
// itself (with full ids); without them it lists only the current families, and this copy stands in.
export const MORE_MODELS: readonly ModelChoice[] = [
  { value: 'claude-haiku-4-5', name: 'Haiku 4.5' },
  { value: 'claude-sonnet-5', name: 'Sonnet 5' },
  { value: 'claude-opus-5', name: 'Opus 5' },
  { value: 'claude-fable-5', name: 'Fable 5' },
  { value: 'claude-opus-4-8', name: 'Opus 4.8' },
  { value: 'claude-opus-4-7', name: 'Opus 4.7' },
  { value: 'claude-opus-4-6', name: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
];

/** SDK entries that are not one model family: the CLI default and the mixed modes. */
const NON_FAMILY = new Set(['default', 'best', 'opusplan']);

const FAMILY_VERSION = /^[A-Z][A-Za-z]* \d+(?:\.\d+)?$/;

/** "claude-opus-5-5[1m]" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "opus" -> "Opus"; other ids stay. */
export function prettyModel(model: string): string {
  if (/^[a-z]+$/.test(model)) return `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
  const match = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:[-[@].*)?$/i.exec(model);
  if (!match) return model;
  const family = match[1]!;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

/** Name of an SDK model: the description's lead ("Opus 5.5 · Best for …") when it names a family and version, else the label. */
export function modelName(option: ModelOption): string {
  if (option.catalogSource === 'native-config') {
    return option.label === option.value ? nativeModelName(option.value) : option.label;
  }
  const lead = option.description?.split(' · ')[0]?.trim() ?? '';
  return FAMILY_VERSION.test(lead) ? lead : option.label;
}

function nativeModelName(value: string): string {
  const extended = value.endsWith('[1m]');
  return `${prettyModel(extended ? value.slice(0, -4) : value)}${extended ? ' (1M context)' : ''}`;
}

function isNativeCatalog(models: readonly ModelOption[], source?: ModelOption['catalogSource']): boolean {
  return source === 'native-config' || models.some((option) => option.catalogSource === 'native-config');
}

/** The desktop's order of the main list. */
const FAMILY_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];

/** "Opus 5.5" -> opus, 5, 5; undefined for a name without a family and version. */
function familyVersion(name: string): { family: string; major: number; minor: number } | undefined {
  const match = /^([A-Za-z]+) (\d+)(?:\.(\d+))?$/.exec(name);
  return match ? { family: match[1]!.toLowerCase(), major: Number(match[2]), minor: Number(match[3] ?? 0) } : undefined;
}

/**
 * The menu's two lists, as in the desktop: the newest model of each family (Opus, Fable, Sonnet, Haiku, then others)
 * and every older one under More models, in SDK order. Without older models from the SDK, More models is MORE_MODELS.
 */
export function modelLists(models: readonly ModelOption[], source?: ModelOption['catalogSource']): { main: ModelChoice[]; more: ModelChoice[] } {
  if (isNativeCatalog(models, source)) {
    const rank = (row: ModelChoice) => {
      const family = /^([A-Za-z]+)(?:\s|$)/.exec(row.name)?.[1]?.toLowerCase();
      const index = FAMILY_ORDER.indexOf(family ?? '');
      return index < 0 ? FAMILY_ORDER.length : index;
    };
    const rows = models.map((option) => ({ value: option.value, name: modelName(option) }));
    const main = rows.filter((row) => !row.value.endsWith('[1m]')).sort((a, b) => rank(a) - rank(b));
    const more = rows.filter((row) => row.value.endsWith('[1m]')).sort((a, b) => rank(a) - rank(b));
    return main.length ? { main, more } : { main: more, more: [] };
  }
  const rows: ModelChoice[] = [];
  for (const option of models) {
    if (NON_FAMILY.has(option.value)) continue;
    const name = modelName(option);
    // Two entries for one model (an alias and its full id) would both carry the check.
    if (rows.some((row) => row.name === name)) continue;
    rows.push({ value: option.value, name });
  }
  const newest = new Map<string, { row: ModelChoice; major: number; minor: number }>();
  for (const row of rows) {
    const version = familyVersion(row.name);
    if (!version) continue;
    const best = newest.get(version.family);
    if (!best || version.major > best.major || (version.major === best.major && version.minor > best.minor)) {
      newest.set(version.family, { row, major: version.major, minor: version.minor });
    }
  }
  const rank = (row: ModelChoice): number => {
    const index = FAMILY_ORDER.indexOf(familyVersion(row.name)?.family ?? '');
    return index < 0 ? FAMILY_ORDER.length : index;
  };
  const main = rows
    .filter((row) => {
      const version = familyVersion(row.name);
      return !version || newest.get(version.family)?.row === row;
    })
    .sort((a, b) => rank(a) - rank(b));
  const older = rows.filter((row) => !main.includes(row));
  return { main, more: older.length > 0 ? older : MORE_MODELS.filter((row) => !main.some((m) => m.name === row.name)) };
}

/** The SDK entry the current model stands for: the same value, the default entry when unset, else the same name. */
export function currentModelOption(model: string | undefined, models: readonly ModelOption[]): ModelOption | undefined {
  const exact = models.find((m) => m.value === model);
  if (exact) return exact;
  if (!model || model === 'default') return models.find((m) => m.value === 'default');
  if (isNativeCatalog(models)) return models.find((option) => option.equivalentValues?.includes(model));
  const name = prettyModel(model);
  return models.find((m) => !NON_FAMILY.has(m.value) && modelName(m) === name);
}

/** Name of the current model; undefined when it is the CLI default and no list says which model that is. */
export function currentModelName(model: string | undefined, models: readonly ModelOption[], source?: ModelOption['catalogSource']): string | undefined {
  const option = currentModelOption(model, models);
  if (option) return modelName(option);
  return model && model !== 'default' ? (isNativeCatalog(models, source) ? nativeModelName(model) : prettyModel(model)) : undefined;
}

export interface ModelMenu {
  main: ModelChoice[];
  more: ModelChoice[];
  /** Readable current model name; selection is bound to currentValue, not this label. */
  current: string;
  currentValue: string;
}

/** Rows of the model menu. A current model that neither list has (an unknown id, or no list yet) is added to the main list. */
export function modelMenu(model: string | undefined, models: readonly ModelOption[], defaultName: string, source?: ModelOption['catalogSource']): ModelMenu {
  const { main, more } = modelLists(models, source);
  const current = currentModelName(model, models, source) ?? defaultName;
  const option = currentModelOption(model, models);
  const listed = [...main, ...more].find((row) => isNativeCatalog(models, source) ? row.value === option?.value : row.name === current);
  return { main: listed ? main : [...main, { value: model ?? 'default', name: current }], more, current,
    currentValue: listed?.value ?? model ?? 'default' };
}

/** fast_mode_disabled_reason values with their own text (model.fastReason.*). */
export const FAST_REASONS = [
  'free',
  'preference',
  'extra_usage_disabled',
  'network_error',
  'unknown',
  'not_first_party',
  'disabled_by_env',
  'model_not_allowed',
  'sdk_opt_in_required',
  'pending',
] as const;
export type FastReason = (typeof FAST_REASONS)[number];

export const isFastReason = (reason: string): reason is FastReason => (FAST_REASONS as readonly string[]).includes(reason);

/** What the footer shows for fast mode: nothing unless it was asked for and the current model (when known) can use it. */
export type FastIndicator = { state: 'on' } | { state: 'cooldown' } | { state: 'unavailable'; reason: string } | null;

export function fastIndicator(
  requested: boolean | undefined,
  status: FastModeStatus | undefined,
  option: ModelOption | undefined,
  native?: NativeFastControl,
): FastIndicator {
  if (native) {
    if (!native.available || !native.requested) return null;
    const observed = status ?? (native.state ? { state: native.state } : undefined);
    if (observed?.state === 'cooldown') return { state: 'cooldown' };
    if (observed?.state === 'on') return { state: 'on' };
    if (observed?.state === 'off' && observed.reason) return { state: 'unavailable', reason: observed.reason };
    return null;
  }
  if (!requested) return null;
  if (option && !option.supportsFastMode) return null;
  if (status?.state === 'cooldown') return { state: 'cooldown' };
  // sdk_opt_in_required only means the request has not reached the CLI yet.
  if (status?.state === 'off' && status.reason && status.reason !== 'sdk_opt_in_required') {
    return { state: 'unavailable', reason: status.reason };
  }
  return { state: 'on' };
}

/** The menu's fast mode switch: for a model that supports it, when the account can pay for it or it is already in use. */
export function fastRowVisible(
  option: ModelOption | undefined,
  extraUsageEnabled: boolean | undefined,
  requested: boolean | undefined,
  status: FastModeStatus | undefined,
  native?: NativeFastControl,
): boolean {
  if (native) return native.available;
  if (!option?.supportsFastMode) return false;
  return extraUsageEnabled === true || Boolean(requested) || status?.state === 'on' || status?.state === 'cooldown';
}
