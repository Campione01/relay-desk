import { DEFAULT_PROFILE_ID, type LaunchRequest } from '@shared/types';
import { toLocalAbsolutePath } from './paths';

export const PROTOCOL_SCHEME = 'relaydesk';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL = 4096;

/** Claude Code session ids are UUIDs (transcript file names). */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Builds the request after validating every present field; null when any is invalid. */
function build(
  action: LaunchRequest['action'],
  fields: { session?: string | null; cwd?: string | null; profile?: string | null },
  sessionRequired: boolean,
): LaunchRequest | null {
  const request: LaunchRequest = { action };
  if (fields.session !== undefined && fields.session !== null) {
    if (!isSessionId(fields.session)) return null;
    request.sessionId = fields.session.toLowerCase();
  } else if (sessionRequired) {
    return null;
  }
  if (fields.cwd !== undefined && fields.cwd !== null) {
    const cwd = toLocalAbsolutePath(fields.cwd);
    if (!cwd) return null;
    request.cwd = cwd;
  }
  if (fields.profile !== undefined && fields.profile !== null) {
    if (!PROFILE_ID.test(fields.profile)) return null;
    request.profileId = fields.profile;
  } else if (action === 'resume') {
    request.profileId = DEFAULT_PROFILE_ID;
  }
  return request;
}

/**
 * `--resume <uuid> [--cwd <path>] [--profile <id>]`, `--new [--cwd <path>]` or `--cwd <path>` alone (new session
 * in that folder), or a relaydesk:// URL among the args (then only the URL counts). null = plain start or invalid.
 * Unknown arguments (Chromium switches, the app path in dev) are ignored.
 */
export function parseArgv(argv: readonly string[]): LaunchRequest | null {
  const url = argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}:`));
  if (url !== undefined) return parseProtocolUrl(url);

  const values = new Map<string, string | null>();
  let isNew = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--new') {
      isNew = true;
      continue;
    }
    const match = /^--(resume|cwd|profile)(?:=(.*))?$/s.exec(arg);
    if (!match) continue;
    const name = match[1]!;
    let value: string | null;
    if (match[2] !== undefined) {
      value = match[2];
    } else {
      const next = argv[i + 1];
      value = typeof next === 'string' && !next.startsWith('--') ? next : null;
      if (value !== null) i++;
    }
    // A repeated flag is ambiguous: refuse rather than guess which one was meant.
    if (values.has(name)) return null;
    values.set(name, value);
  }
  if (values.size === 0 && !isNew) return null;
  for (const value of values.values()) if (value === null || value === '') return null;

  const fields = { session: values.get('resume'), cwd: values.get('cwd'), profile: values.get('profile') };
  if (values.has('resume')) return isNew ? null : build('resume', fields, true);
  return build('new', fields, false);
}

/**
 * relaydesk://resume?session=<uuid>&cwd=<urlencoded>&profile=<id> | relaydesk://new?cwd=<urlencoded> |
 * relaydesk://open. null = invalid (unknown action, credentials/port, repeated or invalid parameters).
 */
export function parseProtocolUrl(url: string): LaunchRequest | null {
  if (typeof url !== 'string' || url.length > MAX_URL) return null;
  if (/[\u0000- \u007f-\u009f]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return null;
  if (parsed.username || parsed.password || parsed.port) return null;

  // relaydesk://resume?...  -> host "resume";  relaydesk:resume?...  -> pathname "resume".
  let action: string;
  if (parsed.host) {
    if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
    action = parsed.hostname.toLowerCase();
  } else {
    action = parsed.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  const one = (key: string): string | null | undefined => {
    const all = parsed.searchParams.getAll(key);
    if (all.length > 1) return undefined;
    return all.length === 1 ? all[0]! : null;
  };
  const session = one('session');
  const cwd = one('cwd');
  const profile = one('profile');
  if (session === undefined || cwd === undefined || profile === undefined) return null;
  if (session === '' || cwd === '' || profile === '') return null;

  switch (action) {
    case 'resume':
      return build('resume', { session, cwd, profile }, true);
    case 'new':
      if (session !== null) return null;
      return build('new', { cwd, profile }, false);
    case 'open':
      if (session !== null) return null;
      return build('open', { cwd, profile }, false);
    default:
      return null;
  }
}
