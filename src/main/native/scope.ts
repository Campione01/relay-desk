import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Profile } from '@shared/types';
import type { ProfileStore } from '../system/profiles';

export function physicalFuturePath(input: string): string {
  if (!isAbsolute(input) || input.startsWith('\\\\')) throw new Error('Prototype paths must be absolute local paths.');
  let candidate = input;
  const suffix: string[] = [];
  for (;;) {
    try { lstatSync(candidate); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error('Cannot resolve prototype path.');
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
  return join(realpathSync(candidate), ...suffix);
}

/** Check existing ancestors before a store may mkdir or follow a junction. */
export function assertPrototypePath(input: string, root: string): void {
  const owner = realpathSync(root);
  const physical = physicalFuturePath(input);
  const rel = relative(owner, physical);
  if (!rel || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('Prototype paths must remain inside the isolated prototype directory.');
  }
}

export function assertPrototypeProfile(profile: Profile, root: string): void {
  assertPrototypePath(profile.configDir ?? join(root, 'home', '.claude'), root);
}

export function scopedPrototypeProfiles(store: ProfileStore, root: string): ProfileStore {
  const check = (profile: Profile): Profile => { assertPrototypeProfile(profile, root); return profile; };
  const get = async (id: string) => check(await store.get(id));
  return {
    list: async () => (await store.list()).map(check), get,
    async add(name, configDir) {
      if (configDir) assertPrototypePath(configDir, root);
      return check(await store.add(name, configDir));
    },
    async rename(id, name) { await get(id); return check(await store.rename(id, name)); },
    async remove(id, options) { await get(id); return store.remove(id, options); },
    async setSharedCodeContext(id, enabled) { await get(id); return check(await store.setSharedCodeContext(id, enabled)); },
    async setAuthenticationSource(id, source) { await get(id); return check(await store.setAuthenticationSource(id, source)); },
  };
}
