// Stage reuse across clones, recovery from an interrupted stage and the download limits, all offline: the registry is
// synthetic and slow downloads come from a local HTTP server on 127.0.0.1.
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { DOWNLOAD_LIMITS, retireStage, stageOfficial, writeAtomic } from '../../tools/native-cli-maintenance/stage-official.mjs';
import { DIST_TAGS_URL } from '../../tools/native-cli-maintenance/update-check.mjs';
import { runCli } from '../../tools/cli/official-cli.mjs';
import { binaryFor } from '../../tools/cli/typecheck-tracks.mjs';
import { admission, project, registry, release, sha, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = '.relay-official-cli-stage-owner.json';
const stable = release('2.1.308'), latest = release('2.1.312');
const ADMITTED = admission(stable, latest);
const TAGS = { stable: '2.1.308', latest: '2.1.312' };
const tarball = (version) => `https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-${version}.tgz`;
const archiveOf = async (item) => Buffer.from(await item.routes.get(tarball(item.version))().arrayBuffer());
// Short limits; the total cap stays bounded so that a broken limit fails a test instead of hanging it.
const FAST = { responseMs: 5000, stallMs: 5000, minTotalMs: 20000, slowBytesPerSecond: 1e12 };
const SERVED = { timeout: 60000 };
const RERUN = 'rerunning the same command starts again from a clean stage';

/** The registry, except that `respond(options, archive)` answers the tarball download of `version`. */
function registryWith(version, respond) {
  const served = registry([stable, latest], TAGS);
  let archive;
  const fetchImpl = async (url, options) => {
    if (url !== tarball(version)) return served.fetchImpl(url, options);
    served.calls.push(url);
    archive ??= await archiveOf(version === stable.version ? stable : latest);
    const response = await respond(options, archive);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return { ...served, fetchImpl };
}

/** A body that delivers the first half of the archive and then fails, as a dropped connection does. */
const hangUp = (options, archive) => new Response(new ReadableStream({
  start(controller) { controller.enqueue(archive.subarray(0, Math.floor(archive.length / 2))); },
  pull(controller) { controller.error(new Error('socket hang up')); },
}));

/** A local HTTP server; each request is handed to `serve(response, archive)`. */
async function server(t, archive, serve) {
  const sockets = new Set();
  const http = createServer((request, response) => { response.on('error', () => {}); serve(response, archive); });
  http.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => http.close(resolve)); });
  return (options) => fetch(`http://127.0.0.1:${http.address().port}/`, options);
}

/** Writes the archive in `pieces` chunks `gapMs` apart; with `stallAfter`, stops sending after that many chunks. */
const paced = ({ pieces, gapMs, stallAfter = Infinity, headers = true }) => (response, archive) => {
  if (!headers) return;
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
  const size = Math.ceil(archive.length / pieces);
  let index = 0;
  const next = () => {
    if (response.destroyed || index >= stallAfter) return;
    response.write(archive.subarray(index * size, (index + 1) * size));
    if (++index >= pieces) response.end(); else setTimeout(next, gapMs);
  };
  next();
};

/** Makes the named entries of `directory`, then the folder itself, look untouched for ten minutes, like the leftovers of a run that died long ago. */
async function aged(directory, ...names) {
  const past = new Date(Date.now() - 10 * 60 * 1000);
  for (const name of names) await utimes(path.join(directory, name), past, past);
  await utimes(directory, past, past);
}

/** Makes a stage look as if another clone (at `root`) had created it, keeping its receipt consistent. */
async function ownedBy(directory, root) {
  const ownerFile = path.join(directory, OWNER);
  const owner = { ...JSON.parse(await readFile(ownerFile, 'utf8')), root };
  const bytes = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`);
  await writeFile(ownerFile, bytes);
  let receipt;
  try { receipt = JSON.parse(await readFile(path.join(directory, 'stage-receipt.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  receipt.owner = owner;
  receipt.files = receipt.files.map((file) => file.relativePath === OWNER ? { relativePath: OWNER, size: bytes.length, sha256: sha(bytes) } : file);
  await writeFile(path.join(directory, 'stage-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

/** The stager loaded through an upper-case path to this clone, as a differently typed cd would load it. */
async function stagerWithOtherCase() {
  const file = path.join(ROOT.toUpperCase(), 'tools', 'native-cli-maintenance', 'stage-official.mjs');
  return (await import(pathToFileURL(file).href)).stageOfficial;
}

async function setup(t) {
  const work = await temporary(t, 'relay-cli-recovery-'), stageRoot = path.join(work, 'stage');
  await mkdir(stageRoot);
  const p = await project(work);
  const lines = [];
  const deps = { projectRoot: p.root, admission: ADMITTED, sdkMetadataSha256: p.sdkMetadataSha256, bundledSha256: p.bundledSha256,
    env: {}, log: (line) => lines.push(line) };
  return { work, stageRoot, p, lines, deps };
}

test('the download limits wait for a slow connection: 120 s for an answer, 60 s without data, at least 30 minutes in all', () => {
  assert.deepEqual({ ...DOWNLOAD_LIMITS }, { responseMs: 120000, stallMs: 60000, minTotalMs: 1800000, slowBytesPerSecond: 65536 });
  assert.equal(Object.isFrozen(DOWNLOAD_LIMITS), true);
});

test('a complete stage is reused by another clone and through a differently cased path, without a new download', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const first = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } });
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  assert.equal(first.stageDirectory, directory);
  await ownedBy(directory, 'C:\\another-clone');
  const reused = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } });
  assert.equal(reused.reused, true); assert.equal(reused.owner.root, 'C:\\another-clone');
  const shouted = await (await stagerWithOtherCase())({ fetchImpl: served.fetchImpl, stageRoot: stageRoot.toUpperCase(), selection: { channel: 'stable' } });
  assert.equal(shouted.reused, true);
  const result = await runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: served.fetchImpl });
  assert.equal(result.copied, true); assert.deepEqual(await readFile(p.target), stable.binary);
  assert.equal(served.downloads().length, 1);
  // A complete stage that fails its checks names its folder and the fix.
  await writeFile(path.join(directory, 'extracted', 'package', 'claude.exe'), 'tampered');
  await assert.rejects(stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } }),
    { message: `Owned stage inventory differs; do not overwrite it. Stage folder: ${directory}. Delete it, then rerun the same command to stage again.` });
});

test('an interrupted download removes its partial tarball, and rerunning use stages again and installs', async (t) => {
  const { stageRoot, p, lines, deps } = await setup(t);
  const broken = registryWith('2.1.308', hangUp);
  const half = Math.floor((await archiveOf(stable)).length / 2);
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: broken.fetchImpl }), (error) => {
    assert.equal(error.message, `Downloading ${tarball('2.1.308')} failed after ${half} bytes: socket hang up. Stage folder: ${directory}; `
      + `the partial download was removed, and ${RERUN}.`);
    return true;
  });
  assert.deepEqual((await readdir(directory)).sort(), [OWNER, 'channel-observations.json', 'parent-package-metadata.json', 'platform-package-metadata.json']);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  const good = registry([stable, latest], TAGS);
  const result = await runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: good.fetchImpl });
  assert.equal(result.copied, true); assert.deepEqual(await readFile(p.target), stable.binary);
  assert.equal(good.downloads().length, 1);
  assert.match(lines.join('\n'), /^Replaced an incomplete stage that an earlier run left in .*claude-code-2\.1\.308-stable\.$/m);
  assert.ok((await readdir(directory)).includes('stage-receipt.json'));
});

test('an incomplete stage of this clone is replaced, also when reached through a differently cased path', async (t) => {
  const { stageRoot } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest');
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  // Without its receipt the stage is incomplete, though the archive and the extracted files are all there.
  await unlink(path.join(directory, 'stage-receipt.json'));
  const again = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  assert.equal(again.retired, true); assert.equal(served.downloads().length, 2);
  await unlink(path.join(directory, 'stage-receipt.json'));
  const shouted = await (await stagerWithOtherCase())({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  assert.equal(shouted.retired, true); assert.equal(served.downloads().length, 3);
  assert.equal(shouted.owner.root, ROOT.toUpperCase());
  // A folder left empty by a run stopped right after creating it is taken over as well, once it has been idle for a while.
  const emptied = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await mkdir(emptied); await aged(emptied);
  assert.equal((await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } })).stageDirectory, emptied);
});

test('an incomplete stage of another clone, a link in a stage or a foreign entry is refused with the folder and the fix', async (t) => {
  const { work, stageRoot } = await setup(t);
  const broken = registryWith('2.1.312', hangUp);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest');
  await assert.rejects(stageOfficial({ fetchImpl: broken.fetchImpl, stageRoot, selection: { channel: 'latest' } }), /socket hang up/);
  const partial = (await readdir(directory)).sort();
  const served = registry([stable, latest], TAGS);
  const again = () => stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });

  await ownedBy(directory, 'C:\\another-clone');
  await assert.rejects(again(), { message: `${directory} is an incomplete stage of the clone at C:\\another-clone, which may still be using it. `
    + 'Finish or rerun the command in that clone, or delete the folder once nothing uses it, then rerun the same command here.' });
  assert.deepEqual((await readdir(directory)).sort(), partial);
  await ownedBy(directory, ROOT);

  const outside = path.join(work, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'not a stage file');
  await mkdir(path.join(directory, 'extracted'));
  const link = path.join(directory, 'extracted', 'package');
  await symlink(outside, link, 'junction');
  await assert.rejects(again(), { message: `${link} was not written by this tool, so the incomplete stage ${directory} was left as it is. `
    + 'Delete that folder, then rerun the same command.' });
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'not a stage file');
  assert.equal(await readFile(path.join(link, 'keep.txt'), 'utf8'), 'not a stage file');
  await unlink(link);

  await writeFile(path.join(directory, 'notes.txt'), 'the user\'s file');
  await assert.rejects(again(), /notes\.txt was not written by this tool, so the incomplete stage .* was left as it is\. Delete that folder, then rerun the same command\./);
  assert.equal(await readFile(path.join(directory, 'notes.txt'), 'utf8'), 'the user\'s file');
  await unlink(path.join(directory, 'notes.txt'));

  await unlink(path.join(directory, OWNER));
  await assert.rejects(again(), { message: `${directory} is not a stage this tool created. Move or delete that folder, then rerun the same command.` });
  assert.equal(served.downloads().length, 0);
});

test('a download with no data for the stall limit stops, names the stage folder and leaves no partial tarball', SERVED, async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const archive = await archiveOf(stable);
  const local = await server(t, archive, paced({ pieces: 8, gapMs: 10, stallAfter: 2 }));
  const stalled = registryWith('2.1.308', (options) => local(options));
  const limits = { ...FAST, stallMs: 300 };
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: stalled.fetchImpl, limits }), (error) => {
    assert.match(error.message, new RegExp(`^Downloading ${tarball('2.1.308').replaceAll('.', '\\.')} failed after \\d+ bytes: no data arrived for 0\\.3 s\\. `));
    assert.ok(error.message.endsWith(`Stage folder: ${directory}; the partial download was removed, and ${RERUN}.`), error.message);
    return true;
  });
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tgz')), false);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  const good = registry([stable, latest], TAGS);
  assert.equal((await runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: good.fetchImpl })).copied, true);
});

test('a slow but steady download finishes although it takes longer than the stall limit', SERVED, async (t) => {
  const { stageRoot } = await setup(t);
  const archive = await archiveOf(stable);
  const local = await server(t, archive, paced({ pieces: 12, gapMs: 60 }));
  const steady = registryWith('2.1.308', (options) => local(options));
  const started = Date.now();
  const receipt = await stageOfficial({ fetchImpl: steady.fetchImpl, stageRoot, selection: { channel: 'stable' }, limits: { ...FAST, stallMs: 400 } });
  assert.ok(Date.now() - started > 400, 'the transfer must outlast one stall period for this test to mean anything');
  assert.equal(receipt.package.bytes, archive.length); assert.equal(receipt.package.sriVerified, true);
});

test('no answer within the response limit, or a trickle beyond the total cap, also stops with the folder named', SERVED, async (t) => {
  const { stageRoot } = await setup(t);
  const archive = await archiveOf(stable);
  const silent = await server(t, archive, paced({ pieces: 1, gapMs: 0, headers: false }));
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await assert.rejects(stageOfficial({ fetchImpl: registryWith('2.1.308', (options) => silent(options)).fetchImpl, stageRoot,
    selection: { channel: 'stable' }, limits: { ...FAST, responseMs: 200 } }),
  { message: `Downloading ${tarball('2.1.308')} failed after 0 bytes: the registry did not answer within 0.2 s. Stage folder: ${directory}; no download was kept, and ${RERUN}.` });
  const trickle = await server(t, archive, paced({ pieces: 40, gapMs: 40 }));
  await assert.rejects(stageOfficial({ fetchImpl: registryWith('2.1.308', (options) => trickle(options)).fetchImpl, stageRoot,
    selection: { channel: 'stable' }, limits: { ...FAST, minTotalMs: 500, slowBytesPerSecond: 1e12 } }),
  /failed after \d+ bytes: it did not finish within 0\.5 s\. Stage folder: .*; the partial download was removed, and rerunning the same command starts again from a clean stage\./);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tgz')), false);
});

const RECEIPT = 'stage-receipt.json';
const NETWORK = 'Check the network, then rerun the same command.';
const jsonError = (text) => { try { JSON.parse(text); } catch (error) { return error.message; } return assert.fail('The text is valid JSON.'); };
const present = async (file) => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

/** A fetch to a port on 127.0.0.1 that nothing listens on, as a network that refuses the connection. */
async function refusedFetch() {
  const http = createServer();
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  await new Promise((resolve) => http.close(resolve));
  return (options) => fetch(`http://127.0.0.1:${port}/`, options);
}

test('writeAtomic fills a temporary file first, renames it whole and never overwrites or leaves a half file', async (t) => {
  const work = await temporary(t, 'relay-cli-recovery-'), file = path.join(work, RECEIPT);
  let during;
  await writeAtomic(file, 'whole text', { beforeRename: async () => {
    during = { final: await present(file), temporary: await readFile(`${file}.relay-partial`, 'utf8') };
  } });
  assert.deepEqual(during, { final: false, temporary: 'whole text' });
  assert.equal(await readFile(file, 'utf8'), 'whole text'); assert.deepEqual(await readdir(work), [RECEIPT]);
  await assert.rejects(writeAtomic(file, 'other text'), /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'whole text'); assert.deepEqual(await readdir(work), [RECEIPT]);
  const failing = path.join(work, 'failing.json');
  await assert.rejects(writeAtomic(failing, 'x', { beforeRename: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.deepEqual(await readdir(work), [RECEIPT]);
});

test('the stager writes the owner file, the metadata and the receipt through temporary files', SERVED, async (t) => {
  const { stageRoot } = await setup(t);
  const seen = new Set();
  const watcher = watch(stageRoot, { recursive: true }, (event, name) => { if (name) seen.add(name.replaceAll('\\', '/')); });
  t.after(() => watcher.close());
  const staged = await stageOfficial({ fetchImpl: registry([stable, latest], TAGS).fetchImpl, stageRoot, selection: { channel: 'stable' } });
  const wanted = [OWNER, 'channel-observations.json', 'parent-package-metadata.json', 'platform-package-metadata.json', RECEIPT]
    .map((name) => `claude-code-2.1.308-stable/${name}.relay-partial`);
  for (const deadline = Date.now() + 5000; wanted.some((name) => !seen.has(name)) && Date.now() < deadline;) await sleep(50);
  assert.deepEqual(wanted.filter((name) => !seen.has(name)), []);
  assert.deepEqual((await readdir(staged.stageDirectory)).filter((name) => name.endsWith('.relay-partial')), []);
});

test('a cut-short receipt or owner file names itself and the folder in use, install, status and typecheck-tracks', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } });
  const receiptFile = path.join(directory, RECEIPT), ownerFile = path.join(directory, OWNER);
  const whole = await readFile(receiptFile);
  const fix = 'Delete it, then rerun the same command to stage again.';
  const rerun = `Delete it, then rerun the command that staged it (npm run cli:stable -- --stage-root ${stageRoot}).`;
  const offline = { ...deps, fetchImpl: () => assert.fail('Nothing may be fetched for an unreadable receipt.') };
  for (const [damaged, why] of [[whole.subarray(0, Math.floor(whole.length / 2)), undefined], [Buffer.from('null'), 'it is not a JSON object'], [Buffer.from(''), undefined]]) {
    await writeFile(receiptFile, damaged);
    const reason = why ?? jsonError(damaged.toString('utf8'));
    await assert.rejects(stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } }),
      { message: `${receiptFile} cannot be read (${reason}). Stage folder: ${directory}. ${fix}` });
    await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: served.fetchImpl }),
      { message: `${receiptFile} cannot be read (${reason}). Stage folder: ${directory}. ${fix}` });
    const named = { message: `${receiptFile} cannot be read (${reason}). Stage folder: ${directory}. ${rerun}` };
    await assert.rejects(runCli(['install', 'stable', '--stage-root', stageRoot], offline), named);
    await assert.rejects(runCli(['status', '--stage-root', stageRoot], offline), named);
    await assert.rejects(binaryFor('stable', { stageRoot, env: {}, admission: ADMITTED }), named);
  }
  assert.equal(served.downloads().length, 1);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  // Deleting the folder, as the message says, is the whole repair.
  await rm(directory, { recursive: true });
  const result = await runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: served.fetchImpl });
  assert.equal(result.copied, true); assert.deepEqual(await readFile(p.target), stable.binary);

  const owner = await readFile(ownerFile), half = owner.subarray(0, Math.floor(owner.length / 2));
  await writeFile(ownerFile, half);
  await assert.rejects(stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } }),
    { message: `${ownerFile} cannot be read (${jsonError(half.toString('utf8'))}). Stage folder: ${directory}. ${fix}` });
});

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a stage file that cannot be read for any reason names itself and the folder; the rerun advice repeats the stage root only when one was given', async (t) => {
  const { work, stageRoot, deps } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const offline = { ...deps, fetchImpl: () => assert.fail('Nothing may be fetched for an unreadable receipt.') };
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable'), receiptFile = path.join(directory, RECEIPT);
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } });
  // A folder where the receipt belongs: reading it fails with EISDIR, which is not a JSON error.
  await rm(receiptFile); await mkdir(receiptFile);
  const unreadable = (file, folder, fix) => (error) => {
    assert.match(error.message, new RegExp(`^${escaped(file)} cannot be read \\(EISDIR[^)]*\\)\\. Stage folder: ${escaped(folder)}\\. ${escaped(fix)}$`));
    return true;
  };
  const again = 'Delete it, then rerun the same command to stage again.';
  const rerun = (command) => `Delete it, then rerun the command that staged it (${command}).`;
  await assert.rejects(stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } }), unreadable(receiptFile, directory, again));
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: served.fetchImpl }), unreadable(receiptFile, directory, again));
  const given = unreadable(receiptFile, directory, rerun(`npm run cli:stable -- --stage-root ${stageRoot}`));
  await assert.rejects(runCli(['install', 'stable', '--stage-root', stageRoot], offline), given);
  await assert.rejects(runCli(['status', '--stage-root', stageRoot], offline), given);
  await assert.rejects(binaryFor('stable', { stageRoot, env: {}, admission: ADMITTED }), given);

  // The default stage root is implied by the command, so the advice leaves it out.
  const local = path.join(work, 'local'), defaultRoot = path.join(local, 'relay-desk-dev', 'cli-stage'), env = { LOCALAPPDATA: local };
  await mkdir(defaultRoot, { recursive: true });
  const defaultDirectory = path.join(defaultRoot, 'claude-code-2.1.308-stable'), defaultReceipt = path.join(defaultDirectory, RECEIPT);
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot: defaultRoot, selection: { channel: 'stable' } });
  await rm(defaultReceipt); await mkdir(defaultReceipt);
  const implied = unreadable(defaultReceipt, defaultDirectory, rerun('npm run cli:stable'));
  await assert.rejects(runCli(['install', 'stable'], { ...offline, env }), implied);
  await assert.rejects(runCli(['status'], { ...offline, env }), implied);
  await assert.rejects(binaryFor('stable', { env, admission: ADMITTED }), implied);

  // A stage made by exact version, in a stage root whose name needs quotes.
  const spaced = path.join(work, 'my stage'), exactDirectory = path.join(spaced, 'claude-code-2.1.308-exact'), exactReceipt = path.join(exactDirectory, RECEIPT);
  await mkdir(spaced);
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot: spaced, selection: { version: '2.1.308' } });
  await rm(exactReceipt); await mkdir(exactReceipt);
  await assert.rejects(runCli(['status', '--stage-root', spaced], offline),
    unreadable(exactReceipt, exactDirectory, rerun(`npm run cli:stable -- --exact --stage-root "${spaced}"`)));
  assert.equal(served.downloads().length, 3);
});

test('an owner file or saved metadata that cannot be read, or is missing, names itself and the folder, also after resume', async (t) => {
  const { stageRoot } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest');
  const stage = (resume) => stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' }, resume });
  const incomplete = async () => {
    await rm(directory, { recursive: true, force: true });
    await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
    await unlink(path.join(directory, RECEIPT));
  };
  const unreadable = (name, why, fix) => ({ message: `${path.join(directory, name)} cannot be read (${why}). Stage folder: ${directory}. ${fix}` });
  const again = 'Delete it, then rerun the same command to stage again.', instead = 'Delete it, then run stage instead of resume to stage again.';
  const ownerFile = path.join(directory, OWNER);

  await incomplete();
  await rm(ownerFile); await mkdir(ownerFile);
  for (const [resume, fix] of [[false, again], [true, instead]]) {
    await assert.rejects(stage(resume), (error) => {
      assert.match(error.message, new RegExp(`^${escaped(ownerFile)} cannot be read \\(EISDIR[^)]*\\)\\. Stage folder: ${escaped(directory)}\\. ${escaped(fix)}$`));
      return true;
    });
  }

  // Saved metadata is read only by resume; a missing file is reported as one, not as a raw ENOENT.
  await incomplete();
  const metadata = path.join(directory, 'parent-package-metadata.json');
  await rm(metadata);
  await assert.rejects(stage(true), (error) => {
    assert.match(error.message, new RegExp(`^${escaped(metadata)} cannot be read \\(ENOENT[^)]*\\)\\. Stage folder: ${escaped(directory)}\\. ${escaped(instead)}$`));
    return true;
  });
  await writeFile(metadata, '{"name": ');
  await assert.rejects(stage(true), unreadable('parent-package-metadata.json', jsonError('{"name": '), instead));
  await rm(metadata); await mkdir(metadata);
  await assert.rejects(stage(true), (error) => {
    assert.match(error.message, new RegExp(`^${escaped(metadata)} cannot be read \\(EISDIR[^)]*\\)\\. Stage folder: ${escaped(directory)}\\. ${escaped(instead)}$`));
    return true;
  });
  // The plain rerun replaces the stage, whatever its metadata looks like.
  await rm(metadata, { recursive: true });
  assert.equal((await stage(false)).retired, true);
});

test('resume names the folder and the way forward when the partial stage cannot be resumed', async (t) => {
  const { stageRoot } = await setup(t);
  const broken = registryWith('2.1.312', hangUp);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest');
  const resume = () => stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' }, resume: true });
  const way = `Stage folder: ${directory}. Run stage instead of resume to replace this incomplete stage, or delete that folder and run stage.`;
  // A download that stopped leaves no archive, so there is nothing to resume from.
  await assert.rejects(stageOfficial({ fetchImpl: broken.fetchImpl, stageRoot, selection: { channel: 'latest' } }), /socket hang up/);
  await assert.rejects(resume(), (error) => {
    assert.match(error.message, new RegExp(`^ENOENT: no such file or directory, lstat '${escaped(path.join(directory, 'claude-code-win32-x64-2.1.312.tgz'))}'\\. ${escaped(way)}$`));
    return true;
  });
  // A complete payload whose receipt write was cut off: the leftover temporary file is named.
  await rm(directory, { recursive: true });
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  await rename(path.join(directory, RECEIPT), path.join(directory, `${RECEIPT}.relay-partial`));
  await assert.rejects(resume(), { message: `Partial stage contains unexpected files: ${RECEIPT}.relay-partial. ${way}` });
  await rm(path.join(directory, `${RECEIPT}.relay-partial`));
  await rm(path.join(directory, 'extracted', 'package', 'LICENSE.md'));
  await assert.rejects(resume(), (error) => {
    assert.match(error.message, /^Partial extracted payload differs from the verified archive\. Stage folder: /);
    assert.ok(error.message.endsWith(way), error.message);
    return true;
  });
  // Without a leftover the same partial stage resumes: a stage that only lacks its receipt.
  await rm(directory, { recursive: true });
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  await unlink(path.join(directory, RECEIPT));
  const resumed = await resume();
  assert.equal(resumed.resumed, true); assert.ok(await present(path.join(directory, RECEIPT)));
  assert.equal(served.downloads().length, 2);
});

test('a folder holding only temporary files is taken over as plain files only, never a nested folder or a link, and not while another run may be creating it', async (t) => {
  const { work, stageRoot } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable'), outside = path.join(work, 'outside'), keep = path.join(outside, 'keep.txt');
  const stage = () => stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } });
  await mkdir(outside); await writeFile(keep, 'not a stage file');

  // A folder that a run created a moment ago may still be filled by that run, whether it is empty or holds temporary files.
  await mkdir(directory);
  const recent = { message: `${directory} was changed less than a minute ago and holds only temporary files, so another run may still be creating it. `
    + 'Rerun the same command when that run has finished, or in a minute if none is running.' };
  await assert.rejects(stage(), recent);
  await writeFile(path.join(directory, `${OWNER}.relay-partial`), '{"schemaVer');
  await assert.rejects(stage(), recent);
  assert.deepEqual(await readdir(directory), [`${OWNER}.relay-partial`]);
  // Idle files in a folder that was itself touched a moment ago are not enough either.
  const past = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(path.join(directory, `${OWNER}.relay-partial`), past, past);
  await assert.rejects(stage(), recent);
  // So is an idle folder with a file that was written a moment ago: a slow write changes the file, not the folder.
  await aged(directory, `${OWNER}.relay-partial`);
  await utimes(path.join(directory, `${OWNER}.relay-partial`), new Date(), new Date());
  await assert.rejects(stage(), recent);
  await aged(directory, `${OWNER}.relay-partial`);

  // A nested folder is refused with guidance and kept whole, although its name looks like ours.
  const nested = path.join(directory, 'inner.relay-partial');
  await mkdir(nested); await writeFile(path.join(nested, 'keep.txt'), 'the user\'s file'); await aged(directory, `${OWNER}.relay-partial`, 'inner.relay-partial');
  const refused = { message: `${nested} is not a file this tool wrote, so ${directory} was left as it is. Delete that folder, then rerun the same command.` };
  await assert.rejects(stage(), refused);
  assert.equal(await readFile(path.join(nested, 'keep.txt'), 'utf8'), 'the user\'s file');
  assert.deepEqual((await readdir(directory)).sort(), [`${OWNER}.relay-partial`, 'inner.relay-partial']);
  await rm(nested, { recursive: true });

  // A junction is no file, so it is not followed and its target stays whole.
  await symlink(outside, nested, 'junction'); await aged(directory, `${OWNER}.relay-partial`);
  await assert.rejects(stage(), refused);
  assert.equal(await readFile(keep, 'utf8'), 'not a stage file');
  await unlink(nested);

  // Plain temporary files that have been idle for a while are debris: they are removed and the stage goes ahead.
  await aged(directory, `${OWNER}.relay-partial`);
  assert.equal((await stage()).stageDirectory, directory);
  assert.ok(await present(path.join(directory, RECEIPT)));
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.relay-partial')), []);
  assert.equal(await readFile(keep, 'utf8'), 'not a stage file');
  assert.equal(served.downloads().length, 1);
});

test('a run killed while writing leaves only a temporary file, and the next run takes the stage over', async (t) => {
  const { stageRoot } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest');
  await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  // Killed after the temporary receipt was written and before the rename.
  await rename(path.join(directory, RECEIPT), path.join(directory, `${RECEIPT}.relay-partial`));
  const again = await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
  assert.equal(again.retired, true); assert.equal(served.downloads().length, 2);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.relay-partial')), []);
  assert.ok(await present(path.join(directory, RECEIPT)));
  // Killed while the owner file was the first thing written: the folder holds nothing else.
  const first = path.join(stageRoot, 'claude-code-2.1.308-stable');
  await mkdir(first); await writeFile(path.join(first, `${OWNER}.relay-partial`), '{"schemaVer'); await aged(first, `${OWNER}.relay-partial`);
  assert.equal((await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'stable' } })).stageDirectory, first);
  assert.ok(await present(path.join(first, RECEIPT)));
});

test('removing an incomplete stage checks every entry again just before deleting it and stops on any change', async (t) => {
  const { work, stageRoot } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const directory = path.join(stageRoot, 'claude-code-2.1.312-latest'), outside = path.join(work, 'outside');
  const incomplete = async () => {
    await rm(directory, { recursive: true, force: true });
    await stageOfficial({ fetchImpl: served.fetchImpl, stageRoot, selection: { channel: 'latest' } });
    await unlink(path.join(directory, RECEIPT));
  };
  const changed = (entry) => ({ message: `${entry} changed while the incomplete stage ${directory} was being removed, so the removal stopped there. `
    + 'Delete that folder by hand, then rerun the same command.' });
  const metadata = path.join(directory, 'parent-package-metadata.json');

  await incomplete();
  await assert.rejects(retireStage(directory, { afterInspection: async () => {
    await writeFile(`${metadata}.swap`, 'a different file'); await rename(`${metadata}.swap`, metadata);
  } }), changed(metadata));
  assert.equal(await readFile(metadata, 'utf8'), 'a different file');

  // A folder swapped for a junction to a look-alike must not be followed, whatever its files are called.
  await incomplete();
  const extracted = path.join(directory, 'extracted'), lookAlike = path.join(outside, 'extracted');
  await cp(extracted, lookAlike, { recursive: true });
  const before = await readdir(path.join(lookAlike, 'package'));
  await assert.rejects(retireStage(directory, { afterInspection: async () => {
    await rename(extracted, path.join(work, 'moved')); await symlink(lookAlike, extracted, 'junction');
  } }), (error) => {
    assert.match(error.message, /extracted[\\/]package[\\/][^\\/]+ changed while the incomplete stage .* was being removed, so the removal stopped there\./);
    return true;
  });
  assert.deepEqual(await readdir(path.join(lookAlike, 'package')), before);
  assert.deepEqual(await readFile(path.join(lookAlike, 'package', 'claude.exe')), latest.binary);
  await unlink(extracted);

  // An entry that disappeared is a change as well.
  await incomplete();
  await assert.rejects(retireStage(directory, { afterInspection: () => unlink(metadata) }), changed(metadata));

  // A folder replaced by another folder is refused too, even when both are empty.
  await incomplete();
  const spare = path.join(directory, 'extracted', 'package', 'spare');
  await mkdir(spare);
  await assert.rejects(retireStage(directory, { afterInspection: async () => {
    await rename(spare, path.join(work, 'spare-before')); await mkdir(spare);
  } }), changed(spare));
  assert.ok(await present(spare)); assert.ok(await present(directory));
});

test('a download that fails on the network shows the cause next to the short reason', SERVED, async (t) => {
  const { stageRoot } = await setup(t);
  const archive = await archiveOf(stable);
  const directory = path.join(stageRoot, 'claude-code-2.1.308-stable');
  const dropped = await server(t, archive, (response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
    response.write(archive.subarray(0, Math.floor(archive.length / 2)));
    setTimeout(() => response.socket.destroy(), 50);
  });
  await assert.rejects(stageOfficial({ fetchImpl: registryWith('2.1.308', (options) => dropped(options)).fetchImpl, stageRoot, selection: { channel: 'stable' } }), (error) => {
    assert.match(error.message, new RegExp(`^Downloading ${tarball('2.1.308').replaceAll('.', '\\.')} failed after \\d+ bytes: terminated \\(cause: UND_ERR_SOCKET: other side closed\\)\\. `));
    assert.ok(error.message.endsWith(`Stage folder: ${directory}; the partial download was removed, and ${RERUN}.`), error.message);
    return true;
  });
  const refused = await refusedFetch();
  await assert.rejects(stageOfficial({ fetchImpl: registryWith('2.1.308', (options) => refused(options)).fetchImpl, stageRoot, selection: { channel: 'stable' } }),
    /failed after 0 bytes: fetch failed \(cause: .*ECONNREFUSED.*\)\. Stage folder: .*; no download was kept, and rerunning the same command starts again from a clean stage\.$/);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tgz')), false);
});

test('a metadata check that fails before the download says to check the network and rerun the same command', SERVED, async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const refused = await refusedFetch();
  const idle = await readdir(stageRoot);
  await assert.rejects(stageOfficial({ fetchImpl: (url, options) => refused(options), stageRoot, selection: { channel: 'stable' } }), (error) => {
    assert.match(error.message, /^Checking the latest release failed: Official npm metadata request failed; no retry or alternate source was attempted \(cause: fetch failed; .*ECONNREFUSED.*\)\. Check the network, then rerun the same command\.$/);
    assert.equal(error.code, 'METADATA_REQUEST_FAILED');
    return true;
  });
  // The moved-tag check of npm run cli:<track> runs first and says the same.
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: (url, options) => refused(options) }),
    { message: /^Checking the npm stable tag failed: Official npm metadata request failed; .*ECONNREFUSED.*\)\. Check the network, then rerun the same command\.$/ });
  assert.deepEqual(await readdir(stageRoot), idle);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
});

const STATUS = 'The registry answered with an error status, which is usually temporary. Rerun the same command in a few minutes.';
const ANSWER = 'The registry, or a proxy or captive portal in between, gave an answer this tool does not accept. Rerun the same command later or from another network.';
const DATA = 'The registry data is not what this source accepts, so nothing was staged. Rerunning changes nothing until that data does; report this message if it persists.';
const UNKNOWN = 'Rerun the same command; if it fails the same way again, report this message.';
const PARENT = 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.308', PLATFORM = 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code-win32-x64/2.1.308';

/** A rejected fetch the way undici reports it: a TypeError whose cause holds the system code. */
const rejection = (code, text) => new TypeError('fetch failed', { cause: Object.assign(new Error(text), { code }) });

test('a failed metadata check says to check the network only for a request that got no answer, and otherwise gives advice that is true', SERVED, async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const served = registry([stable, latest], TAGS);
  const idle = await readdir(stageRoot);
  const reply = (url, response) => Object.defineProperty(response, 'url', { value: url });
  const json = (url, body) => reply(url, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  // Routes `answer(url, count)` over the synthetic registry; `count` is how many times that url was asked for so far.
  const route = (answer) => { const asked = new Map(); return (url, options) => {
    asked.set(url, (asked.get(url) ?? 0) + 1);
    return answer(url, asked.get(url)) ?? served.fetchImpl(url, options);
  }; };
  const cases = [
    // Nothing came back: the network, the name lookup, the certificate or a timeout.
    ['the connection is refused', route((url) => url === DIST_TAGS_URL ? Promise.reject(rejection('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9')) : undefined),
      /^Checking the latest release failed: Official npm metadata request failed; no retry or alternate source was attempted \(cause: fetch failed; .*ECONNREFUSED.*\)\. /, NETWORK],
    ['the host name is not found', route((url) => url === DIST_TAGS_URL ? Promise.reject(rejection('ENOTFOUND', 'getaddrinfo ENOTFOUND registry.npmjs.org')) : undefined),
      /^Checking the latest release failed: .*ENOTFOUND/, NETWORK],
    ['the certificate is refused', route((url) => url === DIST_TAGS_URL ? Promise.reject(rejection('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate')) : undefined),
      /^Checking the latest release failed: .*UNABLE_TO_VERIFY_LEAF_SIGNATURE/, NETWORK],
    ['the stager\'s own request is refused', route((url, count) => url === PARENT && count === 2 ? Promise.reject(rejection('ECONNRESET', 'read ECONNRESET')) : undefined),
      /^Checking Claude Code 2\.1\.308 failed: fetch failed \(cause: ECONNRESET: read ECONNRESET\)\. /, NETWORK],
    ['the failure carries its system code in a cause only', route((url, count) => url === PARENT && count === 2
      ? Promise.reject(Object.assign(new Error('Client network socket disconnected'), { cause: Object.assign(new Error('tls failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) })) : undefined),
      /^Checking Claude Code 2\.1\.308 failed: Client network socket disconnected \(cause: ERR_TLS_CERT_ALTNAME_INVALID: tls failure\)\. /, NETWORK],
    ['the failure carries its system code itself', route((url) => url === PLATFORM ? Promise.reject(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })) : undefined),
      /^Checking the Windows package 2\.1\.308 failed: read ETIMEDOUT\. /, NETWORK],
    ['the stager\'s own request times out', route((url) => url === PLATFORM ? Promise.reject(new DOMException('This operation was aborted', 'AbortError')) : undefined),
      /^Checking the Windows package 2\.1\.308 failed: This operation was aborted\. /, NETWORK],
    // An answer came back, but not a usable one.
    ['the registry answers with a server error', route((url) => url === DIST_TAGS_URL ? reply(url, new Response('unavailable', { status: 503 })) : undefined),
      /^Checking the latest release failed: Official npm metadata returned HTTP 503\. /, STATUS],
    ['the version metadata is not found', route((url) => url === PARENT ? reply(url, new Response('missing', { status: 404 })) : undefined),
      /^Checking the stable release failed: Official npm metadata returned HTTP 404\. /, STATUS],
    ['a proxy redirects', route((url) => url === DIST_TAGS_URL ? reply(url, new Response(null, { status: 302, headers: { location: 'http://portal.example/' } })) : undefined),
      /^Checking the latest release failed: Official npm metadata redirects are not followed\. /, ANSWER],
    ['a captive portal answers with a web page', route((url) => url === DIST_TAGS_URL ? reply(url, new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })) : undefined),
      /^Checking the latest release failed: Official npm metadata response is not application\/json\. /, ANSWER],
    ['the stager\'s own request is answered with a server error', route((url, count) => url === PARENT && count === 2 ? reply(url, new Response('unavailable', { status: 503 })) : undefined),
      /^Checking Claude Code 2\.1\.308 failed: HTTP error, redirect or off-source response\. /, ANSWER],
    ['the stager\'s own request is answered with something that is not JSON', route((url) => url === PLATFORM ? reply(url, new Response('not json', { headers: { 'content-type': 'application/json' } })) : undefined),
      /^Checking the Windows package 2\.1\.308 failed: Unexpected token/, ANSWER],
    // The registry's data itself is wrong, so asking again changes nothing.
    ['a dist-tag names an invalid version', route((url) => url === DIST_TAGS_URL ? json(url, { stable: '2.1.308-beta', latest: '2.1.312' }) : undefined),
      /^Checking the stable release failed: Version must be an exact numeric stable major\.minor\.patch; /, DATA],
    ['the version metadata names another package', route((url) => url === 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.312' ? json(url, { name: 'other', version: '2.1.312' }) : undefined),
      /^Checking the latest release failed: Official npm version metadata does not match the selected package and exact dist-tag version\. /, DATA],
    ['a dist-tag is missing', route((url) => url === DIST_TAGS_URL ? json(url, { latest: '2.1.312' }) : undefined),
      /^Checking the stable release failed: Official npm metadata does not contain the requested stable dist-tag; no fallback was selected\. /, DATA],
    ['the failure is of a kind nobody planned for', route((url, count) => url === PARENT && count === 2 ? Promise.reject(new RangeError('Unplanned failure')) : undefined),
      /^Checking Claude Code 2\.1\.308 failed: Unplanned failure\. /, UNKNOWN],
  ];
  for (const [name, fetchImpl, shape, advice] of cases) {
    await assert.rejects(stageOfficial({ fetchImpl, stageRoot, selection: { channel: 'stable' } }), (error) => {
      assert.match(error.message, shape, name);
      assert.ok(error.message.endsWith(` ${advice}`), `${name}: ${error.message}`);
      // Only the network advice may say so.
      assert.equal(error.message.includes('Check the network'), advice === NETWORK, name);
      return true;
    });
  }
  // The moved-tag check of npm run cli:<track> gives the same advice.
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, fetchImpl: route((url) => url === DIST_TAGS_URL ? reply(url, new Response('unavailable', { status: 503 })) : undefined) }),
    { message: `Checking the npm stable tag failed: Official npm metadata returned HTTP 503. ${STATUS}` });
  assert.deepEqual(await readdir(stageRoot), idle);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  assert.equal(served.downloads().length, 0);
});
