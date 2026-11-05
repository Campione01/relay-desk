import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfileStore, type ProfileStoreDeps } from '../../src/main/system/profiles';

let root: string;
let userData: string;
let home: string;
let desktopDir: string;
let ids: number;
const junctions: string[] = [];

const deps = (): ProfileStoreDeps => ({
  homeDir: home,
  forbiddenDirs: [desktopDir],
  now: () => 1000,
  newId: () => `p-${++ids}`,
});
const store = () => createProfileStore(userData, deps());

async function junction(target: string, path: string): Promise<string> {
  await symlink(target, path, 'junction');
  junctions.push(path);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relay-profiles-'));
  userData = join(root, 'Relay Desk');
  home = join(root, 'home');
  desktopDir = join(root, 'AppData', 'Claude');
  ids = 0;
});

afterEach(async () => {
  for (const path of junctions.splice(0).reverse()) await rm(path, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe('profile store', () => {
  it('always lists the default profile (configDir null) on first run', async () => {
    expect(await store().list()).toEqual([{ id: 'default', name: 'Default', configDir: null, createdAt: 1000 }]);
  });

  it('add without a folder creates <userData>/profiles/<id> and persists it', async () => {
    const profile = await store().add('  Work  ');
    expect(profile).toEqual({ id: 'p-1', name: 'Work', configDir: join(userData, 'profiles', 'p-1'), createdAt: 1000 });
    expect(existsSync(join(userData, 'profiles', 'p-1'))).toBe(true);
    const reloaded = createProfileStore(userData, deps());
    expect((await reloaded.list()).map((p) => p.id)).toEqual(['default', 'p-1']);
    expect(await reloaded.get('p-1')).toEqual(profile);
    expect((await readdir(userData)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('add with a folder uses and creates that folder', async () => {
    const dir = join(root, 'accounts', 'personal');
    const profile = await store().add('Personal', dir);
    expect(profile.configDir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses ~/.claude, anything inside it and the desktop app folders', async () => {
    const s = store();
    await expect(s.add('A', join(home, '.claude'))).rejects.toThrow(/cannot be used/);
    await expect(s.add('B', join(home, '.CLAUDE', 'sub'))).rejects.toThrow(/cannot be used/);
    await expect(s.add('C', join(desktopDir, 'x'))).rejects.toThrow(/cannot be used/);
    expect(await s.list()).toHaveLength(1);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('refuses a folder nested in, equal to or containing another profile folder', async () => {
    const s = store();
    const first = await s.add('First', join(root, 'acc', 'first'));
    await expect(s.add('Nested', join(first.configDir!, 'inner'))).rejects.toThrow(/overlaps/);
    await expect(s.add('Same', first.configDir!.toUpperCase())).rejects.toThrow(/overlaps/);
    await expect(s.add('Parent', join(root, 'acc'))).rejects.toThrow(/overlaps/);
  });

  it('refuses network, relative and dot-dot paths and the Relay data folder', async () => {
    const s = store();
    await expect(s.add('Unc', '\\\\server\\share\\x')).rejects.toThrow(/absolute local path/);
    await expect(s.add('Rel', 'profiles\\x')).rejects.toThrow(/absolute local path/);
    await expect(s.add('Dots', `${root}\\a\\..\\..\\x`)).rejects.toThrow(/absolute local path/);
    await expect(s.add('Data', join(userData, 'mine'))).rejects.toThrow(/data folder/);
    await expect(s.add('', undefined)).rejects.toThrow(/empty/);
    await expect(s.add('bad\u0007name')).rejects.toThrow(/control/);
  });

  it('renames, including the default profile, and rejects unknown ids', async () => {
    const s = store();
    const p = await s.add('Old');
    expect(await s.rename(p.id, 'New')).toMatchObject({ id: p.id, name: 'New' });
    expect(await s.rename('default', 'Desktop account')).toMatchObject({ id: 'default', configDir: null });
    await expect(s.rename('nope', 'x')).rejects.toThrow(/Unknown profile/);
    await expect(s.get('nope')).rejects.toThrow(/Unknown profile/);
    expect((await createProfileStore(userData, deps()).get(p.id)).name).toBe('New');
  });

  it('remove keeps the directory unless asked, never removes default, never deletes a user-picked folder', async () => {
    const s = store();
    await expect(s.remove('default')).rejects.toThrow(/default profile/);
    const kept = await s.add('Kept');
    expect(await s.remove(kept.id)).toEqual({ deletedDirectory: false });
    expect(existsSync(kept.configDir!)).toBe(true);

    const managed = await s.add('Managed');
    expect(await s.remove(managed.id, { deleteDirectory: true })).toEqual({ deletedDirectory: true });
    expect(existsSync(managed.configDir!)).toBe(false);

    const picked = await s.add('Picked', join(root, 'mine'));
    expect(await s.remove(picked.id, { deleteDirectory: true })).toEqual({ deletedDirectory: false });
    expect(existsSync(join(root, 'mine'))).toBe(true);
    expect((await s.list()).map((p) => p.id)).toEqual(['default']);
  });

  it('persists the shared code context switch per independent account and refuses it for the default account', async () => {
    const s = store();
    const p = await s.add('Work');
    expect(p).not.toHaveProperty('sharedCodeContext');
    expect(await s.setSharedCodeContext(p.id, false)).toMatchObject({ id: p.id, sharedCodeContext: false });
    expect((await createProfileStore(userData, deps()).get(p.id)).sharedCodeContext).toBe(false);
    await s.setSharedCodeContext(p.id, true);
    expect((await createProfileStore(userData, deps()).get(p.id)).sharedCodeContext).toBe(true);
    await expect(s.setSharedCodeContext('default', false)).rejects.toThrow(/default account/);
    await expect(s.setSharedCodeContext('nope', false)).rejects.toThrow(/Unknown profile/);
    expect(await s.get('default')).not.toHaveProperty('sharedCodeContext');
  });

  it('keeps legacy profiles and their exact file bytes unchanged when reading or selecting the default source', async () => {
    const s = store();
    expect(await s.get('default')).not.toHaveProperty('authenticationSource');
    await s.setAuthenticationSource('default', 'cli-config');
    expect(existsSync(join(userData, 'profiles.json'))).toBe(false);
    const work = await s.add('Work');
    const file = join(userData, 'profiles.json');
    const before = await readFile(file, 'utf8');
    const reloaded = store();
    expect(await reloaded.get(work.id)).toEqual(work);
    await reloaded.list();
    await reloaded.setAuthenticationSource(work.id, 'cli-config');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('persists only the explicit auth-source choice for the targeted account and preserves isolation', async () => {
    const s = store();
    const first = await s.add('First');
    const second = await s.add('Second');
    const before = await s.list();
    const changed = await s.setAuthenticationSource(first.id, 'launch-environment');
    expect(changed).toEqual({ ...first, authenticationSource: 'launch-environment' });
    expect(before).toEqual([await s.get('default'), first, second]);
    expect(await s.get(second.id)).toEqual(second);
    expect((await store().get(first.id)).authenticationSource).toBe('launch-environment');
    const saved = JSON.parse(await readFile(join(userData, 'profiles.json'), 'utf8')) as { profiles: unknown[] };
    expect(saved.profiles).toEqual([await s.get('default'), changed, second]);
    changed.authenticationSource = 'cli-config';
    expect((await s.get(first.id)).authenticationSource).toBe('launch-environment');
    expect(await s.setAuthenticationSource(first.id, 'cli-config')).toEqual({ ...first, authenticationSource: 'cli-config' });
    expect(await s.setAuthenticationSource('default', 'launch-environment')).toMatchObject({ id: 'default', configDir: null, authenticationSource: 'launch-environment' });
    expect((await store().get('default')).authenticationSource).toBe('launch-environment');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('rejects malformed or unknown auth-source updates without changing profile files', async () => {
    const s = store();
    const profile = await s.add('Work');
    const file = join(userData, 'profiles.json');
    const before = await readFile(file, 'utf8');
    for (const invalid of [undefined, null, '', 'CLI-CONFIG', 'launch-environment ', 1, {}, []]) {
      await expect(s.setAuthenticationSource(profile.id, invalid as never)).rejects.toThrow('Invalid authentication source.');
    }
    await expect(s.setAuthenticationSource('unknown', 'launch-environment')).rejects.toThrow(/Unknown profile/);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await s.get(profile.id)).toEqual(profile);
  });

  it('fails closed on a malformed persisted auth source without rewriting or falling back to another account', async () => {
    await mkdir(userData, { recursive: true });
    const file = join(userData, 'profiles.json');
    const raw = JSON.stringify({ version: 1, profiles: [{ id: 'default', name: 'Default', configDir: null, createdAt: 1, authenticationSource: 'untrusted' }] });
    await writeFile(file, raw);
    await expect(store().list()).rejects.toThrow('Invalid authentication source.');
    expect(await readFile(file, 'utf8')).toBe(raw);
    expect(await readdir(userData)).toEqual(['profiles.json']);
  });

  it('falls back to the default profile on a corrupt file and moves the corrupt file aside', async () => {
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'profiles.json'), '{not json');
    expect((await store().list()).map((p) => p.id)).toEqual(['default']);
    const files = await readdir(userData);
    expect(files.some((f) => f.startsWith('profiles.json.invalid-'))).toBe(true);
  });

  it('drops invalid entries and forces configDir null on default', async () => {
    await mkdir(userData, { recursive: true });
    const validDir = join(root, 'accounts', 'ok');
    await writeFile(
      join(userData, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          { id: 'default', name: 'D', configDir: 'C:\\evil', createdAt: 5 },
          { id: 'ok', name: 'Ok', configDir: validDir, createdAt: 6 },
          { id: '../x', name: 'Bad id', configDir: 'D:\\p\\x', createdAt: 7 },
          { id: 'unc', name: 'Unc', configDir: '\\\\srv\\s', createdAt: 8 },
          { id: 'nodir', name: 'No dir', configDir: null, createdAt: 9 },
        ],
      }),
    );
    expect(await store().list()).toEqual([
      { id: 'default', name: 'D', configDir: null, createdAt: 5 },
      { id: 'ok', name: 'Ok', configDir: validDir, createdAt: 6 },
    ]);
  });

  it('serialises concurrent adds', async () => {
    const s = store();
    await Promise.all([s.add('A'), s.add('B'), s.add('C')]);
    const saved = JSON.parse(await readFile(join(userData, 'profiles.json'), 'utf8')) as { profiles: unknown[] };
    expect(saved.profiles).toHaveLength(4);
  });

  it('rejects junctions into default or desktop directories before creating missing children', async () => {
    const s = store();
    for (const [index, target] of [join(home, '.claude'), desktopDir].entries()) {
      await mkdir(target, { recursive: true });
      const alias = await junction(target, join(root, `blocked-alias-${index}`));
      await expect(s.add('Blocked', alias)).rejects.toThrow(/cannot be used/);
      await expect(s.add('Missing child', join(alias, 'not-created'))).rejects.toThrow(/cannot be used/);
      expect(existsSync(join(target, 'not-created'))).toBe(false);
    }
    expect(await s.list()).toHaveLength(1);
  });

  it('rejects a parent directory containing a protected directory', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await expect(store().add('Parent', home)).rejects.toThrow(/cannot be used/);
  });

  it('returns the physical directory for a safe alias and keeps a custom directory on removal', async () => {
    const target = join(root, 'custom-target');
    await mkdir(target, { recursive: true });
    const alias = await junction(target, join(root, 'custom-alias'));
    const s = store();
    const profile = await s.add('Safe alias', join(alias, 'new-child'));
    expect(profile.configDir).toBe(join(await realpath(target), 'new-child'));
    expect((await createProfileStore(userData, deps()).get(profile.id)).configDir).toBe(profile.configDir);
    await expect(s.remove(profile.id, { deleteDirectory: true })).resolves.toEqual({ deletedDirectory: false });
    expect(existsSync(profile.configDir!)).toBe(true);
  });

  it('rejects physical overlap through aliases in either direction', async () => {
    const s = store();
    const target = join(root, 'accounts', 'work');
    const first = await s.add('First', target);
    const alias = await junction(target, join(root, 'work-alias'));
    await expect(s.add('Same target', alias)).rejects.toThrow(/overlaps/);
    await expect(s.add('Nested target', join(alias, 'not-created'))).rejects.toThrow(/overlaps/);
    const parentAlias = await junction(join(root, 'accounts'), join(root, 'parent-alias'));
    await expect(s.add('Parent target', parentAlias)).rejects.toThrow(/overlaps/);
    expect(existsSync(join(first.configDir!, 'not-created'))).toBe(false);
  });

  it('rejects aliases into or containing the Relay data folder', async () => {
    const s = store();
    await s.add('Managed');
    const alias = await junction(userData, join(root, 'data-alias'));
    await expect(s.add('Data child', join(alias, 'not-created'))).rejects.toThrow(/data folder/);
    const parent = join(root, 'data-parent');
    await mkdir(parent, { recursive: true });
    const otherData = join(parent, 'Relay Desk');
    const otherStore = createProfileStore(otherData, deps());
    const parentAlias = await junction(parent, join(root, 'data-parent-alias'));
    await expect(otherStore.add('Data parent', parentAlias)).rejects.toThrow(/data folder/);
    expect(existsSync(join(userData, 'not-created'))).toBe(false);
    expect(existsSync(otherData)).toBe(false);
  });

  it('revalidates loaded and cached directories without rewriting an unsafe saved profile', async () => {
    await mkdir(desktopDir, { recursive: true });
    const alias = await junction(desktopDir, join(root, 'saved-alias'));
    await mkdir(userData, { recursive: true });
    const saved = JSON.stringify({ profiles: [{ id: 'unsafe', name: 'Unsafe', configDir: alias, createdAt: 0 }] });
    await writeFile(join(userData, 'profiles.json'), saved);
    const s = store();
    await expect(s.list()).rejects.toThrow(/cannot be used/);
    await expect(s.get('unsafe')).rejects.toThrow(/cannot be used/);
    expect(await readFile(join(userData, 'profiles.json'), 'utf8')).toBe(saved);

    await rm(join(userData, 'profiles.json'));
    const cached = store();
    const profile = await cached.add('Cached', join(root, 'cached-profile'));
    await rm(profile.configDir!, { recursive: true, force: true });
    await junction(desktopDir, profile.configDir!);
    await expect(cached.get(profile.id)).rejects.toThrow(/cannot be used/);
    await expect(cached.list()).rejects.toThrow(/cannot be used/);
  });

  it('fails closed for an unresolved junction or a non-directory without creating its target', async () => {
    const target = join(root, 'dangling-target');
    await mkdir(target);
    const alias = await junction(target, join(root, 'dangling-alias'));
    await rm(target, { recursive: true, force: true });
    const s = store();
    await expect(s.add('Dangling', alias)).rejects.toThrow(/Could not resolve/);
    expect(existsSync(target)).toBe(false);
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'synthetic');
    await expect(s.add('File', file)).rejects.toThrow(/Could not resolve/);
    expect(await s.list()).toHaveLength(1);
  });

  it('refuses a redirected managed profile and never deletes its external target', async () => {
    const s = store();
    const profile = await s.add('Managed');
    const saved = await readFile(join(userData, 'profiles.json'), 'utf8');
    const target = join(root, 'managed-external-target');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'synthetic');
    await rm(profile.configDir!, { recursive: true, force: true });
    await junction(target, profile.configDir!);
    await expect(s.remove(profile.id, { deleteDirectory: true })).rejects.toThrow(/cannot redirect/);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('synthetic');
    expect(await readFile(join(userData, 'profiles.json'), 'utf8')).toBe(saved);
  });

  it('refuses a managed-root junction outside userData before creating a profile', async () => {
    const target = join(root, 'managed-root-target');
    await mkdir(target);
    await mkdir(userData);
    await junction(target, join(userData, 'profiles'));
    await expect(store().add('Managed')).rejects.toThrow(/managed profile folder must remain inside/);
    expect(await readdir(target)).toEqual([]);
    expect(existsSync(join(userData, 'profiles.json'))).toBe(false);
  });
});
