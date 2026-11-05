import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { binaryFor, parseArgs, trackConfigs, typecheckTracks } from '../../tools/cli/typecheck-tracks.mjs';
import { admission, sha, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STABLE = Buffer.from('synthetic stable claude.exe'), LATEST = Buffer.from('synthetic latest claude.exe');
const ADMITTED = admission({ version: '9.0.1', sha256: sha(STABLE) }, { version: '9.0.2', sha256: sha(LATEST) });

/** A stage folder as npm run cli:<track> leaves it, as far as typecheck-tracks reads it. */
async function stage(stageRoot, version, selection, bytes) {
  const directory = path.join(stageRoot, `claude-code-${version}-${selection}`), binary = path.join(directory, 'extracted', 'package', 'claude.exe');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, bytes);
  await writeFile(path.join(directory, 'stage-receipt.json'), JSON.stringify({ version, binary: { relativePath: 'extracted/package/claude.exe' } }));
  return binary;
}

test('parses the binaries and the stage root, each once and absolute', () => {
  assert.deepEqual(parseArgs([]), { binaries: {} });
  assert.deepEqual(parseArgs(['--stable-binary', 'C:\\cli\\stable.exe', '--latest-binary', 'C:\\cli\\latest.exe']),
    { binaries: { stable: 'C:\\cli\\stable.exe', latest: 'C:\\cli\\latest.exe' } });
  assert.deepEqual(parseArgs(['--stage-root', 'D:\\stage\\']), { binaries: {}, stageRoot: 'D:\\stage' });
  assert.deepEqual(parseArgs(['--latest-binary', 'C:\\cli\\latest.exe', '--stage-root', 'D:\\stage']),
    { binaries: { latest: 'C:\\cli\\latest.exe' }, stageRoot: 'D:\\stage' });
  for (const args of [['--stage-root'], ['--stage-root', 'relative'], ['--stage-root', 'D:\\a', '--stage-root', 'D:\\b'],
    ['--stable-binary', 'C:\\a.exe', '--stable-binary', 'C:\\b.exe'], ['--stable-binary', 'claude.exe'], ['--nightly-binary', 'C:\\a.exe'],
    ['--stable-binary'], ['C:\\a.exe']]) {
    assert.throws(() => parseArgs(args), /Usage: node tools\/cli\/typecheck-tracks\.mjs .*\[--stage-root <absolute folder>\]/, JSON.stringify(args));
  }
});

test('finds each track binary under the given stage root before the default one', async (t) => {
  const work = await temporary(t), custom = path.join(work, 'custom'), local = path.join(work, 'local');
  const env = { LOCALAPPDATA: local };
  const defaultRoot = path.join(local, 'relay-desk-dev', 'cli-stage');
  const fromDefault = await stage(defaultRoot, '9.0.1', 'stable', STABLE);
  const fromCustom = await stage(custom, '9.0.1', 'exact', STABLE);
  assert.equal(await binaryFor('stable', { env, admission: ADMITTED }), fromDefault);
  assert.equal(await binaryFor('stable', { stageRoot: custom, env, admission: ADMITTED }), fromCustom);
  assert.equal(await binaryFor('stable', { given: 'C:\\given.exe', stageRoot: custom, env, admission: ADMITTED }), 'C:\\given.exe');
  await assert.rejects(binaryFor('latest', { stageRoot: custom, env, admission: ADMITTED }),
    { message: `No staged latest build under ${custom}. Run npm run cli:latest -- --stage-root ${custom} or pass --latest-binary.` });
  await assert.rejects(binaryFor('latest', { env, admission: ADMITTED }),
    /^Error: No staged latest build under %LOCALAPPDATA%\\relay-desk-dev\\cli-stage\. Run npm run cli:latest, pass --stage-root <folder> if you staged it elsewhere, or pass --latest-binary\.$/);
  await assert.rejects(binaryFor('latest', { env: {}, admission: ADMITTED }), /LOCALAPPDATA is not set; pass --stage-root/);
});

test('typechecks every admitted track from a custom stage root and reports each failing program', async (t) => {
  const work = await temporary(t), projectRoot = path.join(work, 'project'), stageRoot = path.join(work, 'stage');
  await stage(stageRoot, '9.0.1', 'stable', STABLE);
  await stage(stageRoot, '9.0.2', 'latest', LATEST);
  const read = [], ran = [], lines = [];
  const generate = (bytes, { expectedSha256 }) => {
    assert.equal(sha(bytes), expectedSha256); read.push(bytes.toString('utf8'));
    return { contract: Buffer.from('// contract\n'), host: Buffer.from('// host\n'), sidecar: { cliSha256: expectedSha256 } };
  };
  const run = (root, config) => { ran.push(path.relative(root, config)); return config.includes('9.0.2') && config.endsWith('tsconfig.mod.json') ? 2 : 0; };
  const result = await typecheckTracks({ projectRoot, stageRoot, env: {}, admission: ADMITTED, generate, run, log: (line) => lines.push(line) });
  assert.deepEqual(read, ['synthetic stable claude.exe', 'synthetic latest claude.exe']);
  assert.deepEqual(ran, [path.join('.cache', 'types', '9.0.1', 'tsconfig.node.json'), path.join('.cache', 'types', '9.0.1', 'tsconfig.mod.json'),
    path.join('.cache', 'types', '9.0.2', 'tsconfig.node.json'), path.join('.cache', 'types', '9.0.2', 'tsconfig.mod.json'), 'tsconfig.web.json']);
  assert.equal(result.ok, false);
  assert.equal(lines.at(-1), 'Failed: mod (latest 9.0.2).');
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, '.cache', 'types', '9.0.1', 'tsconfig.node.json'), 'utf8')),
    trackConfigs(projectRoot, path.join(projectRoot, '.cache', 'types', '9.0.1')).node);
  const passing = await typecheckTracks({ projectRoot, stageRoot, env: {}, admission: ADMITTED, generate, run: () => 0, log: (line) => lines.push(line) });
  assert.equal(passing.ok, true); assert.equal(lines.at(-1), 'All programs typecheck for 9.0.1 and 9.0.2.');
});

test('the command refuses unknown arguments with its usage and exit code 1', () => {
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cli', 'typecheck-tracks.mjs'), ...args],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  for (const args of [['--stage-root', 'relative'], ['--other']]) {
    const refused = run(args);
    assert.equal(refused.status, 1, refused.stderr); assert.match(refused.stderr, /^Usage: node tools\/cli\/typecheck-tracks\.mjs/);
  }
});
