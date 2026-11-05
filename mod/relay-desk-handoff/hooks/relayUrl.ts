// Pure helpers for the hand-off: no engine calls here, so they are unit-tested outside the engine.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
// Characters Windows forbids in path names, plus controls; ':' is checked separately.
const FORBIDDEN = /[<>"|?*\u0000-\u001f\u007f]/;
const MAX_PATH_LENGTH = 4096;

export type Built = { ok: true; url: string } | { ok: false; reason: string };

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** Drive-absolute Windows path: no UNC or device prefix, no stream colon, no `..` segment. */
export function isWindowsAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH) return false;
  if (!DRIVE_PATH.test(value) || FORBIDDEN.test(value)) return false;
  if (value.indexOf(':', 2) !== -1) return false;
  return !value.split(/[\\/]/).includes('..');
}

/** encodeURIComponent plus the five marks it leaves alone, so the URL holds only [A-Za-z0-9-_.~%]. */
export function encodeStrict(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildResumeUrl(sessionId: unknown, cwd: unknown): Built {
  if (!isSessionId(sessionId)) return { ok: false, reason: 'The conversation ID is not a valid UUID, so it cannot be handed to Relay Desk.' };
  if (!isWindowsAbsolutePath(cwd)) {
    return { ok: false, reason: 'The conversation folder is not an absolute path on a local drive (network paths are not supported), so it cannot be handed to Relay Desk.' };
  }
  return { ok: true, url: `relaydesk://resume?session=${sessionId.toLowerCase()}&cwd=${encodeStrict(cwd)}` };
}

/**
 * argv that asks the Windows shell to open `url` with its registered protocol handler, with no
 * command interpreter in between. Null when `systemRoot` is not a plain drive path (not Windows).
 */
export function openerArgv(systemRoot: unknown, url: string): string[] | null {
  if (!isWindowsAbsolutePath(systemRoot) || !url.startsWith('relaydesk://')) return null;
  const root = systemRoot.replace(/[\\/]+$/, '');
  return [`${root}\\System32\\rundll32.exe`, 'url.dll,FileProtocolHandler', url];
}
