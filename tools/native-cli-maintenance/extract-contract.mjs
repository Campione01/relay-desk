import { createHash } from 'node:crypto';
import { lstatSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const marker = '// Claude Code function hooks:';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const DEFAULT_LIMITS = Object.freeze({
  maxBinaryBytes: 512 * 1024 * 1024, maxMagicCandidates: 16_384,
  maxFrameBytes: 4 * 1024 * 1024, maxFrameBlocks: 4096,
  maxOutputBytes: 4 * 1024 * 1024, maxDecompressionAttempts: 8192,
  maxTotalDecompressedBytes: 64 * 1024 * 1024,
});

class ExtractionError extends Error {
  constructor(code, message, details) { super(message); this.name = 'ExtractionError'; this.code = code; this.details = details; }
}
function limitsFor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key)) ||
      Object.values(options).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new ExtractionError('INVALID_LIMITS', 'Extraction limits must be known positive integer fields.');
  }
  return { ...DEFAULT_LIMITS, ...options };
}

// Standard zstd frames only. Parse through the final block/checksum, never pass
// unrelated trailing PE bytes or concatenated frames to the decompressor.
function frameAt(binary, offset, limits) {
  const endLimit = Math.min(binary.length, offset + limits.maxFrameBytes);
  let cursor = offset + magic.length;
  if (cursor >= endLimit) return undefined;
  const header = binary[cursor++], singleSegment = Boolean(header & 0x20);
  if (header & 0x18) return undefined;
  if (!singleSegment) {
    if (cursor >= endLimit) return undefined;
    const descriptor = binary[cursor++], base = 2 ** (10 + (descriptor >> 3));
    if (base + base / 8 * (descriptor & 7) > limits.maxOutputBytes) return undefined;
  }
  const dictionaryBytes = [0, 1, 2, 4][header & 3];
  if (cursor + dictionaryBytes > endLimit) return undefined;
  // No dictionary is supplied to the decoder: such a frame is not admissible.
  if (dictionaryBytes && binary.readUIntLE(cursor, dictionaryBytes) !== 0) return undefined;
  cursor += dictionaryBytes;
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][header >> 6];
  if (cursor + contentSizeBytes > endLimit) return undefined;
  let contentSize;
  if (contentSizeBytes) {
    contentSize = contentSizeBytes === 8 ? binary.readBigUInt64LE(cursor) : BigInt(binary.readUIntLE(cursor, contentSizeBytes));
    if (contentSizeBytes === 2) contentSize += 256n;
  }
  cursor += contentSizeBytes;
  for (let blockCount = 1; blockCount <= limits.maxFrameBlocks; blockCount++) {
    if (cursor + 3 > endLimit) return undefined;
    const block = binary.readUIntLE(cursor, 3); cursor += 3;
    const kind = (block >> 1) & 3, size = block >> 3;
    if (kind === 3 || size > 128 * 1024) return undefined;
    cursor += kind === 1 ? 1 : size;
    if (cursor > endLimit) return undefined;
    if (block & 1) {
      const checksumPresent = Boolean(header & 4);
      cursor += checksumPresent ? 4 : 0;
      if (cursor > endLimit) return undefined;
      return { offset, end: cursor, blockCount, checksumPresent, contentSize };
    }
  }
  return undefined;
}

function declarationMetadata(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return undefined; }
  if (!text.replace(/^\uFEFF/, '').startsWith(marker)) return undefined;
  let ast;
  try { ast = parse(text, { sourceType: 'module', plugins: [['typescript', { dts: true }]] }).program; }
  catch { return undefined; }
  const modules = ast.body.filter((node) => node.type === 'TSModuleDeclaration' && node.id.type === 'StringLiteral');
  const contract = modules.find((node) => node.id.value === 'claude-code' && node.body?.type === 'TSModuleBlock');
  if (!contract?.body.body.some((node) => ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes((node.declaration ?? node).type))) return undefined;
  const counts = { interfaces: 0, typeAliases: 0, functions: 0, classes: 0 };
  const countKeys = { TSInterfaceDeclaration: 'interfaces', TSTypeAliasDeclaration: 'typeAliases', TSDeclareFunction: 'functions', ClassDeclaration: 'classes' };
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (countKeys[value.type]) counts[countKeys[value.type]]++;
    for (const [key, child] of Object.entries(value)) if (!['loc', 'start', 'end', 'extra', 'comments'].includes(key) && !key.endsWith('Comments')) visit(child);
  }
  visit(ast);
  return { modules: [...new Set(modules.map((node) => node.id.value))].sort(), declarationCounts: counts };
}

/** Returns exact decompressed bytes and metadata; never executes a CLI or writes a file. */
export function extractContract(binaryBytes, options = {}) {
  if (!(binaryBytes instanceof Uint8Array)) throw new ExtractionError('INVALID_BINARY', 'Binary input must be bytes.');
  const limits = limitsFor(options);
  const binary = Buffer.from(binaryBytes.buffer, binaryBytes.byteOffset, binaryBytes.byteLength);
  if (binary.length > limits.maxBinaryBytes) throw new ExtractionError('BINARY_LIMIT', 'Binary input exceeds the explicit scan limit.');
  const stats = { magicCandidates: 0, framedCandidates: 0, decompressionAttempts: 0, decompressedFrames: 0,
    totalDecompressedBytes: 0, invalidFrames: 0, declaredOutputTooLarge: 0, decompressionFailures: 0, invalidDeclarations: 0 };
  const matches = [];
  const failLimit = (code) => { throw new ExtractionError(code, 'The bounded extraction budget was exhausted; uniqueness was not established.', { limits, stats: { ...stats } }); };
  for (let offset = binary.indexOf(magic); offset >= 0; offset = binary.indexOf(magic, offset + magic.length)) {
    if (++stats.magicCandidates > limits.maxMagicCandidates) failLimit('SCAN_LIMIT');
    const frame = frameAt(binary, offset, limits);
    if (!frame) { stats.invalidFrames++; continue; }
    stats.framedCandidates++;
    if (frame.contentSize !== undefined && frame.contentSize > BigInt(limits.maxOutputBytes)) { stats.declaredOutputTooLarge++; continue; }
    if (++stats.decompressionAttempts > limits.maxDecompressionAttempts) failLimit('DECOMPRESSION_LIMIT');
    let bytes;
    try { bytes = zstdDecompressSync(binary.subarray(offset, frame.end), { maxOutputLength: limits.maxOutputBytes }); }
    catch { stats.decompressionFailures++; continue; }
    stats.decompressedFrames++; stats.totalDecompressedBytes += bytes.length;
    if (stats.totalDecompressedBytes > limits.maxTotalDecompressedBytes) failLimit('TOTAL_OUTPUT_LIMIT');
    if (!bytes.includes(marker)) continue;
    const declaration = declarationMetadata(bytes);
    if (!declaration) { stats.invalidDeclarations++; continue; }
    matches.push({ bytes, frame, declaration });
  }
  const input = { bytes: binary.length, sha256: hash(binary) };
  if (matches.length !== 1) throw new ExtractionError(matches.length ? 'AMBIGUOUS_CONTRACT' : 'NO_CONTRACT_MATCH',
    'Expected exactly one admissible embedded Mod declaration.', { binary: input, qualifiedMatches: matches.length,
      matches: matches.map((match) => ({ offset: match.frame.offset, end: match.frame.end, bytes: match.bytes.length, sha256: hash(match.bytes) })), limits, stats });
  const { bytes, frame, declaration } = matches[0];
  return { bytes, report: { schemaVersion: 1, method: 'offline-full-binary-zstd-frame-scan', binary: input,
    frame: { offset: frame.offset, end: frame.end, compressedBytes: frame.end - frame.offset,
      compressedSha256: hash(binary.subarray(frame.offset, frame.end)), blockCount: frame.blockCount,
      checksumPresent: frame.checksumPresent, declaredContentBytes: frame.contentSize === undefined ? null : Number(frame.contentSize) },
    contract: { bytes: bytes.length, sha256: hash(bytes), ...declaration },
    parser: { name: '@babel/parser', version: require('@babel/parser/package.json').version },
    scan: { limits, ...stats, qualifiedMatches: 1, completeBinaryScanned: true },
    limitations: ['Uniqueness is established only for complete standard zstd frames admitted by the reported limits.',
      'Extraction and declaration parsing do not attest official provenance or runtime compatibility.', 'No candidate CLI execution occurred.'] } };
}

export function extractContractFile(binaryPath, options = {}) {
  const input = lstatSync(binaryPath);
  if (!input.isFile()) throw new ExtractionError('INVALID_FILE', 'Input must be a normal binary file, not a directory or symbolic link.');
  const limits = limitsFor(options);
  if (input.size > limits.maxBinaryBytes) throw new ExtractionError('BINARY_LIMIT', 'Binary input exceeds the explicit scan limit.');
  return extractContract(readFileSync(binaryPath), options);
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node extract-contract.mjs --binary FILE [--expected-sha256 HASH] [--output ABSOLUTE_STAGED_FILE.d.ts]\nOffline extraction only. Default: JSON report, no writes. Output must be new; parent directory must already exist.\n'); return;
  }
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--binary', '--output', '--expected-sha256'].includes(args[index]) || !args[index + 1] || values.has(args[index])) throw new ExtractionError('INVALID_ARGUMENTS', 'Supply --binary and optional --output / --expected-sha256 exactly once.');
    values.set(args[index], args[index + 1]);
  }
  if (!values.has('--binary')) throw new ExtractionError('INVALID_ARGUMENTS', 'An explicit --binary file is required.');
  const expected = values.get('--expected-sha256');
  if (expected && !/^[0-9a-f]{64}$/i.test(expected)) throw new ExtractionError('INVALID_HASH', 'Expected SHA256 must contain exactly 64 hexadecimal characters.');
  const binaryPath = resolve(values.get('--binary'));
  const input = lstatSync(binaryPath);
  if (!input.isFile() || input.size > DEFAULT_LIMITS.maxBinaryBytes) throw new ExtractionError('INVALID_FILE', 'Input must be a normal file within the binary size limit.');
  const binary = readFileSync(binaryPath);
  if (expected && hash(binary) !== expected.toLowerCase()) throw new ExtractionError('HASH_MISMATCH', 'Binary bytes do not match the explicitly supplied SHA256.');
  const { bytes, report } = extractContract(binary);
  const output = values.get('--output');
  if (output) {
    if (!isAbsolute(output) || !output.endsWith('.d.ts') || !lstatSync(dirname(output)).isDirectory()) throw new ExtractionError('INVALID_OUTPUT', 'Output must be an absolute new staged .d.ts path with an existing parent directory.');
    let descriptor;
    try { descriptor = openSync(output, 'wx', 0o600); writeFileSync(descriptor, bytes); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    report.output = { path: output, createdNewFile: true, bytes: bytes.length, sha256: hash(bytes) };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof ExtractionError ? error.code : 'FILE_OPERATION_FAILED',
      message: error instanceof ExtractionError ? error.message : 'The explicit file operation failed; no existing output is overwritten.',
      ...(error.details ? { details: error.details } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
