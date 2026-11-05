import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { INSTALL_RECORD } from '../../tools/cli/admission.mjs';
import { HELPERS, assertAdmittedCli, assertBuildHost, buildMode } from '../../tools/release/build.mjs';
import { admission, project, release, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const pkg = JSON.parse(text('package.json'));

const SCRIPTS = {
  'cli:stable': 'node tools/cli/official-cli.mjs use stable',
  'cli:latest': 'node tools/cli/official-cli.mjs use latest',
  'cli:status': 'node tools/cli/official-cli.mjs status',
  'types:generate': 'node tools/cli/generate-types.mjs',
  'build:helpers': 'node tools/release/build.mjs --helpers-only',
  build: 'node tools/release/build.mjs',
  start: 'electron .',
  dev: 'npm run build && electron .',
  'dev:web': 'vite --config vite.web.config.ts',
  typecheck: 'node tools/cli/generate-types.mjs --check && tsc --noEmit --composite false -p tsconfig.node.json && tsc --noEmit --composite false -p tsconfig.web.json && tsc --noEmit -p native-mod/tsconfig.json',
  'typecheck:tracks': 'node tools/cli/typecheck-tracks.mjs',
  pretest: 'node tools/release/build.mjs --test-helpers',
  test: 'vitest run --no-cache --configLoader runner',
  'test:source': 'node --test tests/source/*.test.mjs tools/native-cli-maintenance/stage-official.test.mjs tools/native-cli-maintenance/update-check.test.mjs tools/native-cli-maintenance/extract-contract.test.mjs',
  dist: 'npm run build && electron-builder --win --x64',
};

test('package.json has exactly the public scripts and the production entry', () => {
  assert.deepEqual(pkg.scripts, SCRIPTS);
  assert.equal(pkg.main, './out/main/nativeProduction.js');
  assert.equal(pkg.type, 'module');
});

test('every package script points to files that exist', () => {
  const referenced = new Set(['electron-builder.yml', 'tools/release/bootstrap.mjs']);
  for (const [name, script] of Object.entries(pkg.scripts)) {
    const tokens = script.split(/\s+/);
    tokens.forEach((token, index) => {
      if (/\.(?:mjs|js|json|ts|ps1|yml)$/.test(token) || ['-p', '--config', '-File'].includes(tokens[index - 1])) referenced.add(token);
    });
    for (const command of script.split('&&').map((part) => part.trim())) {
      if (command.startsWith('npm run ')) assert(pkg.scripts[command.split(/\s+/)[2]], `${name} runs a missing script: ${command}`);
    }
  }
  for (const file of referenced) {
    if (file.includes('*')) assert(globSync(file, { cwd: ROOT }).length > 0, `No files match ${file}`);
    else assert(existsSync(path.join(ROOT, file)), `A package script names a missing file: ${file}`);
  }
  assert(globSync('tests/source/*.test.mjs', { cwd: ROOT }).length >= 6);
});

test('the build tools resolve tar, resedit and @babel/parser where they load them', () => {
  const tools = createRequire(path.join(ROOT, 'tools', 'native-cli-maintenance', 'stage-official.mjs'));
  for (const name of ['tar', 'resedit', '@babel/parser']) assert(existsSync(tools.resolve(name)), name);
  const project = createRequire(path.join(ROOT, 'package.json'));
  for (const name of ['typescript/package.json', 'electron-vite/package.json', 'vitest/package.json', 'electron-builder/package.json']) assert(project.resolve(name));
});

test('the production bootstrap disables the CLI auto-updater and refuses fixture variables', () => {
  const bootstrap = text('tools/release/bootstrap.mjs');
  assert.match(bootstrap, /process\.env\.DISABLE_AUTOUPDATER = '1';/);
  for (const key of ['RELAY_DESK_NATIVE_PROTOTYPE', 'RELAY_NATIVE_FIXTURE_URL', 'RELAY_NATIVE_DENY_PROXY']) assert(bootstrap.includes(key), key);
  assert.match(bootstrap, /await import\('\.\/index\.js'\);/);
});

// electron-builder as `npm run dist` loads it: its own YAML reader and its Windows packager.
function electronBuilder() {
  const builder = createRequire(createRequire(path.join(ROOT, 'package.json')).resolve('electron-builder/package.json'));
  const lib = createRequire(builder.resolve('app-builder-lib/package.json'));
  return { config: lib('js-yaml').load(text('electron-builder.yml')), WinPackager: builder('app-builder-lib').WinPackager };
}

test('helpers are built from source and the package holds exactly the listed files and resources', () => {
  for (const [script] of [...HELPERS.app, ...HELPERS.test]) assert(existsSync(path.join(ROOT, script)), script);
  assert.deepEqual(HELPERS.app.map(([script]) => script), ['tools/native/build-helper.ps1', 'tools/private-storage/build-helper.ps1', 'tools/auth/build-host.ps1']);
  const { config } = electronBuilder();
  assert.deepEqual(config.files.slice(0, 2), ['out/**', 'package.json']);
  // Anything after them only leaves files out (the copy an interrupted npm run cli:<track> can leave beside claude.exe).
  for (const pattern of config.files.slice(2)) assert(pattern.startsWith('!'), `electron-builder files may only exclude after the first two: ${pattern}`);
  assert.deepEqual(config.asarUnpack, ['node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**']);
  assert.deepEqual(config.extraResources, [
    { from: 'tools/native/bin/RelayNativeHost.exe', to: 'native/RelayNativeHost.exe' },
    { from: 'tools/private-storage/bin/RelayPrivateStorage.exe', to: 'private-storage/RelayPrivateStorage.exe' },
    { from: 'tools/auth/bin/RelayAuthHost.exe', to: 'auth/RelayAuthHost.exe' },
    { from: 'native-mod', to: 'native-mod', filter: ['.claude-plugin/plugin.json', 'hooks/**'] },
    { from: 'build/icon.ico', to: 'icon.ico' },
    { from: 'node_modules/@fontsource-variable/dm-sans/LICENSE', to: 'licenses/DM-Sans-OFL.txt' },
    { from: 'node_modules/@fontsource-variable/jetbrains-mono/LICENSE', to: 'licenses/JetBrains-Mono-OFL.txt' },
  ]);
  assert.equal(config.extraFiles, undefined);
  const ignored = text('.gitignore').split(/\r?\n/);
  assert(ignored.includes('/node_modules'), 'a linked node_modules is a link to Git, so only the pattern without a trailing slash ignores it');
  for (const entry of ['out/', 'release/', '.cache/', 'native-mod/types/', 'native-mod/.claude-plugin/types/', 'src/main/native/generated/',
    'resources/pdf-tools/', INSTALL_RECORD, 'tools/native/bin/', 'tools/private-storage/bin/', 'tools/auth/bin/', 'tools/native-mcp-facade/OwnedMcpJob.exe']) {
    assert(ignored.includes(`/${entry}`), entry);
  }
  // Unanchored folder names would also hide source folders of the same name, such as tools/release/.
  for (const line of ignored) assert(!line || line.startsWith('#') || line.startsWith('/') || line.startsWith('*'), `unanchored .gitignore entry: ${line}`);
  // The maintainers' export tool reads this file to know which build output may sit in a checkout: no wider rule for bin folders.
  assert.deepEqual(ignored.filter((line) => /(?:^|\/)bin\/?$/.test(line)), ['/tools/native/bin/', '/tools/private-storage/bin/', '/tools/auth/bin/']);
});

test('Git stores text with LF and keeps the terminal captures of the panel tests byte for byte', () => {
  const attributes = text('.gitattributes').split(/\r?\n/);
  assert(attributes.includes('* text=auto eol=lf'));
  assert(attributes.includes('*.ansi -text'));
  assert(globSync('tests/engine/fixtures/native-panel/*.ansi', { cwd: ROOT }).length > 0);
});

test('a signed build never signs or edits the official claude.exe and still signs the helpers', () => {
  const { config, WinPackager } = electronBuilder();
  assert.deepEqual(config.win.signExts, ['!claude.exe']);
  assert.notEqual(config.win.signAndEditExecutable, false);
  const packager = { platformSpecificBuildOptions: config.win };
  const signs = (file) => WinPackager.prototype.shouldSignFile.call(packager, file, true);
  const unpacked = path.win32.join('C:\\build', 'resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  assert.equal(signs(path.win32.join(unpacked, 'claude.exe')), false);
  for (const helper of ['native\\RelayNativeHost.exe', 'private-storage\\RelayPrivateStorage.exe', 'auth\\RelayAuthHost.exe']) {
    assert.equal(signs(path.win32.join('C:\\build', 'resources', helper)), true, helper);
  }
});

test('the build picks its mode from the arguments and refuses other hosts and unadmitted CLIs', async (t) => {
  assert.equal(buildMode([]), 'full'); assert.equal(buildMode(['--helpers-only']), 'helpers'); assert.equal(buildMode(['--test-helpers']), 'test-helpers');
  for (const args of [['--helpers-only', '--test-helpers'], ['--other'], ['helpers']]) assert.throws(() => buildMode(args), /Usage/);
  assert.doesNotThrow(() => assertBuildHost({ platform: 'win32', arch: 'x64', env: {} }));
  assert.throws(() => assertBuildHost({ platform: 'linux', arch: 'x64', env: {} }), /Windows x64/);
  assert.throws(() => assertBuildHost({ platform: 'win32', arch: 'arm64', env: {} }), /Windows x64/);
  assert.throws(() => assertBuildHost({ platform: 'win32', arch: 'x64', env: { RELAY_NATIVE_FIXTURE_URL: 'http://127.0.0.1:1/' } }), /must not inherit RELAY_NATIVE_FIXTURE_URL/);
  const stable = release('2.1.308'), latest = release('2.1.312'), admitted = admission(stable, latest);
  const p = await project(await temporary(t));
  await assert.rejects(assertAdmittedCli(p.root, admitted), /is not a build this source admits\. Run npm run cli:stable\./);
  await assert.rejects(assertAdmittedCli(path.join(p.root, 'missing'), admitted), /No Claude Code CLI is installed/);
  await writeFile(p.target, latest.binary);
  assert.deepEqual(await assertAdmittedCli(p.root, admitted), { track: 'latest', version: '2.1.312', sha256: latest.sha256 });
});
