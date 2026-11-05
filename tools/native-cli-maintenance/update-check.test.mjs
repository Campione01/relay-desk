import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CHECK_TIMEOUT_MS, DIST_TAGS_URL, MAX_RESPONSE_BYTES, PACKAGE_NAME, checkOfficialUpdate, compareVersions, runCli } from './update-check.mjs';

const versionUrl = (version) => `https://registry.npmjs.org/@anthropic-ai%2fclaude-code/${version}`;
const metadata = (version = '2.1.303') => ({ name: PACKAGE_NAME, version,
  dist: { tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, shasum: 'a'.repeat(40) } });
function response(value, url, { raw = false, status = 200, headers = {}, redirected = false } = {}) {
  const result = new Response(raw ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: redirected } });
  return result;
}
function fixture({ tags = { latest: '2.1.303', stable: '2.1.301' }, packageMetadata = metadata(), reply } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (reply) return reply(url, options, calls.length);
    return response(url === DIST_TAGS_URL ? tags : packageMetadata, url);
  } };
}
const rejectsCode = (operation, code) => assert.rejects(operation, (error) => error.code === code);

test('strict numeric stable semver compares numerically, including components above Number precision', () => {
  assert.equal(compareVersions('2.1.302', '2.1.302'), 0);
  assert.equal(compareVersions('2.1.10', '2.1.9'), 1);
  assert.equal(compareVersions('2.1.302', '2.2.0'), -1);
  assert.equal(compareVersions('10.0.0', '9.999.999'), 1);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  for (const value of ['v2.1.302', '2.1', '2.1.302-beta.1', '2.1.302+build', '02.1.302', '2.01.302', '2.1.0302',
    '2.1.302 ', ' 2.1.302', '2.1.302\n', '2.1.302\r\n', '^2.1.302', 'latest', '', null, 302]) {
    assert.throws(() => compareVersions(value, '2.1.302'), { code: 'INVALID_VERSION' });
    assert.throws(() => compareVersions('2.1.302', value), { code: 'INVALID_VERSION' });
  }
});

test('API and CLI default offline; injected network implementation is never invoked without --online', async () => {
  const offline = await checkOfficialUpdate();
  assert.equal(offline.status, 'offline'); assert.equal(offline.baselineVersion, '2.1.302'); assert.equal(offline.channel, 'latest');
  assert.equal(offline.observedVersion, null); assert.equal(offline.comparison, null); assert.equal(offline.dist, null);
  const output = [];
  await runCli([], { fetchImpl: () => assert.fail('No network authorized.'), writeOutput: (value) => output.push(JSON.parse(value)) });
  assert.deepEqual(output, [offline]); assert.equal(offline.admissionApproved, false); assert.equal(offline.installed, false);
});

test('online latest metadata reports exact source provenance and integrity, never admission or installation', async () => {
  const mock = fixture(); const result = await checkOfficialUpdate({ fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'observed'); assert.equal(result.channel, 'latest'); assert.equal(result.observedVersion, '2.1.303');
  assert.equal(result.comparison, 'newer'); assert.deepEqual(result.dist, metadata().dist);
  assert.deepEqual(mock.calls.map((call) => call.url), [DIST_TAGS_URL, versionUrl('2.1.303')]);
  assert.equal(DIST_TAGS_URL, 'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags');
  for (const call of mock.calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'omit');
    assert.deepEqual(call.options.headers, { accept: 'application/json' }); assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.signal.aborted, true);
  }
  assert.equal(result.provenance.distTagsUrl, DIST_TAGS_URL); assert.equal(result.provenance.versionMetadataUrl, versionUrl('2.1.303'));
  assert.equal(result.provenance.artifactVerified, false); assert.equal(result.metadataOnly, true);
  assert.equal(result.admissionApproved, false); assert.equal(result.installed, false);
});

test('stable is an explicitly observed tag, not a guessed tag or fallback, and may be older than baseline', async () => {
  const mock = fixture({ packageMetadata: metadata('2.1.301') });
  const result = await checkOfficialUpdate({ channel: 'stable', fetchImpl: mock.fetchImpl });
  assert.equal(result.channel, 'stable'); assert.equal(result.observedVersion, '2.1.301'); assert.equal(result.comparison, 'older');
  assert.equal(mock.calls[1].url, versionUrl('2.1.301'));
  const missing = fixture({ tags: { latest: '2.1.303' } });
  await rejectsCode(() => checkOfficialUpdate({ channel: 'stable', fetchImpl: missing.fetchImpl }), 'MISSING_CHANNEL');
  assert.equal(missing.calls.length, 1);
});

test('same-version metadata remains only an observation; CLI permits explicit channel/baseline selection', async () => {
  const mock = fixture({ tags: { stable: '2.1.303' } }); const output = [];
  const result = await runCli(['--online', '--channel', 'stable', '--baseline-version', '2.1.303'],
    { fetchImpl: mock.fetchImpl, writeOutput: (value) => output.push(JSON.parse(value)) });
  assert.equal(result.comparison, 'same'); assert.deepEqual(output, [result]); assert.equal(mock.calls.length, 2);
  assert.equal(result.installed, false); assert.equal(result.admissionApproved, false);
});

test('prerelease, malformed channel version and mismatched package metadata never become selected updates', async () => {
  for (const version of ['2.2.0-rc.1', '2.1.303+build', 'v2.1.303', '2.1', 303, null]) {
    const mock = fixture({ tags: { latest: version } });
    await rejectsCode(() => checkOfficialUpdate({ fetchImpl: mock.fetchImpl }), 'INVALID_VERSION'); assert.equal(mock.calls.length, 1);
  }
  for (const changed of [{ ...metadata(), name: '@other/claude-code' }, { ...metadata(), version: '2.1.304' }]) {
    const mock = fixture({ packageMetadata: changed });
    await rejectsCode(() => checkOfficialUpdate({ fetchImpl: mock.fetchImpl }), 'PACKAGE_IDENTITY_MISMATCH'); assert.equal(mock.calls.length, 2);
  }
});

test('off-source or malformed tarball/integrity metadata is rejected without downloading any artifact', async () => {
  for (const dist of [null, {}, { ...metadata().dist, tarball: 'https://evil.test/claude-code.tgz' },
    { ...metadata().dist, tarball: 'http://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.303.tgz' },
    { ...metadata().dist, tarball: metadata('2.1.304').dist.tarball }, { ...metadata().dist, integrity: 'sha512-short' },
    { ...metadata().dist, integrity: 'sha1-YQ==' }, { ...metadata().dist, integrity: `${metadata().dist.integrity}\n` },
    { ...metadata().dist, integrity: null }, { ...metadata().dist, shasum: 'bad' }, { ...metadata().dist, shasum: ['a'.repeat(40)] }]) {
    const mock = fixture({ packageMetadata: { ...metadata(), dist } });
    await rejectsCode(() => checkOfficialUpdate({ fetchImpl: mock.fetchImpl }), 'INVALID_DIST_METADATA');
    assert.equal(mock.calls.length, 2); assert.ok(mock.calls.every((call) => !call.url.endsWith('.tgz')));
  }
});

test('redirects, off-source responses and HTTP errors are explicit, with no retry or alternate host', async () => {
  for (const stage of [1, 2]) {
    for (const [kind, code] of [['redirect', 'METADATA_REDIRECT'], ['off-source', 'OFF_SOURCE_METADATA'], ['http', 'METADATA_HTTP_ERROR']]) {
      const mock = fixture({ reply: (url, options, index) => {
        if (index !== stage) return response({ latest: '2.1.303' }, url);
        if (kind === 'redirect') return response({}, url, { status: 302, headers: { location: 'https://evil.test/' } });
        if (kind === 'off-source') return response({}, 'https://evil.test/package');
        return response({}, url, { status: 503 });
      } });
      await rejectsCode(() => checkOfficialUpdate({ fetchImpl: mock.fetchImpl }), code); assert.equal(mock.calls.length, stage);
    }
  }
  const followed = fixture({ reply: (url) => response({}, url, { redirected: true }) });
  await rejectsCode(() => checkOfficialUpdate({ fetchImpl: followed.fetchImpl }), 'METADATA_REDIRECT');
});

test('JSON shape, MIME, empty and oversized metadata responses fail before interpreting versions', async () => {
  const variants = [
    { value: 'not json', options: { raw: true }, code: 'INVALID_METADATA' },
    { value: [], options: {}, code: 'INVALID_METADATA' },
    { value: null, options: {}, code: 'INVALID_METADATA' },
    { value: {}, options: { headers: { 'content-type': 'text/html' } }, code: 'INVALID_METADATA' },
    { value: '', options: { raw: true }, code: 'INVALID_METADATA' },
    { value: {}, options: { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }, code: 'METADATA_TOO_LARGE' },
    { value: 'x'.repeat(MAX_RESPONSE_BYTES + 1), options: { raw: true }, code: 'METADATA_TOO_LARGE' },
  ];
  for (const { value, options, code } of variants) {
    const mock = fixture({ reply: (url) => response(value, url, options) });
    await rejectsCode(() => checkOfficialUpdate({ fetchImpl: mock.fetchImpl }), code); assert.equal(mock.calls.length, 1);
  }
});

test('one whole-check deadline aborts even a non-cooperative mocked fetch; no retry', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0; let signal; let settle;
  const pending = checkOfficialUpdate({ fetchImpl: (url, options) => { calls++; signal = options.signal; return new Promise((resolve) => { settle = resolve; }); } });
  context.mock.timers.tick(CHECK_TIMEOUT_MS);
  await rejectsCode(() => pending, 'METADATA_TIMEOUT'); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  settle(response({ latest: '2.1.303' }, DIST_TAGS_URL));
  await new Promise(setImmediate); assert.equal(calls, 1);
});

test('request failure is explicit and never retried', async () => {
  let calls = 0;
  await rejectsCode(() => checkOfficialUpdate({ fetchImpl: async () => { calls++; throw new Error('mock unavailable'); } }), 'METADATA_REQUEST_FAILED');
  assert.equal(calls, 1);
});

test('invalid inputs and CLI updater/destination/watch options fail before any fetch', async () => {
  const forbiddenFetch = () => assert.fail('Invalid inputs must not query metadata.');
  await rejectsCode(() => checkOfficialUpdate({ baselineVersion: '^2.1.302', fetchImpl: forbiddenFetch }), 'INVALID_VERSION');
  await rejectsCode(() => checkOfficialUpdate({ channel: 'next', fetchImpl: forbiddenFetch }), 'INVALID_CHANNEL');
  await rejectsCode(() => checkOfficialUpdate({ fetchImpl: null }), 'INVALID_FETCH');
  for (const args of [['--install'], ['--watch'], ['--registry', 'https://evil.test'], ['--output', 'D:/other app'],
    ['--online', '--online'], ['--channel'], ['--baseline-version'], ['--channel', 'latest', '--channel', 'stable']]) {
    await rejectsCode(() => runCli(args, { fetchImpl: forbiddenFetch, writeOutput: () => assert.fail('No success output expected.') }), 'INVALID_ARGUMENTS');
  }
});

test('detector source has no host file/process/credential/environment readers or state-mutating imports', async () => {
  const source = await readFile(new URL('./update-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:fs|child_process|os|http|https)|process\.env|writeFile|mkdir|\bspawn\s*\(|(?<!\.)\bexec\s*\(|setInterval|Authorization|Cookie/);
  assert.match(source, /credentials: 'omit'/); assert.match(source, /redirect: 'manual'/);
});
