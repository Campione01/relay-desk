import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import { DEFAULT_LIMITS, extractContract, extractContractFile } from './extract-contract.mjs';

const own = dirname(fileURLToPath(import.meta.url)), root = resolve(own, '../..');
const source = Buffer.from('// Claude Code function hooks: synthetic contract.\r\n\r\ndeclare module "claude-code" { export interface CoreEngineInterface { read(): string } export type Register = () => void; }\r\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const compressed = () => zstdCompressSync(source);

test('finds the unique declaration without a version offset and preserves exact CRLF/quote bytes', () => {
  const prefix = Buffer.alloc(1379, 0x5a), frame = compressed();
  const binary = Buffer.concat([prefix, frame, Buffer.from('unrelated trailing PE bytes')]);
  const result = extractContract(binary);
  assert(result.bytes.equals(source));
  assert.equal(result.report.frame.offset, prefix.length); assert.equal(result.report.frame.end, prefix.length + frame.length);
  assert.equal(result.report.frame.compressedSha256, hash(frame));
  assert.equal(result.report.binary.sha256, hash(binary)); assert.equal(result.report.contract.sha256, hash(source));
  assert.equal(result.report.scan.completeBinaryScanned, true);
  assert(!JSON.stringify(result.report).includes('read(): string'));
});

test('ignores unrelated frames, false magic and an unparsable declaration marker', () => {
  const invalid = zstdCompressSync(Buffer.from('// Claude Code function hooks: invalid\ndeclare module "claude-code" { export interface Broken {'));
  const unrelated = zstdCompressSync(Buffer.from('unrelated normal compressed asset'));
  const falseMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff]);
  const result = extractContract(Buffer.concat([falseMagic, unrelated, invalid, compressed()]));
  assert(result.bytes.equals(source)); assert.equal(result.report.scan.invalidDeclarations, 1);
  assert(result.report.scan.invalidFrames >= 1); assert.equal(result.report.scan.qualifiedMatches, 1);
});

test('requires uniqueness even when duplicate frames decompress to identical declarations', () => {
  assert.throws(() => extractContract(Buffer.concat([compressed(), compressed()])),
    (error) => error.code === 'AMBIGUOUS_CONTRACT' && error.details.qualifiedMatches === 2);
});

test('handles RLE/checksum frames and excludes a declared oversized output before decompression', () => {
  const rleBlock = Buffer.alloc(3); rleBlock.writeUIntLE((20 << 3) | 3, 0, 3);
  const rle = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 20]), rleBlock, Buffer.from('x')]);
  const oversized = Buffer.alloc(16); Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0]).copy(oversized);
  oversized.writeBigUInt64LE(2n ** 40n, 5); oversized[13] = 1;
  const checked = zstdCompressSync(source, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  const result = extractContract(Buffer.concat([rle, oversized, checked]));
  assert(result.bytes.equals(source)); assert.equal(result.report.frame.checksumPresent, true);
  assert.equal(result.report.frame.declaredContentBytes, source.length);
  assert.equal(result.report.scan.declaredOutputTooLarge, 1);
  assert.equal(result.report.scan.decompressionAttempts, 2);
});

test('fails closed on exhausted scan/decompression/output budgets', () => {
  const binary = Buffer.concat([zstdCompressSync(Buffer.from('first asset')), compressed()]);
  assert.throws(() => extractContract(binary, { maxMagicCandidates: 1 }), (error) => error.code === 'SCAN_LIMIT');
  assert.throws(() => extractContract(binary, { maxDecompressionAttempts: 1 }), (error) => error.code === 'DECOMPRESSION_LIMIT');
  assert.throws(() => extractContract(binary, { maxTotalDecompressedBytes: 1 }), (error) => error.code === 'TOTAL_OUTPUT_LIMIT');
  assert.throws(() => extractContract(binary, { maxBinaryBytes: 1 }), (error) => error.code === 'BINARY_LIMIT');
});

test('rejects truncated/reserved/oversized frames and invalid option fields', () => {
  const frame = compressed();
  assert.throws(() => extractContract(frame.subarray(0, frame.length - 1)), (error) => error.code === 'NO_CONTRACT_MATCH');
  assert.throws(() => extractContract(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x18])), (error) => error.code === 'NO_CONTRACT_MATCH');
  assert.throws(() => extractContract(frame, { maxFrameBytes: 8 }), (error) => error.code === 'NO_CONTRACT_MATCH');
  assert.throws(() => extractContract(frame, { executeCandidate: 1 }), (error) => error.code === 'INVALID_LIMITS');
  assert.throws(() => extractContract(frame, { toString: 1 }), (error) => error.code === 'INVALID_LIMITS');
  assert.throws(() => extractContract('not bytes'), (error) => error.code === 'INVALID_BINARY');
  assert(DEFAULT_LIMITS.maxBinaryBytes > 290_211_488);
});

const sdkBinary = resolve(root, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
const SDK_BINARY_SHA256 = '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae';
const sdkBinaryInstalled = () => { try { return hash(readFileSync(sdkBinary)) === SDK_BINARY_SHA256; } catch { return false; } };

test('extracts the pinned legacy 2.1.302 CLI contract with full-byte provenance, read-only', {
  skip: sdkBinaryInstalled() ? false : 'needs the claude.exe bundled with the SDK (2.1.302); npm run cli:stable or cli:latest replaced it, npm ci restores it',
}, () => {
  const result = extractContractFile(sdkBinary);
  assert.equal(hash(result.bytes), '8afa71883ecfa52901eb7a04cf31fef700d8ba565eaad244f4884cc620f8d56e');
  assert.equal(result.report.binary.sha256, '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae');
  assert.equal(result.report.contract.sha256, '8afa71883ecfa52901eb7a04cf31fef700d8ba565eaad244f4884cc620f8d56e');
  assert(result.report.scan.magicCandidates > 1);
});

test('CLI defaults to report-only and rejects invalid arguments without echoing payloads', () => {
  const help = spawnSync(process.execPath, [resolve(own, 'extract-contract.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert(help.stdout.includes('no writes'));
  const invalid = spawnSync(process.execPath, [resolve(own, 'extract-contract.mjs'), '--unknown', 'DO_NOT_PRINT_SECRET'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).error, 'INVALID_ARGUMENTS'); assert(!invalid.stderr.includes('DO_NOT_PRINT_SECRET'));
});
