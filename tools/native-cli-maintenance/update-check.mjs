import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@anthropic-ai/claude-code';
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags';
export const CHECK_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 65536;
const VERSION_URL = 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/';
const DEFAULT_BASELINE = '2.1.302';
const USAGE = 'Usage: node tools/native-cli-maintenance/update-check.mjs [--online] [--channel latest|stable] [--baseline-version <major.minor.patch>]';

const failure = (code, message) => Object.assign(new Error(message), { code });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function versionParts(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw failure('INVALID_VERSION', 'Version must be an exact numeric stable major.minor.patch; prereleases, ranges and prefixes are not selected.');
  }
  return value.split('.').map((part) => BigInt(part));
}

export function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validIntegrity(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length === { sha256: 32, sha384: 48, sha512: 64 }[match[1]] && bytes.toString('base64') === match[2];
}

async function fetchJson(fetchImpl, url, signal) {
  signal.throwIfAborted();
  const response = await fetchImpl(url, {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', credentials: 'omit', signal,
  });
  signal.throwIfAborted();
  if (response.redirected || response.status >= 300 && response.status < 400) {
    throw failure('METADATA_REDIRECT', 'Official npm metadata redirects are not followed.');
  }
  if (response.url !== url) throw failure('OFF_SOURCE_METADATA', 'Metadata response URL differs from the fixed official npm source.');
  if (response.status !== 200) throw failure('METADATA_HTTP_ERROR', `Official npm metadata returned HTTP ${response.status}.`);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw failure('INVALID_METADATA', 'Official npm metadata response is not application/json.');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(MAX_RESPONSE_BYTES))) {
    throw failure('METADATA_TOO_LARGE', `Official npm metadata response exceeds the ${MAX_RESPONSE_BYTES}-byte limit or has an invalid length.`);
  }
  if (!response.body) throw failure('INVALID_METADATA', 'Official npm metadata response has no body.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw failure('METADATA_TOO_LARGE', `Official npm metadata response exceeds the ${MAX_RESPONSE_BYTES}-byte limit.`);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(value)) throw new Error('Expected an object.');
    return value;
  } catch {
    throw failure('INVALID_METADATA', 'Official npm metadata body must be a valid JSON object.');
  }
}

// Calling without an explicitly supplied fetch implementation is offline, including from other tools.
export async function checkOfficialUpdate({ baselineVersion = DEFAULT_BASELINE, channel = 'latest', fetchImpl } = {}) {
  versionParts(baselineVersion);
  if (channel !== 'latest' && channel !== 'stable') throw failure('INVALID_CHANNEL', 'Channel must be exactly latest or stable.');
  const report = {
    schemaVersion: 1, status: 'offline', metadataOnly: true, packageName: PACKAGE_NAME, baselineVersion, channel,
    observedVersion: null, comparison: null, dist: null,
    provenance: { source: 'official-npm-package-metadata', distTagsUrl: DIST_TAGS_URL, versionMetadataUrl: null, artifactVerified: false },
    admissionApproved: false, installed: false,
  };
  if (fetchImpl === undefined) return report;
  if (typeof fetchImpl !== 'function') throw failure('INVALID_FETCH', 'An explicit fetch implementation must be a function.');
  const controller = new AbortController(); let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(failure('METADATA_TIMEOUT', `Official npm metadata check exceeded ${CHECK_TIMEOUT_MS} ms.`));
      controller.abort();
    }, CHECK_TIMEOUT_MS);
  });
  async function observe() {
    const tags = await fetchJson(fetchImpl, DIST_TAGS_URL, controller.signal);
    if (!Object.hasOwn(tags, channel)) throw failure('MISSING_CHANNEL', `Official npm metadata does not contain the requested ${channel} dist-tag; no fallback was selected.`);
    const observedVersion = tags[channel]; versionParts(observedVersion);
    const versionMetadataUrl = `${VERSION_URL}${observedVersion}`;
    const metadata = await fetchJson(fetchImpl, versionMetadataUrl, controller.signal);
    if (metadata.name !== PACKAGE_NAME || metadata.version !== observedVersion) {
      throw failure('PACKAGE_IDENTITY_MISMATCH', 'Official npm version metadata does not match the selected package and exact dist-tag version.');
    }
    const expectedTarball = `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${observedVersion}.tgz`;
    if (!object(metadata.dist) || metadata.dist.tarball !== expectedTarball || !validIntegrity(metadata.dist.integrity)
      || metadata.dist.shasum !== undefined && (typeof metadata.dist.shasum !== 'string'
        || metadata.dist.shasum.length !== 40 || !/^[a-f0-9]{40}$/.test(metadata.dist.shasum))) {
      throw failure('INVALID_DIST_METADATA', 'Package dist metadata needs the exact official versioned npm tarball URL and a valid integrity digest.');
    }
    const comparison = compareVersions(observedVersion, baselineVersion);
    return {
      ...report, status: 'observed', observedVersion, comparison: comparison > 0 ? 'newer' : comparison < 0 ? 'older' : 'same',
      dist: { tarball: metadata.dist.tarball, integrity: metadata.dist.integrity, shasum: metadata.dist.shasum ?? null },
      provenance: { ...report.provenance, versionMetadataUrl },
    };
  }
  try {
    return await Promise.race([observe(), timeout]);
  } catch (error) {
    if (error?.code && ['INVALID_VERSION', 'MISSING_CHANNEL', 'METADATA_REDIRECT', 'OFF_SOURCE_METADATA', 'METADATA_HTTP_ERROR',
      'INVALID_METADATA', 'METADATA_TOO_LARGE', 'PACKAGE_IDENTITY_MISMATCH', 'INVALID_DIST_METADATA', 'METADATA_TIMEOUT'].includes(error.code)) throw error;
    throw Object.assign(failure('METADATA_REQUEST_FAILED', 'Official npm metadata request failed; no retry or alternate source was attempted.'), { cause: error });
  } finally {
    clearTimeout(timer); controller.abort();
  }
}

export async function runCli(args, { fetchImpl = globalThis.fetch, writeOutput = console.log } = {}) {
  const options = {}; const seen = new Set(); let online = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw failure('INVALID_ARGUMENTS', USAGE);
    seen.add(option);
    if (option === '--online') online = true;
    else if ((option === '--channel' || option === '--baseline-version') && index + 1 < args.length) {
      options[option === '--channel' ? 'channel' : 'baselineVersion'] = args[++index];
    } else throw failure('INVALID_ARGUMENTS', USAGE);
  }
  const report = await checkOfficialUpdate({ ...options, fetchImpl: online ? fetchImpl : undefined });
  writeOutput(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ metadataOnly: true, error: { code: error.code ?? 'UPDATE_CHECK_FAILED', message: error.message }, admissionApproved: false, installed: false }));
    process.exitCode = 1;
  });
}
