import assert from 'node:assert/strict';
import { copyFile, link, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SDK_PLATFORM, assertPhysical } from '../../tools/cli/admission.mjs';
import { installCli } from '../../tools/cli/official-cli.mjs';
import { admission, project, release, sha, temporary } from './cli-fixtures.mjs';

const stable = release('2.1.308'), latest = release('2.1.312');
const ADMITTED = admission(stable, latest);
const BUNDLED = 'synthetic SDK bundled CLI';

async function staged(work) {
  const directory = path.join(work, 'stage', 'claude-code-2.1.308-stable', 'extracted', 'package');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'claude.exe'), stable.binary);
  return { directory: path.dirname(path.dirname(directory)), binary: path.join(directory, 'claude.exe'), version: '2.1.308', receiptSha256: 'b'.repeat(64) };
}

const install = (root, stage, p) => installCli({ projectRoot: root, track: 'stable', stage, admission: ADMITTED,
  sdkMetadataSha256: p.sdkMetadataSha256, bundledSha256: p.bundledSha256 });

test('rejects a node_modules junction before touching the external target', async (t) => {
  const work = await temporary(t, 'relay-cli-path-safety-');
  const external = await project(path.join(work, 'external'));
  const root = path.join(work, 'project');
  await mkdir(root);
  await symlink(path.join(external.root, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  await assert.rejects(install(root, await staged(work), external), /node_modules is a link or junction/);
  assert.equal(await readFile(external.target, 'utf8'), BUNDLED);
  await assert.rejects(readFile(path.join(root, '.relay-cli.json')), { code: 'ENOENT' });
});

test('rejects a redirected SDK platform folder even when node_modules itself is physical', async (t) => {
  const work = await temporary(t, 'relay-cli-path-safety-');
  const external = await project(path.join(work, 'external'));
  const root = path.join(work, 'project'), scope = path.join(root, 'node_modules', '@anthropic-ai');
  await mkdir(scope, { recursive: true });
  await symlink(external.platform, path.join(scope, 'claude-agent-sdk-win32-x64'), 'junction');
  await assert.rejects(install(root, await staged(work), external), /claude-agent-sdk-win32-x64 is a link or junction/);
  await assert.rejects(assertPhysical(path.join(root, ...SDK_PLATFORM.split('/'), 'claude.exe'), 'file'), /redirected directory/);
  assert.equal(await readFile(external.target, 'utf8'), BUNDLED);
});

test('rejects a hard-linked binary and accepts only a physical project-local target', async (t) => {
  const work = await temporary(t, 'relay-cli-path-safety-');
  const p = await project(work), stage = await staged(work), other = path.join(work, 'other.exe');
  await link(p.target, other);
  await assert.rejects(install(p.root, stage, p), /hard-linked/);
  assert.equal(await readFile(p.target, 'utf8'), BUNDLED);
  await unlink(other);
  const result = await install(p.root, stage, p);
  assert.equal(result.copied, true); assert.equal(sha(await readFile(p.target)), stable.sha256);
  assert.deepEqual((await readdir(p.platform)).sort(), ['claude.exe', 'package.json']);
  const linkedStage = path.join(work, 'linked-stage.exe');
  await link(stage.binary, linkedStage);
  await assert.rejects(install(p.root, stage, p), /hard-linked/);
});

test('rejects a project root or a stage reached through a junction', async (t) => {
  const work = await temporary(t, 'relay-cli-path-safety-');
  const p = await project(work), stage = await staged(work);
  const linkedRoot = path.join(work, 'linked-project');
  await symlink(p.root, linkedRoot, 'junction');
  await assert.rejects(install(linkedRoot, stage, p), /linked-project is a link or junction; it must be a physical directory\./);
  const linkedStage = path.join(work, 'linked-stage');
  await symlink(stage.directory, linkedStage, 'junction');
  await assert.rejects(install(p.root, { ...stage, binary: path.join(linkedStage, 'extracted', 'package', 'claude.exe') }, p), /is reached through a redirected directory\./);
  assert.equal(await readFile(p.target, 'utf8'), BUNDLED);
  await assert.rejects(readFile(path.join(p.root, '.relay-cli.json')), { code: 'ENOENT' });
});

test('the copy, the rename and the checks around them leave the SDK binary and no copy behind when they fail', async (t) => {
  const work = await temporary(t, 'relay-cli-path-safety-');
  const p = await project(work), stage = await staged(work);
  const left = async () => (await readdir(p.platform)).sort();
  const attempt = (io) => installCli({ projectRoot: p.root, track: 'stable', stage, admission: ADMITTED,
    sdkMetadataSha256: p.sdkMetadataSha256, bundledSha256: p.bundledSha256, io });
  const unchanged = async () => {
    assert.equal(await readFile(p.target, 'utf8'), BUNDLED);
    assert.deepEqual(await left(), ['claude.exe', 'package.json']);
    await assert.rejects(readFile(path.join(p.root, '.relay-cli.json')), { code: 'ENOENT' });
  };

  // A copy whose bytes differ from the staged binary is never renamed into place.
  await assert.rejects(attempt({ copyFile: (from, to) => writeFile(to, 'damaged copy'), rename }),
    /The copied claude\.exe differs from the staged one; nothing was installed\./);
  await unchanged();

  // claude.exe held open by a running CLI: Windows refuses the rename.
  for (const code of ['EBUSY', 'EPERM']) {
    const busy = Object.assign(new Error('resource busy or locked'), { code });
    await assert.rejects(attempt({ copyFile, rename: async () => { throw busy; } }),
      /claude\.exe is in use; close Relay Desk and any running Claude Code, then retry\./);
    await unchanged();
  }

  // The folder is checked again between the copy and the rename.
  const second = path.join(work, 'second-name.exe');
  await assert.rejects(attempt({ copyFile: async (from, to, mode) => { await copyFile(from, to, mode); await link(p.target, second); }, rename }), /hard-linked/);
  await unlink(second);
  await unchanged();

  // The SDK metadata is checked again after the install.
  await assert.rejects(attempt({ copyFile, rename: async (from, to) => { await rename(from, to); await writeFile(path.join(p.platform, 'package.json'), '{}'); } }),
    /package\.json changed during the install\./);
  await assert.rejects(readFile(path.join(p.root, '.relay-cli.json')), { code: 'ENOENT' });
  assert.deepEqual(await left(), ['claude.exe', 'package.json']);
});
