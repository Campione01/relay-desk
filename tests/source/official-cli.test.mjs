import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ADMISSION, INSTALL_RECORD, SDK_BUNDLED_CLI_SHA256, SDK_METADATA_SHA256, SDK_PLATFORM, SDK_VERSION, defaultStageRoot, sha256File, trackOf,
} from '../../tools/cli/admission.mjs';
import {
  cliStatus, displayPath, displayText, findStaged, formatStatus, installCli, parseArgs, runCli, stageTrack, trackMismatch,
} from '../../tools/cli/official-cli.mjs';
import { writeAtomic } from '../../tools/native-cli-maintenance/stage-official.mjs';
import { NATIVE_CLI_BUILDS, nativeCliTrack } from '../../src/main/native/cliBuilds.ts';
import { admission, pe, project, registry, release, sha, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stable = release('2.1.308'), latest = release('2.1.312'), moved = release('2.1.313');
const ADMITTED = admission(stable, latest);

async function setup(t, tags = { stable: '2.1.308', latest: '2.1.312' }) {
  const work = await temporary(t), stageRoot = path.join(work, 'stage');
  const p = await project(work), served = registry([stable, latest, moved], tags);
  const deps = { fetchImpl: served.fetchImpl, projectRoot: p.root, admission: ADMITTED, sdkMetadataSha256: p.sdkMetadataSha256,
    bundledSha256: p.bundledSha256, env: {}, log: () => {} };
  return { work, stageRoot, p, served, deps };
}

test('parses only the documented commands and options', () => {
  assert.deepEqual(parseArgs(['use', 'stable']), { command: 'use', exact: false, track: 'stable' });
  assert.deepEqual(parseArgs(['use', 'latest', '--exact', '--stage-root', 'C:\\stage']), { command: 'use', exact: true, track: 'latest', stageRoot: 'C:\\stage' });
  assert.deepEqual(parseArgs(['install', 'stable']), { command: 'install', exact: false, track: 'stable' });
  assert.deepEqual(parseArgs(['status']), { command: 'status', exact: false });
  for (const args of [[], ['use'], ['use', 'nightly'], ['use', 'beta'], ['install', 'stable', '--exact'], ['status', 'stable'],
    ['use', 'stable', '--stage-root', 'relative'], ['use', 'stable', '--stage-root'], ['use', 'stable', '--exact', '--exact'], ['stage', 'stable']]) {
    assert.throws(() => parseArgs(args), /Usage/, JSON.stringify(args));
  }
  assert.equal(defaultStageRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), path.join('C:\\Users\\me\\AppData\\Local', 'relay-desk-dev', 'cli-stage'));
  assert.throws(() => defaultStageRoot({}), /--stage-root/);
});

test('the shipped tracks map hashes the same way as the app', () => {
  for (const build of NATIVE_CLI_BUILDS) assert.equal(trackOf(build.sha256), nativeCliTrack(build.sha256));
  assert.deepEqual(NATIVE_CLI_BUILDS.map((build) => trackOf(build.sha256)), ['stable', 'latest']);
  assert.equal(trackOf('3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae'), 'unadmitted');
  assert.equal(ADMISSION.builds, NATIVE_CLI_BUILDS);
});

test('the pinned SDK hashes were taken from the SDK version that package-lock.json installs', async () => {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const refresh = `refresh SDK_VERSION, SDK_METADATA_SHA256 and SDK_BUNDLED_CLI_SHA256 in tools/cli/admission.mjs`;
  assert.equal(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'], SDK_VERSION, `package.json pins another SDK; ${refresh}`);
  for (const name of ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-win32-x64']) {
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, SDK_VERSION, `package-lock.json locks another ${name}; ${refresh}`);
  }
  // Where npm ci has installed that version, its files are the ones the hashes describe (an admitted CLI may replace claude.exe).
  const platform = path.join(ROOT, ...SDK_PLATFORM.split('/'));
  let metadata;
  try { metadata = await readFile(path.join(platform, 'package.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!metadata || JSON.parse(metadata.toString('utf8')).version !== SDK_VERSION) return;
  assert.equal(sha(metadata), SDK_METADATA_SHA256, `the installed SDK platform package.json differs; ${refresh}`);
  const installed = await sha256File(path.join(platform, 'claude.exe'));
  if (trackOf(installed) === 'unadmitted') assert.equal(installed, SDK_BUNDLED_CLI_SHA256, `claude.exe is neither admitted nor the SDK's own; run npm ci or ${refresh}`);
});

test('printed messages name user folders by their variable', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me\\' };
  assert.equal(displayText('Stage folder: c:\\users\\me\\appdata\\local\\relay-desk-dev\\cli-stage\\x; and C:\\Users\\me\\stage.', env),
    'Stage folder: %LOCALAPPDATA%\\relay-desk-dev\\cli-stage\\x; and %USERPROFILE%\\stage.');
  assert.equal(displayText('C:\\Users\\meet\\stage and C:\\Users\\me-two', env), 'C:\\Users\\meet\\stage and C:\\Users\\me-two');
  assert.equal(displayText('C:\\Users\\me', env), '%USERPROFILE%');
  assert.equal(displayText('nothing to hide', {}), 'nothing to hide');
});

test('an install removes a claude.exe.relay-new left by an interrupted install, even when nothing is copied', async (t) => {
  const { stageRoot, p, served, deps } = await setup(t);
  const lines = [];
  await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  await writeFile(path.join(p.platform, 'claude.exe.relay-new'), 'half of a copy');
  const result = await runCli(['install', 'stable', '--stage-root', stageRoot], { ...deps, log: (line) => lines.push(line) });
  assert.equal(result.copied, false); assert.equal(result.staleCopyRemoved, true);
  assert.deepEqual(await readdir(p.platform), ['claude.exe', 'package.json']);
  assert.match(lines.join('\n'), /Removed a claude\.exe\.relay-new that an interrupted install left in the SDK package folder\./);
  await mkdir(path.join(p.platform, 'claude.exe.relay-new'));
  await assert.rejects(runCli(['install', 'stable', '--stage-root', stageRoot], deps), /claude\.exe\.relay-new is not the copy an earlier install left; remove it by hand, then rerun\./);
  assert.equal(served.downloads().length, 1);
});

test('use stable stages the admitted build, installs it and records it; a second run copies nothing', async (t) => {
  const { stageRoot, p, served, deps } = await setup(t);
  const result = await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  assert.equal(result.copied, true); assert.equal(result.beforeSha256, p.bundledSha256);
  assert.deepEqual(await readFile(p.target), stable.binary);
  const receipt = await readFile(path.join(stageRoot, 'claude-code-2.1.308-stable', 'stage-receipt.json'));
  const record = JSON.parse(await readFile(path.join(p.root, INSTALL_RECORD), 'utf8'));
  assert.deepEqual(record, { track: 'stable', version: '2.1.308', sha256: stable.sha256, stageReceiptSha256: sha(receipt) });
  assert.deepEqual(served.downloads(), ['https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.308.tgz']);
  const again = await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  assert.equal(again.copied, false); assert.equal(served.downloads().length, 1);
  assert.deepEqual(await readdir(p.platform), ['claude.exe', 'package.json']);
});

test('a moved npm tag stops before any download with the exact-version hint; --exact installs the admitted build', async (t) => {
  const { stageRoot, p, served, deps } = await setup(t, { stable: '2.1.308', latest: '2.1.313' });
  await assert.rejects(runCli(['use', 'latest', '--stage-root', stageRoot], deps),
    { message: 'npm latest is 2.1.313; this source admits 2.1.312. Run npm run cli:latest -- --exact.' });
  assert.deepEqual(served.downloads(), []);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  const result = await runCli(['use', 'latest', '--exact', '--stage-root', stageRoot], deps);
  assert.equal(result.track, 'latest'); assert.equal(result.version, '2.1.312');
  assert.deepEqual(await readFile(p.target), latest.binary);
  assert.deepEqual(await readdir(stageRoot), ['claude-code-2.1.312-exact']);
  assert.equal(trackMismatch('stable', '2.1.320', '2.1.308'), 'npm stable is 2.1.320; this source admits 2.1.308. Run npm run cli:stable -- --exact.');
});

test('a staged binary with another hash than the admitted one is never installed', async (t) => {
  const { stageRoot, p, served, deps } = await setup(t);
  const other = admission({ version: '2.1.308', sha256: sha(pe('2.1.399')) }, latest);
  await assert.rejects(runCli(['use', 'stable', '--stage-root', stageRoot], { ...deps, admission: other }),
    /The staged stable build 2\.1\.308 has sha256 [0-9a-f]{64}; this source admits [0-9a-f]{64} for it\. Nothing was installed\./);
  assert.equal(served.downloads().length, 1);
  assert.deepEqual(await readFile(p.target), Buffer.from('synthetic SDK bundled CLI'));
  await assert.rejects(readFile(path.join(p.root, INSTALL_RECORD)), { code: 'ENOENT' });
  await assert.rejects(stageTrack({ track: 'stable', stageRoot, admission: ADMITTED }), /network access/);
});

test('install works offline from an existing stage and re-hashes the staged binary', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  await assert.rejects(runCli(['install', 'latest', '--stage-root', stageRoot], { ...deps, fetchImpl: undefined }),
    /No staged latest build 2\.1\.312 with the admitted sha256 under .*\. Run npm run cli:latest\./);
  await stageTrack({ track: 'latest', stageRoot, fetchImpl: deps.fetchImpl, admission: ADMITTED });
  const offline = { ...deps, fetchImpl: () => assert.fail('install must not use the network') };
  assert.equal((await runCli(['install', 'latest', '--stage-root', stageRoot], offline)).copied, true);
  assert.deepEqual(await readFile(p.target), latest.binary);
  await writeFile(path.join(stageRoot, 'claude-code-2.1.312-latest', 'extracted', 'package', 'claude.exe'), 'tampered');
  await assert.rejects(findStaged({ track: 'latest', stageRoot, admission: ADMITTED }), /No staged latest build/);
});

test('install refuses an unrecognized binary, foreign SDK metadata and a hard-linked target', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const stage = await stageTrack({ track: 'stable', stageRoot, fetchImpl: deps.fetchImpl, admission: ADMITTED });
  const install = (overrides = {}) => installCli({ projectRoot: p.root, track: 'stable', stage, admission: ADMITTED,
    sdkMetadataSha256: p.sdkMetadataSha256, bundledSha256: p.bundledSha256, ...overrides });
  await assert.rejects(install({ sdkMetadataSha256: 'a'.repeat(64) }), /not the locked SDK platform metadata/);
  await writeFile(p.target, 'some other claude.exe');
  await assert.rejects(install(), /Refusing to replace an unrecognized claude\.exe/);
  assert.equal(await readFile(p.target, 'utf8'), 'some other claude.exe');
  await writeFile(p.target, latest.binary);
  await assert.rejects(install({ stage: { ...stage, binary: path.join(p.root, 'missing.exe') } }), /Missing/);
  const wrong = path.join(p.root, 'wrong.exe');
  await writeFile(wrong, pe('2.1.308').subarray(0, 512));
  await assert.rejects(install({ stage: { ...stage, binary: wrong } }), /The staged binary has sha256 [0-9a-f]{64}; this source admits [0-9a-f]{64} for stable\./);
  assert.deepEqual(await readFile(p.target), latest.binary);
  assert.equal((await install()).beforeSha256, latest.sha256);
  await link(p.target, path.join(p.root, 'second-name.exe'));
  await assert.rejects(install(), /hard-linked/);
});

test('status maps the installed hash to its track and lists the staged tracks', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const status = (extra = {}) => cliStatus({ projectRoot: p.root, stageRoot, admission: ADMITTED, bundledSha256: p.bundledSha256, ...extra });
  let report = await status();
  assert.deepEqual(report.installed, { sha256: p.bundledSha256, track: 'unadmitted', version: null, sdkBundled: true });
  assert.deepEqual(report.tracks.map((item) => [item.track, item.version, item.staged]), [['stable', '2.1.308', []], ['latest', '2.1.312', []]]);
  assert.match(formatStatus(report), /Installed CLI: unadmitted \(the SDK's bundled build\)/);
  await runCli(['use', 'latest', '--stage-root', stageRoot], deps);
  report = await status();
  assert.equal(report.installed.track, 'latest'); assert.equal(report.installed.version, '2.1.312');
  assert.deepEqual(report.tracks[1].staged, [path.join(stageRoot, 'claude-code-2.1.312-latest')]);
  assert.match(formatStatus(report), /Installed CLI: 2\.1\.312 \(latest\)/);
  assert.match(formatStatus(report), /latest 2\.1\.312 {2}isolated acceptance only; staged in /);
  await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  assert.equal((await status()).installed.track, 'stable');
  await writeFile(p.target, 'edited');
  report = await status();
  assert.equal(report.installed.track, 'unadmitted'); assert.equal(report.installed.sdkBundled, false);
  assert.match(formatStatus(report), /\.relay-cli\.json names 2\.1\.308; the binary has changed since/);
  const lines = [];
  await runCli(['status', '--stage-root', stageRoot], { ...deps, log: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /stable 2\.1\.308 {2}maintainer real-account use plus isolated acceptance; staged in /);
  await mkdir(path.join(stageRoot, 'claude-code-2.1.308-exact'));
  await writeFile(path.join(stageRoot, 'claude-code-2.1.308-exact', 'stage-receipt.json'), JSON.stringify({ version: '2.1.308', binary: { relativePath: '../../escape.exe' } }));
  await assert.rejects(status(), /unexpected binary path/);
});

test('status and install output name user folders by their variable, not by the user name', async (t) => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' };
  assert.equal(displayPath('C:\\Users\\me\\AppData\\Local\\relay-desk-dev\\cli-stage', env), '%LOCALAPPDATA%\\relay-desk-dev\\cli-stage');
  assert.equal(displayPath('c:\\users\\ME\\appdata\\local', env), '%LOCALAPPDATA%');
  assert.equal(displayPath('C:\\Users\\me\\stage', env), '%USERPROFILE%\\stage');
  assert.equal(displayPath('C:\\Users\\meet\\stage', env), 'C:\\Users\\meet\\stage');
  assert.equal(displayPath('D:\\stage', env), 'D:\\stage');
  assert.equal(displayPath('C:\\Users\\me\\stage', {}), 'C:\\Users\\me\\stage');

  const { stageRoot, deps } = await setup(t);
  const user = { LOCALAPPDATA: path.dirname(stageRoot) };
  const lines = [];
  await runCli(['use', 'latest', '--stage-root', stageRoot], { ...deps, env: user, log: (line) => lines.push(line) });
  await runCli(['status', '--stage-root', stageRoot], { ...deps, env: user, log: (line) => lines.push(line) });
  const output = lines.join('\n');
  assert.ok(!output.includes(path.dirname(stageRoot)), output);
  assert.match(output, /from %LOCALAPPDATA%\\stage\\claude-code-2\.1\.312-latest\./);
  assert.match(output, /\(stage root %LOCALAPPDATA%\\stage\):/);
  assert.match(output, /latest 2\.1\.312 {2}isolated acceptance only; staged in %LOCALAPPDATA%\\stage\\claude-code-2\.1\.312-latest$/m);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the install record is written through a temporary file and a rename, and replaces the earlier record whole', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const record = path.join(p.root, INSTALL_RECORD), temporaryName = `${INSTALL_RECORD}.relay-partial`;
  const seen = new Set();
  const watcher = watch(p.root, (event, name) => { if (name) seen.add(name); });
  t.after(() => watcher.close());
  await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  for (const deadline = Date.now() + 5000; !seen.has(temporaryName) && Date.now() < deadline;) await wait(50);
  assert.ok(seen.has(temporaryName), 'the record must pass through its temporary file');
  assert.equal(JSON.parse(await readFile(record, 'utf8')).track, 'stable');
  await runCli(['use', 'latest', '--stage-root', stageRoot], deps);
  const replaced = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual([replaced.track, replaced.version, replaced.sha256], ['latest', '2.1.312', latest.sha256]);
  assert.deepEqual((await readdir(p.root)).filter((name) => name.endsWith('.relay-partial')), []);
});

test('writeAtomic with replace keeps the old file until the new one is whole, and clears the temporary file a killed run left', async (t) => {
  const work = await temporary(t), file = path.join(work, 'record.json'), partial = `${file}.relay-partial`;
  await writeFile(file, 'old record');
  let during;
  await writeAtomic(file, 'new record', { replace: true, beforeRename: async () => {
    during = { final: await readFile(file, 'utf8'), temporary: await readFile(partial, 'utf8') };
  } });
  assert.deepEqual(during, { final: 'old record', temporary: 'new record' });
  assert.equal(await readFile(file, 'utf8'), 'new record'); assert.deepEqual(await readdir(work), ['record.json']);
  await assert.rejects(writeAtomic(file, 'refused'), /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'new record');
  // A write that fails keeps the old file and leaves no temporary file.
  await assert.rejects(writeAtomic(file, 'lost', { replace: true, beforeRename: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(await readFile(file, 'utf8'), 'new record'); assert.deepEqual(await readdir(work), ['record.json']);
  // A run killed after it created the temporary file must not block every later write.
  await writeFile(partial, 'half of a rec');
  await writeAtomic(file, 'newest record', { replace: true });
  assert.equal(await readFile(file, 'utf8'), 'newest record'); assert.deepEqual(await readdir(work), ['record.json']);
  // Anything else under that name is not ours to delete.
  await mkdir(partial);
  await assert.rejects(writeAtomic(file, 'refused', { replace: true }), (error) => {
    assert.equal(error.message, `${partial} is not the copy an earlier run left; remove it by hand, then rerun.`);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), 'newest record');
});

test('an install record that is cut short or unreadable names its file and the fix, and the next install writes it again', async (t) => {
  const { stageRoot, p, deps } = await setup(t);
  const record = path.join(p.root, INSTALL_RECORD);
  await runCli(['use', 'stable', '--stage-root', stageRoot], deps);
  const whole = await readFile(record);
  const fix = 'Delete it, then rerun npm run cli:stable or npm run cli:latest, whichever you use, to write it again.';
  const jsonError = (text) => { try { JSON.parse(text); } catch (error) { return error.message; } return assert.fail('The text is valid JSON.'); };
  const cut = whole.subarray(0, 14);
  const cases = [[cut, jsonError(cut.toString('utf8'))], [Buffer.from(''), jsonError('')], [Buffer.from('null'), 'it is not a JSON object'], [Buffer.from('[]'), 'it is not a JSON object']];
  for (const [damaged, why] of cases) {
    await writeFile(record, damaged);
    const named = { message: `${record} cannot be read (${why}). ${fix}` };
    await assert.rejects(cliStatus({ projectRoot: p.root, stageRoot, admission: ADMITTED, bundledSha256: p.bundledSha256 }), named);
    await assert.rejects(runCli(['status', '--stage-root', stageRoot], deps), named);
  }
  // A folder, or a file nobody may read, is reported the same way.
  await rm(record); await mkdir(record);
  await assert.rejects(runCli(['status', '--stage-root', stageRoot], deps), (error) => {
    assert.ok(error.message.startsWith(`${record} cannot be read (EISDIR`), error.message);
    assert.ok(error.message.endsWith(`). ${fix}`), error.message);
    return true;
  });
  await rm(record, { recursive: true });
  // The advice works: the install writes a good record over a damaged one, with nothing left beside it.
  await writeFile(record, cut);
  assert.equal((await runCli(['use', 'stable', '--stage-root', stageRoot], deps)).copied, false);
  assert.deepEqual(await readFile(record), whole);
  assert.equal((await runCli(['status', '--stage-root', stageRoot], deps)).record.track, 'stable');
  assert.deepEqual((await readdir(p.root)).filter((name) => name.endsWith('.relay-partial')), []);
});
