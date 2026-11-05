import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createNativeDurableAssets } from '../../src/main/native/durableAssets';
import type { NativeDurableAssetLease } from '../../src/main/native/durableAssets';
import { createPrivateStorage } from '../../src/main/native/privateStorage';

const helperPath = resolve('tools/private-storage/bin/RelayPrivateStorage.exe');
const prototypeRoot = `C:\\RelayDeskNativePrototype\\durable-assets-tests-${randomBytes(16).toString('hex')}`;
const pdf = Buffer.from('%PDF-1.4\nsynthetic-retained-layout\n%%EOF\n');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 0]);
const key = (profileId: string) => createHash('sha256').update(`relay-native-assets-v1\0${profileId}`).digest('hex');
const store = (profileId: string) => createNativeDurableAssets({ helperPath, prototypeRoot, profileId });
const metadata = (profileId: string) => createPrivateStorage({ helperPath, prototypeRoot, persistentKey: key(profileId) });
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
function ps(script: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`], { env, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error('Synthetic durable-assets fixture PowerShell failed.');
  return result.stdout.trim();
}
function stage(lease: NativeDurableAssetLease, bytes = pdf, name = 'attachment-1.pdf') {
  const launch = lease.storage.createLaunch(); const file = lease.storage.writeBytes(launch, bytes, name); return { launch, file };
}

describe.skipIf(process.platform !== 'win32')('native durable asset ownership with isolated synthetic files', () => {
  beforeAll(() => { expect(existsSync(helperPath)).toBe(true); mkdirSync(prototypeRoot); });
  afterAll(() => {
    if (!existsSync(prototypeRoot)) return;
    expect(lstatSync(prototypeRoot).isSymbolicLink()).toBe(false);
    expect(realpathSync(prototypeRoot).toLowerCase()).toBe(prototypeRoot.toLowerCase());
    expect(prototypeRoot).toMatch(/^C:\\RelayDeskNativePrototype\\durable-assets-tests-[a-f0-9]{32}$/);
    ps(`Remove-Item -LiteralPath ${quote(prototypeRoot)} -Recurse -Force`);
    expect(existsSync(prototypeRoot)).toBe(false);
  });

  it('keeps exact normal-session PDF/image paths after adapter release, close and cold reopen', () => {
    const first = store('normal'); const lease = first.openSession({ sessionId: 'session-normal' });
    const { launch, file } = stage(lease); const image = lease.storage.writeBytes(launch, png, 'attachment-2.png');
    lease.retain(launch); lease.retain(launch);
    expect(() => lease.storage.writeBytes(launch, png, 'attachment-3.png')).toThrow('cannot be extended');
    lease.storage.removeLaunch(launch); lease.close(); lease.close();
    expect(readFileSync(file.path).equals(pdf)).toBe(true); expect(readFileSync(image.path).equals(png)).toBe(true);
    const reopened = store('normal').openSession({ sessionId: 'session-normal', resumeSessionId: 'session-normal', requiredPaths: [file.path, image.path] });
    expect(reopened.listReferences().map((item) => item.path)).toEqual([file.path, image.path]);
    expect(reopened.verifyPath(file.path)).toMatchObject({ type: 'document', mediaType: 'application/pdf', path: file.path, sha256: file.sha256 });
    expect(reopened.verifyPath(image.path)).toMatchObject({ type: 'image', mediaType: 'image/png', path: image.path, sha256: image.sha256 });
    reopened.close(); expect(existsSync(file.path)).toBe(true);
  }, 15_000);

  it('forks ownership without moving references or adding fork-only files to the source session', () => {
    const assets = store('fork'); const source = assets.openSession({ sessionId: 'source' });
    const base = stage(source); source.retain(base.launch); source.storage.removeLaunch(base.launch);
    const fork = assets.openSession({ sessionId: 'forked', resumeSessionId: 'source', fork: true });
    source.close(); expect(fork.verifyPath(base.file.path)?.path).toBe(base.file.path);
    const added = stage(fork, png, 'attachment-1.png'); fork.retain(added.launch); fork.storage.removeLaunch(added.launch); fork.close();
    const resumedSource = store('fork').openSession({ sessionId: 'source', resumeSessionId: 'source' });
    expect(resumedSource.listReferences().map((item) => item.path)).toEqual([base.file.path]); resumedSource.close();
    const resumedFork = store('fork').openSession({ sessionId: 'forked', resumeSessionId: 'forked' });
    expect(resumedFork.listReferences().map((item) => item.path)).toEqual([base.file.path, added.file.path]); resumedFork.close();
  }, 15_000);

  it('disposes ephemeral uploads while preserving inherited normal references and the manifest bytes', () => {
    const assets = store('ephemeral'); const normal = assets.openSession({ sessionId: 'base' });
    const retained = stage(normal); normal.retain(retained.launch); normal.storage.removeLaunch(retained.launch); normal.close();
    const before = metadata('ephemeral').readState()!;
    const side = assets.openSession({ sessionId: 'temporary-side', resumeSessionId: 'base', fork: true, ephemeral: true });
    const disposable = stage(side, png, 'attachment-1.png'); side.retain(disposable.launch);
    expect(side.verifyPath(retained.file.path)?.path).toBe(retained.file.path);
    side.storage.removeLaunch(disposable.launch); side.close();
    expect(existsSync(disposable.file.path)).toBe(false); expect(existsSync(retained.file.path)).toBe(true);
    const after = metadata('ephemeral').readState()!;
    expect(after.file.sha256).toBe(before.file.sha256); expect(after.value).toEqual(before.value);
  }, 15_000);

  it('deletes failed/unaccepted batches and rejects other-profile or cloned lease tokens', () => {
    const first = store('failed').openSession({ sessionId: 'one' }); const second = store('other-profile').openSession({ sessionId: 'one' });
    const batch = stage(first);
    expect(second.verifyPath(batch.file.path)).toBeUndefined();
    expect(() => second.storage.removeLaunch(batch.launch)).toThrow('not owned');
    expect(() => first.storage.removeLaunch({ ...batch.launch })).toThrow('not owned');
    first.storage.removeLaunch(batch.launch); expect(existsSync(batch.file.path)).toBe(false);
    const abandoned = stage(first); first.close(); expect(existsSync(abandoned.file.path)).toBe(false); second.close();
  });

  it('rejects missing or changed retained bytes on first use after resume without rewriting a history reference', () => {
    const lease = store('integrity').openSession({ sessionId: 'known' }); const batch = stage(lease);
    lease.retain(batch.launch); lease.storage.removeLaunch(batch.launch); lease.close();
    writeFileSync(batch.file.path, 'synthetic-changed');
    const changed = store('integrity').openSession({ sessionId: 'known', resumeSessionId: 'known', requiredPaths: [batch.file.path] });
    expect(() => changed.verifyPath(batch.file.path)).toThrow('content_changed');
    expect(() => changed.listReferences()).toThrow('content_changed'); changed.close();
    writeFileSync(batch.file.path, pdf); unlinkSync(batch.file.path);
    const missing = store('integrity').openSession({ sessionId: 'known', resumeSessionId: 'known' });
    expect(() => missing.verifyPath(batch.file.path)).toThrow(); missing.close();
    expect(existsSync(batch.file.path)).toBe(false);
    expect(() => store('unknown-reference').openSession({ sessionId: 'unknown', requiredPaths: [batch.file.path] })).toThrow('not rewritten');
  }, 15_000);

  it('enforces authoritative resume/fork identities and one active lease per session', () => {
    const assets = store('identity'); const lease = assets.openSession({ sessionId: 'active' });
    expect(() => assets.openSession({ sessionId: 'active' })).toThrow('active lease');
    expect(() => assets.openSession({ sessionId: 'other', resumeSessionId: 'active' })).toThrow('identity');
    expect(() => assets.openSession({ sessionId: 'active', resumeSessionId: 'active', fork: true })).toThrow('distinct');
    expect(() => assets.openSession({ sessionId: 'bad\nidentity' })).toThrow('identifier');
    lease.close(); const reopened = assets.openSession({ sessionId: 'active' }); reopened.close();
  });

  it('retains accepted files when atomic manifest publication fails, then permits an explicit retry', () => {
    const lease = store('write-failure').openSession({ sessionId: 'keep-accepted' }); const batch = stage(lease);
    const state = metadata('write-failure').readState()!;
    ps(`(Get-Item -LiteralPath ${quote(state.file.path)}).IsReadOnly=$true`);
    try {
      expect(() => lease.retain(batch.launch)).toThrow('publish_failed');
      expect(() => lease.storage.removeLaunch(batch.launch)).toThrow('preserved');
      expect(readFileSync(batch.file.path).equals(pdf)).toBe(true);
    } finally { ps(`(Get-Item -LiteralPath ${quote(state.file.path)}).IsReadOnly=$false`); }
    lease.retain(batch.launch); lease.storage.removeLaunch(batch.launch); lease.close();
    const resume = store('write-failure').openSession({ sessionId: 'keep-accepted', resumeSessionId: 'keep-accepted' });
    expect(resume.verifyPath(batch.file.path)?.sha256).toBe(batch.file.sha256); resume.close();
  }, 15_000);

  it('closes a lease whose accepted batch could not be recorded, leaving its files on disk', () => {
    const assets = store('pinned-close'); const lease = assets.openSession({ sessionId: 'pinned' }); const batch = stage(lease);
    const staged = stage(lease, png, 'attachment-1.png');
    const state = metadata('pinned-close').readState()!;
    ps(`(Get-Item -LiteralPath ${quote(state.file.path)}).IsReadOnly=$true`);
    try {
      expect(() => lease.retain(batch.launch)).toThrow('publish_failed');
      expect(() => lease.close()).not.toThrow();
    } finally { ps(`(Get-Item -LiteralPath ${quote(state.file.path)}).IsReadOnly=$false`); }
    expect(readFileSync(batch.file.path).equals(pdf)).toBe(true); expect(existsSync(staged.file.path)).toBe(false);
    const reopened = assets.openSession({ sessionId: 'pinned', resumeSessionId: 'pinned' });
    expect(reopened.listReferences()).toEqual([]); reopened.close();
    expect(metadata('pinned-close').readState()!.file.sha256).toBe(state.file.sha256);
  }, 15_000);

  it('refuses a new batch before submission when the manifest could not record it, and admits one that fits', () => {
    store('headroom').openSession({ sessionId: 'first' }).close();
    const backend = metadata('headroom'); const root = backend.ensureTaskRoot();
    const fill = (free: number) => {
      const state = backend.readState()!; const value = { ...(state.value as Record<string, unknown>), sessions: {} as Record<string, unknown> };
      // Each padding session adds `"<64 hex>":{"batches":[]},` (82 bytes) to the manifest.
      for (let index = 0, size = Buffer.byteLength(JSON.stringify(value)); size + 82 <= 1024 * 1024 - free; index++, size += 82) value.sessions[key(`padding-${index}`)] = { batches: [] };
      backend.writeState(value, state.file);
    };
    const launches = () => readdirSync(root.path).filter((name) => name.startsWith('launch-'));
    fill(2 * 1024);
    const full = store('headroom').openSession({ sessionId: 'full' });
    expect(() => full.storage.createLaunch()).toThrow('storage for this account is full'); expect(launches()).toEqual([]); full.close();
    fill(64 * 1024);
    const roomy = store('headroom').openSession({ sessionId: 'roomy' }); const batch = stage(roomy);
    let unpublished = 1;
    for (; unpublished < 40; unpublished++) {
      try { roomy.storage.createLaunch(); } catch (error) { expect(String(error)).toContain('full'); break; }
    }
    expect(unpublished).toBeGreaterThan(1); expect(unpublished).toBeLessThan(40);
    roomy.retain(batch.launch); roomy.storage.removeLaunch(batch.launch); roomy.close();
    expect(launches()).toHaveLength(1);
    const resumed = store('headroom').openSession({ sessionId: 'roomy', resumeSessionId: 'roomy' });
    expect(resumed.listReferences().map((item) => item.path)).toEqual([batch.file.path]); resumed.close();
  }, 60_000);

  it('verifies the protected manifest ACL and rejects a hardlinked metadata entry', () => {
    const lease = store('manifest-acl').openSession({ sessionId: 'metadata' }); lease.close();
    const state = metadata('manifest-acl').readState()!;
    expect(state.file).toMatchObject({ kind: 'file', protectedDacl: true, aceCount: 2, inheritedAceCount: 0, linkCount: 1 });
    const observed = JSON.parse(ps(`$a=Get-Acl -LiteralPath ${quote(state.file.path)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [pscustomobject]@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;sid=$sid;protected=$a.AreAccessRulesProtected;aces=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress`));
    expect(observed.owner).toBe(observed.sid); expect(observed.protected).toBe(true); expect(observed.aces.sort()).toEqual([observed.sid, 'S-1-5-18'].sort());
    const alias = join(prototypeRoot, 'manifest-hardlink.json'); linkSync(state.file.path, alias);
    expect(() => store('manifest-acl').openSession({ sessionId: 'metadata' })).toThrow('hard_link'); unlinkSync(alias);
  });

  it('uses compare-and-swap manifest publication and rejects oversized metadata without losing the old state', () => {
    const first = metadata('cas'), second = metadata('cas');
    const initial = first.writeState({ revision: 1 }, null); const stale = second.readState()!;
    first.writeState({ revision: 2 }, initial);
    expect(() => second.writeState({ revision: 3 }, stale.file)).toThrow();
    const current = first.readState()!; expect(current.value).toEqual({ revision: 2 });
    expect(() => first.writeState({ data: 'x'.repeat(1024 * 1024) }, current.file)).toThrow('1 MiB');
    expect(first.readState()!.file.sha256).toBe(current.file.sha256);
    expect(() => first.dispose()).toThrow('cannot be disposed');
  });

  it('rejects missing manifests with existing assets and mismatched profile manifests', () => {
    const lease = store('missing-manifest').openSession({ sessionId: 'saved' }); const batch = stage(lease);
    lease.retain(batch.launch); lease.storage.removeLaunch(batch.launch); lease.close();
    const saved = metadata('missing-manifest').readState()!; unlinkSync(saved.file.path);
    expect(() => store('missing-manifest').openSession({ sessionId: 'saved', resumeSessionId: 'saved' })).toThrow('state_missing_assets');
    expect(readFileSync(batch.file.path).equals(pdf)).toBe(true);
    const other = store('wrong-manifest').openSession({ sessionId: 'metadata' }); other.close();
    const backend = metadata('wrong-manifest'), state = backend.readState()!;
    backend.writeState({ ...(state.value as Record<string, unknown>), profileKey: key('another-profile') }, state.file);
    expect(() => store('wrong-manifest').openSession({ sessionId: 'metadata' })).toThrow('manifest identity');
  }, 15_000);
});
