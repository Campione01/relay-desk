import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile } from '@shared/types';
import { assertPrototypePath } from './scope';

const cache = new Map<string, { size: number; mtime: number; sha256: string }>();
/**
 * The executable's observed hash, never the expected one. Any official build may run: the controls compare
 * the hash with the accepted builds (cliBuilds.ts) and leave unknown layouts to the CLI's own panels.
 */
export function verifiedNativeHash(binary: string): string {
  const stat = statSync(binary);
  const prior = cache.get(binary);
  if (prior && prior.size === stat.size && prior.mtime === stat.mtimeMs) return prior.sha256;
  const fd = openSync(binary, 'r');
  try {
    const before = fstatSync(fd), digest = createHash('sha256'), buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (!length) break; digest.update(buffer.subarray(0, length)); }
    const after = fstatSync(fd), sha256 = digest.digest('hex');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('The Claude executable changed while Relay verified it.');
    cache.set(binary, { size: after.size, mtime: after.mtimeMs, sha256 });
    return sha256;
  } finally { closeSync(fd); }
}

const PREFERENCE_KEYS = new Set(['model', 'effortLevel', 'modelSettings', 'enableWorkflows', 'ultracode', 'fastMode',
  'workflowSizeGuideline', 'permissionMode', 'autoContinueAtUsageLimit', 'permissions', 'allowedTools',
  'disabledMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers']);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function preferences(value: unknown): unknown {
  if (!record(value)) throw new Error('Native preferences must be a JSON object.');
  const selected = Object.fromEntries(Object.entries(value).filter(([key]) => PREFERENCE_KEYS.has(key)));
  if (record(value.projects)) selected.projects = Object.fromEntries(Object.entries(value.projects).map(([key, entry]) => [key, preferences(entry)]));
  return selected;
}

/** Hash persistent settings only; native usage/startup bookkeeping must not imitate a saved preference change. */
export async function nativePreferenceFingerprint(profile: Profile, cwd: string, prototypeRoot: string,
  scope?: { home: string; enforcePrototypeBoundary: boolean }): Promise<string> {
  const home = scope?.home ?? join(prototypeRoot, 'home');
  const config = profile.configDir ?? join(home, '.claude');
  const global = profile.configDir ? join(config, '.claude.json') : join(home, '.claude.json');
  const paths = [global, join(config, 'settings.json'), join(config, 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  const values: unknown[] = [];
  for (const [index, file] of paths.entries()) {
    if (scope?.enforcePrototypeBoundary !== false) assertPrototypePath(file, prototypeRoot);
    let stat;
    try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { values.push({}); continue; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('Native preference source is not a bounded regular file.');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    values.push(index === 0 ? preferences(parsed) : parsed);
  }
  return createHash('sha256').update(JSON.stringify(canonical(values))).digest('hex');
}
