import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativePreferenceScope } from '../../src/main/native/persistentPreferences';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-preferences-')); owned.push(root);
  const configDir = join(root, 'independent'); mkdirSync(configDir);
  const settings = join(configDir, 'settings.json');
  const profile = { id: 'independent', name: 'Fixture', configDir, createdAt: 0 };
  return { root, settings, profile, configDir };
}

describe('native saved preferences scope', () => {
  it('changes only workflow keys and leaves rules, memory, MCP data and other accounts untouched', () => {
    const f = fixture();
    const original = { disableWorkflows: true, permissions: { deny: ['Read(secret)'] }, env: { HTTPS_PROXY: 'fixture' }, autoMemoryDirectory: 'shared-memory' };
    writeFileSync(f.settings, JSON.stringify(original));
    const account = join(f.configDir, '.claude.json'); writeFileSync(account, '{"projects":{"fixture":{"disabledMcpServers":["one"]}}}');
    const before = readFileSync(account);
    const scope = createNativePreferenceScope(f.profile, f.root);
    scope.prepareWorkflows('on');
    expect(JSON.parse(readFileSync(f.settings, 'utf8'))).toEqual({ permissions: original.permissions, env: original.env, autoMemoryDirectory: original.autoMemoryDirectory, enableWorkflows: true });
    expect(readFileSync(account)).toEqual(before);
    scope.prepareWorkflows('off');
    expect(JSON.parse(readFileSync(f.settings, 'utf8')).enableWorkflows).toBe(false);
    const saved = readFileSync(f.settings); scope.prepareWorkflows(undefined);
    expect(readFileSync(f.settings)).toEqual(saved);
    expect(readdirSync(f.configDir).sort()).toEqual(['.claude.json', 'settings.json']);
  });
  it('leaves the native default unset and rejects the Desktop default profile', () => {
    const f = fixture(); createNativePreferenceScope(f.profile, f.root).prepareWorkflows(undefined);
    expect(existsSync(f.settings)).toBe(false);
    expect(() => createNativePreferenceScope({ ...f.profile, id: 'default' }, f.root)).toThrow('independent');
    expect(() => createNativePreferenceScope({ ...f.profile, configDir: null }, f.root)).toThrow('independent');
  });
  it('prepares only the requested native saved settings and does not reset unrelated or omitted preferences', () => {
    const f = fixture(); const original = { permissions: { defaultMode: 'default' }, autoMemoryEnabled: false, enableWorkflows: false };
    writeFileSync(f.settings, JSON.stringify(original));
    const scope = createNativePreferenceScope(f.profile, f.root);
    scope.prepareNativeSettings({ autoContinue: false, fastMode: true });
    expect(JSON.parse(readFileSync(f.settings, 'utf8'))).toEqual({ ...original, autoContinueAtUsageLimit: false, fastMode: true });
    const prior = readFileSync(f.settings); scope.prepareNativeSettings({});
    expect(readFileSync(f.settings)).toEqual(prior);
  });
  it('refuses aliased account directories and linked settings even within the prototype', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.configDir, alias, 'junction');
    expect(() => createNativePreferenceScope({ ...f.profile, configDir: alias }, f.root)).toThrow('alias');
    const shared = join(f.root, 'shared-settings.json'); writeFileSync(shared, '{}'); linkSync(shared, f.settings);
    expect(() => createNativePreferenceScope(f.profile, f.root)).toThrow('independent regular');
    expect(readFileSync(shared, 'utf8')).toBe('{}');
  });
  it('rejects malformed or external preference sources without overwriting them', () => {
    const f = fixture(); writeFileSync(f.settings, 'not-json');
    expect(() => createNativePreferenceScope(f.profile, f.root).prepareWorkflows('on')).toThrow();
    expect(readFileSync(f.settings, 'utf8')).toBe('not-json');
    const other = fixture();
    expect(() => createNativePreferenceScope(other.profile, f.root)).toThrow('inside');
  });
});
