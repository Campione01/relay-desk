// Stages the official Claude Code CLI of a track from registry.npmjs.org and installs it as the project's CLI.
//
//   node tools/cli/official-cli.mjs use <stable|latest> [--exact] [--stage-root <absolute folder>]
//   node tools/cli/official-cli.mjs install <stable|latest> [--stage-root <absolute folder>]
//   node tools/cli/official-cli.mjs status [--stage-root <absolute folder>]
//
// "use" stages (downloads with the integrity checks of tools/native-cli-maintenance/stage-official.mjs) and installs.
// "install" is offline, from an existing stage. Only the build this source admits for the track is installed; the CLI
// is never run. A failed "use" can simply be rerun: it replaces the incomplete stage an earlier run left, and every
// clone reuses a complete stage under the shared stage root. See docs/CLI-TRACKS.md.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataStep, stageOfficial, writeAtomic } from '../native-cli-maintenance/stage-official.mjs';
import { checkOfficialUpdate } from '../native-cli-maintenance/update-check.mjs';
import {
  ADMISSION, INSTALL_RECORD, ROOT, SDK_BUNDLED_CLI_SHA256, SDK_METADATA_SHA256, SDK_PLATFORM, SDK_VERSION, STAGE_RECEIPT, TRACKS,
  admittedBuild, assertPhysical, assertTrack, defaultStageRoot, displayPath, displayText, fail, installedCliPath, readJson, sha256,
  sha256File, stagedBuilds, trackOf, versionOf,
} from './admission.mjs';

export { displayPath, displayText };

const USAGE = 'Usage: node tools/cli/official-cli.mjs use <stable|latest> [--exact] [--stage-root <absolute folder>]'
  + ' | install <stable|latest> [--stage-root <absolute folder>] | status [--stage-root <absolute folder>]';

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['use', 'install', 'status'].includes(command)) fail(USAGE);
  const options = { command, exact: false };
  if (command !== 'status') {
    if (!TRACKS.includes(rest[0])) fail(USAGE);
    options.track = rest.shift();
  }
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (seen.has(option)) fail(USAGE);
    seen.add(option);
    if (option === '--exact' && command === 'use') options.exact = true;
    else if (option === '--stage-root' && index + 1 < rest.length && path.isAbsolute(rest[index + 1])) options.stageRoot = path.resolve(rest[++index]);
    else fail(USAGE);
  }
  return options;
}

export const trackMismatch = (track, observed, admitted) =>
  `npm ${track} is ${observed}; this source admits ${admitted}. Run npm run cli:${track} -- --exact.`;

/**
 * Stages the admitted build of a track; a moved npm tag stops before any download unless `exact` is set. `limits`
 * overrides the stager's download limits (tests only).
 */
export async function stageTrack({ track, exact = false, stageRoot, fetchImpl, admission = ADMISSION, limits }) {
  const admitted = admittedBuild(assertTrack(track), admission);
  if (typeof fetchImpl !== 'function') fail('Staging needs network access to registry.npmjs.org.');
  if (typeof stageRoot !== 'string' || !path.isAbsolute(stageRoot)) fail('The stage root must be an absolute folder.');
  if (!exact) {
    const tag = await metadataStep(`the npm ${track} tag`, () => checkOfficialUpdate({ channel: track, fetchImpl, baselineVersion: admitted.version }));
    if (tag.observedVersion !== admitted.version) fail(trackMismatch(track, tag.observedVersion, admitted.version));
  }
  await mkdir(stageRoot, { recursive: true });
  const receipt = await stageOfficial({ fetchImpl, stageRoot, selection: exact ? { version: admitted.version } : { channel: track }, ...(limits ? { limits } : {}) });
  if (receipt.version !== admitted.version) fail(trackMismatch(track, receipt.version, admitted.version));
  const binary = path.join(receipt.stageDirectory, 'extracted', 'package', 'claude.exe');
  const hash = await sha256File(binary);
  if (receipt.binary?.sha256 !== admitted.sha256 || hash !== admitted.sha256) {
    fail(`The staged ${track} build ${receipt.version} has sha256 ${hash}; this source admits ${admitted.sha256} for it. Nothing was installed.`);
  }
  return { directory: receipt.stageDirectory, binary, version: receipt.version,
    receiptSha256: sha256(await readFile(path.join(receipt.stageDirectory, STAGE_RECEIPT))), reused: Boolean(receipt.reused), retired: Boolean(receipt.retired) };
}

/** An existing stage of the admitted track build whose binary still hashes to the admitted sha256. `explicitRoot` says the user named `stageRoot`. */
export async function findStaged({ track, stageRoot, admission = ADMISSION, explicitRoot = false }) {
  const admitted = admittedBuild(assertTrack(track), admission);
  for (const stage of await stagedBuilds(track, stageRoot, admission, { explicitRoot })) {
    if (stage.receipt.version !== admitted.version || stage.receipt.binary?.sha256 !== admitted.sha256) continue;
    let hash;
    try { hash = await sha256File(stage.binary); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (hash === admitted.sha256) return { directory: stage.directory, binary: stage.binary, version: admitted.version, receiptSha256: stage.receiptSha256 };
  }
  return fail(`No staged ${track} build ${admitted.version} with the admitted sha256 under ${displayPath(stageRoot)}. Run npm run cli:${track}.`);
}

async function physicalPlatform(root) {
  const nodeModules = path.join(root, 'node_modules');
  const platform = path.join(root, ...SDK_PLATFORM.split('/'));
  for (const directory of [root, nodeModules, path.dirname(platform), platform]) await assertPhysical(directory, 'directory');
  const target = path.join(platform, 'claude.exe'), metadata = path.join(platform, 'package.json');
  await assertPhysical(target, 'file');
  await assertPhysical(metadata, 'file');
  return { target, metadata };
}

/** Removes the copy that an install stopped before its rename left behind; anything else of that name is refused. */
async function removeStaleCopy(file) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile()) fail(`${file} is not the copy an earlier install left; remove it by hand, then rerun.`);
  await unlink(file);
  return true;
}

/**
 * Copies a staged admitted claude.exe over the SDK platform package's binary. node_modules and the target must be
 * physical, the SDK metadata must be the locked file, and the binary being replaced must be the SDK's own or admitted.
 * `io` replaces the copy and the rename (tests only).
 */
export async function installCli({ projectRoot = ROOT, track, stage, admission = ADMISSION,
  sdkMetadataSha256 = SDK_METADATA_SHA256, bundledSha256 = SDK_BUNDLED_CLI_SHA256, io = { copyFile, rename } }) {
  const admitted = admittedBuild(assertTrack(track), admission);
  const root = path.resolve(projectRoot);
  const { target, metadata } = await physicalPlatform(root);
  if (await sha256File(metadata) !== sdkMetadataSha256) {
    fail(`${metadata} is not the locked SDK platform metadata (@anthropic-ai/claude-agent-sdk-win32-x64 ${SDK_VERSION}); run npm ci first.`);
  }
  const temporary = `${target}.relay-new`;
  const staleCopyRemoved = await removeStaleCopy(temporary);
  const before = await sha256File(target);
  if (before !== bundledSha256 && trackOf(before, admission) === 'unadmitted') {
    fail(`Refusing to replace an unrecognized claude.exe (sha256 ${before}): it is neither the build npm ci installs nor one this source `
      + `admits (an earlier version of this source may have admitted it). Run npm ci to restore the SDK's own binary, then npm run cli:${track}.`);
  }
  await assertPhysical(stage.binary, 'file');
  const staged = await sha256File(stage.binary);
  if (staged !== admitted.sha256) fail(`The staged binary has sha256 ${staged}; this source admits ${admitted.sha256} for ${track}.`);
  let copied = false;
  if (before !== admitted.sha256) {
    try {
      await io.copyFile(stage.binary, temporary, constants.COPYFILE_EXCL);
      if (await sha256File(temporary) !== admitted.sha256) fail('The copied claude.exe differs from the staged one; nothing was installed.');
      await physicalPlatform(root);
      await io.rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      if (error.code === 'EPERM' || error.code === 'EBUSY') fail('claude.exe is in use; close Relay Desk and any running Claude Code, then retry.');
      throw error;
    }
    copied = true;
  }
  const after = await sha256File(target);
  if (after !== admitted.sha256) fail(`claude.exe has sha256 ${after} after the install; expected ${admitted.sha256}.`);
  if (await sha256File(metadata) !== sdkMetadataSha256) fail(`${metadata} changed during the install.`);
  const record = { track, version: admitted.version, sha256: admitted.sha256, stageReceiptSha256: stage.receiptSha256 };
  await writeAtomic(path.join(root, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`, { replace: true });
  return { ...record, beforeSha256: before, copied, staleCopyRemoved };
}

/** The record of the last install, or null before the first. One that is cut short or damaged names its file and says how to write it again. */
async function readInstallRecord(root) {
  const file = path.join(root, INSTALL_RECORD);
  const unreadable = (why) => fail(`${file} cannot be read (${why}). Delete it, then rerun npm run cli:stable or npm run cli:latest, whichever you use, to write it again.`);
  let record;
  try { record = await readJson(file); } catch (error) { return error.code === 'ENOENT' ? null : unreadable(error.message); }
  return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : unreadable('it is not a JSON object');
}

/** The installed CLI's track and the staged state of every track. `explicitRoot` says the user named `stageRoot`. */
export async function cliStatus({ projectRoot = ROOT, stageRoot, admission = ADMISSION, bundledSha256 = SDK_BUNDLED_CLI_SHA256, explicitRoot = false } = {}) {
  const root = path.resolve(projectRoot);
  let installed = null;
  try {
    const hash = await sha256File(installedCliPath(root));
    installed = { sha256: hash, track: trackOf(hash, admission), version: versionOf(hash, admission) ?? null, sdkBundled: hash === bundledSha256 };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = await readInstallRecord(root);
  const tracks = [];
  for (const track of TRACKS) {
    const admitted = admittedBuild(track, admission);
    const staged = stageRoot ? (await stagedBuilds(track, stageRoot, admission, { explicitRoot }))
      .filter((stage) => stage.receipt.version === admitted.version && stage.receipt.binary?.sha256 === admitted.sha256)
      .map((stage) => stage.directory) : [];
    tracks.push({ ...admitted, staged });
  }
  return { installed, record, stageRoot: stageRoot ?? null, tracks };
}

const VERIFICATION = { 'real-account-and-isolated': 'maintainer real-account use plus isolated acceptance', 'isolated-only': 'isolated acceptance only' };

export function formatStatus(status, { env = process.env } = {}) {
  const shown = (folder) => displayPath(folder, env);
  const lines = [];
  const { installed } = status;
  if (!installed) lines.push('Installed CLI: none (run npm ci, then npm run cli:stable).');
  else if (installed.track === 'unadmitted') {
    lines.push(`Installed CLI: unadmitted${installed.sdkBundled ? ' (the SDK\'s bundled build)' : ''}, sha256 ${installed.sha256}.`);
    lines.push('  Relay Desk runs it with its dialog automation off. Run npm run cli:stable or npm run cli:latest.');
  } else lines.push(`Installed CLI: ${installed.version} (${installed.track}), sha256 ${installed.sha256}.`);
  if (installed && status.record && status.record.sha256 !== installed.sha256) lines.push(`  ${INSTALL_RECORD} names ${status.record.version}; the binary has changed since.`);
  lines.push(`Tracks admitted by this source${status.stageRoot ? ` (stage root ${shown(status.stageRoot)})` : ''}:`);
  for (const track of status.tracks) {
    lines.push(`  ${track.track.padEnd(6)} ${track.version}  ${VERIFICATION[track.verification] ?? track.verification}; ${track.staged.length ? `staged in ${track.staged.map(shown).join(', ')}` : 'not staged'}`);
  }
  return lines.join('\n');
}

export async function runCli(args, { fetchImpl = globalThis.fetch, env = process.env, projectRoot = ROOT, admission = ADMISSION, log = console.log,
  sdkMetadataSha256 = SDK_METADATA_SHA256, bundledSha256 = SDK_BUNDLED_CLI_SHA256, limits } = {}) {
  const options = parseArgs(args);
  if (options.command === 'status') {
    let stageRoot = options.stageRoot;
    if (!stageRoot) { try { stageRoot = defaultStageRoot(env); } catch { stageRoot = undefined; } }
    const status = await cliStatus({ projectRoot, stageRoot, admission, bundledSha256, explicitRoot: Boolean(options.stageRoot) });
    log(formatStatus(status, { env }));
    return status;
  }
  const stageRoot = options.stageRoot ?? defaultStageRoot(env);
  const stage = options.command === 'use'
    ? await stageTrack({ track: options.track, exact: options.exact, stageRoot, fetchImpl, admission, limits })
    : await findStaged({ track: options.track, stageRoot, admission, explicitRoot: Boolean(options.stageRoot) });
  if (stage.retired) log(`Replaced an incomplete stage that an earlier run left in ${displayPath(stage.directory, env)}.`);
  const result = await installCli({ projectRoot, track: options.track, stage, admission, sdkMetadataSha256, bundledSha256 });
  if (result.staleCopyRemoved) log('Removed a claude.exe.relay-new that an interrupted install left in the SDK package folder.');
  log(`${result.copied ? 'Installed' : 'Already installed:'} Claude Code ${result.version} (${result.track}) from ${displayPath(stage.directory, env)}.`);
  log('Run npm run build to regenerate the Mod declarations for this build.');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => { console.error(displayText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
}
