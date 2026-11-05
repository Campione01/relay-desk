import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrototypeProfile, nativePrivateRoot, validatedFixtureUrl } from '../../src/main/native/prototypeServices';
import { scopedPrototypeProfiles } from '../../src/main/native/scope';
import type { ProfileStore } from '../../src/main/system/profiles';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('prototype production-account gates', () => {
  it('keeps normal private assets in the verified per-application namespace without changing user/profile paths', () => {
    const first = nativePrivateRoot('C:\\Users\\Fixture\\AppData\\Roaming\\Relay Desk');
    expect(first).toMatch(/^C:\\RelayDeskNativePrototype\\app-assets\\[a-f0-9]{64}$/);
    expect(nativePrivateRoot('c:\\users\\fixture\\appdata\\roaming\\relay desk')).toBe(first);
    expect(nativePrivateRoot('C:\\Users\\Other\\AppData\\Roaming\\Relay Desk')).not.toBe(first);
    expect(() => nativePrivateRoot('\\\\server\\share')).toThrow('local absolute');
    expect(() => nativePrivateRoot('relative')).toThrow('local absolute');
  });
  it('only accepts numeric loopback fixture origins without embedded credentials or paths', () => {
    expect(validatedFixtureUrl(undefined)).toBeUndefined();
    expect(validatedFixtureUrl('http://127.0.0.1:43210/')).toBe('http://127.0.0.1:43210');
    for (const input of ['https://api.anthropic.com', 'http://localhost:43210', 'http://127.0.0.1', 'http://a:b@127.0.0.1:43210', 'http://127.0.0.1:43210/other', 'http://127.0.0.1:43210/?key=secret', 'http://127.0.0.1:43210/#fragment']) {
      expect(() => validatedFixtureUrl(input)).toThrow();
    }
  });

  it('refuses external accounts including junction escapes', () => {
    const folder = mkdtempSync(join(tmpdir(), 'relay-native-profile-test-')); owned.push(folder);
    const root = join(folder, 'RelayDeskNativePrototype');
    const external = join(folder, 'outside');
    mkdirSync(root); mkdirSync(external);
    const profile = { id: 'default', name: 'Default', configDir: null, createdAt: 0 };
    expect(() => assertPrototypeProfile(profile, root)).not.toThrow();
    expect(() => assertPrototypeProfile({ ...profile, configDir: external }, root)).toThrow('inside');
    const link = join(root, 'escape');
    symlinkSync(external, link, 'junction');
    expect(() => assertPrototypeProfile({ ...profile, configDir: link }, root)).toThrow('inside');
  });

  it('checks imported account directories before stores can create or mutate them', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'relay-native-store-test-')); owned.push(folder);
    const root = join(folder, 'RelayDeskNativePrototype'); mkdirSync(root);
    const outside = join(folder, 'outside-not-created');
    const unsafe = { id: 'outside', name: 'External', configDir: outside, createdAt: 0 };
    const store: ProfileStore = {
      list: vi.fn(async () => [unsafe]), get: vi.fn(async () => unsafe),
      add: vi.fn(async () => unsafe), rename: vi.fn(async () => unsafe),
      remove: vi.fn(async () => ({ deletedDirectory: false })), setSharedCodeContext: vi.fn(async () => unsafe),
      setAuthenticationSource: vi.fn(async () => unsafe),
    };
    const scoped = scopedPrototypeProfiles(store, root);
    await expect(scoped.add('External', outside)).rejects.toThrow('inside');
    expect(store.add).not.toHaveBeenCalled();
    await expect(scoped.list()).rejects.toThrow('inside');
    await expect(scoped.get('outside')).rejects.toThrow('inside');
    await expect(scoped.rename('outside', 'Changed')).rejects.toThrow('inside');
    await expect(scoped.remove('outside', { deleteDirectory: true })).rejects.toThrow('inside');
    await expect(scoped.setSharedCodeContext('outside', true)).rejects.toThrow('inside');
    await expect(scoped.setAuthenticationSource('outside', 'launch-environment')).rejects.toThrow('inside');
    expect(store.rename).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.setSharedCodeContext).not.toHaveBeenCalled();
    expect(store.setAuthenticationSource).not.toHaveBeenCalled();
  });
});
