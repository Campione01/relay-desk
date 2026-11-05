import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NATIVE_CLI_BUILDS, NATIVE_CLI_TRACKS } from '../../src/main/native/cliBuilds.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROW = /^\| (\S+) \| (\d+\.\d+\.\d+) \| `([0-9a-f]{64})` \| `([a-z-]+)` \|$/;

/** The rows of the track table in docs/CLI-TRACKS.md. */
function documentedTracks(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.indexOf('| Track | Version | claude.exe sha256 | Verification |');
  assert.notEqual(header, -1, 'docs/CLI-TRACKS.md has no track table');
  assert.equal(lines[header + 1], '| --- | --- | --- | --- |');
  const rows = [];
  for (let index = header + 2; index < lines.length && lines[index].startsWith('|'); index++) {
    const match = ROW.exec(lines[index]);
    assert(match, `Unexpected track table row: ${lines[index]}`);
    rows.push({ track: match[1], version: match[2], sha256: match[3], verification: match[4] });
  }
  return rows;
}

test('docs/CLI-TRACKS.md lists exactly the admitted tracks', async () => {
  const rows = documentedTracks(await readFile(path.join(ROOT, 'docs', 'CLI-TRACKS.md'), 'utf8'));
  const expected = Object.entries(NATIVE_CLI_TRACKS).map(([track, info]) => ({ track, version: info.version,
    sha256: NATIVE_CLI_BUILDS.find((build) => build.version === info.version)?.sha256, verification: info.verification }));
  assert.deepEqual(rows, expected);
});

test('the table reader rejects a changed or extra row', () => {
  const table = (...rows) => ['| Track | Version | claude.exe sha256 | Verification |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  const row = (track, version) => `| ${track} | ${version} | \`${'a'.repeat(64)}\` | \`isolated-only\` |`;
  assert.deepEqual(documentedTracks(table(row('latest', '9.9.9'))), [{ track: 'latest', version: '9.9.9', sha256: 'a'.repeat(64), verification: 'isolated-only' }]);
  assert.throws(() => documentedTracks(table(row('latest', '9.9.9'), '| nightly | soon | ? | ? |')), /Unexpected track table row/);
  assert.throws(() => documentedTracks('no table'), /no track table/);
});
