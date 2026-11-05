import { lstat, readFile, readlink, realpath, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve, win32 } from 'node:path';
import { resolveSettings, type ResolvedSettings, type Settings as SDKSettings } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_PROFILE_ID, PERMISSION_MODES, type Profile, type SharedCodeContextReport } from '@shared/types';
import { isSameOrInside, toLocalAbsolutePath } from './paths';

export type SharedCodeContextSettings = Pick<SDKSettings, 'permissions' | 'autoMemoryDirectory' | 'autoMemoryEnabled'>;

const MARKER = '.relay-shared-code-context.json';
const MARKER_OWNER = 'relay-desk-shared-code-context';
const BRIDGE_HEADER = '<!-- Relay Desk managed shared instructions; do not edit. -->';
// The CLI's /memory edits the bridge; a bigger file is not treated as one.
const MAX_BRIDGE_BYTES = 1024 * 1024;
const PROJECT_KEY_WARNING = 'An explicit CLAUDE_CODE_PROJECT_DIR_NAME override requires native path verification; shared memory was not guessed.';
const GLOBALS = [
  { kind: 'instructions', name: 'CLAUDE.md' },
  { kind: 'rules', name: 'rules' },
  { kind: 'skills', name: 'skills' },
] as const;
const preparing = new Map<string, Promise<unknown>>();
const same = (a: string, b: string): boolean => win32.relative(a, b) === '';
const overlaps = (a: string, b: string): boolean => isSameOrInside(a, b) || isSameOrInside(b, a);
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

async function metadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}

/** Metadata only; dangling links and non-local physical targets fail closed. */
async function physicalPath(input: string): Promise<string> {
  let candidate = toLocalAbsolutePath(input);
  if (!candidate) throw new Error(`The path ${input} is not an absolute path on a local drive.`);
  const suffix: string[] = [];
  for (;;) {
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if (!missing(error) || await metadata(candidate)) throw new Error(`Cannot safely resolve shared code context path: ${input}`);
      const parent = dirname(candidate);
      if (same(candidate, parent)) throw new Error(`Cannot safely resolve shared code context path: ${input}`);
      suffix.unshift(basename(candidate));
      candidate = parent;
      continue;
    }
    const physical = toLocalAbsolutePath(resolved);
    if (!physical) throw new Error(`The path ${input} leads to ${resolved}, which is not on a local drive.`);
    return join(physical, ...suffix);
  }
}

async function roots(profile: Profile): Promise<{ globalRoot: string; configDirectory: string }> {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === 'CLAUDE_CONFIG_DIR' && process.env[key]) {
      throw new Error(`Relay Desk was started with an inherited CLAUDE_CONFIG_DIR (${process.env[key]}); shared context was not prepared. Start Relay Desk directly instead of from another Claude process.`);
    }
  }
  const globalRoot = await physicalPath(join(homedir(), '.claude'));
  const protectedRoots: string[] = [];
  for (const path of [
    process.env.APPDATA && join(process.env.APPDATA, 'Claude'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'AnthropicClaude'),
  ]) if (path) protectedRoots.push(await physicalPath(path));
  const desktop = protectedRoots.find((path) => overlaps(globalRoot, path));
  if (desktop) throw new Error(`The default code-context folder ${globalRoot} overlaps the desktop-owned directory ${desktop}.`);
  if (profile.id === DEFAULT_PROFILE_ID) {
    if (profile.configDir !== null) throw new Error('The default account must use its native config root.');
    return { globalRoot, configDirectory: globalRoot };
  }
  if (!profile.configDir) throw new Error(`The account "${profile.name}" has no config directory.`);
  const configDirectory = await physicalPath(profile.configDir);
  if (!same(configDirectory, profile.configDir)) {
    throw new Error(`The account folder ${profile.configDir} redirects to ${configDirectory} (junction, symbolic link or short name).`);
  }
  if (overlaps(configDirectory, globalRoot)) throw new Error(`The account folder ${configDirectory} overlaps the default account folder ${globalRoot}.`);
  if (!(await metadata(configDirectory))?.isDirectory()) throw new Error(`The account folder ${configDirectory} does not exist.`);
  for (const forbidden of protectedRoots) {
    if (overlaps(configDirectory, forbidden)) throw new Error(`The account folder ${configDirectory} overlaps the desktop-owned directory ${forbidden}.`);
  }
  return { globalRoot, configDirectory };
}

function importLine(source: string): string {
  // Native 2.1.302 WLo parses escaped spaces, not quoted @include paths.
  if (source.includes('#')) throw new Error(`The default instruction path ${source} contains # and cannot be safely imported.`);
  return `@${source.replaceAll('\\', '/').replaceAll(' ', '\\ ')}`;
}

function bridge(source: string): string {
  return `${BRIDGE_HEADER}\n${importLine(source)}\n`;
}

function markerText(profile: Profile, locations: Awaited<ReturnType<typeof roots>>): string {
  return `${JSON.stringify({ owner: MARKER_OWNER, version: 1, profileId: profile.id, ...locations })}\n`;
}

async function exactManagedFile(path: string, expected: string): Promise<boolean> {
  const info = await metadata(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== Buffer.byteLength(expected)) return false;
  if (!same(await physicalPath(path), path)) return false;
  return await readFile(path, 'utf8') === expected;
}

/** A regular bridge file that still holds the managed import line, even after /memory added text to it. */
async function bridgeWithImport(path: string, source: string): Promise<boolean> {
  const info = await metadata(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BRIDGE_BYTES) return false;
  if (!same(await physicalPath(path), path)) return false;
  const line = importLine(source);
  return (await readFile(path, 'utf8')).split('\n').some((text) => text.trimEnd() === line);
}

async function linkTarget(path: string): Promise<string | null> {
  return toLocalAbsolutePath((await readlink(path)).replace(/^\\\\\?\\/, ''));
}

/** The CLI's folder name for a project path: every character but ASCII letters and digits becomes '-'; a name longer
 * than 200 characters is cut there and gets the base-36 absolute value of a signed 31-hash of the path. */
function projectKey(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function smallGitFile(path: string): Promise<string> {
  const info = await metadata(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || !same(await physicalPath(path), path)) {
    throw new Error(`Cannot verify the Git metadata file ${path} safely: it is a link, a hard link or larger than 4 KB.`);
  }
  return (await readFile(path, 'utf8')).trim();
}

/** Native Js/St/hr: nearest .git, and linked-worktree commondir only with a matching backlink. */
async function projectBase(cwd: string): Promise<string> {
  let candidate = resolve(cwd);
  const original = candidate;
  for (;;) {
    const git = join(candidate, '.git');
    const info = await metadata(git);
    if (info) {
      if (info.isSymbolicLink() || !same(await physicalPath(git), git)) throw new Error(`Cannot verify the redirected .git entry ${git}: it is a junction or symbolic link.`);
      if (info.isDirectory()) return candidate;
      if (!info.isFile()) throw new Error(`Cannot verify the Git metadata entry ${git}: it is neither a folder nor a file.`);
      const content = await smallGitFile(git);
      if (!content.startsWith('gitdir:')) return candidate;
      const gitdir = toLocalAbsolutePath(resolve(candidate, content.slice(7).trim()));
      if (!gitdir) throw new Error(`Cannot verify the Git worktree directory named in ${git}: it is not on a local drive.`);
      if (basename(dirname(gitdir)) !== 'worktrees') return candidate;
      const commonFile = join(gitdir, 'commondir');
      if (!await metadata(commonFile)) return candidate;
      const common = toLocalAbsolutePath(resolve(gitdir, await smallGitFile(commonFile)));
      if (!common || !same(dirname(gitdir), join(common, 'worktrees'))) return candidate;
      const backlink = join(gitdir, 'gitdir');
      if (!await metadata(backlink) || !same(resolve(gitdir, await smallGitFile(backlink)), git)) return candidate;
      if (basename(common) !== '.git') {
        if (await metadata(join(common, '.git'))) return candidate;
        return common;
      }
      return dirname(common);
    }
    const parent = dirname(candidate);
    if (same(parent, candidate)) return original;
    candidate = parent;
  }
}

function memoryOverride(value: string, home: string): string | undefined {
  let path = value;
  if (/^~[\\/]/.test(path)) {
    const relative = normalize(path.slice(2) || '.');
    if (relative === '.' || relative === '..' || relative.startsWith('..\\')) return;
    path = join(home, relative);
  }
  const normalized = normalize(path).replace(/[\\/]+$/, '');
  return toLocalAbsolutePath(normalized) ?? undefined;
}

function userPermissions(settings: SDKSettings): SDKSettings['permissions'] {
  const source = settings.permissions;
  if (!source) return;
  const result: NonNullable<SDKSettings['permissions']> = {};
  for (const key of ['allow', 'deny', 'ask', 'additionalDirectories'] as const) {
    const value = source[key];
    if (value !== undefined) result[key] = [...value];
  }
  if (source.defaultMode !== undefined) result.defaultMode = source.defaultMode;
  if (source.disableBypassPermissionsMode !== undefined) result.disableBypassPermissionsMode = source.disableBypassPermissionsMode;
  if (source.blockReadsOutsideWorkingDirectories !== undefined) result.blockReadsOutsideWorkingDirectories = source.blockReadsOutsideWorkingDirectories;
  return result;
}

async function settingsFor(
  profile: Profile, cwd: string | undefined, locations: Awaited<ReturnType<typeof roots>>, report: SharedCodeContextReport,
): Promise<SharedCodeContextSettings | undefined> {
  const paths = [join(locations.globalRoot, 'settings.json')];
  if (cwd) {
    for (let dir = resolve(cwd);;) {
      paths.push(join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'));
      const parent = dirname(dir);
      if (same(parent, dir)) break;
      dir = parent;
    }
  }
  for (const path of paths) {
    const info = await metadata(path);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !same(await physicalPath(path), path))) {
      throw new Error(`Cannot resolve settings through a redirected or non-regular file: ${path} is a link, a hard link or not a regular file.`);
    }
  }
  let resolved: ResolvedSettings;
  try {
    resolved = await resolveSettings({ cwd: cwd ?? locations.globalRoot, settingSources: cwd ? ['user', 'project', 'local'] : ['user'] });
  } catch {
    throw new Error('Could not resolve shared code settings safely; native settings details were not exposed.');
  }
  const settings: SharedCodeContextSettings = {};
  let explicitProjectKey = false;
  for (const source of resolved.sources) {
    // This documented storage-key name is the sole authorized env-value exception; never copy env.
    const env = source.settings.env;
    const key = env && Object.keys(env).find((name) => name.toUpperCase() === 'CLAUDE_CODE_PROJECT_DIR_NAME');
    if (key && env[key]) explicitProjectKey = true;
    if (source.source === 'user') {
      const expected = join(locations.globalRoot, 'settings.json');
      if (!source.path || !same(await physicalPath(source.path), expected)) {
        throw new Error(`Unexpected default user-settings provenance: the SDK read ${source.path ?? 'an unnamed file'} instead of ${expected}.`);
      }
      const permissions = userPermissions(source.settings);
      if (permissions) settings.permissions = permissions;
    }
    if (!['user', 'project', 'local'].includes(source.source)) continue;
    const enabled = source.settings.autoMemoryEnabled;
    const directory = source.settings.autoMemoryDirectory;
    if (enabled !== undefined) settings.autoMemoryEnabled = enabled;
    if (directory !== undefined) settings.autoMemoryDirectory = directory;
  }
  for (const key of ['autoMemoryEnabled', 'autoMemoryDirectory'] as const) {
    if (resolved.provenance[key]?.source === 'managed' && resolved.effective[key] !== settings[key]) {
      report.warnings.push(`Default managed ${key} was not copied; this account keeps its own native policy.`);
    }
  }
  if (resolved.provenance.permissions?.source === 'managed') report.warnings.push('Default managed permissions were not copied; this account keeps its own native policy.');
  if (settings.permissions) {
    const p = settings.permissions;
    report.permissions = { allow: p.allow?.length ?? 0, deny: p.deny?.length ?? 0, ask: p.ask?.length ?? 0,
      ...(PERMISSION_MODES.includes(p.defaultMode as never) ? { defaultMode: p.defaultMode } : {}) };
  }
  if (settings.autoMemoryEnabled !== undefined) report.memory.enabled = settings.autoMemoryEnabled;
  if (explicitProjectKey) {
    report.warnings.push(PROJECT_KEY_WARNING);
    delete settings.autoMemoryDirectory;
    return profile.id === DEFAULT_PROFILE_ID ? undefined : settings;
  }
  if (cwd) {
    let directory = settings.autoMemoryDirectory && memoryOverride(settings.autoMemoryDirectory, homedir());
    if (settings.autoMemoryDirectory && !directory) report.warnings.push('Invalid default memory-directory override; using the native project directory.');
    directory ||= join(locations.globalRoot, 'projects', projectKey(await projectBase(cwd)), 'memory').normalize('NFC');
    directory = await physicalPath(directory);
    if (same(directory, locations.globalRoot) || (profile.id !== DEFAULT_PROFILE_ID && overlaps(directory, locations.configDirectory))) {
      throw new Error(`The shared memory directory ${directory} overlaps the account folder ${same(directory, locations.globalRoot) ? locations.globalRoot : locations.configDirectory}.`);
    }
    settings.autoMemoryDirectory = directory;
    report.memory.directory = directory;
    report.memory.indexExists = (await metadata(join(directory, 'MEMORY.md')))?.isFile() ?? false;
  } else {
    delete settings.autoMemoryDirectory;
  }
  return profile.id === DEFAULT_PROFILE_ID ? undefined : settings;
}

type EntryState = SharedCodeContextReport['entries'][number]['state'];
type Locations = Awaited<ReturnType<typeof roots>>;

/** An existing local folder, resolved like the CLI does (junction, symlink, subst and 8.3 aliases become the real path). */
async function projectFolder(cwd: string): Promise<string> {
  const local = toLocalAbsolutePath(cwd);
  if (!local) throw new Error(`The project folder ${cwd} is not on a local drive.`);
  const info = await stat(local).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`The project folder ${cwd} does not exist or is not a folder.`);
  return physicalPath(local);
}

async function analyze(profile: Profile, cwd?: string): Promise<{
  report: SharedCodeContextReport; settings?: SharedCodeContextSettings; marker: string; markerOwned: boolean; markerPath: string;
}> {
  const locations = await roots(profile);
  const project = cwd ? await projectFolder(cwd) : undefined;
  const isDefault = profile.id === DEFAULT_PROFILE_ID;
  const marker = markerText(profile, locations);
  const markerPath = join(locations.configDirectory, MARKER);
  const markerExists = !isDefault && !!await metadata(markerPath);
  const markerOwned = markerExists && await exactManagedFile(markerPath, marker);
  const report: SharedCodeContextReport = {
    profileId: profile.id, mode: isDefault ? 'default' : 'shared', ...locations,
    entries: [], memory: { shared: !isDefault }, warnings: [],
  };
  if (!isDefault && profile.sharedCodeContext === false) {
    report.memory.shared = false;
    report.warnings.push('Sharing is turned off for this account: new sessions neither prepare nor pass the shared files, permissions or memory.');
  }
  if (markerExists && !markerOwned) {
    report.warnings.push(`The ownership marker ${markerPath} was not written by Relay Desk for this account folder (it may have been moved or copied); nothing in this folder will be changed.`);
  }
  for (const global of GLOBALS) {
    const sourcePath = join(locations.globalRoot, global.name);
    const targetPath = join(locations.configDirectory, global.name);
    const source = await metadata(sourcePath);
    const target = isDefault ? source : await metadata(targetPath);
    const sourceValid = !source || (!source.isSymbolicLink() && same(await physicalPath(sourcePath), sourcePath) &&
      (global.kind === 'instructions' ? source.isFile() && source.nlink === 1 : source.isDirectory()));
    if (!isDefault && source && global.kind === 'instructions') {
      bridge(sourcePath);
      report.warnings.push('The shared CLAUDE.md bridge adds one @import hop; chains at the native five-file depth limit may be truncated.');
    }
    let state: EntryState;
    let reason = '';
    if (!sourceValid) {
      state = 'conflict';
      reason = `its source ${sourcePath} is a link, a hard link or not a regular ${global.kind === 'instructions' ? 'file' : 'folder'}`;
    } else if (markerExists && !markerOwned) {
      state = 'conflict';
      reason = `the ownership marker ${markerPath} does not match this account folder`;
    } else if (isDefault) state = source ? 'native' : 'missing';
    else if (!target) state = source ? 'pending' : 'missing';
    else if (!markerOwned) {
      state = 'conflict';
      reason = 'it already exists and belongs to this account';
    } else if (global.kind === 'instructions') {
      state = await bridgeWithImport(targetPath, sourcePath) ? (source ? 'ready' : 'missing') : 'conflict';
      if (state === 'conflict') reason = `it no longer imports ${sourcePath}`;
    } else {
      const link = target.isSymbolicLink() ? await linkTarget(targetPath) : null;
      state = link && same(link, sourcePath) && (!source || same(await physicalPath(targetPath), sourcePath)) ? (source ? 'ready' : 'missing') : 'conflict';
      if (state === 'conflict') reason = `it is not a Relay Desk junction to ${sourcePath}`;
    }
    if (state === 'conflict') report.warnings.push(`Skipped ${targetPath} and left it unchanged: ${reason}.`);
    report.entries.push({ kind: global.kind, sourcePath, targetPath, state });
  }
  const settings = await settingsFor(profile, project, locations, report);
  return { report, ...(settings ? { settings } : {}), marker, markerOwned, markerPath };
}

function nativeReport(profile: Profile, warning: string): SharedCodeContextReport {
  const globalRoot = join(homedir(), '.claude');
  const configDirectory = profile.configDir ?? globalRoot;
  return {
    profileId: profile.id, mode: profile.id === DEFAULT_PROFILE_ID ? 'default' : 'shared', configDirectory, globalRoot,
    entries: GLOBALS.map((entry) => ({ kind: entry.kind, sourcePath: join(globalRoot, entry.name), targetPath: join(configDirectory, entry.name), state: 'native' })),
    memory: { shared: false }, warnings: [warning],
  };
}

/** Reads only metadata, our owned bridge/marker, Git metadata and the whitelisted SDK settings. */
export async function inspectSharedCodeContext(profile: Profile, cwd?: string): Promise<SharedCodeContextReport> {
  try {
    return (await analyze(profile, cwd)).report;
  } catch (error) {
    if (profile.id !== DEFAULT_PROFILE_ID) throw error;
    return nativeReport(profile, 'Optional Default context inspection was unavailable; the account retains native CLI behavior.');
  }
}

function sameRoots(a: Locations, b: Locations): boolean {
  return same(a.globalRoot, b.globalRoot) && same(a.configDirectory, b.configDirectory);
}

async function prepare(profile: Profile, cwd: string): Promise<{ settings?: SharedCodeContextSettings; report: SharedCodeContextReport }> {
  if (profile.id === DEFAULT_PROFILE_ID) return { report: await inspectSharedCodeContext(profile, cwd) };
  if (profile.sharedCodeContext === false) {
    return { report: nativeReport(profile, 'Sharing is turned off for this account; nothing was prepared.') };
  }
  const planned = await analyze(profile, cwd);
  if (planned.report.warnings.includes(PROJECT_KEY_WARNING)) throw new Error(PROJECT_KEY_WARNING);
  const result = (analysis: typeof planned) => ({ ...(analysis.settings ? { settings: analysis.settings } : {}), report: analysis.report });
  const pending = planned.report.entries.filter((entry) => entry.state === 'pending');
  if (!pending.length) return result(planned);
  // Without an existing marker, a conflicting entry means the folder is not ours to claim yet.
  if (!planned.markerOwned && planned.report.entries.some((entry) => entry.state === 'conflict')) {
    planned.report.warnings.push(`Not created: ${pending.map((entry) => entry.targetPath).join(', ')}. Relay Desk adds shared files to an account folder only when none of them conflicts; resolve the skipped entries or turn sharing off for this account.`);
    return result(planned);
  }
  const { markerPath, report } = planned;
  const changed = (path: string): Error => new Error(`The shared-context path ${path} changed before preparation; retry after checking the folders.`);
  if (!sameRoots(await roots(profile), report)) throw changed(report.configDirectory);
  if (!planned.markerOwned) await writeFile(markerPath, planned.marker, { encoding: 'utf8', flag: 'wx' });
  for (const entry of pending) {
    if (!sameRoots(await roots(profile), report) || !await exactManagedFile(markerPath, planned.marker)) throw changed(markerPath);
    if (await metadata(entry.targetPath)) throw changed(entry.targetPath);
    if (!same(await physicalPath(entry.sourcePath), entry.sourcePath)) throw changed(entry.sourcePath);
    if (entry.kind === 'instructions') await writeFile(entry.targetPath, bridge(entry.sourcePath), { encoding: 'utf8', flag: 'wx' });
    else await symlink(entry.sourcePath, entry.targetPath, 'junction');
  }
  return result(await analyze(profile, cwd));
}

/** Serialized per account: preparation and unsharing never interleave. */
function serialized<T>(profile: Profile, run: () => Promise<T>): Promise<T> {
  const key = profile.configDir ?? DEFAULT_PROFILE_ID;
  const result = (preparing.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  const settled = result.finally(() => { if (preparing.get(key) === settled) preparing.delete(key); });
  preparing.set(key, settled);
  return settled;
}

export function prepareSharedCodeContext(profile: Profile, cwd: string): Promise<{ settings?: SharedCodeContextSettings; report: SharedCodeContextReport }> {
  return serialized(profile, () => prepare(profile, cwd));
}

async function ownMarker(path: string, profile: Profile): Promise<boolean> {
  const info = await metadata(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) return false;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { owner?: unknown; profileId?: unknown };
    return value.owner === MARKER_OWNER && value.profileId === profile.id;
  } catch {
    return false;
  }
}

/** Removes only a junction itself, never what it points to; a real folder fails instead of being emptied. */
async function removeLink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || (error.code !== 'EPERM' && error.code !== 'EISDIR')) throw error;
    await rmdir(path);
  }
}

async function unshare(profile: Profile): Promise<SharedCodeContextReport> {
  if (profile.id === DEFAULT_PROFILE_ID || !profile.configDir) throw new Error('The default account uses its native Claude Code context; there is nothing to unshare.');
  const configDirectory = await physicalPath(profile.configDir);
  if (!same(configDirectory, profile.configDir)) {
    throw new Error(`The account folder ${profile.configDir} redirects to ${configDirectory}; nothing was removed.`);
  }
  if (!(await metadata(configDirectory))?.isDirectory()) throw new Error(`The account folder ${configDirectory} does not exist.`);
  const globalRoot = await physicalPath(join(homedir(), '.claude'));
  const report: SharedCodeContextReport = {
    profileId: profile.id, mode: 'shared', configDirectory, globalRoot, entries: [], memory: { shared: false }, warnings: [],
  };
  for (const global of GLOBALS) {
    const sourcePath = join(globalRoot, global.name);
    const targetPath = join(configDirectory, global.name);
    const target = await metadata(targetPath);
    let state: EntryState = 'native';
    if (target && global.kind === 'instructions') {
      let expected: string | null = null;
      try { expected = bridge(sourcePath); } catch { /* an unrepresentable path was never bridged */ }
      if (expected && await exactManagedFile(targetPath, expected)) await unlink(targetPath);
      else if (expected && await bridgeWithImport(targetPath, sourcePath)) {
        state = 'conflict';
        report.warnings.push(`Kept ${targetPath}: it was edited after Relay Desk created it and still imports ${sourcePath}. Remove that import line yourself to stop sharing the default instructions.`);
      } else report.warnings.push(`Kept ${targetPath}: it was not created by Relay Desk.`);
    } else if (target) {
      const link = target.isSymbolicLink() ? await linkTarget(targetPath) : null;
      if (link && same(link, sourcePath)) await removeLink(targetPath);
      else report.warnings.push(`Kept ${targetPath}: it is not a Relay Desk junction to ${sourcePath}.`);
    }
    report.entries.push({ kind: global.kind, sourcePath, targetPath, state });
  }
  const markerPath = join(configDirectory, MARKER);
  if (await ownMarker(markerPath, profile)) await unlink(markerPath);
  else if (await metadata(markerPath)) report.warnings.push(`Kept ${markerPath}: it is not a Relay Desk marker for this account.`);
  return report;
}

/** Removes the marker, an unchanged bridge and Relay's own junctions (unlink only); everything else stays and is reported. */
export function unshareSharedCodeContext(profile: Profile): Promise<SharedCodeContextReport> {
  return serialized(profile, () => unshare(profile));
}
