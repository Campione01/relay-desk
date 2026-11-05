import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { gzipSync } from 'node:zlib';
import { DIST_TAGS_URL } from './update-check.mjs';
import { CHANNELS, PLATFORM_PACKAGE, extractPackage, inspectPe, normalizeSelection, runCli, safeTarPath, selectArtifact, stageOfficial, verifyIntegrity } from './stage-official.mjs';

const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let UNIT;
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const stageRoot = async (name) => { const directory = path.join(UNIT, name); await mkdir(directory); return directory; };
// Stage roots must lie outside the repository, so the generated stages live in the system temp folder.
before(async () => { UNIT = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relay-stage-official-'))); });
after(() => rm(UNIT, { recursive: true, force: true }));

function pe(version = '2.1.308', is32Bit = false, bunSection = false) {
  const image = NtExecutable.createEmpty(is32Bit, false); const resources = NtExecutableResource.from(image);
  const [major, minor, patch] = version.split('.').map(Number);
  const info = Resource.VersionInfo.create({ lang: 1033, fixedInfo: { fileVersionMS: major * 65536 + minor, fileVersionLS: patch * 65536,
    productVersionMS: major * 65536 + minor, productVersionLS: patch * 65536 },
    strings: [{ lang: 1033, codepage: 1200, values: { FileVersion: version, ProductVersion: version, ProductName: 'Generated fixture' } }] });
  info.outputToResourceEntries(resources.entries); resources.outputResource(image);
  if (bunSection) image.setSectionByEntry(0, { info: { name: '.bun', virtualSize: 16, virtualAddress: 0, sizeOfRawData: 0,
    pointerToRawData: 0, pointerToRelocations: 0, pointerToLineNumbers: 0, numberOfRelocations: 0, numberOfLineNumbers: 0,
    characteristics: 0x40000040 }, data: new ArrayBuffer(16) });
  return Buffer.from(image.generate());
}

function tar(entries) {
  const chunks = [];
  for (const { name, bytes = Buffer.alloc(0), type = '0', link = '' } of entries) {
    const header = Buffer.alloc(512); header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function response(value, url, binary = false) {
  const result = new Response(binary ? value : JSON.stringify(value), { headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' } });
  Object.defineProperty(result, 'url', { value: url }); return result;
}

/** One fetch for several generated releases behind the given dist-tags. */
function serve(releases, tags) {
  const calls = []; const routes = new Map(releases.flatMap((release) => [...release.routes]));
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    if (url === DIST_TAGS_URL) return response(tags, url);
    if (routes.has(url)) return routes.get(url)();
    assert.fail(`Unexpected fixture URL: ${url}`);
  };
  return { calls, fetchImpl };
}

function fixture({ cliVersion = '2.1.308', platformVersion = cliVersion, corrupt = false } = {}) {
  const entries = [
    { name: 'package/package.json', bytes: Buffer.from(JSON.stringify({ name: PLATFORM_PACKAGE, version: platformVersion, license: 'SEE LICENSE IN LICENSE.md' })) },
    { name: 'package/claude.exe', bytes: pe(cliVersion) },
    { name: 'package/LICENSE.md', bytes: Buffer.from('Generated license fixture only.\n') },
    { name: 'package/README.md', bytes: Buffer.from('Generated package fixture.\n') },
  ];
  const archive = tar(entries);
  const parent = { name: '@anthropic-ai/claude-code', version: cliVersion, license: 'SEE LICENSE IN README.md', optionalDependencies: { [PLATFORM_PACKAGE]: platformVersion },
    dist: { tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${cliVersion}.tgz`, integrity: sri(Buffer.from(`generated parent fixture ${cliVersion}`)) } };
  const platform = { name: PLATFORM_PACKAGE, version: platformVersion, os: ['win32'], cpu: ['x64'], license: 'SEE LICENSE IN LICENSE.md',
    dist: { tarball: `https://registry.npmjs.org/${PLATFORM_PACKAGE}/-/claude-code-win32-x64-${platformVersion}.tgz`, integrity: sri(archive),
      fileCount: entries.length, unpackedSize: entries.reduce((sum, entry) => sum + entry.bytes.length, 0) } };
  const report = (channel) => ({ status: 'observed', packageName: parent.name, channel, observedVersion: cliVersion, dist: parent.dist });
  const routes = new Map([
    [platform.dist.tarball, () => response(corrupt ? Buffer.from('corrupt fixture') : archive, platform.dist.tarball, true)],
    [`https://registry.npmjs.org/@anthropic-ai%2fclaude-code/${cliVersion}`, () => response(parent, `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/${cliVersion}`)],
    [`https://registry.npmjs.org/@anthropic-ai%2fclaude-code-win32-x64/${platformVersion}`, () => response(platform, `https://registry.npmjs.org/@anthropic-ai%2fclaude-code-win32-x64/${platformVersion}`)],
  ]);
  const { calls, fetchImpl } = serve([{ routes }], { latest: cliVersion, stable: cliVersion });
  return { archive, parent, platform, routes, calls, fetchImpl, latest: report('latest'), stable: report('stable') };
}

test('default CLI is offline; staging needs an explicit online mode, an absolute stage root and one selection', async () => {
  const output = []; const plan = await runCli([], { fetchImpl: () => assert.fail('No online authorization.'), writeOutput: (value) => output.push(JSON.parse(value)) });
  assert.equal(plan.mode, 'offline'); assert.deepEqual(plan.channels, CHANNELS); assert.equal(plan.installed, false); assert.deepEqual(output, [plan]);
  for (const args of [['stage'], ['--online'], ['install', '--online'], ['stage', '--online'], ['stage', '--online', '--output', 'D:/other app'],
    ['stage', '--online', '--stage-root', UNIT, '--stage-root', UNIT], ['stage', '--stage-root', UNIT],
    ['stage', '--online', '--stage-root', UNIT, '--channel', 'stable', '--version', '2.1.308'], ['stage', '--online', '--stage-root']]) {
    await assert.rejects(() => runCli(args, { fetchImpl: () => assert.fail('Rejected before any request.') }), /Usage/);
  }
  const offline = () => assert.fail('Rejected before any request.');
  await assert.rejects(() => stageOfficial({ fetchImpl: offline, stageRoot: 'relative/stage' }), /absolute/);
  await assert.rejects(() => stageOfficial({ fetchImpl: offline, stageRoot: path.parse(UNIT).root }), /filesystem root/);
  await assert.rejects(() => stageOfficial({ fetchImpl: offline, stageRoot: path.join(UNIT, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(() => stageOfficial({ fetchImpl: offline, stageRoot: UNIT, selection: { channel: 'beta' } }), /exactly one/);
  for (const inside of [ROOT, path.join(ROOT, 'docs')]) await assert.rejects(() => stageOfficial({ fetchImpl: offline, stageRoot: inside }), /inside the repository/);
});

test('platform version comes from exact official dependency, not a guessed CLI/SDK mapping', () => {
  const f = fixture({ platformVersion: '0.3.999' }); const result = selectArtifact(f.latest, f.stable, f.parent, f.platform);
  assert.equal(result.version, '2.1.308'); assert.equal(result.platformVersion, '0.3.999'); assert.equal(result.relation.dependencySpec, '0.3.999');
  const newerStable = fixture({ cliVersion: '2.1.309' });
  assert.equal(selectArtifact(f.latest, newerStable.stable, newerStable.parent, newerStable.platform).selectedChannel, 'stable');
  for (const platform of [{ ...f.platform, name: '@other/package' }, { ...f.platform, os: ['linux'] }, { ...f.platform, cpu: ['arm64'] },
    { ...f.platform, dist: { ...f.platform.dist, tarball: 'https://evil.test/archive.tgz' } }]) assert.throws(() => selectArtifact(f.latest, f.stable, f.parent, platform));
  assert.throws(() => selectArtifact(f.latest, f.stable, { ...f.parent, optionalDependencies: {} }, f.platform));
  assert.throws(() => selectArtifact({ ...f.latest, observedVersion: '2.2.0-beta.1' }, f.stable, f.parent, f.platform));
});

test('a selection names one channel or one exact version; metadata must belong to it', () => {
  const old = fixture({ cliVersion: '2.1.308' }); const next = fixture({ cliVersion: '2.1.312' }); const between = fixture({ cliVersion: '2.1.310' });
  const latest = next.latest; const stable = old.stable;
  assert.equal(selectArtifact(latest, stable, next.parent, next.platform).selectedChannel, 'latest');
  assert.deepEqual(selectArtifact(latest, stable, next.parent, next.platform, { channel: 'latest' }).selection, { channel: 'latest' });
  const fromStable = selectArtifact(latest, stable, old.parent, old.platform, { channel: 'stable' });
  assert.equal(fromStable.version, '2.1.308'); assert.equal(fromStable.selectedChannel, 'stable'); assert.deepEqual(fromStable.selection, { channel: 'stable' });
  assert.throws(() => selectArtifact(latest, stable, next.parent, next.platform, { channel: 'stable' }), /identity\/version/);
  const exact = selectArtifact(latest, stable, between.parent, between.platform, { version: '2.1.310' });
  assert.equal(exact.version, '2.1.310'); assert.equal(exact.selectedChannel, 'exact'); assert.deepEqual(exact.selection, { version: '2.1.310' });
  const changed = { ...old.parent, dist: { ...old.parent.dist, integrity: sri(Buffer.from('other parent')) } };
  assert.throws(() => selectArtifact(latest, stable, changed, old.platform, { version: '2.1.308' }), /changed/);
  assert.deepEqual(normalizeSelection(), { channel: 'newer' });
  for (const selection of [null, {}, { channel: 'beta' }, { channel: 'stable', version: '2.1.308' }, { version: '2.2.0-beta.1' }, { version: 'v2.1.308' }]) {
    assert.throws(() => normalizeSelection(selection));
  }
});

test('SRI is verified against actual bytes; malformed or changed bytes cannot pass', () => {
  const f = fixture(); assert.equal(verifyIntegrity(f.archive, f.platform.dist.integrity), true);
  assert.throws(() => verifyIntegrity(Buffer.from('other bytes'), f.platform.dist.integrity), /SRI/);
  assert.throws(() => verifyIntegrity(f.archive, 'sha512-malformed'), /SRI/);
});

test('safe tar paths reject traversal, absolute/Windows paths, devices, streams and separators', () => {
  assert.equal(safeTarPath('package/claude.exe'), 'package/claude.exe');
  for (const name of ['../escape', 'package/../../escape', '/package/a', 'C:/escape', 'package/a:ads', 'package/a\\b',
    'package//a', 'package/./a', 'package/NUL', 'package/a.', 'other/a']) assert.throws(() => safeTarPath(name), /Unsafe/);
});

test('bounded extraction rejects malicious paths, links, duplicate names and incorrect size metadata', async () => {
  let index = 0;
  for (const entries of [
    [{ name: 'package/../../escape', bytes: Buffer.from('x') }],
    [{ name: 'package/link', type: '2', link: '../escape' }],
    [{ name: 'package/link', type: '1', link: 'package/file' }],
    [{ name: 'package/a', bytes: Buffer.from('x') }, { name: 'package/A', bytes: Buffer.from('y') }],
  ]) {
    const archive = path.join(UNIT, `unsafe-${index}.tgz`); await writeFile(archive, tar(entries), { flag: 'wx' });
    await assert.rejects(() => extractPackage(archive, path.join(UNIT, `unsafe-${index++}`), { unpackedSize: 100, fileCount: 4 }));
  }
  const f = fixture(); const archive = path.join(UNIT, 'wrong-size.tgz'); await writeFile(archive, f.archive, { flag: 'wx' });
  await assert.rejects(() => extractPackage(archive, path.join(UNIT, 'wrong-size'), { ...f.platform.dist, unpackedSize: 1 }));
});

test('generated AMD64 PE version is read without execution; wrong release/architecture fail', () => {
  assert.equal(inspectPe(pe(), '2.1.308').versionMatchesSelectedRelease, true);
  assert.throws(() => inspectPe(pe(), '2.1.309'), /version/);
  assert.throws(() => inspectPe(pe('2.1.308', true), '2.1.308'), /AMD64/);
  const original = pe(); const signed = Buffer.concat([original, Buffer.alloc(8)]);
  const certificateDirectory = signed.readUInt32LE(0x3c) + 24 + 112 + 4 * 8;
  signed.writeUInt32LE(original.length, certificateDirectory); signed.writeUInt32LE(8, certificateDirectory + 4);
  const before = createHash('sha256').update(signed).digest('hex'); const info = inspectPe(signed, '2.1.308');
  assert.equal(info.certificateTable.present, true); assert.equal(info.certificateTable.authenticodeVerified, false);
  assert.equal(createHash('sha256').update(signed).digest('hex'), before);
  const bun = pe('2.1.308', false, true);
  assert.throws(() => NtExecutableResource.from(NtExecutable.from(bun)), /After Resource section/);
  assert.equal(inspectPe(bun, '2.1.308').versionMatchesSelectedRelease, true);
});

test('offline mocked staging produces SRI/binary/license provenance; exact owned reuse does not redownload', async () => {
  const root = await stageRoot('success'); const f = fixture(); const receipt = await stageOfficial({ fetchImpl: f.fetchImpl, stageRoot: root });
  const directory = path.join(root, 'claude-code-2.1.308-latest'); assert.equal(receipt.stageDirectory, directory);
  assert.equal(receipt.version, '2.1.308'); assert.equal(receipt.package.sriVerified, true); assert.equal(receipt.binary.relativePath, 'extracted/package/claude.exe');
  assert.deepEqual(receipt.selection, { channel: 'newer' });
  assert.equal(receipt.executed, false); assert.equal(receipt.installed, false); assert.equal(receipt.admissionApproved, false);
  assert.equal(receipt.licenses.platformLicense.relativePath, 'extracted/package/LICENSE.md'); assert.equal(f.calls.filter((url) => url.endsWith('.tgz')).length, 1);
  const second = fixture(); assert.equal((await stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: root })).reused, true);
  assert.equal(second.calls.filter((url) => url.endsWith('.tgz')).length, 0);
  await unlink(path.join(directory, 'stage-receipt.json'));
  assert.equal((await stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: root, resume: true })).resumed, true);
  assert.equal(second.calls.filter((url) => url.endsWith('.tgz')).length, 0);
  await assert.rejects(() => stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: path.join(directory, 'extracted') }), /inside another stage/);
  // A receipt rewritten to match swapped bytes still fails: reuse holds the payload to the verified archive.
  const tampered = Buffer.from('tampered generated fixture'); await writeFile(path.join(directory, receipt.binary.relativePath), tampered);
  await assert.rejects(() => stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: root }), /inventory differs/);
  const stored = JSON.parse(await readFile(path.join(directory, 'stage-receipt.json'), 'utf8'));
  const swapped = { relativePath: stored.binary.relativePath, size: tampered.length, sha256: createHash('sha256').update(tampered).digest('hex') };
  const rewritten = { ...stored, binary: swapped, files: stored.files.map((file) => file.relativePath === swapped.relativePath ? swapped : file) };
  await writeFile(path.join(directory, 'stage-receipt.json'), JSON.stringify(rewritten));
  await assert.rejects(() => stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: root }), /differs from the verified archive/);
  await writeFile(path.join(directory, 'stage-receipt.json'), JSON.stringify({ ...rewritten, owner: { ...rewritten.owner, root: 'C:\\elsewhere' } }));
  await assert.rejects(() => stageOfficial({ fetchImpl: second.fetchImpl, stageRoot: root }), /does not belong/);
});

test('resume needs a partial stage to resume', async () => {
  const f = fixture(); const root = await stageRoot('nothing-to-resume');
  await assert.rejects(() => stageOfficial({ fetchImpl: f.fetchImpl, stageRoot: root, resume: true }), /Nothing to resume/);
  assert.equal(f.calls.filter((url) => url.endsWith('.tgz')).length, 0);
});

test('a stable-only stage downloads the stable build while latest is newer; an exact version stages beside it', async () => {
  const old = fixture({ cliVersion: '2.1.308' }); const next = fixture({ cliVersion: '2.1.312' });
  const served = serve([old, next], { latest: '2.1.312', stable: '2.1.308' }); const root = await stageRoot('channels');
  const stable = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot: root, selection: { channel: 'stable' } });
  assert.equal(stable.version, '2.1.308'); assert.equal(stable.selectedChannel, 'stable'); assert.deepEqual(stable.selection, { channel: 'stable' });
  assert.deepEqual(stable.channelVersions, { latest: '2.1.312', stable: '2.1.308' });
  assert.deepEqual(served.calls.filter((url) => url.endsWith('.tgz')), [old.platform.dist.tarball]);
  const exact = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot: root, selection: { version: '2.1.312' } });
  assert.equal(exact.stageDirectory, path.join(root, 'claude-code-2.1.312-exact')); assert.equal(exact.selectedChannel, 'exact');
  const output = [];
  const again = await runCli(['stage', '--online', '--stage-root', root, '--channel', 'stable'], { fetchImpl: served.fetchImpl, writeOutput: (value) => output.push(JSON.parse(value)) });
  assert.equal(again.reused, true); assert.equal(output[0].receipt, path.join(root, 'claude-code-2.1.308-stable', 'stage-receipt.json'));
  assert.equal(output[0].binary.path, path.join(root, 'claude-code-2.1.308-stable', 'extracted', 'package', 'claude.exe'));
  assert.deepEqual(output[0].channelVersionsNow, { latest: '2.1.312', stable: '2.1.308' });
  assert.equal(served.calls.filter((url) => url.endsWith('.tgz')).length, 2);
  // The same version staged by exact version is its own stage, so a stable-only recipe never meets an exact receipt.
  const sameByVersion = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot: root, selection: { version: '2.1.308' } });
  assert.equal(sameByVersion.stageDirectory, path.join(root, 'claude-code-2.1.308-exact')); assert.equal(sameByVersion.selectedChannel, 'exact');
  assert.equal(sameByVersion.reused, undefined); assert.equal(served.calls.filter((url) => url.endsWith('.tgz')).length, 3);
});

test('failed download integrity is never extracted; its tarball is removed and a rerun stages again', async () => {
  const f = fixture({ corrupt: true }); const root = await stageRoot('corrupt'); const directory = path.join(root, 'claude-code-2.1.308-latest');
  await assert.rejects(() => stageOfficial({ fetchImpl: f.fetchImpl, stageRoot: root }), /SRI differs/);
  await assert.rejects(() => readFile(path.join(directory, 'extracted/package/claude.exe')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(directory, 'claude-code-win32-x64-2.1.308.tgz')), { code: 'ENOENT' });
  await assert.rejects(() => stageOfficial({ fetchImpl: f.fetchImpl, stageRoot: root }),
    /SRI differs\. Stage folder: .*; the partial download was removed, and rerunning the same command starts again from a clean stage\./);
  assert.equal(f.calls.filter((url) => url.endsWith('.tgz')).length, 2);
});
