// Synthetic npm releases, stages and project folders for the CLI tool tests. Nothing here is an official file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PLATFORM_PACKAGE } from '../../tools/native-cli-maintenance/stage-official.mjs';
import { DIST_TAGS_URL } from '../../tools/native-cli-maintenance/update-check.mjs';
import { SDK_PLATFORM } from '../../tools/cli/admission.mjs';

const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A temporary folder outside the repository, removed after the test. */
export async function temporary(t, prefix = 'relay-cli-test-') {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    assert(path.basename(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** An empty AMD64 PE with the version resource the stager reads; it is never run. */
export function pe(version) {
  const image = NtExecutable.createEmpty(false, false); const resources = NtExecutableResource.from(image);
  const [major, minor, patch] = version.split('.').map(Number);
  const info = Resource.VersionInfo.create({ lang: 1033, fixedInfo: { fileVersionMS: major * 65536 + minor, fileVersionLS: patch * 65536,
    productVersionMS: major * 65536 + minor, productVersionLS: patch * 65536 },
    strings: [{ lang: 1033, codepage: 1200, values: { FileVersion: version, ProductVersion: version, ProductName: 'Synthetic fixture' } }] });
  info.outputToResourceEntries(resources.entries); resources.outputResource(image);
  return Buffer.from(image.generate());
}

function tar(entries) {
  const chunks = [];
  for (const { name, bytes } of entries) {
    const header = Buffer.alloc(512); header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function response(value, url, binary = false) {
  const result = new Response(binary ? value : JSON.stringify(value), { headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** The registry routes of one synthetic Claude Code release whose claude.exe is `binary`. */
export function release(version, binary = pe(version)) {
  const entries = [
    { name: 'package/package.json', bytes: Buffer.from(JSON.stringify({ name: PLATFORM_PACKAGE, version, license: 'SEE LICENSE IN LICENSE.md' })) },
    { name: 'package/claude.exe', bytes: binary },
    { name: 'package/LICENSE.md', bytes: Buffer.from('Synthetic license fixture.\n') },
  ];
  const archive = tar(entries);
  const parentUrl = `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/${version}`;
  const platformUrl = `https://registry.npmjs.org/@anthropic-ai%2fclaude-code-win32-x64/${version}`;
  const parent = { name: '@anthropic-ai/claude-code', version, license: 'SEE LICENSE IN README.md', optionalDependencies: { [PLATFORM_PACKAGE]: version },
    dist: { tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`, integrity: sri(Buffer.from(`synthetic parent ${version}`)) } };
  const platform = { name: PLATFORM_PACKAGE, version, os: ['win32'], cpu: ['x64'], license: 'SEE LICENSE IN LICENSE.md',
    dist: { tarball: `https://registry.npmjs.org/${PLATFORM_PACKAGE}/-/claude-code-win32-x64-${version}.tgz`, integrity: sri(archive),
      fileCount: entries.length, unpackedSize: entries.reduce((sum, entry) => sum + entry.bytes.length, 0) } };
  return { version, binary, sha256: sha(binary), routes: new Map([
    [parentUrl, () => response(parent, parentUrl)],
    [platformUrl, () => response(platform, platformUrl)],
    [platform.dist.tarball, () => response(archive, platform.dist.tarball, true)],
  ]) };
}

/** One fetch for the releases behind the given dist-tags; `calls` records every URL. */
export function registry(releases, tags) {
  const calls = []; const routes = new Map(releases.flatMap((item) => [...item.routes]));
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    if (url === DIST_TAGS_URL) return response(tags, url);
    if (routes.has(url)) return routes.get(url)();
    return assert.fail(`Unexpected synthetic registry URL: ${url}`);
  };
  return { calls, fetchImpl, downloads: () => calls.filter((url) => url.endsWith('.tgz')) };
}

export function admission(stable, latest) {
  const builds = [{ version: stable.version, sha256: stable.sha256 }];
  if (latest.version !== stable.version) builds.push({ version: latest.version, sha256: latest.sha256 });
  return { builds, tracks: { stable: { version: stable.version, verification: 'real-account-and-isolated' }, latest: { version: latest.version, verification: 'isolated-only' } } };
}

/** A project with a physical SDK platform folder: synthetic package.json and the SDK's own (synthetic) claude.exe. */
export async function project(parent, { binary = Buffer.from('synthetic SDK bundled CLI') } = {}) {
  const root = path.join(parent, 'project'), platform = path.join(root, ...SDK_PLATFORM.split('/'));
  await mkdir(platform, { recursive: true });
  const metadata = Buffer.from('{"name":"@anthropic-ai/claude-agent-sdk-win32-x64","version":"0.0.0-synthetic"}\n');
  await writeFile(path.join(platform, 'package.json'), metadata);
  await writeFile(path.join(platform, 'claude.exe'), binary);
  return { root, platform, target: path.join(platform, 'claude.exe'), sdkMetadataSha256: sha(metadata), bundledSha256: sha(binary) };
}
