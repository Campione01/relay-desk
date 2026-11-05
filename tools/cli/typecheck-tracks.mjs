// Typechecks the source against the Mod declarations of every admitted track, not only the installed one.
//
//   node tools/cli/typecheck-tracks.mjs [--stable-binary <absolute claude.exe>] [--latest-binary <absolute claude.exe>]
//     [--stage-root <absolute folder>]
//
// Binaries default to the staged builds under the stage root, %LOCALAPPDATA%\relay-desk-dev\cli-stage unless
// --stage-root names the one given to npm run cli:<track>. Declarations go to .cache/types/<version>/, with temporary
// tsconfig files beside them; the project's own generated declarations are left alone.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMISSION, ROOT, TRACKS, admittedBuild, defaultStageRoot, displayPath, displayText, fail, stagedBuilds } from './admission.mjs';
import { generateDeclarations, outputPaths, readBinary, writeDeclarations } from './generate-types.mjs';

const USAGE = 'Usage: node tools/cli/typecheck-tracks.mjs [--stable-binary <absolute claude.exe>] [--latest-binary <absolute claude.exe>]'
  + ' [--stage-root <absolute folder>]';
const require = createRequire(import.meta.url);

/** { binaries: { stable?, latest? }, stageRoot? }; each option once, each value an absolute path. */
export function parseArgs(args) {
  const binaries = {};
  let stageRoot;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1] ?? '';
    const match = /^--(stable|latest)-binary$/.exec(option);
    if (!path.isAbsolute(value)) fail(USAGE);
    if (match && !binaries[match[1]]) binaries[match[1]] = path.resolve(value);
    else if (option === '--stage-root' && stageRoot === undefined) stageRoot = path.resolve(value);
    else fail(USAGE);
  }
  return stageRoot === undefined ? { binaries } : { binaries, stageRoot };
}

/** The temporary configs: the node program swaps src/main/native/generated for mod-api.d.ts, the Mod program uses claude-code.d.ts. */
export function trackConfigs(projectRoot, directory) {
  const up = (relative) => path.relative(directory, path.join(projectRoot, relative)).replaceAll('\\', '/');
  return {
    node: { extends: up('tsconfig.node.json'), files: ['./mod-api.d.ts'],
      exclude: [`${up('src/main/native/generated')}/**`] },
    mod: { extends: up('native-mod/tsconfig.json'), include: [`${up('native-mod/hooks')}/**/*.ts`, `${up('native-mod/tests')}/**/*.ts`, './claude-code.d.ts'] },
  };
}

function tsc(projectRoot, config) {
  const packageFile = require.resolve('typescript/package.json', { paths: [projectRoot] });
  const metadata = require(packageFile);
  const bin = path.resolve(path.dirname(packageFile), typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.tsc);
  const result = spawnSync(process.execPath, [bin, '--noEmit', '--composite', 'false', '-p', config], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  return result.error ? 1 : result.status ?? 1;
}

/** The given binary of a track, else the staged one under the stage root (the default one unless `stageRoot` is set). */
export async function binaryFor(track, { given, stageRoot, env = process.env, admission = ADMISSION } = {}) {
  if (given) return given;
  const root = stageRoot ?? defaultStageRoot(env);
  const [stage] = await stagedBuilds(track, root, admission, { explicitRoot: Boolean(stageRoot) });
  if (!stage) {
    const shown = displayPath(root, env);
    fail(`No staged ${track} build under ${shown}. ${stageRoot ? `Run npm run cli:${track} -- --stage-root ${shown}`
      : `Run npm run cli:${track}, pass --stage-root <folder> if you staged it elsewhere,`} or pass --${track}-binary.`);
  }
  return stage.binary;
}

export async function typecheckTracks({ projectRoot = ROOT, binaries = {}, stageRoot, env = process.env, admission = ADMISSION, run = tsc, log = console.log,
  generate = generateDeclarations } = {}) {
  const results = [];
  const seen = new Set();
  for (const track of TRACKS) {
    const admitted = admittedBuild(track, admission);
    if (seen.has(admitted.version)) continue;
    seen.add(admitted.version);
    const directory = path.join(projectRoot, '.cache', 'types', admitted.version);
    const binary = await binaryFor(track, { given: binaries[track], stageRoot, env, admission });
    const generated = generate(await readBinary(binary), { expectedSha256: admitted.sha256, admission });
    await mkdir(directory, { recursive: true });
    await writeDeclarations(outputPaths(projectRoot, directory), generated);
    const configs = trackConfigs(projectRoot, directory);
    for (const [name, config] of Object.entries(configs)) await writeFile(path.join(directory, `tsconfig.${name}.json`), `${JSON.stringify(config, null, 2)}\n`);
    for (const name of Object.keys(configs)) {
      log(`Typechecking the ${name} program against ${track} ${admitted.version}...`);
      results.push({ track, version: admitted.version, program: name, status: run(projectRoot, path.join(directory, `tsconfig.${name}.json`)) });
    }
  }
  log('Typechecking the renderer program (it does not use the Mod declarations)...');
  results.push({ track: null, version: null, program: 'web', status: run(projectRoot, path.join(projectRoot, 'tsconfig.web.json')) });
  const failed = results.filter((result) => result.status !== 0);
  log(failed.length ? `Failed: ${failed.map((item) => `${item.program}${item.version ? ` (${item.track} ${item.version})` : ''}`).join(', ')}.`
    : `All programs typecheck for ${[...seen].join(' and ')}.`);
  return { results, ok: failed.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => typecheckTracks(parseArgs(process.argv.slice(2))))
    .then((result) => { if (!result.ok) process.exitCode = 1; })
    .catch((error) => { console.error(displayText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
}
