import { createHash } from 'node:crypto';
import { lstat, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFORT_LEVELS, type Effort, type EffortGuide, type EffortLevelGuide, type ModelOption } from '@shared/types';
import { cliGlobalConfigPath, MAX_CONFIG_BYTES } from '../system/cliProfile';

/**
 * The effort picker's notes come from the model-selector catalog Claude Code fetches for its own surface and caches per
 * account (CLI 2.1.308). Only the account's organization and account ids are read from the global config, to find that
 * file; credentials (.credentials.json) are never opened.
 */

/** The cached catalog is about 14 KB; this is the CLI's own size limit for its cache file. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024 + 4096;
/** The notes never hold up the model list; a slower read means no notes this time. */
export const EFFORT_GUIDE_TIMEOUT_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^claude-[a-z0-9-]{1,64}$/;
// Bidirectional marks and overrides could make a note read differently from what it says.
const UNSAFE = /[\p{Cc}\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/u;
const LONG_CONTEXT = /\[1m\]$/;

export interface CliAccount { organizationUuid: string; accountUuid: string }

/** The CLI's name for its cached catalog of an OAuth account: `<org>-<first 12 hex of sha256(account)>-<surface>.json`. */
export function servedCatalogFileName(account: CliAccount, surface = 'cc'): string | undefined {
  if (!UUID.test(account.organizationUuid) || !UUID.test(account.accountUuid)) return undefined;
  const scope = createHash('sha256').update(account.accountUuid.toLowerCase()).digest('hex').slice(0, 12);
  return `${account.organizationUuid.toLowerCase()}-${scope}-${surface}.json`;
}

/** Pure: the OAuth account's organization and account ids in a global config's text; undefined for other sign-ins. */
export function parseCliAccount(globalConfigText: string): CliAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(globalConfigText.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  const account = isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : undefined;
  const organizationUuid = account?.organizationUuid, accountUuid = account?.accountUuid;
  if (typeof organizationUuid !== 'string' || typeof accountUuid !== 'string') return undefined;
  return UUID.test(organizationUuid) && UUID.test(accountUuid) ? { organizationUuid, accountUuid } : undefined;
}

/**
 * Pure: the effort notes of each model in a cached catalog document, by model id. A malformed model or effort option is
 * left out on its own; a document of another version or surface gives nothing.
 */
export function parseServedEffortGuides(text: string): Record<string, EffortGuide> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
  const catalog = isRecord(parsed) && parsed.version === 2 && isRecord(parsed.catalog) ? parsed.catalog : undefined;
  if (!catalog || catalog.surface !== 'cc' || !isRecord(catalog.config) || !Array.isArray(catalog.config.models)) return {};
  const guides: Record<string, EffortGuide> = {};
  for (const model of catalog.config.models) {
    if (!isRecord(model) || typeof model.id !== 'string' || !MODEL_ID.test(model.id) || hasOwn(guides, model.id)) continue;
    const thinking = model.thinking;
    if (!isRecord(thinking) || thinking.type !== 'effort' || !Array.isArray(thinking.effort_options)) continue;
    const levels: Partial<Record<Effort, EffortLevelGuide>> = {};
    const seen = new Set<Effort>();
    for (const option of thinking.effort_options) {
      if (!isRecord(option)) continue;
      const level = EFFORT_LEVELS.find((value) => value === option.id);
      if (!level || seen.has(level)) continue;
      seen.add(level);
      const guide = levelGuide(option);
      if (guide && (guide.badge || guide.tooltip)) levels[level] = guide;
    }
    const description = catalogText(thinking.description, 300);
    if (description === undefined && !Object.keys(levels).length) continue;
    guides[model.id] = { ...(description === undefined ? {} : { description }), levels };
  }
  return guides;
}

/** One option's badge and hover text; undefined when either is present but malformed. */
function levelGuide(option: Record<string, unknown>): EffortLevelGuide | undefined {
  const guide: EffortLevelGuide = {};
  const { badge, tooltip } = option;
  if (badge !== undefined && badge !== null) {
    if (!isRecord(badge)) return undefined;
    const message = catalogText(badge.message, 60);
    if (message === undefined) return undefined;
    guide.badge = { message, tone: badge.variant === 'warning' ? 'warning' : 'neutral' };
  }
  if (tooltip !== undefined && tooltip !== null) {
    if (!isRecord(tooltip)) return undefined;
    const content = catalogText(tooltip.content, 300);
    if (content === undefined) return undefined;
    guide.tooltip = content;
  }
  return guide;
}

function catalogText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length >= 1 && text.length <= max && !UNSAFE.test(text) ? text : undefined;
}

/**
 * The effort notes the CLI cached for a profile's OAuth account; empty when there are none to read. Never throws.
 * Call it only for a claude.ai sign-in: with a Console sign-in the global config holds the API key (R2).
 */
export async function readServedEffortGuides(options: {
  configDir: string | null;
  configRoot: string;
  home?: string;
  maxBytes?: number;
  maxConfigBytes?: number;
}): Promise<Record<string, EffortGuide>> {
  try {
    const configFile = await cliGlobalConfigPath(options.configDir, options.home);
    const configInfo = await stat(configFile);
    if (!configInfo.isFile() || configInfo.size > (options.maxConfigBytes ?? MAX_CONFIG_BYTES)) return {};
    const account = parseCliAccount(await readFile(configFile, 'utf8'));
    const name = account && servedCatalogFileName(account);
    if (!name) return {};
    const text = await readBoundedFile(join(options.configRoot, 'cache', 'model-catalog', name), options.maxBytes ?? MAX_CATALOG_BYTES);
    return text === undefined ? {} : parseServedEffortGuides(text);
  } catch {
    return {};
  }
}

/** A regular file's text, or undefined when it is something else or larger than the limit. */
async function readBoundedFile(path: string, maxBytes: number): Promise<string | undefined> {
  if (!(await lstat(path)).isFile()) return undefined;
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The model rows with the catalog's effort notes of the model each one names: its value or an equivalent, a 1M context
 * variant counting as its base model. A row with notes is a new object, the input is not changed; 'default' names no
 * fixed model.
 */
export function withEffortGuides(options: readonly ModelOption[], guides: Readonly<Record<string, EffortGuide>>): ModelOption[] {
  return options.map((option) => {
    if (option.value === 'default') return option;
    const equivalents = Array.isArray(option.equivalentValues) ? option.equivalentValues : [];
    const values = [option.value, ...equivalents].filter((value): value is string => typeof value === 'string')
      .map((value) => value.replace(LONG_CONTEXT, ''));
    // An alias standing for several models (fable: 5.2 or 5.1 by build and account) has no one set of notes; the
    // session's actual model picks its own.
    const models = [...new Set(values.filter((value) => MODEL_ID.test(value)))];
    if (!MODEL_ID.test(option.value) && models.length > 1) {
      const byModel = Object.fromEntries(models.filter((id) => hasOwn(guides, id)).map((id) => [id, guides[id]!]));
      return Object.keys(byModel).length ? { ...option, effortGuideByModel: byModel } : option;
    }
    const id = values.find((value) => hasOwn(guides, value));
    return id === undefined ? option : { ...option, effortGuide: guides[id] };
  });
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
