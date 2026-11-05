import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const EXECUTABLES = ['pdfinfo.exe', 'pdftoppm.exe'] as const;
const SYSTEM_DLLS = new Set(['advapi32.dll', 'bcrypt.dll', 'crypt32.dll', 'dbghelp.dll', 'dnsapi.dll', 'gdi32.dll', 'iphlpapi.dll', 'kernel32.dll', 'msvcrt.dll', 'ncrypt.dll', 'netapi32.dll', 'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll', 'user32.dll', 'userenv.dll', 'version.dll', 'winhttp.dll', 'winmm.dll', 'wldap32.dll', 'ws2_32.dll']);
const isSystemDll = (name: string) => SYSTEM_DLLS.has(name) || /^(api-ms-win-|ext-ms-win-)[a-z0-9-]+\.dll$/.test(name);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface NativePdfResourceFile { path: string; bytes: number; sha256: string }
export interface NativePdfResourceReceipt {
  schemaVersion: 1;
  files: NativePdfResourceFile[];
  imports: Record<string, string[]>;
  systemDlls: string[];
}

/** Read ordinary and delay imports, without loading or running untrusted native code. */
export function readNativePeImports(bytes: Buffer): string[] {
  const check = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error('Truncated native PDF PE image.');
    return offset;
  };
  check(0, 64);
  const pe = bytes.readUInt32LE(60); check(pe, 24);
  if (bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Native PDF tools require an AMD64 PE image.');
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20); check(optional, optionalSize);
  if (optionalSize < 224 || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 14) throw new Error('Native PDF PE directory table is incomplete.');
  const sections = optional + optionalSize;
  const count = bytes.readUInt16LE(pe + 6); check(sections, count * 40);
  const atRva = (rva: number, length: number): number => {
    for (let i = 0; i < count; i++) {
      const section = sections + i * 40;
      const start = bytes.readUInt32LE(section + 12); const size = bytes.readUInt32LE(section + 16);
      if (rva >= start && rva - start + length <= size) return check(bytes.readUInt32LE(section + 20) + rva - start, length);
    }
    throw new Error('Native PDF PE import points outside file-backed sections.');
  };
  const names = new Set<string>();
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = bytes.readUInt32LE(optional + 112 + index * 8);
    const size = bytes.readUInt32LE(optional + 116 + index * 8);
    if (!rva && !size) continue;
    const start = atRva(rva, size); let terminated = false;
    for (let offset = start; offset + stride <= start + size; offset += stride) {
      if (bytes.subarray(offset, offset + stride).every((byte) => byte === 0)) { terminated = true; break; }
      if (index === 13 && bytes.readUInt32LE(offset) !== 1) throw new Error('Unsupported absolute delay-import descriptor.');
      const nameStart = atRva(bytes.readUInt32LE(offset + nameOffset), 1);
      const end = bytes.indexOf(0, nameStart);
      const name = bytes.toString('ascii', nameStart, end).toLowerCase();
      if (end < nameStart || end - nameStart > 255 || !/^[a-z0-9_.-]+\.dll$/.test(name)) throw new Error('Invalid native PDF DLL import.');
      names.add(name);
    }
    if (!terminated) throw new Error('Unterminated native PDF import table.');
  }
  return [...names].sort();
}

function readPhysicalFile(root: string, relative: string): Buffer {
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid PDF resource path.');
  const file = path.join(root, ...relative.split('/'));
  for (let current = file; ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`PDF resources cannot follow links: ${relative}`);
    if (path.dirname(current) === current) break;
  }
  if (!lstatSync(file).isFile() || realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error(`PDF resource identity changed: ${relative}`);
  return readFileSync(file);
}

/** Select the real recursive DLL closure, retaining the distribution's auxiliary layout. */
export function selectNativePdfResources(sourceRoot: string): NativePdfResourceReceipt {
  const binaries = new Map(readdirSync(path.join(sourceRoot, 'Library', 'bin')).map((name) => [name.toLowerCase(), name]));
  const selected = new Set<string>(); const system = new Set<string>();
  const imports: Record<string, string[]> = {};
  const queue: string[] = [...EXECUTABLES];
  while (queue.length) {
    const requested = queue.shift()!; const name = binaries.get(requested);
    if (!name) throw new Error(`Missing portable PDF dependency: ${requested}`);
    const relative = `Library/bin/${name}`;
    if (selected.has(relative)) continue;
    selected.add(relative); imports[relative] = readNativePeImports(readPhysicalFile(sourceRoot, relative));
    for (const dependency of imports[relative]) {
      if (isSystemDll(dependency)) system.add(dependency);
      else queue.push(dependency);
    }
  }
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(sourceRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`PDF auxiliary resource is a link: ${child}`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) selected.add(child);
    }
  };
  for (const directory of ['Library/etc/fonts', 'Library/share/fonts', 'share/poppler']) visit(directory);
  selected.add('manifest.json');
  const files = [...selected].sort().map((relative) => {
    const bytes = readPhysicalFile(sourceRoot, relative);
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  });
  return { schemaVersion: 1, files, imports, systemDlls: [...system].sort() };
}

export function verifyNativePdfResources(root: string, receipt: NativePdfResourceReceipt): void {
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.files) || !receipt.files.length) throw new Error('A portable PDF resource receipt is required.');
  const names = new Set<string>();
  const imports: Array<{ path: string; names: string[] }> = [];
  for (const file of receipt.files) {
    if (names.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid portable PDF resource receipt.');
    names.add(file.path.toLowerCase());
    const bytes = readPhysicalFile(root, file.path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`PDF resource hash mismatch: ${file.path}`);
    if (/^Library\/bin\/.*\.(exe|dll)$/i.test(file.path)) imports.push({ path: file.path, names: readNativePeImports(bytes) });
  }
  for (const executable of EXECUTABLES) if (!names.has(`library/bin/${executable}`)) throw new Error(`PDF receipt omits ${executable}.`);
  // Recompute the import graph once per verification, so a two-EXE-only receipt cannot pass.
  for (const file of imports) {
    if (JSON.stringify(file.names) !== JSON.stringify(receipt.imports[file.path])) throw new Error(`PDF import receipt mismatch: ${file.path}`);
    for (const dependency of file.names) if (!isSystemDll(dependency) && !names.has(`library/bin/${dependency}`)) throw new Error(`PDF receipt omits dependency: ${dependency}`);
  }
  for (const prefix of ['Library/etc/fonts/', 'Library/share/fonts/', 'share/poppler/']) if (!receipt.files.some((file) => file.path.startsWith(prefix))) throw new Error(`PDF receipt omits auxiliary resources: ${prefix}`);
}

/** The receipt is packaged beside the tools; no cache, PATH lookup, or downloads are fallback sources. */
export function createPackagedNativePdfTools(options: { resourcesPath: string }) {
  const root = path.join(options.resourcesPath, 'pdf-tools');
  const receipt = JSON.parse(readPhysicalFile(root, 'receipt.json').toString('utf8')) as NativePdfResourceReceipt;
  verifyNativePdfResources(root, receipt);
  return nativePdfTools(root, receipt);
}

/** Development-only explicit source; inventory is captured once, with no copy or staging. */
export function createNativePdfToolsFromSource(options: { sourceRoot: string }) {
  const root = path.resolve(options.sourceRoot);
  return nativePdfTools(root, selectNativePdfResources(root));
}

/**
 * A development folder that opted in with receipt.json: verified against that receipt now and before every session, as a
 * packaged folder is, so a file changed before the start is caught.
 */
export function createNativePdfToolsFromReceipt(options: { sourceRoot: string }) {
  const root = path.resolve(options.sourceRoot); const file = path.join(root, 'receipt.json');
  let receipt: NativePdfResourceReceipt;
  try { receipt = JSON.parse(readPhysicalFile(root, 'receipt.json').toString('utf8')) as NativePdfResourceReceipt; }
  catch (error) { throw new Error(`The PDF tools receipt ${file} cannot be read (${error instanceof Error ? error.message : String(error)}).`, { cause: error }); }
  try { verifyNativePdfResources(root, receipt); }
  catch (error) {
    if (error instanceof TypeError) throw new Error(`The PDF tools receipt ${file} is not a valid receipt (${error.message}).`, { cause: error });
    throw error;
  }
  return nativePdfTools(root, receipt);
}

function nativePdfTools(root: string, receipt: NativePdfResourceReceipt) {
  const directory = path.join(root, 'Library', 'bin');
  if (/[\u0000-\u001f;]/.test(directory)) throw new Error('PDF directory cannot be represented safely in the child PATH.');
  const hashes = Object.freeze(Object.fromEntries(EXECUTABLES.map((name) => [name, receipt.files.find((file) => file.path === `Library/bin/${name}`)?.sha256 ?? ''])) as Record<typeof EXECUTABLES[number], string>);
  const verify = () => verifyNativePdfResources(root, receipt);
  return Object.freeze({ directory, hashes, verify, withEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    verify();
    const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
    if (keys.length > 1) throw new Error('Native child environment contains duplicate PATH keys.');
    const key = keys[0] ?? 'PATH';
    // Prepend: appending lets an unrelated system or user pdfinfo shadow our verified binary.
    const rest = (env[key] ?? '').split(';').filter((entry) => entry && entry.toLowerCase() !== directory.toLowerCase());
    return { ...env, [key]: [directory, ...rest].join(';') };
  } });
}
