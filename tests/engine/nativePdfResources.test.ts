import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativePdfToolsFromSource, createPackagedNativePdfTools, readNativePeImports, selectNativePdfResources, verifyNativePdfResources } from '../../src/main/native/pdfResources.ts';

function pe(imports: string[] = ['KERNEL32.dll'], delayImports: string[] = []): Buffer {
  const bytes = Buffer.alloc(0x1200);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  let stringOffset = 0x800;
  for (const [names, index, offset, stride, nameOffset] of [[imports, 1, 0x200, 20, 12], [delayImports, 13, 0x400, 32, 4]] as const) {
    if (!names.length) continue;
    bytes.writeUInt32LE(offset + 0xe00, optional + 112 + index * 8);
    bytes.writeUInt32LE((names.length + 1) * stride, optional + 116 + index * 8);
    names.forEach((name, i) => {
      if (index === 13) bytes.writeUInt32LE(1, offset + i * stride);
      bytes.writeUInt32LE(stringOffset + 0xe00, offset + i * stride + nameOffset);
      bytes.write(name, stringOffset, 'ascii'); stringOffset += name.length + 1;
    });
  }
  return bytes;
}

const temporaryRoot = path.resolve('.tmp');
const owned: string[] = [];
function fixture() {
  mkdirSync(temporaryRoot, { recursive: true });
  const resourcesPath = mkdtempSync(path.join(temporaryRoot, 'pdf-resources-')); owned.push(resourcesPath);
  const root = path.join(resourcesPath, 'pdf-tools');
  const put = (relative: string, data: Buffer | string) => {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, data);
  };
  put('Library/bin/pdfinfo.exe', pe(['poppler.dll', 'KERNEL32.dll']));
  put('Library/bin/pdftoppm.exe', pe(['poppler.dll'], ['codec.dll']));
  put('Library/bin/poppler.dll', pe(['codec.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']));
  put('Library/bin/codec.dll', pe());
  put('Library/bin/unrelated.dll', pe());
  put('Library/etc/fonts/fonts.conf', '<fontconfig/>');
  put('Library/share/fonts/font.stub', 'unit fixture, not a font');
  put('share/poppler/cMap/map.stub', 'unit character map');
  put('manifest.json', '{"name":"poppler"}');
  return { root, resourcesPath, put };
}
afterEach(() => {
  for (const directory of owned.splice(0)) {
    if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith('pdf-resources-')) throw new Error('Unexpected test cleanup boundary.');
    rmSync(directory, { recursive: true });
  }
});

describe('portable native PDF resource closure', () => {
  it('reads normal and delay PE imports without executing a binary', () => {
    expect(readNativePeImports(pe(['Poppler.dll', 'KERNEL32.dll'], ['Codec.dll']))).toEqual(['codec.dll', 'kernel32.dll', 'poppler.dll']);
    expect(() => readNativePeImports(Buffer.from('not a PE'))).toThrow('Truncated');
    const wrongArch = pe(); wrongArch.writeUInt16LE(0x14c, 0x84);
    expect(() => readNativePeImports(wrongArch)).toThrow('AMD64');
    const invalidRva = pe(); invalidRva.writeUInt32LE(0x40000000, 0x98 + 120);
    expect(() => readNativePeImports(invalidRva)).toThrow('outside');
  });

  it('selects transitive local DLLs and data, not unrelated executables or DLLs', () => {
    const { root } = fixture(); const receipt = selectNativePdfResources(root);
    expect(receipt.files.map((file) => file.path)).toEqual([
      'Library/bin/codec.dll', 'Library/bin/pdfinfo.exe', 'Library/bin/pdftoppm.exe', 'Library/bin/poppler.dll',
      'Library/etc/fonts/fonts.conf', 'Library/share/fonts/font.stub', 'manifest.json', 'share/poppler/cMap/map.stub',
    ]);
    expect(receipt.systemDlls).toEqual(['api-ms-win-crt-runtime-l1-1-0.dll', 'kernel32.dll']);
    expect(() => verifyNativePdfResources(root, receipt)).not.toThrow();
  });

  it('fails instead of resolving missing transitive dependencies through ambient PATH', () => {
    const { root } = fixture(); rmSync(path.join(root, 'Library/bin/codec.dll'));
    expect(() => selectNativePdfResources(root)).toThrow('Missing portable PDF dependency: codec.dll');
  });

  it('rejects DLL mutation, incomplete two-EXE receipts, and altered import evidence', () => {
    const { root, put } = fixture(); const receipt = selectNativePdfResources(root);
    const original = readFileSync(path.join(root, 'Library/bin/codec.dll'));
    put('Library/bin/codec.dll', Buffer.concat([original, Buffer.from('changed')]));
    expect(() => verifyNativePdfResources(root, receipt)).toThrow('hash mismatch');
    put('Library/bin/codec.dll', original);
    expect(() => verifyNativePdfResources(root, { ...receipt, files: receipt.files.filter((file) => !file.path.endsWith('.dll')) })).toThrow('omits dependency');
    expect(() => verifyNativePdfResources(root, { ...receipt, imports: { ...receipt.imports, 'Library/bin/pdfinfo.exe': [] } })).toThrow('import receipt mismatch');
  });

  it('rejects missing auxiliary resources and unsafe receipt paths', () => {
    const { root } = fixture(); const receipt = selectNativePdfResources(root);
    expect(() => verifyNativePdfResources(root, { ...receipt, files: receipt.files.filter((file) => !file.path.startsWith('share/poppler/')) })).toThrow('auxiliary');
    expect(() => verifyNativePdfResources(root, { ...receipt, files: [{ ...receipt.files[0], path: '../outside.dll' }, ...receipt.files.slice(1)] })).toThrow('resource path');
  });

  it('uses only packaged resources and prepends their verified directory in a copied child environment', () => {
    const { root, resourcesPath, put } = fixture(); const receipt = selectNativePdfResources(root);
    put('receipt.json', JSON.stringify(receipt));
    const tools = createPackagedNativePdfTools({ resourcesPath });
    const before = { Path: 'C:\\unrelated-pdf;C:\\Windows\\System32', OTHER: 'preserved' };
    const after = tools.withEnvironment(before);
    expect(after.Path).toBe(`${tools.directory};${before.Path}`);
    expect(after.OTHER).toBe('preserved'); expect(before.Path).toBe('C:\\unrelated-pdf;C:\\Windows\\System32');
    expect(tools.withEnvironment(after).Path).toBe(after.Path);
    expect(() => tools.withEnvironment({ Path: 'one', PATH: 'two' })).toThrow('duplicate PATH');
    put('share/poppler/cMap/map.stub', 'changed');
    expect(() => tools.verify()).toThrow('hash mismatch');
  });

  it('reuses an explicit development source without staging and detects later source changes', () => {
    const { root, put } = fixture();
    const tools = createNativePdfToolsFromSource({ sourceRoot: root });
    expect(tools.directory).toBe(path.join(root, 'Library/bin'));
    expect(() => tools.verify()).not.toThrow();
    put('Library/bin/poppler.dll', pe(['different.dll']));
    expect(() => tools.withEnvironment({ PATH: 'C:\\Windows\\System32' })).toThrow('hash mismatch');
  });
});
