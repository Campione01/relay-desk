// Generates the Mod API declarations from the installed official CLI (or --binary), offline and without running it.
//
//   node tools/cli/generate-types.mjs [--binary <absolute claude.exe> [--expected-sha256 <hex>]] [--out-dir <absolute folder>]
//   node tools/cli/generate-types.mjs --check [--out-dir <absolute folder>]
//
// The binary must be a build this source admits (src/main/native/cliBuilds.ts). The CLI embeds its declarations; they
// are extracted (extract-contract.mjs) and projected for the host typecheck (project-contract.mjs). Outputs are
// native-mod/types/claude-code.d.ts, src/main/native/generated/mod-api.d.ts and native-mod/types/generated.json, or
// claude-code.d.ts, mod-api.d.ts and generated.json in --out-dir. They are Anthropic's text: never commit them.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContract } from '../native-cli-maintenance/extract-contract.mjs';
import { projectContract } from '../native-cli-maintenance/project-contract.mjs';
import { ADMISSION, ROOT, fail, installedCliPath, sha256, sha256File, trackOf, versionOf } from './admission.mjs';

const USAGE = 'Usage: node tools/cli/generate-types.mjs [--binary <absolute claude.exe> [--expected-sha256 <hex>]] [--check] [--out-dir <absolute folder>]';
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const SIDECAR_KEYS = ['cliVersion', 'cliSha256', 'track', 'contractSha256', 'hostSha256', 'parserVersion'];

export function outputPaths(projectRoot = ROOT, outDir) {
  if (outDir) return { contract: path.join(outDir, 'claude-code.d.ts'), host: path.join(outDir, 'mod-api.d.ts'), sidecar: path.join(outDir, 'generated.json') };
  return {
    contract: path.join(projectRoot, 'native-mod', 'types', 'claude-code.d.ts'),
    host: path.join(projectRoot, 'src', 'main', 'native', 'generated', 'mod-api.d.ts'),
    sidecar: path.join(projectRoot, 'native-mod', 'types', 'generated.json'),
  };
}

export function parseArgs(args) {
  const options = { check: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) fail(USAGE);
    seen.add(option);
    if (option === '--check') options.check = true;
    else if ((option === '--binary' || option === '--out-dir') && index + 1 < args.length && path.isAbsolute(args[index + 1])) {
      options[option === '--binary' ? 'binary' : 'outDir'] = path.resolve(args[++index]);
    } else if (option === '--expected-sha256' && /^[0-9a-f]{64}$/i.test(args[index + 1] ?? '')) options.expectedSha256 = args[++index].toLowerCase();
    else fail(USAGE);
  }
  if (options.expectedSha256 && !options.binary) fail(USAGE);
  if (options.check && options.binary) fail(USAGE);
  return options;
}

/** Declarations of an admitted binary: { contract, host, sidecar }. Refuses any other build. */
export function generateDeclarations(binaryBytes, { expectedSha256, admission = ADMISSION, extract = extractContract, project = projectContract } = {}) {
  const cliSha256 = sha256(binaryBytes);
  if (expectedSha256 !== undefined && cliSha256 !== expectedSha256.toLowerCase()) fail(`The binary has sha256 ${cliSha256}, not the expected ${expectedSha256}.`);
  const track = trackOf(cliSha256, admission);
  if (track === 'unadmitted') fail(`claude.exe (sha256 ${cliSha256}) is not a build this source admits. Run npm run cli:stable or npm run cli:latest.`);
  const extracted = extract(binaryBytes);
  const projected = project(extracted.bytes);
  const contract = Buffer.from(extracted.bytes), host = Buffer.from(projected.bytes);
  const sidecar = { cliVersion: versionOf(cliSha256, admission), cliSha256, track, contractSha256: sha256(contract), hostSha256: sha256(host),
    parserVersion: extracted.report.parser.version };
  return { contract, host, sidecar };
}

async function writeIfChanged(file, bytes) {
  try { if ((await readFile(file)).equals(bytes)) return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return true;
}

/** Writes both declarations, then the sidecar that describes them. */
export async function writeDeclarations(paths, result) {
  const written = [];
  if (await writeIfChanged(paths.contract, result.contract)) written.push(paths.contract);
  if (await writeIfChanged(paths.host, result.host)) written.push(paths.host);
  if (await writeIfChanged(paths.sidecar, Buffer.from(`${JSON.stringify(result.sidecar, null, 2)}\n`))) written.push(paths.sidecar);
  return written;
}

/** The sidecar must describe both files and name an admitted build; a different installed build is only a warning. */
export async function checkDeclarations(paths, { admission = ADMISSION, installedSha256 } = {}) {
  let sidecar;
  try { sidecar = JSON.parse(await readFile(paths.sidecar, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') fail('The generated Mod declarations are missing. Run npm run types:generate.'); throw error; }
  if (!sidecar || typeof sidecar !== 'object' || JSON.stringify(Object.keys(sidecar).sort()) !== JSON.stringify([...SIDECAR_KEYS].sort())) {
    fail(`${paths.sidecar} is not a declaration sidecar. Run npm run types:generate.`);
  }
  const track = trackOf(sidecar.cliSha256, admission);
  if (track === 'unadmitted' || track !== sidecar.track || versionOf(sidecar.cliSha256, admission) !== sidecar.cliVersion) {
    fail(`The declarations were generated from a build this source does not admit as ${sidecar.track} ${sidecar.cliVersion}. Run npm run types:generate.`);
  }
  for (const [key, file] of [['contractSha256', paths.contract], ['hostSha256', paths.host]]) {
    let hash;
    try { hash = sha256(await readFile(file)); }
    catch (error) { if (error.code === 'ENOENT') fail(`${file} is missing. Run npm run types:generate.`); throw error; }
    if (hash !== sidecar[key]) fail(`${file} does not match ${path.basename(paths.sidecar)}. Run npm run types:generate.`);
  }
  const warnings = [];
  if (installedSha256 !== undefined && installedSha256 !== sidecar.cliSha256) {
    const installedTrack = trackOf(installedSha256, admission);
    warnings.push(`The installed CLI (${installedTrack === 'unadmitted' ? 'unadmitted' : `${versionOf(installedSha256, admission)} ${installedTrack}`}) is not `
      + `${sidecar.cliVersion} (${sidecar.track}), which the declarations describe. Run npm run types:generate after switching tracks.`);
  }
  return { sidecar, warnings };
}

export async function readBinary(file) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') fail(`${file} does not exist. Run npm ci, then npm run cli:stable.`);
    throw error;
  });
  if (!info.isFile() || info.size > MAX_BINARY_BYTES) fail(`${file} must be a regular file of at most 512 MiB.`);
  return readFile(file);
}

export async function runCli(args, { projectRoot = ROOT, admission = ADMISSION, log = console.log, warn = console.warn } = {}) {
  const options = parseArgs(args);
  const paths = outputPaths(projectRoot, options.outDir);
  if (options.check) {
    let installedSha256;
    try { installedSha256 = await sha256File(installedCliPath(projectRoot)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { sidecar, warnings } = await checkDeclarations(paths, { admission, installedSha256 });
    for (const warning of warnings) warn(`Warning: ${warning}`);
    log(`Mod declarations match Claude Code ${sidecar.cliVersion} (${sidecar.track}).`);
    return { sidecar, warnings };
  }
  const binary = options.binary ?? installedCliPath(projectRoot);
  const result = generateDeclarations(await readBinary(binary), { expectedSha256: options.expectedSha256, admission });
  const written = await writeDeclarations(paths, result);
  log(`Mod declarations for Claude Code ${result.sidecar.cliVersion} (${result.sidecar.track}): ${written.length ? `wrote ${written.length} file(s)` : 'unchanged'}.`);
  return { ...result, paths, written };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
