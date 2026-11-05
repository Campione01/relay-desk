import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { projectContract } from '../../tools/native-cli-maintenance/project-contract.mjs';
import { checkDeclarations, generateDeclarations, outputPaths, parseArgs, writeDeclarations } from '../../tools/cli/generate-types.mjs';
import { admission, sha, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'tools', 'native-cli-maintenance', 'extract-contract.mjs'));
const declaration = (name) => Buffer.from(`// Claude Code function hooks: synthetic declarations for tests.\ndeclare module "claude-code" {\n  interface ${name} { value: string }\n  type SyntheticEvent = { kind: "synthetic" };\n}\n`);
const binary = (name) => Buffer.concat([Buffer.from('MZ synthetic prefix '), zstdCompressSync(declaration(name)), Buffer.from(' synthetic suffix')]);
const STABLE = binary('StableHook'), LATEST = binary('LatestHook');
const ADMITTED = admission({ version: '9.0.1', sha256: sha(STABLE) }, { version: '9.0.2', sha256: sha(LATEST) });
const project = (bytes) => ({ bytes: Buffer.from(bytes.toString('utf8').replace('value: string', 'value: unknown')), report: {} });
const generate = (bytes, options = {}) => generateDeclarations(bytes, { admission: ADMITTED, project, ...options });

test('parses the documented options only', () => {
  assert.deepEqual(parseArgs([]), { check: false });
  assert.deepEqual(parseArgs(['--binary', 'C:\\cli\\claude.exe', '--expected-sha256', 'A'.repeat(64), '--out-dir', 'C:\\out']),
    { check: false, binary: 'C:\\cli\\claude.exe', expectedSha256: 'a'.repeat(64), outDir: 'C:\\out' });
  assert.deepEqual(parseArgs(['--check', '--out-dir', 'C:\\out']), { check: true, outDir: 'C:\\out' });
  for (const args of [['--binary', 'relative.exe'], ['--expected-sha256', 'a'.repeat(64)], ['--check', '--binary', 'C:\\cli\\claude.exe'],
    ['--binary', 'C:\\a.exe', '--expected-sha256', 'xyz'], ['--check', '--check'], ['--out-dir'], ['--other']]) assert.throws(() => parseArgs(args), /Usage/, JSON.stringify(args));
  assert.deepEqual(outputPaths('C:\\project'), { contract: path.join('C:\\project', 'native-mod', 'types', 'claude-code.d.ts'),
    host: path.join('C:\\project', 'src', 'main', 'native', 'generated', 'mod-api.d.ts'), sidecar: path.join('C:\\project', 'native-mod', 'types', 'generated.json') });
});

test('extracts the embedded declarations of an admitted build and describes them in the sidecar', () => {
  const result = generate(LATEST);
  assert.deepEqual(result.contract, declaration('LatestHook'));
  assert.equal(result.host.toString('utf8'), declaration('LatestHook').toString('utf8').replace('value: string', 'value: unknown'));
  assert.deepEqual(result.sidecar, { cliVersion: '9.0.2', cliSha256: sha(LATEST), track: 'latest', contractSha256: sha(result.contract),
    hostSha256: sha(result.host), parserVersion: require('@babel/parser/package.json').version });
  assert.equal(generate(STABLE).sidecar.track, 'stable');
});

test('refuses an unadmitted build, a wrong expected hash and an unaudited projection', () => {
  const other = binary('OtherHook');
  assert.throws(() => generate(other), new RegExp(`claude\\.exe \\(sha256 ${sha(other)}\\) is not a build this source admits`));
  assert.throws(() => generate(STABLE, { expectedSha256: sha(LATEST) }), /not the expected/);
  assert.throws(() => generateDeclarations(STABLE, { admission: ADMITTED, project: projectContract }), (error) => error.code === 'UNEXPECTED_GLOBAL_SCOPE');
  const empty = Buffer.from('MZ no embedded declarations');
  const admitsEmpty = admission({ version: '9.0.1', sha256: sha(empty) }, { version: '9.0.2', sha256: sha(LATEST) });
  assert.throws(() => generateDeclarations(empty, { admission: admitsEmpty, project }), (error) => error.code === 'NO_CONTRACT_MATCH');
});

test('writes idempotently, and --check holds the sidecar to both files and to an admitted build', async (t) => {
  const work = await temporary(t), paths = outputPaths(undefined, work);
  const result = generate(STABLE);
  assert.deepEqual(await writeDeclarations(paths, result), [paths.contract, paths.host, paths.sidecar]);
  assert.deepEqual(await writeDeclarations(paths, result), []);
  assert.deepEqual((await checkDeclarations(paths, { admission: ADMITTED })).warnings, []);
  assert.match((await checkDeclarations(paths, { admission: ADMITTED, installedSha256: sha(LATEST) })).warnings[0],
    /installed CLI \(9\.0\.2 latest\) is not 9\.0\.1 \(stable\)/);
  assert.match((await checkDeclarations(paths, { admission: ADMITTED, installedSha256: 'f'.repeat(64) })).warnings[0], /installed CLI \(unadmitted\)/);
  const sidecar = await readFile(paths.sidecar, 'utf8');
  await writeFile(paths.host, Buffer.concat([result.host, Buffer.from('\n')]));
  await assert.rejects(checkDeclarations(paths, { admission: ADMITTED }), /mod-api\.d\.ts does not match generated\.json/);
  await writeDeclarations(paths, result);
  await writeFile(paths.contract, 'edited');
  await assert.rejects(checkDeclarations(paths, { admission: ADMITTED }), /claude-code\.d\.ts does not match generated\.json/);
  await writeDeclarations(paths, result);
  for (const edit of [{ track: 'latest' }, { cliVersion: '9.0.2' }, { cliSha256: 'f'.repeat(64) }]) {
    await writeFile(paths.sidecar, JSON.stringify({ ...JSON.parse(sidecar), ...edit }));
    await assert.rejects(checkDeclarations(paths, { admission: ADMITTED }), /does not admit/, JSON.stringify(edit));
  }
  await writeFile(paths.sidecar, JSON.stringify({ ...JSON.parse(sidecar), extra: true }));
  await assert.rejects(checkDeclarations(paths, { admission: ADMITTED }), /is not a declaration sidecar/);
  await writeFile(paths.sidecar, sidecar);
  await checkDeclarations(paths, { admission: ADMITTED });
  await assert.rejects(checkDeclarations(outputPaths(undefined, path.join(work, 'empty')), { admission: ADMITTED }), /missing\. Run npm run types:generate/);
});

test('the command refuses an unadmitted binary without writing anything', async (t) => {
  const work = await temporary(t), file = path.join(work, 'claude.exe'), out = path.join(work, 'out');
  await writeFile(file, binary('UnadmittedHook'));
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cli', 'generate-types.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const refused = run(['--binary', file, '--out-dir', out]);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /is not a build this source admits\. Run npm run cli:stable/);
  assert.deepEqual(await readdir(work), ['claude.exe']);
  const missing = run(['--check', '--out-dir', out]);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /The generated Mod declarations are missing/);
  const usage = run(['--check', '--binary', file]);
  assert.equal(usage.status, 1); assert.match(usage.stderr, /Usage/);
});
