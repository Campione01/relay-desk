import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { DEFAULT_PROFILE_ID, type AuthenticationSource, type Profile, type ProfileId } from '@shared/types';
import { validateAuthenticationSource } from './authenticationEnvironment';
import { createSerialQueue, quarantineFile, readJsonFile, writeJsonFileAtomic } from './jsonFile';
import { isSameOrInside, toLocalAbsolutePath } from './paths';

/** profiles.json under userData; the 'default' profile (configDir null) always exists. */
export interface ProfileStore {
  list(): Promise<Profile[]>;
  /** Rejects for unknown ids. */
  get(id: ProfileId): Promise<Profile>;
  /** Creates <userData>/profiles/<id> unless `configDir` is given (that folder is created when missing). */
  add(name: string, configDir?: string): Promise<Profile>;
  rename(id: ProfileId, name: string): Promise<Profile>;
  /**
   * Never deletes the profile directory unless `deleteDirectory` is set, and even then only a directory
   * Relay created under <userData>/profiles; a folder the user picked is always kept.
   */
  remove(id: ProfileId, options?: { deleteDirectory?: boolean }): Promise<{ deletedDirectory: boolean }>;
  /** Independent accounts only; an absent flag means the user's original approval (on) stands. */
  setSharedCodeContext(id: ProfileId, enabled: boolean): Promise<Profile>;
  /** Saves only the explicit source selection, never authentication values. */
  setAuthenticationSource(id: ProfileId, source: AuthenticationSource): Promise<Profile>;
}

export interface ProfileStoreDeps {
  /** Home folder whose .claude (the default profile) must never become another profile's dir. */
  homeDir?: string;
  /** Folders a profile may not use or live in, besides ~/.claude (default: the desktop app's own folders, R1). */
  forbiddenDirs?: string[];
  now?: () => number;
  newId?: () => string;
}

const FILE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 64;

interface DirectoryBounds {
  userData: string;
  managedRoot: string;
  forbidden: string[];
}

function sameDirectory(a: string, b: string): boolean {
  return win32.relative(a, b) === '';
}

function overlaps(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** Resolve the deepest existing ancestor before mkdir can follow a junction into a protected folder. */
async function resolveDirectory(input: string): Promise<string> {
  let candidate = toLocalAbsolutePath(input);
  if (!candidate) throw new Error('The profile folder must be an absolute local path (no network paths)');
  const suffix: string[] = [];
  const unresolved = (): Error => new Error(`Could not resolve the profile folder safely: ${input}`);
  for (;;) {
    try {
      const resolved = toLocalAbsolutePath(await realpath(candidate));
      if (!resolved || !(await stat(resolved)).isDirectory()) throw unresolved();
      return join(resolved, ...suffix);
    } catch (error) {
      if (!isMissing(error)) throw unresolved();
      let exists = false;
      try {
        await lstat(candidate);
        exists = true;
      } catch (entryError) {
        if (!isMissing(entryError)) throw unresolved();
      }
      // A dangling junction is not a missing directory we may safely create.
      if (exists) throw unresolved();
      const parent = dirname(candidate);
      if (sameDirectory(parent, candidate)) throw unresolved();
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

export function defaultProfile(createdAt = 0): Profile {
  return { id: DEFAULT_PROFILE_ID, name: 'Default', configDir: null, createdAt };
}

/** Pure: trimmed display name, or an error for empty, too long or control characters. */
export function validateProfileName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Profile name must be text');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Profile name is empty');
  if (trimmed.length > MAX_NAME) throw new Error(`Profile name is longer than ${MAX_NAME} characters`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw new Error('Profile name contains control characters');
  return trimmed;
}

function parseProfiles(value: unknown): Profile[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { profiles?: unknown }).profiles)) return null;
  const result: Profile[] = [];
  for (const raw of (value as { profiles: unknown[] }).profiles) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id) || result.some((x) => x.id === p.id)) continue;
    let name: string;
    try {
      name = validateProfileName(p.name);
    } catch {
      continue;
    }
    const createdAt = typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : 0;
    const authentication = p.authenticationSource === undefined ? {} : { authenticationSource: validateAuthenticationSource(p.authenticationSource) };
    if (p.id === DEFAULT_PROFILE_ID) {
      result.push({ id: DEFAULT_PROFILE_ID, name, configDir: null, createdAt, ...authentication });
      continue;
    }
    const configDir = toLocalAbsolutePath(p.configDir);
    if (!configDir) continue;
    result.push({ id: p.id, name, configDir, createdAt, ...authentication, ...(typeof p.sharedCodeContext === 'boolean' ? { sharedCodeContext: p.sharedCodeContext } : {}) });
  }
  return result;
}

export function createProfileStore(userDataDir: string, deps: ProfileStoreDeps = {}): ProfileStore {
  const file = join(userDataDir, 'profiles.json');
  const managedRoot = join(userDataDir, 'profiles');
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `p-${randomBytes(4).toString('hex')}`);
  const serial = createSerialQueue();
  let cache: Profile[] | undefined;

  const forbidden = (): string[] => {
    if (deps.forbiddenDirs) return [join(deps.homeDir ?? homedir(), '.claude'), ...deps.forbiddenDirs];
    const dirs = [join(deps.homeDir ?? homedir(), '.claude')];
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'Claude'));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'AnthropicClaude'));
    return dirs;
  };

  const directoryBounds = async (): Promise<DirectoryBounds> => {
    const userData = await resolveDirectory(userDataDir);
    const managed = await resolveDirectory(managedRoot);
    if (!isSameOrInside(managed, userData) || sameDirectory(managed, userData)) {
      throw new Error('The managed profile folder must remain inside the Relay Desk data folder');
    }
    return { userData, managedRoot: managed, forbidden: await Promise.all(forbidden().map(resolveDirectory)) };
  };

  const isManaged = (dir: string, id: string, bounds: DirectoryBounds): boolean =>
    sameDirectory(dir, join(managedRoot, id)) || sameDirectory(dir, join(bounds.managedRoot, id));

  const checkConfigDir = (dir: string, profiles: Profile[], bounds: DirectoryBounds): void => {
    for (const blocked of bounds.forbidden) {
      if (overlaps(dir, blocked)) {
        throw new Error(`This folder cannot be used for a profile: ${blocked} belongs to the default account or the desktop app`);
      }
    }
    for (const other of profiles) {
      if (!other.configDir) continue;
      if (overlaps(dir, other.configDir)) {
        throw new Error(`This folder overlaps the folder of profile "${other.name}"`);
      }
    }
  };

  const checkedDirectory = async (
    dir: string, id: string, profiles: Profile[], bounds: DirectoryBounds, managed: boolean,
  ): Promise<string> => {
    const resolved = await resolveDirectory(dir);
    if (managed) {
      if (!sameDirectory(resolved, join(bounds.managedRoot, id))) {
        throw new Error('The managed profile folder cannot redirect to another directory');
      }
    } else if (overlaps(resolved, bounds.userData)) {
      throw new Error('The profile folder cannot be inside or contain the Relay Desk data folder');
    }
    checkConfigDir(resolved, profiles, bounds);
    return resolved;
  };

  const load = async (): Promise<Profile[]> => {
    if (!cache) {
      const read = await readJsonFile(file);
      let profiles = read.state === 'ok' ? parseProfiles(read.value) : null;
      if (read.state === 'invalid' || (read.state === 'ok' && !profiles)) await quarantineFile(file);
      profiles ??= [];
      if (!profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) profiles.unshift(defaultProfile(now()));
      cache = profiles;
    }
    if (!cache.some((profile) => profile.configDir)) return cache;
    const bounds = await directoryBounds();
    const checked: Profile[] = [];
    for (const profile of cache) {
      if (!profile.configDir) {
        checked.push(profile);
        continue;
      }
      const configDir = await checkedDirectory(
        profile.configDir, profile.id, checked, bounds, isManaged(profile.configDir, profile.id, bounds),
      );
      checked.push({ ...profile, configDir });
    }
    return checked;
  };

  const save = async (profiles: Profile[]): Promise<void> => {
    await writeJsonFileAtomic(file, { version: FILE_VERSION, profiles });
    cache = profiles;
  };

  const find = (profiles: Profile[], id: ProfileId): Profile => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  };

  return {
    list: () => serial(async () => structuredClone(await load())),
    get: (id) => serial(async () => structuredClone(find(await load(), id))),
    add: (name, configDir) =>
      serial(async () => {
        const profiles = await load();
        const cleanName = validateProfileName(name);
        let id = newId();
        while (profiles.some((p) => p.id === id)) id = newId();
        if (!ID_PATTERN.test(id)) throw new Error(`Invalid profile id: ${id}`);
        let dir: string;
        if (configDir === undefined || configDir === '') {
          dir = join(managedRoot, id);
        } else {
          const checked = toLocalAbsolutePath(configDir);
          if (!checked) throw new Error('The profile folder must be an absolute local path (no network paths)');
          if (isSameOrInside(checked, userDataDir) || isSameOrInside(userDataDir, checked)) {
            throw new Error('The profile folder cannot be inside or contain the Relay Desk data folder');
          }
          dir = checked;
        }
        const bounds = await directoryBounds();
        dir = await checkedDirectory(dir, id, profiles, bounds, configDir === undefined || configDir === '');
        await mkdir(dir, { recursive: true });
        if (!sameDirectory(await resolveDirectory(dir), dir)) throw new Error('The profile folder changed while it was being created');
        const profile: Profile = { id, name: cleanName, configDir: dir, createdAt: now() };
        await save([...profiles, profile]);
        return structuredClone(profile);
      }),
    rename: (id, name) =>
      serial(async () => {
        const profiles = await load();
        const cleanName = validateProfileName(name);
        find(profiles, id);
        const next = profiles.map((p) => (p.id === id ? { ...p, name: cleanName } : p));
        await save(next);
        return structuredClone(find(next, id));
      }),
    remove: (id, options) =>
      serial(async () => {
        if (id === DEFAULT_PROFILE_ID) throw new Error('The default profile cannot be removed');
        const profiles = await load();
        const profile = find(profiles, id);
        const dir = profile.configDir;
        const bounds = await directoryBounds();
        const deleteDirectory = options?.deleteDirectory && dir && sameDirectory(dir, join(bounds.managedRoot, id));
        if (deleteDirectory && !sameDirectory(await resolveDirectory(dir), dir)) {
          throw new Error('The profile folder changed before it could be removed');
        }
        await save(profiles.filter((p) => p.id !== id));
        if (!deleteDirectory) {
          return { deletedDirectory: false };
        }
        await rm(dir, { recursive: true, force: true });
        return { deletedDirectory: true };
      }),
    setSharedCodeContext: (id, enabled) =>
      serial(async () => {
        if (id === DEFAULT_PROFILE_ID) throw new Error('The default account always uses its native Claude Code context.');
        if (typeof enabled !== 'boolean') throw new Error('Invalid shared code context setting.');
        const profiles = await load();
        find(profiles, id);
        const next = profiles.map((p) => (p.id === id ? { ...p, sharedCodeContext: enabled } : p));
        await save(next);
        return structuredClone(find(next, id));
      }),
    setAuthenticationSource: (id, source) =>
      serial(async () => {
        const mode = validateAuthenticationSource(source);
        const profiles = await load();
        const current = find(profiles, id);
        if ((current.authenticationSource ?? 'cli-config') === mode) return structuredClone(current);
        const next = profiles.map((profile) => profile.id === id ? { ...profile, authenticationSource: mode } : profile);
        await save(next);
        return structuredClone(find(next, id));
      }),
  };
}
