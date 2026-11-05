import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializePrototypeEnvironment, prototypePaths } from '../../src/main/native/isolation';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('native prototype isolation', () => {
  it('separates every storage root while retaining transport settings and the original environment', () => {
    const folder = mkdtempSync(join(tmpdir(), 'relay-prototype-isolation-')); owned.push(folder);
    const root = join(folder, 'RelayDeskNativePrototype');
    const original = { USERPROFILE: 'C:\\Users\\Synthetic', HOME: 'C:\\Users\\Synthetic', APPDATA: 'C:\\Users\\Synthetic\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Synthetic\\AppData\\Local', HTTPS_PROXY: 'http://127.0.0.1:9988' };
    const env: NodeJS.ProcessEnv = { ...original };
    const result = initializePrototypeEnvironment(root, env);
    expect(env.USERPROFILE).toBe(result.home);
    expect(env.APPDATA).toBe(result.roaming);
    expect(env.LOCALAPPDATA).toBe(result.local);
    expect(env.TEMP).toBe(result.temp);
    expect(env.TMP).toBe(result.temp);
    expect(env.TMPDIR).toBe(result.temp);
    expect(result.userData).toBe(join(root, 'app'));
    expect(env.HTTPS_PROXY).toBe(original.HTTPS_PROXY);
    expect(original.USERPROFILE).toBe('C:\\Users\\Synthetic');
  });
  it('refuses a real home, system directory, root and relative output location', () => {
    for (const root of ['C:\\', 'C:\\Windows\\Fonts', 'C:\\Users\\Synthetic', 'C:\\Users\\Synthetic\\.claude', 'C:\\Users\\Synthetic\\RelayDeskNativePrototype', 'relative']) {
      expect(() => prototypePaths(root, 'C:\\Users\\Synthetic')).toThrow();
    }
  });
  it('rejects redirected storage before creating any files outside the prototype', () => {
    const folder = mkdtempSync(join(tmpdir(), 'relay-prototype-reparse-')); owned.push(folder);
    const root = join(folder, 'RelayDeskNativePrototype');
    const outside = join(folder, 'outside');
    mkdirSync(root); mkdirSync(outside);
    symlinkSync(outside, join(root, 'home'), 'junction');
    expect(() => initializePrototypeEnvironment(root, { USERPROFILE: 'C:\\Users\\Synthetic' })).toThrow('redirected');
    expect(existsSync(join(root, 'app'))).toBe(false);
    expect(existsSync(join(outside, '.claude'))).toBe(false);
  });
});
