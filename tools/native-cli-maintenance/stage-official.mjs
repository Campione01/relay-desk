import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { checkOfficialUpdate, compareVersions, PACKAGE_NAME } from './update-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PLATFORM_PACKAGE = '@anthropic-ai/claude-code-win32-x64';
export const MAX_TARBALL_BYTES = 384 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 384 * 1024 * 1024;
/**
 * A download needs an answer within responseMs and then never waits stallMs for a byte. The whole transfer is capped at
 * the expected size read at slowBytesPerSecond, never below minTotalMs, so a slow but steady connection finishes.
 */
export const DOWNLOAD_LIMITS = Object.freeze({ responseMs: 120000, stallMs: 60000, minTotalMs: 30 * 60000, slowBytesPerSecond: 64 * 1024 });
/** `newer` stages the newer of latest and stable (latest on a tie); the others follow that one dist-tag. */
export const CHANNELS = Object.freeze(['newer', 'latest', 'stable']);
const OWNER = '.relay-official-cli-stage-owner.json';
const RECEIPT = 'stage-receipt.json';
const USAGE = 'Usage: node tools/native-cli-maintenance/stage-official.mjs [stage|resume --online --stage-root <absolute directory> [--channel newer|latest|stable | --version <major.minor.patch>]]';
const require = createRequire(import.meta.url);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const metadataUrl = (name, version) => `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`;
const exists = async (file) => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const sameDirectory = (a, b) => typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b)
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const RERUN = 'rerunning the same command starts again from a clean stage';
const TEMPORARY = '.relay-partial';
// A folder holding only temporary files may belong to a run that is still creating it, so it is taken over only after this long.
const RECENT_MS = 60 * 1000;

/** What to do about a failed metadata step; only a request that got no usable answer is a network problem. */
const ADVICE = Object.freeze({
  network: 'Check the network, then rerun the same command.',
  status: 'The registry answered with an error status, which is usually temporary. Rerun the same command in a few minutes.',
  answer: 'The registry, or a proxy or captive portal in between, gave an answer this tool does not accept. Rerun the same command later or from another network.',
  data: 'The registry data is not what this source accepts, so nothing was staged. Rerunning changes nothing until that data does; report this message if it persists.',
  unknown: 'Rerun the same command; if it fails the same way again, report this message.',
});
const NETWORK_CODE = /^(ECONN|ENOTFOUND|EAI_|ENET|EHOST|ETIMEDOUT|EPIPE|EPROTO|UND_ERR_|ERR_TLS_|ERR_SSL_|ERR_SOCKET_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|HPE_)/;
const ANSWER_MESSAGE = /^(HTTP error, redirect or off-source response|Response exceeds the bounded size|Missing response body|Metadata exceeds 64 KiB)/;
const sentence = (message) => /[.]$/.test(message) ? message : `${message}.`;

/** The advice for a failed metadata step: the registry's own error codes first, then what the failed request itself looked like. */
function metadataAdvice(error) {
  const chain = [];
  for (let link = error, depth = 0; link && depth < 5; link = link.cause, depth++) chain.push(link);
  const codes = chain.map((link) => link.code).filter((code) => typeof code === 'string');
  const has = (...wanted) => codes.some((code) => wanted.includes(code));
  if (has('METADATA_HTTP_ERROR')) return ADVICE.status;
  if (has('INVALID_VERSION', 'MISSING_CHANNEL', 'PACKAGE_IDENTITY_MISMATCH', 'INVALID_DIST_METADATA')) return ADVICE.data;
  if (has('METADATA_REDIRECT', 'OFF_SOURCE_METADATA', 'INVALID_METADATA', 'METADATA_TOO_LARGE')) return ADVICE.answer;
  if (has('METADATA_REQUEST_FAILED', 'METADATA_TIMEOUT') || codes.some((code) => NETWORK_CODE.test(code))
    || chain.some((link) => link.name === 'AbortError' || link.name === 'TimeoutError' || link instanceof TypeError && link.message === 'fetch failed')) return ADVICE.network;
  return error instanceof SyntaxError || ANSWER_MESSAGE.test(String(error?.message)) ? ADVICE.answer : ADVICE.unknown;
}

/** The codes and messages behind an error: Node's fetch keeps the real reason of a network failure in error.cause. */
function causeText(error) {
  const parts = [];
  for (let cause = error?.cause, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
    const text = typeof cause === 'string' ? cause : [cause.code, cause.message].filter((part) => typeof part === 'string' && part).join(': ');
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.length ? ` (cause: ${parts.join('; ')})` : '';
}

/** Reads registry metadata before anything is staged: a failure names the step and says what to do, since a rerun repeats it. */
export async function metadataStep(label, step) {
  try { return await step(); } catch (error) {
    const message = String(error?.message ?? error).replace(/\.$/, '');
    throw Object.assign(new Error(`Checking ${label} failed: ${message}${causeText(error)}. ${metadataAdvice(error)}`, { cause: error }), error?.code ? { code: error.code } : {});
  }
}

/**
 * Writes through a temporary file and a rename, so a run that is killed or runs out of disk space never leaves a cut-short
 * file under its name. A stage file is never overwritten; `replace` is for a record that is rewritten on every run, and it
 * also clears the temporary file a killed run left, which would otherwise block every later write.
 */
export async function writeAtomic(file, text, { beforeRename, replace = false } = {}) {
  const temporary = `${file}${TEMPORARY}`; let created = false;
  try {
    if (replace) {
      const stale = await lstat(temporary).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stale) { assert(stale.isFile(), `${temporary} is not the copy an earlier run left; remove it by hand, then rerun.`); await unlink(temporary); }
    }
    const handle = await open(temporary, 'wx'); created = true;
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    assert(replace || !await exists(file), `${file} already exists.`);
    await beforeRename?.();
    await rename(temporary, file);
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function physical(directory) {
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (await realpath(directory)).toLowerCase() === path.resolve(directory).toLowerCase(), `Expected physical directory: ${directory}`);
}

export function safeTarPath(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.includes('//'), 'Unsafe archive path.');
  const name = value.replace(/\/$/, '');
  assert((name === 'package' || name.startsWith('package/')) && name.split('/').every((part) => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), `Unsafe archive path: ${value}`);
  return name;
}

export function verifyIntegrity(bytes, integrity) {
  const match = typeof integrity === 'string' && /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  assert(match && integrity === integrity.trim() && createHash(match[1]).update(bytes).digest('base64') === match[2], 'Package SRI differs.');
  return true;
}

function integrityParts(integrity) {
  const match = typeof integrity === 'string' && /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  assert(match && integrity === integrity.trim() && Buffer.from(match[2], 'base64').length === { sha256: 32, sha384: 48, sha512: 64 }[match[1]]
    && Buffer.from(match[2], 'base64').toString('base64') === match[2], 'Invalid package SRI metadata.');
  return { algorithm: match[1], expected: match[2] };
}

function assertPackageMetadata(metadata, name, version) {
  compareVersions(version, version);
  assert(metadata.name === name && metadata.version === version, 'Official package identity/version differs.');
  const basename = name.split('/')[1];
  assert(metadata.dist?.tarball === `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`, 'Off-source package tarball metadata.');
  integrityParts(metadata.dist.integrity);
}

export function normalizeSelection(selection = { channel: 'newer' }) {
  const keys = selection !== null && typeof selection === 'object' ? Object.keys(selection) : [];
  if (keys.length === 1 && keys[0] === 'channel' && CHANNELS.includes(selection.channel)) return { channel: selection.channel };
  assert(keys.length === 1 && keys[0] === 'version', 'Select exactly one channel (newer, latest, stable) or one exact version.');
  compareVersions(selection.version, selection.version);
  return { version: selection.version };
}

function chosenRelease(latest, stable, selection) {
  if (selection.version) return { version: selection.version, channel: 'exact', report: [latest, stable].find((report) => report.observedVersion === selection.version) };
  const report = selection.channel === 'latest' ? latest : selection.channel === 'stable' ? stable
    : compareVersions(latest.observedVersion, stable.observedVersion) >= 0 ? latest : stable;
  return { version: report.observedVersion, channel: report.channel, report };
}

export function selectArtifact(latest, stable, parent, platform, selection) {
  for (const [channel, report] of [['latest', latest], ['stable', stable]]) {
    assert(report.status === 'observed' && report.channel === channel && report.packageName === PACKAGE_NAME, 'Missing official release-channel observation.');
    compareVersions(report.observedVersion, report.observedVersion);
  }
  selection = normalizeSelection(selection);
  const selected = chosenRelease(latest, stable, selection);
  assertPackageMetadata(parent, PACKAGE_NAME, selected.version);
  // An exact version that no channel names has no channel metadata to agree with; its own fixed-URL metadata stands.
  if (selected.report) assert(parent.dist.integrity === selected.report.dist.integrity && parent.dist.tarball === selected.report.dist.tarball, 'Selected parent package metadata changed.');
  const dependencyVersion = parent.optionalDependencies?.[PLATFORM_PACKAGE];
  compareVersions(dependencyVersion, dependencyVersion);
  assertPackageMetadata(platform, PLATFORM_PACKAGE, dependencyVersion);
  assert(JSON.stringify(platform.os) === '["win32"]' && JSON.stringify(platform.cpu) === '["x64"]', 'Package is not the official Windows x64 artifact.');
  assert(Number.isSafeInteger(platform.dist.unpackedSize) && platform.dist.unpackedSize > 0 && platform.dist.unpackedSize <= MAX_UNPACKED_BYTES
    && Number.isSafeInteger(platform.dist.fileCount) && platform.dist.fileCount > 0 && platform.dist.fileCount <= 32, 'Unbounded official artifact metadata.');
  return { version: selected.version, selectedChannel: selected.channel, selection, platformVersion: dependencyVersion,
    relation: { parentPackage: PACKAGE_NAME, parentVersion: parent.version, dependencyKind: 'optionalDependencies', packageName: PLATFORM_PACKAGE,
      dependencySpec: dependencyVersion, platformVersion: platform.version }, dist: platform.dist };
}

async function boundedResponse(response, url, limit) {
  assert(response.status === 200 && !response.redirected && response.url === url, 'HTTP error, redirect or off-source response.');
  const declared = response.headers.get('content-length');
  assert(declared === null || /^\d+$/.test(declared) && BigInt(declared) <= BigInt(limit), 'Response exceeds the bounded size.');
  assert(response.body, 'Missing response body.');
  return response.body;
}

async function getMetadata(fetchImpl, url) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url, { credentials: 'omit', redirect: 'manual', headers: { accept: 'application/json' }, signal: controller.signal });
    const body = await boundedResponse(response, url, 65536); const chunks = []; let size = 0;
    for await (const chunk of body) { size += chunk.byteLength; assert(size <= 65536, 'Metadata exceeds 64 KiB.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); controller.abort(); }
}

async function fileEntry(file, relativePath) {
  const stat = await lstat(file); assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected a regular staged file.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { relativePath, size: stat.size, sha256: hash.digest('hex') };
}

async function inventory(directory, prefix = '') {
  await physical(directory); const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert(!item.isSymbolicLink(), 'Stage links are forbidden.');
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await inventory(path.join(directory, item.name), name));
    else { assert(item.isFile(), 'Unsupported stage entry.'); files.push(await fileEntry(path.join(directory, item.name), name)); }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const seconds = (ms) => `${ms / 1000} s`;

/** Streams the tarball to `destination`; when anything fails, the file this call created is removed. */
async function download(fetchImpl, dist, destination, limits = DOWNLOAD_LIMITS) {
  const { algorithm, expected } = integrityParts(dist.integrity); const sri = createHash(algorithm); const hash = createHash('sha256'); let bytes = 0;
  const controller = new AbortController(); let reason; let file;
  const stop = (why) => () => { reason ??= why; controller.abort(); };
  const totalMs = Math.min(2 ** 31 - 1, Math.max(limits.minTotalMs, Math.ceil(((dist.unpackedSize || 0) * 1000) / limits.slowBytesPerSecond)));
  const total = setTimeout(stop(`it did not finish within ${seconds(totalMs)}`), totalMs);
  let idle = setTimeout(stop(`the registry did not answer within ${seconds(limits.responseMs)}`), limits.responseMs);
  const progress = () => { clearTimeout(idle); idle = setTimeout(stop(`no data arrived for ${seconds(limits.stallMs)}`), limits.stallMs); };
  const owned = !await exists(destination);
  try {
    const response = await fetchImpl(dist.tarball, { credentials: 'omit', redirect: 'manual', signal: controller.signal });
    const body = await boundedResponse(response, dist.tarball, MAX_TARBALL_BYTES); progress();
    file = createWriteStream(destination, { flags: 'wx' });
    await pipeline(body, new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length; progress();
      if (bytes > MAX_TARBALL_BYTES) return callback(new Error('Tarball exceeds the bounded size.'));
      sri.update(chunk); hash.update(chunk); callback(null, chunk);
    } }), file, { signal: controller.signal });
    assert(sri.digest('base64') === expected, 'Downloaded package SRI differs.');
    return { bytes, sha256: hash.digest('hex'), sriVerified: true, integrity: dist.integrity };
  } catch (error) {
    clearTimeout(total); clearTimeout(idle);
    if (file && !file.closed) await new Promise((resolve) => { file.once('close', resolve); file.destroy(); });
    const removed = owned && await exists(destination) ? (await unlink(destination), 'the partial download was removed') : 'no download was kept';
    const cause = String(reason ?? error.message);
    // Our own limits explain themselves; any other failure also shows what error.cause holds (a socket, proxy or certificate error).
    throw new Error(`Downloading ${dist.tarball} failed after ${bytes} bytes: ${cause.endsWith('.') ? cause.slice(0, -1) : cause}${reason === undefined ? causeText(error) : ''}. `
      + `Stage folder: ${path.dirname(destination)}; ${removed}, and ${RERUN}.`, { cause: error });
  } finally { clearTimeout(total); clearTimeout(idle); controller.abort(); }
}

export async function extractPackage(archive, destination, { unpackedSize, fileCount }) {
  await mkdir(destination); await physical(destination);
  const { x } = require('tar'); const seen = new Set(); let payloadBytes = 0; let files = 0; let expanded = 0;
  const unpack = x({ cwd: destination, strict: true, preservePaths: false, noChmod: true, noMtime: true, keep: true,
    filter(name, entry) {
      const safe = safeTarPath(name);
      assert(entry.type === 'File' || entry.type === 'Directory', 'Archive links/special entries are forbidden.');
      assert(!seen.has(safe.toLowerCase()), 'Duplicate archive path.'); seen.add(safe.toLowerCase());
      assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_UNPACKED_BYTES, 'Unbounded archive member.');
      if (entry.type === 'File') { files++; payloadBytes += entry.size; }
      assert(files <= fileCount && payloadBytes <= unpackedSize, 'Archive exceeds official file/size metadata.');
      return true;
    } });
  await pipeline(createReadStream(archive), createGunzip(), new Transform({ transform(chunk, encoding, callback) {
    expanded += chunk.length;
    callback(expanded > unpackedSize + 128 * 512 ? new Error('Decompressed tar exceeds bounded payload/header size.') : null, chunk);
  } }), unpack);
  assert(files === fileCount && payloadBytes === unpackedSize, 'Archive file count/bytes differ from official metadata.');
  return inventory(destination);
}

async function archiveEntries(archive, { unpackedSize, fileCount }) {
  const { t } = require('tar'); const files = []; const seen = new Set(); let bytes = 0; let expanded = 0;
  const parser = t({ strict: true, onReadEntry(entry) {
    const name = safeTarPath(entry.path);
    assert(entry.type === 'File' || entry.type === 'Directory', 'Archive links/special entries are forbidden.');
    assert(!seen.has(name.toLowerCase()), 'Duplicate archive path.'); seen.add(name.toLowerCase());
    if (entry.type !== 'File') return;
    bytes += entry.size; assert(bytes <= unpackedSize && files.length < fileCount, 'Archive exceeds bounded metadata.');
    const hash = createHash('sha256'); let read = 0;
    entry.on('data', (chunk) => { read += chunk.length; hash.update(chunk); });
    entry.on('end', () => { assert(read === entry.size, 'Archive member size differs.'); files.push({ relativePath: name, size: read, sha256: hash.digest('hex') }); });
  } });
  await pipeline(createReadStream(archive), createGunzip(), new Transform({ transform(chunk, encoding, callback) {
    expanded += chunk.length; callback(expanded > unpackedSize + 128 * 512 ? new Error('Decompressed tar exceeds bounded size.') : null, chunk);
  } }), parser);
  assert(files.length === fileCount && bytes === unpackedSize, 'Archive size/count differs.');
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function verifyDownloaded(file, integrity) {
  const stat = await lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_TARBALL_BYTES, 'Invalid staged archive.');
  const { algorithm, expected } = integrityParts(integrity); const sri = createHash(algorithm); const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { sri.update(chunk); hash.update(chunk); }
  assert(sri.digest('base64') === expected, 'Reused package SRI differs.');
  return { bytes: stat.size, sha256: hash.digest('hex'), sriVerified: true, integrity };
}

export function inspectPe(bytes, selectedVersion) {
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
  // This is read-only parsing: retain the original signed bytes and never regenerate the image.
  const image = NtExecutable.from(bytes, { ignoreCert: true });
  assert(!image.is32bit() && image.newHeader.fileHeader.machine === 0x8664, 'Candidate is not an AMD64 PE executable.');
  // Bun places data after .rsrc; the writer-oriented .from() rejects that layout.
  const resourceSection = image.getSectionByEntry(2); assert(resourceSection, 'PE version resource section is missing.');
  const resources = new NtExecutableResource(); resources.parse(resourceSection, false);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  const versionInfos = versions.map((info) => ({ lang: info.lang, fixed: { ...info.fixedInfo },
    strings: info.getAllLanguagesForStringValues().map((language) => ({ language, values: { ...info.getStringValues(language) } })) }));
  const match = (value) => value === selectedVersion || value === `${selectedVersion}.0`;
  const versionMatchesSelectedRelease = versionInfos.some((info) => info.strings.some((entry) => match(entry.values.FileVersion) || match(entry.values.ProductVersion)));
  assert(versionMatchesSelectedRelease, 'PE version metadata does not match the selected official CLI release.');
  const certificate = image.newHeader.optionalHeaderDataDirectory.get(4);
  assert(certificate.virtualAddress + certificate.size <= bytes.length, 'Invalid PE certificate table.');
  return { machine: 'AMD64', machineCode: 0x8664, versionInfos, versionMatchesSelectedRelease,
    certificateTable: { present: certificate.size > 0, size: certificate.size,
      sha256: certificate.size ? sha(bytes.subarray(certificate.virtualAddress, certificate.virtualAddress + certificate.size)) : null,
      authenticodeVerified: false } };
}

/**
 * A JSON file of a stage. One that cannot be read, whatever the reason (cut short, a folder, no access, in use), names
 * itself and the folder and says what to do; after `resume` the fix is stage, since a deleted stage has nothing to resume.
 */
async function stageJson(stageDirectory, name, resume = false) {
  const file = path.join(stageDirectory, name);
  const fix = resume ? 'Delete it, then run stage instead of resume to stage again.' : 'Delete it, then rerun the same command to stage again.';
  const unreadable = (why, cause) => Object.assign(new Error(`${file} cannot be read (${why}). Stage folder: ${stageDirectory}. ${fix}`, { cause }), cause?.code ? { code: cause.code } : {});
  let value;
  try { value = await json(file); } catch (error) { throw unreadable(error?.message ?? String(error), error); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable('it is not a JSON object');
  return value;
}

/** The owner file of an existing stage folder; a folder this tool did not create is refused. */
async function stageOwner(stageDirectory, resume = false) {
  let owner;
  try { owner = await stageJson(stageDirectory, OWNER, resume); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(owner?.owner === 'relay-official-cli-stage' && typeof owner.root === 'string' && sameDirectory(owner.stageDirectory, stageDirectory),
    `${stageDirectory} is not a stage this tool created. Move or delete that folder, then rerun the same command.`);
  return owner;
}

const PARTIAL_ENTRIES = new Set([OWNER, 'channel-observations.json', 'parent-package-metadata.json', 'platform-package-metadata.json', 'extracted']);
// A link reports as 'other', so it never equals the recorded identity of a file or folder.
const identity = (info) => `${info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'} ${info.dev}:${info.ino}`;

/** Every file and folder of an incomplete stage, parents first, each with the identity it had when it was checked. A link or an entry this tool never writes stops it. */
async function partialStage(stageDirectory, directory = stageDirectory, found = { files: [], directories: [] }) {
  await physical(directory); found.directories.push({ path: directory, identity: identity(await lstat(directory, { bigint: true })) });
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name); const info = await lstat(entry, { bigint: true });
    const known = directory !== stageDirectory || PARTIAL_ENTRIES.has(name) || name.endsWith(TEMPORARY)
      || (name.startsWith('claude-code-win32-x64-') && name.endsWith('.tgz'));
    assert(known && !info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
      `${entry} was not written by this tool, so the incomplete stage ${stageDirectory} was left as it is. Delete that folder, then rerun the same command.`);
    if (info.isDirectory()) await partialStage(stageDirectory, entry, found); else found.files.push({ path: entry, identity: identity(info) });
  }
  return found;
}

/**
 * Removes the inspected entries of an incomplete stage one by one, so no link is ever followed. Each entry is checked again
 * right before it is deleted and must still be the same file or folder; on any change the removal stops. `afterInspection`
 * runs between the inspection and the removal (tests only).
 */
async function removeEntries(stageDirectory, { files, directories }, afterInspection) {
  await afterInspection?.();
  const unchanged = async (entry) => {
    let info;
    try { info = await lstat(entry.path, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(info && identity(info) === entry.identity,
      `${entry.path} changed while the incomplete stage ${stageDirectory} was being removed, so the removal stopped there. Delete that folder by hand, then rerun the same command.`);
  };
  for (const file of files) { await unchanged(file); await unlink(file.path); }
  for (const directory of directories.reverse()) { await unchanged(directory); await physical(directory.path); await rmdir(directory.path); }
}

/** Removes an incomplete stage: every file and folder this tool writes, nothing else (see partialStage). */
export async function retireStage(stageDirectory, { afterInspection } = {}) {
  await removeEntries(stageDirectory, await partialStage(stageDirectory), afterInspection);
}

/**
 * Takes over a folder that holds nothing but temporary files, which a run killed before it wrote its owner file leaves.
 * Only plain files at its top level are removed, never a folder or a link, and a folder changed within the last minute is
 * refused, because a run that is still creating it looks the same. A folder with anything else is left to the owner check.
 */
async function takeOverTemporaryStage(stageDirectory) {
  const names = await readdir(stageDirectory);
  if (!names.every((name) => name.endsWith(TEMPORARY))) return;
  const folder = await lstat(stageDirectory, { bigint: true }); const found = { files: [], directories: [{ path: stageDirectory, identity: identity(folder) }] };
  let newest = Number(folder.mtimeMs);
  for (const name of names) {
    const entry = path.join(stageDirectory, name); const info = await lstat(entry, { bigint: true });
    assert(info.isFile(), `${entry} is not a file this tool wrote, so ${stageDirectory} was left as it is. Delete that folder, then rerun the same command.`);
    found.files.push({ path: entry, identity: identity(info) }); newest = Math.max(newest, Number(info.mtimeMs));
  }
  assert(Date.now() - newest >= RECENT_MS, `${stageDirectory} was changed less than a minute ago and holds only temporary files, so another run may still be creating it. `
    + 'Rerun the same command when that run has finished, or in a minute if none is running.');
  await removeEntries(stageDirectory, found);
}

async function validateStage(stageDirectory, receipt, dist) {
  assert(sameDirectory(receipt.stageDirectory, stageDirectory) && JSON.stringify(receipt.owner) === JSON.stringify(await json(path.join(stageDirectory, OWNER))),
    'Receipt does not belong to this owned stage.');
  const files = await inventory(stageDirectory);
  assert(JSON.stringify(files.filter((file) => file.relativePath !== RECEIPT)) === JSON.stringify(receipt.files), 'Owned stage inventory differs; do not overwrite it.');
  assert(JSON.stringify(receipt.files.find((file) => file.relativePath === receipt.binary.relativePath)) === JSON.stringify(receipt.binary), 'Receipt binary differs from its inventory entry.');
  const archive = path.join(stageDirectory, receipt.package.relativePath);
  const { algorithm, expected } = integrityParts(receipt.package.integrity); const hash = createHash(algorithm);
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert(hash.digest('base64') === expected, 'Reused package SRI differs.');
  // A rewritten receipt can match any bytes, so the extracted files are held to the SRI-verified archive itself.
  assert(JSON.stringify(await inventory(path.join(stageDirectory, 'extracted'))) === JSON.stringify(await archiveEntries(archive, dist)), 'Extracted payload differs from the verified archive.');
  assert(JSON.stringify(inspectPe(await readFile(path.join(stageDirectory, receipt.binary.relativePath)), receipt.version)) === JSON.stringify(receipt.pe), 'Reused binary PE evidence differs.');
  return receipt;
}

/**
 * Stages into `<stageRoot>/claude-code-<version>-<latest|stable|exact>`; the root is an existing physical directory, kept
 * outside the repository. The selection is in the name so a stable stage never reuses one staged by exact version.
 */
export async function stageOfficial({ fetchImpl, stageRoot, selection, resume = false, limits = DOWNLOAD_LIMITS } = {}) {
  assert(typeof fetchImpl === 'function', 'Staging requires explicit online fetch authorization.');
  assert(typeof stageRoot === 'string' && path.isAbsolute(stageRoot), 'Staging needs an absolute stage root.');
  stageRoot = path.resolve(stageRoot); selection = normalizeSelection(selection);
  assert(path.parse(stageRoot).root.toLowerCase() !== stageRoot.toLowerCase(), 'A filesystem root cannot be a stage root.');
  await physical(ROOT); await physical(stageRoot);
  const real = (await realpath(stageRoot)).toLowerCase(), repository = (await realpath(ROOT)).toLowerCase();
  assert(real !== repository && !real.startsWith(`${repository}${path.sep}`), 'A stage root inside the repository is refused; keep stages outside it.');
  for (let directory = stageRoot; ; directory = path.dirname(directory)) {
    assert(!await exists(path.join(directory, OWNER)), 'A stage root inside another stage is refused.');
    if (path.dirname(directory) === directory) break;
  }
  const latest = await metadataStep('the latest release', () => checkOfficialUpdate({ channel: 'latest', fetchImpl }));
  const stable = await metadataStep('the stable release', () => checkOfficialUpdate({ channel: 'stable', fetchImpl }));
  const observed = { latest: latest.observedVersion, stable: stable.observedVersion };
  const selected = chosenRelease(latest, stable, selection);
  const parent = await metadataStep(`Claude Code ${selected.version}`, () => getMetadata(fetchImpl, metadataUrl(PACKAGE_NAME, selected.version)));
  const platformVersion = parent.optionalDependencies?.[PLATFORM_PACKAGE]; compareVersions(platformVersion, platformVersion);
  const platform = await metadataStep(`the Windows package ${platformVersion}`, () => getMetadata(fetchImpl, metadataUrl(PLATFORM_PACKAGE, platformVersion)));
  const artifact = selectArtifact(latest, stable, parent, platform, selection);
  const stageDirectory = path.join(stageRoot, `claude-code-${artifact.version}-${artifact.selectedChannel}`);
  if (await exists(stageDirectory)) {
    // A run stopped between creating the folder and writing its owner file leaves it empty or holding only temporary files.
    await physical(stageDirectory); await takeOverTemporaryStage(stageDirectory);
  }
  if (await exists(stageDirectory)) {
    await physical(stageDirectory); const owner = await stageOwner(stageDirectory, resume);
    // A deleted stage has nothing to resume, so after resume the way forward is stage.
    const again = resume ? 'run stage instead of resume' : 'rerun the same command';
    if (await exists(path.join(stageDirectory, RECEIPT))) {
      const receipt = await stageJson(stageDirectory, RECEIPT, resume);
      assert(receipt.version === artifact.version && receipt.package?.integrity === artifact.dist.integrity,
        `${stageDirectory} holds other package bytes for ${artifact.version}. Delete that folder, then ${again}.`);
      // Any clone may reuse a complete stage: it is held to the registry integrity, its verified archive and the binary.
      try { return { ...await validateStage(stageDirectory, receipt, artifact.dist), reused: true, observed }; }
      catch (error) { throw new Error(`${sentence(error.message)} Stage folder: ${stageDirectory}. Delete it, then ${again} to stage again.`, { cause: error }); }
    }
    assert(sameDirectory(owner.root, ROOT), `${stageDirectory} is an incomplete stage of the clone at ${owner.root}, which may still be using it. `
      + 'Finish or rerun the command in that clone, or delete the folder once nothing uses it, then rerun the same command here.');
    // Nothing can have been installed from a stage without a receipt, so a rerun replaces it instead of refusing.
    if (!resume) { await retireStage(stageDirectory); return { ...await stageOfficial({ fetchImpl, stageRoot, selection, limits }), retired: true }; }
    const savedParent = await stageJson(stageDirectory, 'parent-package-metadata.json', true);
    const savedPlatform = await stageJson(stageDirectory, 'platform-package-metadata.json', true);
    const savedChannels = await stageJson(stageDirectory, 'channel-observations.json', true);
    let resumable;
    try {
      const saved = selectArtifact(savedChannels.latest, savedChannels.stable, savedParent, savedPlatform, selection);
      assert(saved.version === artifact.version && saved.dist.integrity === artifact.dist.integrity, 'Partial stage belongs to a different candidate.');
      const archiveName = `claude-code-win32-x64-${saved.platformVersion}.tgz`;
      const packageEvidence = await verifyDownloaded(path.join(stageDirectory, archiveName), saved.dist.integrity);
      const extracted = await archiveEntries(path.join(stageDirectory, archiveName), saved.dist);
      assert(JSON.stringify(await inventory(path.join(stageDirectory, 'extracted'))) === JSON.stringify(extracted), 'Partial extracted payload differs from the verified archive.');
      const allowed = [OWNER, 'channel-observations.json', 'parent-package-metadata.json', 'platform-package-metadata.json', archiveName,
        ...extracted.map((file) => `extracted/${file.relativePath}`)].sort();
      const present = (await inventory(stageDirectory)).map((file) => file.relativePath).sort();
      const named = (names) => `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;
      const unexpected = present.filter((name) => !allowed.includes(name)), lacking = allowed.filter((name) => !present.includes(name));
      assert(!unexpected.length && !lacking.length, `Partial stage ${unexpected.length ? `contains unexpected files: ${named(unexpected)}` : `lacks files: ${named(lacking)}`}.`);
      resumable = { saved, archiveName, packageEvidence, extracted };
    } catch (error) {
      throw new Error(`${sentence(error.message)} Stage folder: ${stageDirectory}. Run stage instead of resume to replace this incomplete stage, or delete that folder and run stage.`, { cause: error });
    }
    const { saved, archiveName, packageEvidence, extracted } = resumable;
    return { ...await finalizeStage(stageDirectory, owner, savedChannels.latest, savedChannels.stable, savedParent, savedPlatform, saved, archiveName, packageEvidence, extracted), resumed: true, observed };
  }
  assert(!resume, 'Nothing to resume: this release has no partial stage.');
  await mkdir(stageDirectory); const owner = { schemaVersion: 1, owner: 'relay-official-cli-stage', root: ROOT, stageDirectory };
  const writeJson = (name, value) => writeAtomic(path.join(stageDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
  await writeJson(OWNER, owner); await writeJson('channel-observations.json', { latest, stable });
  await writeJson('parent-package-metadata.json', parent); await writeJson('platform-package-metadata.json', platform);
  const archiveName = `claude-code-win32-x64-${artifact.platformVersion}.tgz`;
  const packageEvidence = await download(fetchImpl, artifact.dist, path.join(stageDirectory, archiveName), limits);
  const extracted = await extractPackage(path.join(stageDirectory, archiveName), path.join(stageDirectory, 'extracted'), artifact.dist);
  return { ...await finalizeStage(stageDirectory, owner, latest, stable, parent, platform, artifact, archiveName, packageEvidence, extracted), observed };
}

async function finalizeStage(stageDirectory, owner, latest, stable, parent, platform, artifact, archiveName, packageEvidence, extracted) {
  const packageJson = await json(path.join(stageDirectory, 'extracted/package/package.json'));
  assert(packageJson.name === PLATFORM_PACKAGE && packageJson.version === artifact.platformVersion, 'Extracted platform package identity differs.');
  const binary = extracted.filter((file) => file.relativePath.endsWith('/claude.exe'));
  assert(binary.length === 1 && binary[0].relativePath === 'package/claude.exe', 'Expected exactly the official package/claude.exe.');
  const license = extracted.find((file) => file.relativePath === 'package/LICENSE.md'); assert(license, 'Official platform license file is missing.');
  assert(packageJson.license === platform.license && platform.license === 'SEE LICENSE IN LICENSE.md', 'Platform license metadata differs.');
  const pe = inspectPe(await readFile(path.join(stageDirectory, 'extracted', binary[0].relativePath)), artifact.version);
  const files = await inventory(stageDirectory);
  const receipt = { schemaVersion: 1, createdAt: new Date().toISOString(), owner, stageDirectory, version: artifact.version,
    selectedChannel: artifact.selectedChannel, selection: artifact.selection, channelVersions: { latest: latest.observedVersion, stable: stable.observedVersion }, relation: artifact.relation,
    provenance: { parentMetadataUrl: metadataUrl(PACKAGE_NAME, parent.version), platformMetadataUrl: metadataUrl(PLATFORM_PACKAGE, platform.version),
      tarball: artifact.dist.tarball, registrySignaturesMetadata: artifact.dist.signatures ?? [], registrySignaturesVerified: false },
    package: { relativePath: archiveName, ...packageEvidence }, binary: { ...binary[0], relativePath: `extracted/${binary[0].relativePath}` }, pe,
    licenses: { parent: parent.license, platform: platform.license, platformLicense: { ...license, relativePath: `extracted/${license.relativePath}` } },
    files, artifactBytesVerified: true, executed: false, installed: false, admissionApproved: false,
    scope: 'Official candidate acquisition only; no package scripts, CLI execution, installation, live-state changes or deployment.' };
  await writeAtomic(path.join(stageDirectory, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
  return await validateStage(stageDirectory, receipt, artifact.dist);
}

export async function runCli(args, { fetchImpl = globalThis.fetch, writeOutput = console.log } = {}) {
  if (!args.length) {
    const plan = { mode: 'offline', next: 'stage --online --stage-root <absolute directory> [--channel stable]', channels: CHANNELS, defaultChannel: 'newer',
      executed: false, installed: false, admissionApproved: false };
    writeOutput(JSON.stringify(plan, null, 2)); return plan;
  }
  const [mode, ...rest] = args; const options = {}; const seen = new Set();
  assert(mode === 'stage' || mode === 'resume', USAGE);
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index]; assert(!seen.has(option), USAGE); seen.add(option);
    if (option === '--online') options.online = true;
    else if (['--stage-root', '--channel', '--version'].includes(option) && index + 1 < rest.length) options[option.slice(2)] = rest[++index];
    else assert(false, USAGE);
  }
  assert(options.online && options['stage-root'] && !(options.channel && options.version), USAGE);
  const selection = options.version ? { version: options.version } : { channel: options.channel ?? 'newer' };
  const receipt = await stageOfficial({ fetchImpl, stageRoot: options['stage-root'], selection, resume: mode === 'resume' });
  writeOutput(JSON.stringify({ receipt: path.join(receipt.stageDirectory, RECEIPT), version: receipt.version, channelVersions: receipt.channelVersions,
    channelVersionsNow: receipt.observed,
    selectedChannel: receipt.selectedChannel, selection: receipt.selection, relation: receipt.relation,
    binary: { path: path.join(receipt.stageDirectory, receipt.binary.relativePath), ...receipt.binary },
    package: receipt.package, pe: receipt.pe, licenses: receipt.licenses, reused: receipt.reused ?? false, resumed: receipt.resumed ?? false,
    artifactBytesVerified: true, executed: false, installed: false, admissionApproved: false }, null, 2));
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
