import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const maxContractBytes = 4 * 1024 * 1024;
const ignoredKeys = new Set(['start', 'end', 'loc', 'extra', 'comments', 'tokens', 'errors']);
// The same VM-only global block is present in the audited 2.1.302 and 2.1.308
// contracts. A changed declaration requires review, not a broader omission.
const knownGlobalAstSha256 = '50a9eacb2fc81cf235fda08c0eccb6cc0f2a78b466f745e8912785415c4e3af1';

class ProjectionError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectionError'; this.code = code; }
}

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !ignoredKeys.has(key) && !key.endsWith('Comments'))
    .map((key) => [key, shape(value[key])]));
}

/** Projects exact declaration bytes without executing a CLI or modifying input. */
export function projectContract(contractBytes) {
  if (!(contractBytes instanceof Uint8Array)) throw new ProjectionError('INVALID_BYTES', 'Contract input must be bytes.');
  if (contractBytes.length > maxContractBytes) throw new ProjectionError('INPUT_LIMIT', 'Contract input exceeds the bounded declaration size.');
  const original = Buffer.from(contractBytes.buffer, contractBytes.byteOffset, contractBytes.byteLength);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); }
  catch { throw new ProjectionError('INVALID_UTF8', 'Contract input must be UTF-8.'); }
  let program;
  try { program = parse(source, { sourceType: 'module', plugins: [['typescript', { dts: true }]] }).program; }
  catch { throw new ProjectionError('PARSE_ERROR', 'Contract input could not be parsed as declarations.'); }
  const modules = program.body.filter((node) => node.type === 'TSModuleDeclaration' && node.id.type === 'StringLiteral' && node.id.value === 'claude-code');
  if (modules.length !== 1 || modules[0].body?.type !== 'TSModuleBlock') {
    throw new ProjectionError('UNEXPECTED_MODULE', 'Expected exactly one top-level claude-code declaration module.');
  }
  const globals = [];
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'TSModuleDeclaration' && value.global === true) globals.push(value);
    for (const [key, child] of Object.entries(value)) if (!ignoredKeys.has(key) && !key.endsWith('Comments')) visit(child);
  }
  visit(program);
  if (globals.length !== 1 || !modules[0].body.body.includes(globals[0])) {
    throw new ProjectionError('UNEXPECTED_GLOBAL_SCOPE', 'Expected exactly one VM global block directly inside claude-code.');
  }
  const global = globals[0], astSha256 = hash(JSON.stringify(shape(global)));
  if (astSha256 !== knownGlobalAstSha256) {
    throw new ProjectionError('UNKNOWN_GLOBAL_DECLARATIONS', 'The VM global declarations differ from the audited block; review is required.');
  }
  // Match the historical generator: retain line endings and UTF-16 positions,
  // and preserve every byte outside the AST-selected VM global declaration.
  const block = source.slice(global.start, global.end);
  const bytes = Buffer.from(source.slice(0, global.start) + block.replace(/[^\r\n]/g, ' ') + source.slice(global.end), 'utf8');
  return { bytes, report: { schemaVersion: 1, method: 'babel-ast-known-vm-global-projection',
    parser: { name: '@babel/parser', version: require('@babel/parser/package.json').version },
    contract: { bytes: original.length, sha256: hash(original) },
    hostProjection: { bytes: bytes.length, sha256: hash(bytes) },
    vmGlobalBlocksOmitted: 1,
    omittedBlock: { startUtf16: global.start, endUtf16: global.end, startLine: global.loc.start.line, endLine: global.loc.end.line,
      sha256: hash(block), astSha256 },
    limitations: ['Only the audited VM global declaration is omitted; all other declaration bytes are retained.',
      'Projection is not evidence of type checking, official provenance or runtime compatibility.', 'No candidate CLI execution occurred.'] } };
}

export function projectContractFile(inputPath) {
  const input = lstatSync(inputPath);
  if (!inputPath.endsWith('.d.ts') || !input.isFile()) throw new ProjectionError('INVALID_FILE', 'Input must be an explicit normal .d.ts file, not a directory or symbolic link.');
  if (input.size > maxContractBytes) throw new ProjectionError('INPUT_LIMIT', 'Contract input exceeds the bounded declaration size.');
  return projectContract(readFileSync(inputPath));
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node project-contract.mjs --input FILE.d.ts [--expected-sha256 HASH] [--output ABSOLUTE_NEW_FILE.d.ts]\nOffline host projection only. Default: JSON report, no writes. Output must be new; parent directory must already exist.\n'); return;
  }
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--input', '--output', '--expected-sha256'].includes(args[index]) || !args[index + 1] || values.has(args[index])) {
      throw new ProjectionError('INVALID_ARGUMENTS', 'Supply --input and optional --output / --expected-sha256 exactly once.');
    }
    values.set(args[index], args[index + 1]);
  }
  if (!values.has('--input')) throw new ProjectionError('INVALID_ARGUMENTS', 'An explicit --input declaration file is required.');
  const expected = values.get('--expected-sha256');
  if (expected && !/^[0-9a-f]{64}$/i.test(expected)) throw new ProjectionError('INVALID_HASH', 'Expected SHA256 must contain exactly 64 hexadecimal characters.');
  const { bytes, report } = projectContractFile(resolve(values.get('--input')));
  if (expected && report.contract.sha256 !== expected.toLowerCase()) throw new ProjectionError('HASH_MISMATCH', 'Declaration bytes do not match the explicitly supplied SHA256.');
  const output = values.get('--output');
  if (output) {
    if (!isAbsolute(output) || !output.endsWith('.d.ts') || !lstatSync(dirname(output)).isDirectory()) {
      throw new ProjectionError('INVALID_OUTPUT', 'Output must be an absolute new .d.ts path with an existing parent directory.');
    }
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
    process.stderr.write(JSON.stringify({ error: error instanceof ProjectionError ? error.code : 'FILE_OPERATION_FAILED',
      message: error instanceof ProjectionError ? error.message : 'The explicit file operation failed; no existing output is overwritten.' }) + '\n');
    process.exitCode = 1;
  }
}
