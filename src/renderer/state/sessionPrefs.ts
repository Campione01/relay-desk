import { EFFORT_LEVELS, MAX_MCP_OVERRIDES, PERMISSION_MODES, type Effort, type PermissionMode, type ProfileId } from '@shared/types';

/** Choices the user made in one conversation; Relay applies them again when the conversation opens. */
export interface SessionPrefs {
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  ultracode?: boolean;
  fastMode?: boolean;
  /** MCP server name → on/off, as last switched in this conversation. */
  mcp?: Record<string, boolean>;
}

export const SESSION_PREFS_KEY = 'relay.sessionPrefs';
/** Oldest conversations are forgotten first. */
export const MAX_REMEMBERED_SESSIONS = 300;
const MAX_MODEL_LENGTH = 100;
const MAX_MCP_NAME_LENGTH = 200;

type Stored = Record<string, SessionPrefs & { at: number }>;

function storeKey(profileId: ProfileId, sessionId: string): string {
  return `${profileId}/${sessionId.toLowerCase()}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps only well-formed fields: the store is user-editable local data. */
export function sanitizePrefs(value: unknown): SessionPrefs | undefined {
  if (!isObject(value)) return undefined;
  const prefs: SessionPrefs = {};
  if (typeof value.model === 'string' && value.model && value.model.length <= MAX_MODEL_LENGTH) prefs.model = value.model;
  if (EFFORT_LEVELS.includes(value.effort as Effort)) prefs.effort = value.effort as Effort;
  if (PERMISSION_MODES.includes(value.permissionMode as PermissionMode)) prefs.permissionMode = value.permissionMode as PermissionMode;
  if (typeof value.ultracode === 'boolean') prefs.ultracode = value.ultracode;
  if (typeof value.fastMode === 'boolean') prefs.fastMode = value.fastMode;
  if (isObject(value.mcp)) {
    const entries = Object.entries(value.mcp)
      .filter(([name, enabled]) => name.trim() && name.length <= MAX_MCP_NAME_LENGTH && typeof enabled === 'boolean')
      .slice(0, MAX_MCP_OVERRIDES);
    if (entries.length) prefs.mcp = Object.fromEntries(entries) as Record<string, boolean>;
  }
  return Object.keys(prefs).length ? prefs : undefined;
}

function readAll(): Stored {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SESSION_PREFS_KEY) ?? '{}');
    if (!isObject(parsed)) return {};
    const stored: Stored = {};
    for (const [key, value] of Object.entries(parsed)) {
      const prefs = sanitizePrefs(value);
      const at = isObject(value) && typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
      if (prefs) stored[key] = { ...prefs, at };
    }
    return stored;
  } catch {
    return {};
  }
}

export function readSessionPrefs(profileId: ProfileId, sessionId: string): SessionPrefs | undefined {
  const stored = readAll()[storeKey(profileId, sessionId)];
  if (!stored) return undefined;
  const { at: _at, ...prefs } = stored;
  return prefs;
}

/** Replaces the remembered choices of one conversation; storage is a convenience, so failures are ignored. */
export function writeSessionPrefs(profileId: ProfileId, sessionId: string, prefs: SessionPrefs, now: number): void {
  const clean = sanitizePrefs(prefs);
  const stored = readAll();
  const key = storeKey(profileId, sessionId);
  delete stored[key];
  if (clean) stored[key] = { ...clean, at: now };
  const kept = Object.entries(stored)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_REMEMBERED_SESSIONS);
  try {
    window.localStorage.setItem(SESSION_PREFS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or blocked: the choice still applies to the open view.
  }
}

/** Merges new choices into earlier ones; MCP choices merge per server. */
export function mergePrefs(base: SessionPrefs | undefined, patch: SessionPrefs): SessionPrefs {
  const mcp = patch.mcp ? { ...base?.mcp, ...patch.mcp } : base?.mcp;
  return { ...base, ...patch, ...(mcp ? { mcp } : {}) };
}
