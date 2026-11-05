// Shared by the CLI tools: which official Claude Code builds this source admits, and where the project's CLI lives.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CLI_BUILDS, NATIVE_CLI_TRACKS } from '../../src/main/native/cliBuilds.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TRACKS = Object.freeze(['stable', 'latest']);
export const SDK_PLATFORM = 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64';
/** The @anthropic-ai/claude-agent-sdk version both hashes below were taken from; a test holds it to package-lock.json. */
export const SDK_VERSION = '0.3.302';
/** package.json of the locked @anthropic-ai/claude-agent-sdk-win32-x64 0.3.302; installing a CLI never rewrites it. */
export const SDK_METADATA_SHA256 = '032574deb6c8ffb19de3bf785624cb52b1155667fba362f3227ca3c4c486f283';
/** The claude.exe that npm ci installs with that SDK package (2.1.302, not admitted). */
export const SDK_BUNDLED_CLI_SHA256 = '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae';
export const INSTALL_RECORD = '.relay-cli.json';
export const STAGE_RECEIPT = 'stage-receipt.json';

/** The admitted builds and tracks from src/main/native/cliBuilds.ts; tests pass their own. */
export const ADMISSION = Object.freeze({ builds: NATIVE_CLI_BUILDS, tracks: NATIVE_CLI_TRACKS });

export const fail = (message) => { throw new Error(message); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function assertTrack(track) {
  if (!TRACKS.includes(track)) fail(`Unknown track ${JSON.stringify(track)}; use stable or latest.`);
  return track;
}

/** The admitted build of a track: { track, version, sha256, verification }. */
export function admittedBuild(track, admission = ADMISSION) {
  const info = admission.tracks[assertTrack(track)];
  const matches = admission.builds.filter((build) => build.version === info?.version);
  if (!info || matches.length !== 1) fail(`The ${track} track does not name exactly one admitted build.`);
  return { track, version: info.version, sha256: matches[0].sha256, verification: info.verification };
}

/** 'stable', 'latest' or 'unadmitted' for a binary's sha256; when both tracks name one version it is stable. */
export function trackOf(hash, admission = ADMISSION) {
  const build = typeof hash === 'string' ? admission.builds.find((item) => item.sha256 === hash.toLowerCase()) : undefined;
  if (!build) return 'unadmitted';
  return TRACKS.find((track) => admission.tracks[track]?.version === build.version) ?? 'unadmitted';
}

export function versionOf(hash, admission = ADMISSION) {
  return typeof hash === 'string' ? admission.builds.find((item) => item.sha256 === hash.toLowerCase())?.version : undefined;
}

export function installedCliPath(projectRoot = ROOT) {
  return path.join(projectRoot, ...SDK_PLATFORM.split('/'), 'claude.exe');
}

/** %LOCALAPPDATA%\relay-desk-dev\cli-stage: outside the repository, as the stager requires. */
export function defaultStageRoot(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local || !path.win32.isAbsolute(local)) fail('LOCALAPPDATA is not set; pass --stage-root <absolute folder>.');
  return path.join(local, 'relay-desk-dev', 'cli-stage');
}

/** A folder for printing: under %LOCALAPPDATA% or %USERPROFILE% it starts with the variable, so pasted output names no user. */
export function displayPath(target, env = process.env) {
  for (const name of ['LOCALAPPDATA', 'USERPROFILE']) {
    const base = env[name];
    if (!base || !path.win32.isAbsolute(base)) continue;
    const relative = path.win32.relative(base, target);
    if (relative === '') return `%${name}%`;
    if (relative.split('\\')[0] !== '..' && !path.win32.isAbsolute(relative)) return `%${name}%\\${relative}`;
  }
  return target;
}

/** A message for printing: every path under %LOCALAPPDATA% or %USERPROFILE% is shown by its variable, as displayPath does. */
export function displayText(text, env = process.env) {
  let result = String(text);
  for (const name of ['LOCALAPPDATA', 'USERPROFILE']) {
    const base = env[name];
    if (!base || !path.win32.isAbsolute(base)) continue;
    const trimmed = base.replace(/[\\/]+$/, '');
    const pattern = new RegExp(`${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi');
    result = result.replace(pattern, `%${name}%`);
  }
  return result;
}

/** A directory or file that is not a link, a junction, a redirected parent or (for files) a hard link. */
export async function assertPhysical(target, kind) {
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') fail(`Missing ${target}.`); throw error; }
  if (info.isSymbolicLink()) fail(`${target} is a link or junction; it must be a physical ${kind}.`);
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) fail(`${target} is not a ${kind}.`);
  if ((await realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()) fail(`${target} is reached through a redirected directory.`);
  if (kind === 'file' && info.nlink !== 1) fail(`${target} is a hard-linked file; refusing to use it.`);
  return info;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The command that stages `track` (by exact version with `exact`); a stage root the user gave is part of it, since the same stage is not found without it. */
export function stagingCommand(track, exact, stageRoot, explicitRoot) {
  const flags = [...exact ? ['--exact'] : [], ...explicitRoot ? ['--stage-root', /\s/.test(stageRoot) ? `"${stageRoot}"` : stageRoot] : []];
  return `npm run cli:${track}${flags.length ? ` -- ${flags.join(' ')}` : ''}`;
}

/**
 * The stage receipt in `bytes`; one that is cut short or damaged names its file and the folder, and says what to rerun.
 * `why` is the reason a receipt that could not be read at all gives.
 */
function parseReceipt(bytes, directory, command, why) {
  const file = path.join(directory, STAGE_RECEIPT);
  const unreadable = (reason) => fail(`${file} cannot be read (${reason}). Stage folder: ${directory}. Delete it, then rerun the command that staged it (${command}).`);
  if (why !== undefined) return unreadable(why);
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch (error) { return unreadable(error.message); }
  return receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : unreadable('it is not a JSON object');
}

/**
 * Staged folders of an admitted track build under a stage root, newest selection first: the track's own stage, then one
 * staged by exact version. Each entry has the receipt; nothing here re-hashes the binary. `explicitRoot` says the user
 * named the stage root, so that the advice for an unreadable receipt repeats it.
 */
export async function stagedBuilds(track, stageRoot, admission = ADMISSION, { explicitRoot = false } = {}) {
  const admitted = admittedBuild(track, admission);
  const found = [];
  for (const selection of [track, 'exact']) {
    const directory = path.join(stageRoot, `claude-code-${admitted.version}-${selection}`);
    const command = stagingCommand(track, selection === 'exact', stageRoot, explicitRoot);
    let receiptBytes, why;
    try { receiptBytes = await readFile(path.join(directory, STAGE_RECEIPT)); }
    catch (error) { if (error.code === 'ENOENT') continue; why = error.message; }
    const receipt = parseReceipt(receiptBytes, directory, command, why);
    if (receipt.binary?.relativePath !== 'extracted/package/claude.exe') fail(`${directory}: the stage receipt names an unexpected binary path.`);
    found.push({ directory, receipt, receiptSha256: sha256(receiptBytes), binary: path.join(directory, 'extracted', 'package', 'claude.exe') });
  }
  return found;
}
