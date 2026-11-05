import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ADMISSION, SDK_PLATFORM } from '../../tools/cli/admission.mjs';
import { PACKAGED_PDF_NOTE, build } from '../../tools/release/build.mjs';
import { admission, project, release, temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// electron-builder as `npm run dist` loads it: its own YAML reader and the matcher it applies to node_modules files.
function electronBuilder() {
  const builder = createRequire(createRequire(path.join(ROOT, 'package.json')).resolve('electron-builder/package.json'));
  const lib = createRequire(builder.resolve('app-builder-lib/package.json'));
  return { config: lib('js-yaml').load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')), fileMatcher: lib('app-builder-lib/out/fileMatcher') };
}

test('a full build refuses an unadmitted or missing CLI before any build step', async (t) => {
  const p = await project(await temporary(t));
  const lines = [];
  const run = (root, extra = {}) => build([], { projectRoot: root, log: (line) => lines.push(line), env: {}, ...extra });
  await assert.rejects(run(p.root),
    /^Error: The installed Claude Code CLI \(sha256 [0-9a-f]{64}\) is not a build this source admits\. Run npm run cli:stable\.$/);
  const stable = release('2.1.308'), latest = release('2.1.312');
  await assert.rejects(run(p.root, { admission: admission(stable, latest) }), /^Error: The installed Claude Code CLI \(sha256 [0-9a-f]{64}\) is not a build/);
  await assert.rejects(run(path.join(p.root, 'missing')), /^Error: No Claude Code CLI is installed in node_modules\. Run npm ci, then npm run cli:stable\.$/);
  assert.deepEqual(lines, []);
  assert.deepEqual((await readdir(p.root)).sort(), ['node_modules']);
  assert.equal((await readdir(path.join(p.root, ...SDK_PLATFORM.split('/')))).length, 2);
  assert.equal(ADMISSION.builds.some((item) => item.sha256 === p.bundledSha256), false);
});

test('a full build refuses fixture variables before it looks at the CLI', async (t) => {
  const p = await project(await temporary(t));
  await assert.rejects(build([], { projectRoot: p.root, log: () => {}, env: { RELAY_NATIVE_FIXTURE_URL: 'http://127.0.0.1:1/' } }),
    /must not inherit RELAY_NATIVE_FIXTURE_URL/);
});

test('npm run dist never packages a claude.exe.relay-new left by an interrupted install, and still packages claude.exe', () => {
  const { config, fileMatcher } = electronBuilder();
  const appDir = 'C:\\project', destination = 'C:\\project\\dist\\app';
  const packager = { config, debugLogger: { isEnabled: false } };
  const modules = fileMatcher.getNodeModuleFileMatcher(appDir, destination, (value) => value, {}, packager);
  const relative = path.win32.join('node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  const source = path.win32.join(appDir, relative);
  // As computeNodeModuleFileSets: no exclusions means no filter; otherwise each file is matched by its path in the app.
  const filter = modules.isEmpty() ? () => true
    : new fileMatcher.FileMatcher(source, path.win32.join(destination, relative), (value) => value, modules.patterns).createFilter();
  const keeps = (name) => filter(path.win32.join(source, name), { isDirectory: () => false, moduleFullFilePath: path.win32.join(relative, name) });
  assert.equal(keeps('claude.exe'), true);
  assert.equal(keeps('package.json'), true);
  assert.equal(keeps('claude.exe.relay-new'), false);
});

test('packaged builds hold no PDF tools, as the build message says', () => {
  const { config } = electronBuilder();
  const packaged = JSON.stringify([config.files, config.extraResources, config.extraFiles, config.asarUnpack]);
  assert.doesNotMatch(packaged, /pdf/i, 'electron-builder.yml now packages PDF tools; update PACKAGED_PDF_NOTE and BUILD.md');
  assert.match(PACKAGED_PDF_NOTE, /include no PDF tools and ignore RELAY_DESK_PDF_TOOLS_DIR/);
});
