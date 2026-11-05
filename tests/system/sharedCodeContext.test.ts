import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile, link, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSettings, type ResolvedSettings, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@shared/types';
import { createProfileStore } from '../../src/main/system/profiles';

const h = vi.hoisted(() => ({ home: '', reads: [] as string[] }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => h.home }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => { h.reads.push(String(args[0])); return actual.readFile(...args); } };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ resolveSettings: vi.fn() }));
const { inspectSharedCodeContext, prepareSharedCodeContext, unshareSharedCodeContext } = await import('../../src/main/system/sharedCodeContext');

let root: string;
let base: string;
let cwd: string;
let account: Profile;
let snapshot: ResolvedSettings;
const defaultAccount: Profile = { id: 'default', name: 'Default', configDir: null, createdAt: 0 };
const extraJunctions: string[] = [];
const marker = '.relay-shared-code-context.json';
const poison = (): never => { throw new Error('UNEXPECTED_SECRET_ACCESS'); };
const key = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, '-');
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return sanitized.length <= 200 ? sanitized : `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
};
const expectedMemory = (project = cwd): string => join(base, 'projects', key(project), 'memory');
const userSettings = (): Settings => snapshot.sources[0]!.settings;

async function globals(): Promise<void> {
  await writeFile(join(base, 'CLAUDE.md'), 'SYNTHETIC PRIVATE INSTRUCTIONS\n@./relative.md\n');
  await mkdir(join(base, 'rules'));
  await mkdir(join(base, 'skills'));
}

async function junction(target: string, path: string): Promise<void> {
  await symlink(target, path, 'junction');
  extraJunctions.push(path);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relay-shared-code-'));
  h.home = join(root, 'Home With Spaces');
  base = join(h.home, '.claude');
  cwd = join(root, 'Project-A');
  account = { id: 'work', name: 'Work', configDir: join(root, 'account-work'), createdAt: 0 };
  await Promise.all([mkdir(base, { recursive: true }), mkdir(cwd), mkdir(account.configDir!)]);
  snapshot = { effective: {}, provenance: {}, sources: [{ source: 'user', path: join(base, 'settings.json'), settings: {} }] };
  vi.mocked(resolveSettings).mockReset().mockImplementation(async () => snapshot);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('APPDATA', join(root, 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', join(root, 'Local'));
  h.reads.length = 0;
});

afterEach(async () => {
  const paths = [...extraJunctions.splice(0), join(account.configDir!, 'rules'), join(account.configDir!, 'skills')];
  for (const path of [...new Set(paths)].reverse()) {
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('shared code context', () => {
  it('inspection is read-only and Default preparation preserves native settings and all global files', async () => {
    await globals();
    const before = await readdir(base);
    const report = await inspectSharedCodeContext(account, cwd);
    expect(report.entries.map((entry) => entry.state)).toEqual(['pending', 'pending', 'pending']);
    expect(await readdir(account.configDir!)).toEqual([]);
    expect((await prepareSharedCodeContext(defaultAccount, cwd)).settings).toBeUndefined();
    expect(await readdir(base)).toEqual(before);
    expect(await lstat(expectedMemory()).catch(() => null)).toBeNull();
    expect(h.reads).not.toContain(join(base, 'CLAUDE.md'));
  });

  it('creates only an escaped absolute import bridge and validated rules/skills junctions, with a depth warning', async () => {
    await globals();
    await writeFile(join(base, '.credentials.json'), 'SYNTHETIC DO NOT READ OR COPY');
    await writeFile(join(base, '.claude.json'), 'SYNTHETIC DO NOT COPY');
    await mkdir(expectedMemory(), { recursive: true });
    await writeFile(join(expectedMemory(), 'MEMORY.md'), 'SYNTHETIC MEMORY MUST NOT BE READ');
    h.reads.length = 0;
    const result = await prepareSharedCodeContext(account, cwd);
    const helperReads = [...h.reads];
    expect(result.report.entries.map((entry) => entry.state)).toEqual(['ready', 'ready', 'ready']);
    expect(result.report.warnings.join(' ')).toMatch(/one @import hop.*five-file depth/);
    const content = await readFile(join(account.configDir!, 'CLAUDE.md'), 'utf8');
    expect(content).toBe(`<!-- Relay Desk managed shared instructions; do not edit. -->\n@${join(base, 'CLAUDE.md').replaceAll('\\', '/').replaceAll(' ', '\\ ')}\n`);
    expect(content).not.toContain('SYNTHETIC PRIVATE');
    expect(await readFile(join(base, 'CLAUDE.md'), 'utf8')).toContain('@./relative.md');
    expect((await lstat(join(account.configDir!, 'rules'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(account.configDir!, 'skills'))).isSymbolicLink()).toBe(true);
    expect((await readdir(account.configDir!)).sort()).toEqual([marker, 'CLAUDE.md', 'rules', 'skills'].sort());
    expect(helperReads).not.toContain(join(base, '.credentials.json'));
    expect(helperReads).not.toContain(join(expectedMemory(), 'MEMORY.md'));
    expect(result.report.memory).toMatchObject({ directory: expectedMemory(), indexExists: true, shared: true });
  });

  it('retries absent sources on the next session and serializes concurrent preparation without replacing owned files', async () => {
    await prepareSharedCodeContext(account, cwd);
    expect(await readdir(account.configDir!)).toEqual([]);
    await globals();
    const results = await Promise.all([prepareSharedCodeContext(account, cwd), prepareSharedCodeContext(account, cwd)]);
    expect(results.every((result) => result.report.entries.every((entry) => entry.state === 'ready'))).toBe(true);
    const before = await readFile(join(account.configDir!, marker), 'utf8');
    await prepareSharedCodeContext(account, cwd);
    expect(await readFile(join(account.configDir!, marker), 'utf8')).toBe(before);
  });

  it('preserves nonmanaged local instructions and directories, skips them with a named warning and writes no marker', async () => {
    await globals();
    userSettings().permissions = { deny: ['Bash(rm *)'] };
    for (const name of ['CLAUDE.md', 'rules', 'skills']) {
      const path = join(account.configDir!, name);
      if (name === 'CLAUDE.md') await writeFile(path, 'LOCAL SYNTHETIC CONTENT');
      else await mkdir(path);
      expect((await inspectSharedCodeContext(account, cwd)).entries.some((entry) => entry.state === 'conflict')).toBe(true);
      const result = await prepareSharedCodeContext(account, cwd);
      expect(result.report.warnings).toContain(`Skipped ${path} and left it unchanged: it already exists and belongs to this account.`);
      expect(result.settings).toMatchObject({ permissions: { deny: ['Bash(rm *)'] }, autoMemoryDirectory: expectedMemory() });
      expect((await readdir(account.configDir!)).sort()).toEqual([name]);
      if (name === 'CLAUDE.md') expect(await readFile(path, 'utf8')).toBe('LOCAL SYNTHETIC CONTENT');
      else expect(await readdir(path)).toEqual([]);
      await rm(path, { recursive: true, force: true });
    }
  });

  it('skips everything beside invalid or hardlinked ownership markers without modifying them', async () => {
    await globals();
    const path = join(account.configDir!, marker);
    await writeFile(path, 'LOCAL MARKER');
    const invalid = await prepareSharedCodeContext(account, cwd);
    expect(invalid.report.entries.map((entry) => entry.state)).toEqual(['conflict', 'conflict', 'conflict']);
    expect(invalid.report.warnings.join(' ')).toContain(`The ownership marker ${path} was not written by Relay Desk`);
    expect(invalid.settings?.autoMemoryDirectory).toBe(expectedMemory());
    expect(await readFile(path, 'utf8')).toBe('LOCAL MARKER');
    expect(await readdir(account.configDir!)).toEqual([marker]);
    await rm(path);
    await prepareSharedCodeContext(account, cwd);
    const owned = await readFile(path, 'utf8');
    await link(path, join(root, 'marker-hardlink'));
    const hardlinked = await prepareSharedCodeContext(account, cwd);
    expect(hardlinked.report.entries.map((entry) => entry.state)).toEqual(['conflict', 'conflict', 'conflict']);
    expect(await readFile(path, 'utf8')).toBe(owned);
  });

  it('skips a foreign junction beside a valid owned marker and names it', async () => {
    await globals();
    await prepareSharedCodeContext(account, cwd);
    await rm(join(account.configDir!, 'rules'), { recursive: true, force: true });
    const foreign = join(root, 'foreign-rules');
    await mkdir(foreign);
    await junction(foreign, join(account.configDir!, 'rules'));
    const result = await prepareSharedCodeContext(account, cwd);
    expect(result.report.entries.map((entry) => entry.state)).toEqual(['ready', 'conflict', 'ready']);
    expect(result.report.warnings).toContain(`Skipped ${join(account.configDir!, 'rules')} and left it unchanged: it is not a Relay Desk junction to ${join(base, 'rules')}.`);
    expect(await readdir(foreign)).toEqual([]);
  });

  it('rejects redirected isolated roots and skips redirected default sources for nondefault sharing', async () => {
    const target = join(root, 'redirect-target');
    await mkdir(target);
    await junction(target, join(base, 'rules'));
    const skipped = await prepareSharedCodeContext(account, cwd);
    expect(skipped.report.entries.find((entry) => entry.kind === 'rules')?.state).toBe('conflict');
    expect(skipped.report.warnings.join(' ')).toContain(`its source ${join(base, 'rules')} is a link`);
    expect(await readdir(account.configDir!)).toEqual([]);
    const alias = join(root, 'account-alias');
    await junction(account.configDir!, alias);
    await expect(prepareSharedCodeContext({ ...account, configDir: alias }, cwd)).rejects.toThrow(/redirects/);
    expect(await readdir(account.configDir!)).toEqual([]);
    await rm(join(base, 'rules'), { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
    const desktop = join(process.env.APPDATA!, 'Claude');
    await mkdir(desktop, { recursive: true });
    await junction(desktop, base);
    vi.mocked(resolveSettings).mockClear();
    await expect(inspectSharedCodeContext(account, cwd)).rejects.toThrow(/desktop-owned/);
    expect((await prepareSharedCodeContext(defaultAccount, cwd)).settings).toBeUndefined();
    expect(resolveSettings).not.toHaveBeenCalled();
  });

  it('copies only whitelisted user permissions and never reads other settings or env secret values', async () => {
    const env = Object.defineProperty({}, 'ANTHROPIC_API_KEY', { enumerable: true, get: poison });
    const user: Settings = { permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Edit'], defaultMode: 'acceptEdits', additionalDirectories: [cwd] }, env };
    for (const field of ['apiKeyHelper', 'hooks', 'mcpServers', 'plugins']) Object.defineProperty(user, field, { enumerable: true, get: poison });
    const project: Settings = Object.defineProperty({ env }, 'permissions', { get: poison });
    const managed: Settings = Object.defineProperty({ env }, 'permissions', { get: poison });
    snapshot.sources = [{ source: 'user', settings: user, path: join(base, 'settings.json') }, { source: 'project', settings: project }, { source: 'managed', settings: managed }];
    Object.defineProperty(snapshot.effective, 'permissions', { get: poison });
    snapshot.provenance.permissions = { source: 'managed' };
    const result = await prepareSharedCodeContext(account, cwd);
    expect(result.settings?.permissions).toEqual(user.permissions);
    expect(Object.keys(result.settings!).sort()).toEqual(['autoMemoryDirectory', 'permissions']);
    expect(result.report.permissions).toEqual({ allow: 1, deny: 1, ask: 1, defaultMode: 'acceptEdits' });
    expect(JSON.stringify(result.report)).not.toContain('Bash(rm');
    expect(result.report.warnings.join(' ')).toMatch(/managed permissions were not copied/);
  });

  it('uses the nonmanaged memory cascade and never copies differing managed memory policy', async () => {
    const custom = join(root, 'custom-memory');
    userSettings().autoMemoryEnabled = true;
    userSettings().autoMemoryDirectory = custom;
    snapshot.sources.push({ source: 'project', settings: { autoMemoryEnabled: true } }, { source: 'local', settings: { autoMemoryEnabled: false } },
      { source: 'managed', settings: { autoMemoryEnabled: true, autoMemoryDirectory: join(root, 'policy-only-memory') } });
    snapshot.effective = { autoMemoryEnabled: true, autoMemoryDirectory: join(root, 'policy-only-memory') };
    snapshot.provenance = { autoMemoryEnabled: { source: 'managed' }, autoMemoryDirectory: { source: 'managed' } };
    const result = await prepareSharedCodeContext(account, cwd);
    expect(result.settings).toMatchObject({ autoMemoryEnabled: false, autoMemoryDirectory: custom });
    expect(result.report.memory.enabled).toBe(false);
    expect(result.report.warnings.filter((warning) => warning.includes('Default managed'))).toHaveLength(2);
    expect(await lstat(custom).catch(() => null)).toBeNull();
  });

  it('does not enable unset or disabled memory and leaves project memory unknown without cwd', async () => {
    expect((await prepareSharedCodeContext(account, cwd)).settings).not.toHaveProperty('autoMemoryEnabled');
    userSettings().autoMemoryEnabled = false;
    expect((await prepareSharedCodeContext(account, cwd)).settings?.autoMemoryEnabled).toBe(false);
    const report = await inspectSharedCodeContext(account);
    expect(report.memory).toEqual({ shared: true, enabled: false });
    expect(vi.mocked(resolveSettings)).toHaveBeenLastCalledWith({ cwd: base, settingSources: ['user'] });
  });

  it('fails closed on unexpected settings provenance and before reading a hardlinked settings file', async () => {
    snapshot.sources[0]!.path = join(root, 'wrong-account', 'settings.json');
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(/provenance/);
    snapshot.sources[0]!.path = join(base, 'settings.json');
    await writeFile(join(root, 'settings-fixture'), 'SYNTHETIC SECRET DO NOT READ');
    await link(join(root, 'settings-fixture'), join(base, 'settings.json'));
    vi.mocked(resolveSettings).mockClear();
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(/redirected or non-regular/);
    expect(resolveSettings).not.toHaveBeenCalled();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'inherited-account'));
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(/inherited/);
  });

  it('shares native repository and verified linked-worktree memory but rejects a wrong worktree backlink', async () => {
    const repo = join(root, 'Repo');
    const nested = join(repo, 'src');
    const worktree = join(root, 'Worktree');
    const gitdir = join(repo, '.git', 'worktrees', 'test');
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(gitdir, { recursive: true }), mkdir(worktree)]);
    await writeFile(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    await writeFile(join(gitdir, 'gitdir'), `${join(worktree, '.git')}\n`);
    expect((await prepareSharedCodeContext(account, nested)).settings?.autoMemoryDirectory).toBe(expectedMemory(repo));
    expect((await prepareSharedCodeContext(account, worktree)).settings?.autoMemoryDirectory).toBe(expectedMemory(repo));
    await writeFile(join(gitdir, 'gitdir'), `${join(root, 'wrong', '.git')}\n`);
    expect((await prepareSharedCodeContext(account, worktree)).settings?.autoMemoryDirectory).toBe(expectedMemory(worktree));
  });

  it('derives the CLI memory folder for Unicode and long case-sensitive project paths', async () => {
    const long = join(root, 'Mixed-Case', 'A'.repeat(105), `${'B'.repeat(75)}\u4e2d\ud83d\ude00`);
    await mkdir(long, { recursive: true });
    const result = await prepareSharedCodeContext(account, long);
    expect(result.settings?.autoMemoryDirectory).toBe(expectedMemory(long).normalize('NFC'));
    expect(result.settings?.autoMemoryDirectory).toContain('Mixed-Case');
  });

  it('expands a native tilde memory override and falls back for invalid relative overrides without creating memory folders', async () => {
    userSettings().autoMemoryDirectory = '~/Shared Memory';
    expect((await prepareSharedCodeContext(account, cwd)).settings?.autoMemoryDirectory).toBe(join(h.home, 'Shared Memory'));
    userSettings().autoMemoryDirectory = '../not-absolute';
    const result = await prepareSharedCodeContext(account, cwd);
    expect(result.settings?.autoMemoryDirectory).toBe(expectedMemory());
    expect(result.report.warnings.join(' ')).toMatch(/Invalid default memory/);
    expect(await lstat(join(h.home, 'Shared Memory')).catch(() => null)).toBeNull();
  });

  it('detects only the documented storage-key env value and refuses to guess an explicitly overridden shared memory path', async () => {
    userSettings().env = Object.defineProperty({ claude_code_project_dir_name: 'explicit-key' }, 'ANTHROPIC_AUTH_TOKEN', { enumerable: true, get: poison });
    const report = await inspectSharedCodeContext(account, cwd);
    expect(report.memory.directory).toBeUndefined();
    expect(report.warnings.join(' ')).toMatch(/PROJECT_DIR_NAME.*not guessed/);
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(/PROJECT_DIR_NAME/);
    expect(await readdir(account.configDir!)).toEqual([]);
  });

  it('does not block Default native sessions on aliases, custom overrides, unsupported metadata or settings errors', async () => {
    const outside = join(root, 'default-native-rules');
    await mkdir(outside);
    await junction(outside, join(base, 'rules'));
    userSettings().autoMemoryDirectory = base;
    expect((await prepareSharedCodeContext(defaultAccount, cwd)).settings).toBeUndefined();
    vi.mocked(resolveSettings).mockRejectedValue(new Error('SYNTHETIC_SENSITIVE_NATIVE_VALIDATION_DETAIL'));
    const result = await prepareSharedCodeContext(defaultAccount, cwd);
    expect(result.settings).toBeUndefined();
    expect(result.report.warnings.join(' ')).toMatch(/retains native CLI behavior/);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SENSITIVE');
    expect(await readdir(outside)).toEqual([]);
  });

  it('never returns raw SDK settings errors to a nondefault caller', async () => {
    vi.mocked(resolveSettings).mockRejectedValue(new Error('SYNTHETIC_SENSITIVE_NATIVE_VALIDATION_DETAIL'));
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow('Could not resolve shared code settings safely; native settings details were not exposed.');
    await expect(inspectSharedCodeContext(account, cwd)).rejects.not.toThrow(/SYNTHETIC_SENSITIVE/);
    expect(await readdir(account.configDir!)).toEqual([]);
  });

  it('refuses unrepresentable instruction import paths before writing an ownership marker', async () => {
    h.home = join(root, 'Home#Unsupported');
    const alternate = join(h.home, '.claude');
    await mkdir(alternate, { recursive: true });
    await writeFile(join(alternate, 'CLAUDE.md'), 'SYNTHETIC');
    snapshot.sources[0]!.path = join(alternate, 'settings.json');
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(/contains #/);
    expect(await readdir(account.configDir!)).toEqual([]);
  });

  it('removes a managed account without following its shared junctions or changing Default file hashes', async () => {
    await globals();
    await mkdir(join(base, 'skills', 'synthetic-skill'));
    await mkdir(expectedMemory(), { recursive: true });
    const files = [
      join(base, 'CLAUDE.md'), join(base, 'rules', 'synthetic-rule.md'),
      join(base, 'skills', 'synthetic-skill', 'SKILL.md'), join(expectedMemory(), 'MEMORY.md'),
    ];
    for (const file of files.slice(1)) await writeFile(file, 'SYNTHETIC SHARED CONTENT');
    const hashes = async (): Promise<string[]> => Promise.all(files.map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')));
    const before = await hashes();
    const store = createProfileStore(join(root, 'Relay Desk'), {
      homeDir: h.home, forbiddenDirs: [join(root, 'Desktop')], newId: () => 'managed-work',
    });
    const managed = await store.add('Managed');
    await prepareSharedCodeContext(managed, cwd);
    extraJunctions.push(join(managed.configDir!, 'rules'), join(managed.configDir!, 'skills'));
    await expect(store.remove(managed.id, { deleteDirectory: true })).resolves.toEqual({ deletedDirectory: true });
    expect(await lstat(managed.configDir!).catch(() => null)).toBeNull();
    expect(await hashes()).toEqual(before);
  });
});

describe('shared code context recovery (EC-2)', () => {
  it('resolves a project opened through a junction or an 8.3 short path to the native real-path memory key', async () => {
    const real = join(root, 'LongProjectFolderName', 'proj');
    await mkdir(join(real, '.git'), { recursive: true });
    await junction(join(root, 'LongProjectFolderName'), join(root, 'lnk'));
    const viaJunction = await prepareSharedCodeContext(account, join(root, 'lnk', 'proj'));
    expect(viaJunction.settings?.autoMemoryDirectory).toBe(expectedMemory(real));
    expect(vi.mocked(resolveSettings)).toHaveBeenLastCalledWith({ cwd: real, settingSources: ['user', 'project', 'local'] });
    const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${real}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
    if (short.toLowerCase() !== real.toLowerCase()) {
      expect((await prepareSharedCodeContext(account, short)).settings?.autoMemoryDirectory).toBe(expectedMemory(real));
    }
  });

  it('still rejects a .git entry that is itself a junction and names it', async () => {
    const gitTarget = join(root, 'elsewhere-git');
    await mkdir(gitTarget);
    await junction(gitTarget, join(cwd, '.git'));
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(`Cannot verify the redirected .git entry ${join(cwd, '.git')}`);
  });

  it('treats a bridge edited by /memory as ready and a bridge without the import line as a skipped conflict', async () => {
    await globals();
    await prepareSharedCodeContext(account, cwd);
    const bridgePath = join(account.configDir!, 'CLAUDE.md');
    const original = await readFile(bridgePath, 'utf8');
    await writeFile(bridgePath, `${original.replaceAll('\n', '\r\n')}- prefer tabs\r\n`);
    const edited = await prepareSharedCodeContext(account, cwd);
    expect(edited.report.entries.map((entry) => entry.state)).toEqual(['ready', 'ready', 'ready']);
    expect(edited.report.warnings.join(' ')).not.toMatch(/Skipped/);
    await writeFile(bridgePath, '- only my own notes\n');
    const removed = await prepareSharedCodeContext(account, cwd);
    expect(removed.report.entries.map((entry) => entry.state)).toEqual(['conflict', 'ready', 'ready']);
    expect(removed.report.warnings).toContain(`Skipped ${bridgePath} and left it unchanged: it no longer imports ${join(base, 'CLAUDE.md')}.`);
    expect(removed.settings?.autoMemoryDirectory).toBe(expectedMemory());
    expect(await readFile(bridgePath, 'utf8')).toBe('- only my own notes\n');
  });

  it('keeps permissions and memory working for a moved account folder without touching its files', async () => {
    await globals();
    userSettings().permissions = { deny: ['Bash(rm *)'] };
    await prepareSharedCodeContext(account, cwd);
    const moved = join(root, 'account-moved');
    for (const name of ['rules', 'skills']) await rm(join(account.configDir!, name), { recursive: true, force: true });
    await rename(account.configDir!, moved);
    const movedMarker = await readFile(join(moved, marker), 'utf8');
    const result = await prepareSharedCodeContext({ ...account, configDir: moved }, cwd);
    expect(result.settings).toMatchObject({ permissions: { deny: ['Bash(rm *)'] }, autoMemoryDirectory: expectedMemory() });
    expect(result.report.warnings.join(' ')).toContain(`The ownership marker ${join(moved, marker)} was not written by Relay Desk`);
    expect((await readdir(moved)).sort()).toEqual([marker, 'CLAUDE.md'].sort());
    expect(await readFile(join(moved, marker), 'utf8')).toBe(movedMarker);
  });

  it('names the offending path in fatal errors', async () => {
    await writeFile(join(root, 'settings-fixture'), '{}');
    await link(join(root, 'settings-fixture'), join(base, 'settings.json'));
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(join(base, 'settings.json'));
    await rm(join(base, 'settings.json'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'inherited-account'));
    await expect(prepareSharedCodeContext(account, cwd)).rejects.toThrow(join(root, 'inherited-account'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    await expect(prepareSharedCodeContext(account, join(root, 'no-such-project'))).rejects.toThrow(join(root, 'no-such-project'));
  });

  it('prepares nothing and passes no settings while sharing is turned off for the account', async () => {
    await globals();
    userSettings().permissions = { deny: ['Bash(rm *)'] };
    const result = await prepareSharedCodeContext({ ...account, sharedCodeContext: false }, cwd);
    expect(result.settings).toBeUndefined();
    expect(await readdir(account.configDir!)).toEqual([]);
    expect((await inspectSharedCodeContext({ ...account, sharedCodeContext: false }, cwd)).memory.shared).toBe(false);
  });

  it('unshares only what Relay created: junction targets and their files survive, edited or foreign entries are kept and reported', async () => {
    await globals();
    await writeFile(join(base, 'rules', 'keep-rule.md'), 'SYNTHETIC RULE');
    await mkdir(join(base, 'skills', 'synthetic-skill'));
    await writeFile(join(base, 'skills', 'synthetic-skill', 'SKILL.md'), 'SYNTHETIC SKILL');
    await prepareSharedCodeContext(account, cwd);
    const report = await unshareSharedCodeContext(account);
    expect(report.warnings).toEqual([]);
    expect(report.entries.map((entry) => entry.state)).toEqual(['native', 'native', 'native']);
    expect(await readdir(account.configDir!)).toEqual([]);
    expect(await readFile(join(base, 'rules', 'keep-rule.md'), 'utf8')).toBe('SYNTHETIC RULE');
    expect(await readFile(join(base, 'skills', 'synthetic-skill', 'SKILL.md'), 'utf8')).toBe('SYNTHETIC SKILL');
    expect(await readFile(join(base, 'CLAUDE.md'), 'utf8')).toContain('SYNTHETIC PRIVATE');

    await prepareSharedCodeContext(account, cwd);
    const bridgePath = join(account.configDir!, 'CLAUDE.md');
    await writeFile(bridgePath, `${await readFile(bridgePath, 'utf8')}- remembered\n`);
    await rm(join(account.configDir!, 'skills'), { recursive: true, force: true });
    const foreign = join(root, 'foreign-skills');
    await mkdir(foreign);
    await writeFile(join(foreign, 'own.md'), 'OWN SKILL');
    await junction(foreign, join(account.configDir!, 'skills'));
    const kept = await unshareSharedCodeContext(account);
    expect(kept.entries.map((entry) => entry.state)).toEqual(['conflict', 'native', 'native']);
    expect(kept.warnings).toHaveLength(2);
    expect(kept.warnings[0]).toContain(`Kept ${bridgePath}: it was edited`);
    expect(kept.warnings[1]).toBe(`Kept ${join(account.configDir!, 'skills')}: it is not a Relay Desk junction to ${join(base, 'skills')}.`);
    expect((await readdir(account.configDir!)).sort()).toEqual(['CLAUDE.md', 'skills']);
    expect(await readFile(bridgePath, 'utf8')).toContain('- remembered');
    expect(await readFile(join(foreign, 'own.md'), 'utf8')).toBe('OWN SKILL');
    expect(await readFile(join(base, 'rules', 'keep-rule.md'), 'utf8')).toBe('SYNTHETIC RULE');
  });

  it('keeps a real folder and a foreign marker when unsharing and refuses the default account', async () => {
    await mkdir(join(account.configDir!, 'rules'));
    await writeFile(join(account.configDir!, 'rules', 'mine.md'), 'MINE');
    await writeFile(join(account.configDir!, marker), 'LOCAL MARKER');
    const report = await unshareSharedCodeContext(account);
    expect(report.warnings).toEqual([
      `Kept ${join(account.configDir!, 'rules')}: it is not a Relay Desk junction to ${join(base, 'rules')}.`,
      `Kept ${join(account.configDir!, marker)}: it is not a Relay Desk marker for this account.`,
    ]);
    expect(await readFile(join(account.configDir!, 'rules', 'mine.md'), 'utf8')).toBe('MINE');
    await expect(unshareSharedCodeContext(defaultAccount)).rejects.toThrow(/default account/);
  });
});
