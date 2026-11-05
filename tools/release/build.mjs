// Builds Relay Desk from source on Windows x64.
//
//   node tools/release/build.mjs                  full build (needs an admitted CLI: npm run cli:stable)
//   node tools/release/build.mjs --helpers-only   the C# helpers the app runs
//   node tools/release/build.mjs --test-helpers   those helpers plus the test-only ones; no CLI needed
//
// The helpers are compiled with the .NET Framework csc.exe that ships with Windows. Nothing is downloaded.
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMISSION, ROOT, installedCliPath, sha256File, trackOf, versionOf } from '../cli/admission.mjs';
import { runCli as generateTypes } from '../cli/generate-types.mjs';

const require = createRequire(import.meta.url);
const USAGE = 'Usage: node tools/release/build.mjs [--helpers-only | --test-helpers]';
const FIXTURE_ENV = ['RELAY_DESK_NATIVE_PROTOTYPE', 'RELAY_NATIVE_FIXTURE_URL', 'RELAY_NATIVE_DENY_PROXY'];

/** [script, ...arguments] per mode. NativeConsoleFixture and OwnedMcpJob only serve the tests. */
export const HELPERS = Object.freeze({
  app: Object.freeze([['tools/native/build-helper.ps1'], ['tools/private-storage/build-helper.ps1'], ['tools/auth/build-host.ps1']]),
  test: Object.freeze([['tools/native/build-helper.ps1', '-IncludeFixture'], ['tools/private-storage/build-helper.ps1'], ['tools/auth/build-host.ps1'],
    ['tools/native-mcp-facade/build-helper.ps1']]),
});

export function buildMode(args) {
  if (args.length === 0) return 'full';
  if (args.length === 1 && args[0] === '--helpers-only') return 'helpers';
  if (args.length === 1 && args[0] === '--test-helpers') return 'test-helpers';
  throw new Error(USAGE);
}

export function assertBuildHost({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Relay Desk builds require Windows x64.');
  for (const key of FIXTURE_ENV) if (env[key] !== undefined) throw new Error(`Normal Relay builds must not inherit ${key}.`);
}

/** The installed project CLI must be a build this source admits; the SDK's bundled build is not. */
export async function assertAdmittedCli(projectRoot = ROOT, admission = ADMISSION) {
  let hash;
  try { hash = await sha256File(installedCliPath(projectRoot)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No Claude Code CLI is installed in node_modules. Run npm ci, then npm run cli:stable.'); throw error; }
  const track = trackOf(hash, admission);
  if (track === 'unadmitted') throw new Error(`The installed Claude Code CLI (sha256 ${hash}) is not a build this source admits. Run npm run cli:stable.`);
  return { track, version: versionOf(hash, admission), sha256: hash };
}

export const PDF_TOOLS_ENV = 'RELAY_DESK_PDF_TOOLS_DIR';

/**
 * The PDF tools folder the built app reads, as src/main/native/pdfSelection.ts resolves it: RELAY_DESK_PDF_TOOLS_DIR when
 * set (undefined unless it is a local absolute path, as the app then has no PDF tools), else resources/pdf-tools.
 */
export function pdfToolsDir(projectRoot = ROOT, env = process.env) {
  const configured = env[PDF_TOOLS_ENV];
  if (configured === undefined || configured === '') return { source: 'resources/pdf-tools', root: path.join(projectRoot, 'resources', 'pdf-tools') };
  if (!path.win32.isAbsolute(configured) || /^[\\/]{2}/.test(configured)) return { source: PDF_TOOLS_ENV, root: undefined };
  return { source: PDF_TOOLS_ENV, root: configured };
}

/** PDF tools are optional: verified when the folder the app reads holds receipt.json, otherwise reported as disabled. */
export async function checkPdfTools(projectRoot = ROOT, env = process.env) {
  const { source, root } = pdfToolsDir(projectRoot, env);
  if (!root) return { enabled: false, source, invalid: true };
  let receipt;
  try { receipt = JSON.parse(await readFile(path.join(root, 'receipt.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, source }; throw error; }
  const { verifyNativePdfResources } = await import('../../src/main/native/pdfResources.ts');
  verifyNativePdfResources(root, receipt);
  return { enabled: true, source, files: receipt.files.length };
}

/** electron-builder.yml packages no PDF tools, and a packaged app ignores RELAY_DESK_PDF_TOOLS_DIR. */
export const PACKAGED_PDF_NOTE = `Packaged builds (npm run dist) include no PDF tools and ignore ${PDF_TOOLS_ENV}, so they refuse PDF attachments.`;

export function describePdfTools(pdf) {
  if (pdf.enabled) return `PDF attachments are enabled for npm start: ${pdf.files} files in the ${pdf.source} folder verified. ${PACKAGED_PDF_NOTE}`;
  if (pdf.invalid) return `PDF attachments are disabled: ${PDF_TOOLS_ENV} is not a local absolute path (see BUILD.md).`;
  return `PDF attachments are disabled: the ${pdf.source} folder has no receipt.json (optional; see BUILD.md).`;
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, windowsHide: true, shell: false, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Build step failed: ${path.basename(executable)} ${args.slice(-2).join(' ')} (${result.status ?? result.error?.code})`);
}

function packageBin(projectRoot, name, bin, args) {
  const packageFile = require.resolve(`${name}/package.json`, { paths: [projectRoot] });
  const metadata = require(packageFile);
  const relative = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin[bin];
  run(process.execPath, [path.resolve(path.dirname(packageFile), relative), ...args], projectRoot);
}

export function buildHelpers(projectRoot, list) {
  for (const [script, ...args] of list) {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, script), ...args], projectRoot);
  }
}

export async function build(args, { projectRoot = ROOT, log = console.log, admission = ADMISSION, env = process.env } = {}) {
  const mode = buildMode(args);
  assertBuildHost({ env });
  if (mode !== 'full') {
    buildHelpers(projectRoot, mode === 'test-helpers' ? HELPERS.test : HELPERS.app);
    log(mode === 'test-helpers' ? 'Built the app and test helpers.' : 'Built the app helpers.');
    return { mode };
  }
  const cli = await assertAdmittedCli(projectRoot, admission);
  log(`Claude Code ${cli.version} (${cli.track}) is installed.`);
  await generateTypes([], { projectRoot, log, admission });
  buildHelpers(projectRoot, HELPERS.app);
  packageBin(projectRoot, 'typescript', 'tsc', ['--noEmit', '-p', 'native-mod/tsconfig.json']);
  packageBin(projectRoot, 'electron-vite', 'electron-vite', ['build']);
  if (!(await stat(path.join(projectRoot, 'out/main/index.js'))).isFile()) throw new Error('electron-vite did not build out/main/index.js.');
  const bootstrap = path.join(projectRoot, 'tools/release/bootstrap.mjs'), entry = path.join(projectRoot, 'out/main/nativeProduction.js');
  await copyFile(bootstrap, entry);
  if (!(await readFile(bootstrap)).equals(await readFile(entry))) throw new Error('The bootstrap copy changed bytes.');
  const pdf = await checkPdfTools(projectRoot, env);
  log(describePdfTools(pdf));
  log(`Built Relay Desk for Claude Code ${cli.version} (${cli.track}). Start it with npm start.`);
  return { mode, cli, pdf };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
