import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateNativeAttachmentSubmission } from '../../src/main/native/attachments';
import { selectNativePdfResources } from '../../src/main/native/pdfResources';
import { PDF_TOOLS_ENV, resolveNativePdfTools } from '../../src/main/native/pdfSelection';

/** A minimal AMD64 PE image that only imports the given DLLs; it is never run. */
function pe(imports: string[] = ['KERNEL32.dll']): Buffer {
  const bytes = Buffer.alloc(0x1200);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x200 + 0xe00, optional + 120); bytes.writeUInt32LE((imports.length + 1) * 20, optional + 124);
  let stringOffset = 0x800;
  imports.forEach((name, index) => {
    bytes.writeUInt32LE(stringOffset + 0xe00, 0x200 + index * 20 + 12);
    bytes.write(name, stringOffset, 'ascii'); stringOffset += name.length + 1;
  });
  return bytes;
}

const owned: string[] = [];
function workspace(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'relay-pdf-selection-'))); owned.push(directory);
  return directory;
}
/** A synthetic Poppler layout; with `receipt` it also gets the receipt tools/pdf/receipt.mjs writes. */
function pdfTools(root: string, receipt = true): string {
  const put = (relative: string, data: Buffer | string) => {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, data);
  };
  put('Library/bin/pdfinfo.exe', pe(['poppler.dll', 'KERNEL32.dll']));
  put('Library/bin/pdftoppm.exe', pe(['poppler.dll']));
  put('Library/bin/poppler.dll', pe());
  put('Library/etc/fonts/fonts.conf', '<fontconfig/>');
  put('Library/share/fonts/font.stub', 'unit fixture, not a font');
  put('share/poppler/cMap/map.stub', 'unit character map');
  put('manifest.json', '{"name":"synthetic"}');
  if (receipt) put('receipt.json', JSON.stringify(selectNativePdfResources(root)));
  return root;
}
afterEach(() => {
  for (const directory of owned.splice(0)) {
    if (!path.basename(directory).startsWith('relay-pdf-selection-')) throw new Error('Unexpected test cleanup boundary.');
    rmSync(directory, { recursive: true });
  }
});

describe('optional native PDF tools', () => {
  it('uses packaged tools only with their receipt, and verifies them', () => {
    const resourcesPath = path.join(workspace(), 'resources'), appPath = path.join(resourcesPath, 'app.asar');
    expect(resolveNativePdfTools({ packaged: true, appPath, resourcesPath }, {})).toBeUndefined();
    pdfTools(path.join(resourcesPath, 'pdf-tools'), false);
    expect(resolveNativePdfTools({ packaged: true, appPath, resourcesPath }, {})).toBeUndefined();
    pdfTools(path.join(resourcesPath, 'pdf-tools'));
    const tools = resolveNativePdfTools({ packaged: true, appPath, resourcesPath }, { [PDF_TOOLS_ENV]: path.join(appPath, 'elsewhere') });
    expect(tools?.directory).toBe(path.join(resourcesPath, 'pdf-tools', 'Library', 'bin'));
    expect(tools?.withEnvironment({ PATH: 'C:\\Windows' }).PATH).toBe(`${tools?.directory};C:\\Windows`);
    writeFileSync(path.join(resourcesPath, 'pdf-tools', 'Library', 'bin', 'poppler.dll'), pe(['other.dll']));
    expect(() => resolveNativePdfTools({ packaged: true, appPath, resourcesPath }, {})).toThrow('hash mismatch');
  });

  it('uses <app>/resources/pdf-tools in development only with a receipt', () => {
    const appPath = workspace(), resourcesPath = path.join(appPath, 'unused');
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, {})).toBeUndefined();
    pdfTools(path.join(appPath, 'resources', 'pdf-tools'), false);
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, {})).toBeUndefined();
    pdfTools(path.join(appPath, 'resources', 'pdf-tools'));
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, {})?.directory).toBe(path.join(appPath, 'resources', 'pdf-tools', 'Library', 'bin'));
  });

  it('holds a development folder to its receipt.json when it resolves the tools, as a packaged folder is', () => {
    const appPath = workspace(), resourcesPath = path.join(appPath, 'unused'), external = path.join(workspace(), 'poppler');
    const location = { packaged: false, appPath, resourcesPath };
    const dll = (root: string) => path.join(root, 'Library', 'bin', 'poppler.dll');
    for (const [root, env] of [[path.join(appPath, 'resources', 'pdf-tools'), {}], [external, { [PDF_TOOLS_ENV]: external }]] as const) {
      pdfTools(root);
      expect(resolveNativePdfTools(location, env)).toBeDefined();
      // Changed after the receipt was written and before the start: a fresh inventory would have accepted this.
      writeFileSync(dll(root), pe(['other.dll']));
      expect(() => resolveNativePdfTools(location, env)).toThrow('PDF resource hash mismatch: Library/bin/poppler.dll');
      writeFileSync(dll(root), pe());
      expect(resolveNativePdfTools(location, env)).toBeDefined();
      writeFileSync(path.join(root, 'Library', 'share', 'fonts', 'font.stub'), 'changed font');
      expect(() => resolveNativePdfTools(location, env)).toThrow('PDF resource hash mismatch: Library/share/fonts/font.stub');
      rmSync(path.join(root, 'Library', 'share', 'fonts', 'font.stub'));
      expect(() => resolveNativePdfTools(location, env)).toThrow('font.stub');
    }
  });

  it('keeps checking against the receipt before every session, and names a receipt that cannot be used', () => {
    const appPath = workspace(), resourcesPath = path.join(appPath, 'unused'), root = path.join(appPath, 'resources', 'pdf-tools');
    const location = { packaged: false, appPath, resourcesPath };
    pdfTools(root);
    const tools = resolveNativePdfTools(location, {});
    expect(tools?.withEnvironment({ PATH: 'C:\\Windows' }).PATH).toBe(`${tools?.directory};C:\\Windows`);
    writeFileSync(path.join(root, 'manifest.json'), '{"name":"changed"}');
    expect(() => tools?.withEnvironment({ PATH: 'C:\\Windows' })).toThrow('PDF resource hash mismatch: manifest.json');
    expect(() => tools?.verify()).toThrow('PDF resource hash mismatch: manifest.json');
    const receipt = path.join(root, 'receipt.json');
    for (const [text, reason] of [['{"schemaVersion":1,"files":[', 'cannot be read'], ['', 'cannot be read'], ['null', 'is not a valid receipt'],
      [JSON.stringify({ schemaVersion: 1, files: [{ path: 7, bytes: 1, sha256: 'a'.repeat(64) }], imports: {}, systemDlls: [] }), 'is not a valid receipt'],
      ['{}', 'A portable PDF resource receipt is required.']] as const) {
      writeFileSync(receipt, text);
      expect(() => resolveNativePdfTools(location, {})).toThrow(reason);
    }
    writeFileSync(receipt, '[');
    expect(() => resolveNativePdfTools(location, {})).toThrow(`The PDF tools receipt ${receipt} cannot be read`);
  });

  it('prefers a local absolute RELAY_DESK_PDF_TOOLS_DIR and ignores the project folder when it is set', () => {
    const appPath = workspace(), resourcesPath = path.join(appPath, 'unused'), external = path.join(workspace(), 'poppler');
    pdfTools(path.join(appPath, 'resources', 'pdf-tools'));
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, { [PDF_TOOLS_ENV]: external })).toBeUndefined();
    pdfTools(external);
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, { [PDF_TOOLS_ENV]: external })?.directory).toBe(path.join(external, 'Library', 'bin'));
    // Each refused value names the valid external folder, so only the path rule refuses it.
    const relative = path.relative(process.cwd(), external);
    const refused = [`\\\\?\\${external}`, `//?/${external.replaceAll('\\', '/')}`, ...(path.isAbsolute(relative) ? [] : [relative])];
    for (const value of refused) expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, { [PDF_TOOLS_ENV]: value })).toBeUndefined();
    expect(resolveNativePdfTools({ packaged: false, appPath, resourcesPath }, { [PDF_TOOLS_ENV]: '' })?.directory).toBe(path.join(appPath, 'resources', 'pdf-tools', 'Library', 'bin'));
  });

  it('refuses PDF attachments with a clear message when no PDF tools are configured', () => {
    const pdf = { kind: 'pdf' as const, name: 'paper.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7\n').toString('base64') };
    expect(() => validateNativeAttachmentSubmission({ text: 'Read this', attachments: [pdf] }, false))
      .toThrow('Native PDF attachment requires the verified portable PDF tools in this CLI child; no text-only fallback was submitted.');
  });
});
