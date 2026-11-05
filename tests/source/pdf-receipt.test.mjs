import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPackagedNativePdfTools } from '../../src/main/native/pdfResources.ts';
import { checkPdfTools, describePdfTools } from '../../tools/release/build.mjs';
import { defaultPdfToolsDir, writePdfReceipt } from '../../tools/pdf/receipt.mjs';
import { temporary } from './cli-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A minimal AMD64 PE image that only imports the given DLLs; it is never run. */
function pe(imports = ['KERNEL32.dll']) {
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

async function poppler(root) {
  const put = async (relative, data) => { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data); };
  await put('Library/bin/pdfinfo.exe', pe(['poppler.dll', 'KERNEL32.dll']));
  await put('Library/bin/pdftoppm.exe', pe(['poppler.dll']));
  await put('Library/bin/poppler.dll', pe(['vcruntime140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']));
  await put('Library/bin/vcruntime140.dll', pe());
  await put('Library/bin/unused.dll', pe());
  await put('Library/etc/fonts/fonts.conf', '<fontconfig/>');
  await put('Library/share/fonts/font.stub', 'unit fixture, not a font');
  await put('share/poppler/cMap/map.stub', 'unit character map');
  await put('manifest.json', '{"name":"synthetic poppler"}');
  return root;
}

test('writes a verifiable receipt for the dependency closure of the two PDF tools', async (t) => {
  const resources = path.join(await temporary(t, 'relay-pdf-receipt-'), 'resources'), root = await poppler(path.join(resources, 'pdf-tools'));
  const { file, receipt } = writePdfReceipt(root);
  assert.equal(file, path.join(root, 'receipt.json'));
  assert.deepEqual(receipt.files.map((item) => item.path), ['Library/bin/pdfinfo.exe', 'Library/bin/pdftoppm.exe', 'Library/bin/poppler.dll',
    'Library/bin/vcruntime140.dll', 'Library/etc/fonts/fonts.conf', 'Library/share/fonts/font.stub', 'manifest.json', 'share/poppler/cMap/map.stub']);
  assert.deepEqual(receipt.systemDlls, ['api-ms-win-crt-runtime-l1-1-0.dll', 'kernel32.dll']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), receipt);
  assert.equal(createPackagedNativePdfTools({ resourcesPath: resources }).directory, path.join(root, 'Library', 'bin'));
  const project = path.dirname(resources);
  assert.deepEqual(await checkPdfTools(project, {}), { enabled: true, source: 'resources/pdf-tools', files: 8 });
  await writeFile(path.join(root, 'Library/share/fonts/font.stub'), 'changed');
  await assert.rejects(checkPdfTools(project, {}), /PDF resource hash mismatch: Library\/share\/fonts\/font\.stub/);
  await rm(path.join(root, 'receipt.json'));
  assert.deepEqual(await checkPdfTools(project, {}), { enabled: false, source: 'resources/pdf-tools' });
});

test('the build checks the folder the app reads: RELAY_DESK_PDF_TOOLS_DIR first, then resources/pdf-tools', async (t) => {
  const work = await temporary(t, 'relay-pdf-receipt-');
  const project = path.join(work, 'project'), external = await poppler(path.join(work, 'external'));
  writePdfReceipt(external);
  const env = { RELAY_DESK_PDF_TOOLS_DIR: external };
  const enabled = await checkPdfTools(project, env);
  assert.deepEqual(enabled, { enabled: true, source: 'RELAY_DESK_PDF_TOOLS_DIR', files: 8 });
  assert.equal(describePdfTools(enabled), 'PDF attachments are enabled for npm start: 8 files in the RELAY_DESK_PDF_TOOLS_DIR folder verified. '
    + 'Packaged builds (npm run dist) include no PDF tools and ignore RELAY_DESK_PDF_TOOLS_DIR, so they refuse PDF attachments.');
  assert.deepEqual(await checkPdfTools(project, { RELAY_DESK_PDF_TOOLS_DIR: '' }), { enabled: false, source: 'resources/pdf-tools' });
  const local = await poppler(path.join(project, 'resources', 'pdf-tools'));
  writePdfReceipt(local);
  await writeFile(path.join(external, 'manifest.json'), 'changed');
  await assert.rejects(checkPdfTools(project, env), /PDF resource hash mismatch: manifest\.json/, 'a set variable wins over resources/pdf-tools, as in the app');
  for (const value of ['poppler', '\\\\server\\share\\poppler', '//server/share/poppler']) {
    const refused = await checkPdfTools(project, { RELAY_DESK_PDF_TOOLS_DIR: value });
    assert.deepEqual(refused, { enabled: false, source: 'RELAY_DESK_PDF_TOOLS_DIR', invalid: true }, value);
    assert.equal(describePdfTools(refused), 'PDF attachments are disabled: RELAY_DESK_PDF_TOOLS_DIR is not a local absolute path (see BUILD.md).');
  }
  await rm(path.join(external, 'receipt.json'));
  const absent = await checkPdfTools(project, env);
  assert.deepEqual(absent, { enabled: false, source: 'RELAY_DESK_PDF_TOOLS_DIR' });
  assert.equal(describePdfTools(absent), 'PDF attachments are disabled: the RELAY_DESK_PDF_TOOLS_DIR folder has no receipt.json (optional; see BUILD.md).');
  assert.deepEqual(await checkPdfTools(project, {}), { enabled: true, source: 'resources/pdf-tools', files: 8 });
});

test('refuses an incomplete folder instead of writing a partial receipt', async (t) => {
  const root = await poppler(path.join(await temporary(t, 'relay-pdf-receipt-'), 'poppler'));
  await rm(path.join(root, 'Library/bin/vcruntime140.dll'));
  assert.throws(() => writePdfReceipt(root), /Missing portable PDF dependency: vcruntime140\.dll/);
  await assert.rejects(readFile(path.join(root, 'receipt.json')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'Library/bin/vcruntime140.dll'), pe());
  await rm(path.join(root, 'manifest.json'));
  assert.throws(() => writePdfReceipt(root), { code: 'ENOENT' });
  assert.throws(() => writePdfReceipt('relative\\poppler'), /absolute/);
});

test('the folder comes from --dir, RELAY_DESK_PDF_TOOLS_DIR or resources/pdf-tools', async (t) => {
  assert.equal(defaultPdfToolsDir({}, 'C:\\project'), path.join('C:\\project', 'resources', 'pdf-tools'));
  assert.equal(defaultPdfToolsDir({ RELAY_DESK_PDF_TOOLS_DIR: 'C:\\Users\\me\\poppler' }, 'C:\\project'), 'C:\\Users\\me\\poppler');
  for (const value of ['poppler', '\\\\server\\share\\poppler']) assert.throws(() => defaultPdfToolsDir({ RELAY_DESK_PDF_TOOLS_DIR: value }), /local absolute path/);
  const root = await poppler(path.join(await temporary(t, 'relay-pdf-receipt-'), 'poppler'));
  const script = path.join(ROOT, 'tools', 'pdf', 'receipt.mjs');
  const written = spawnSync(process.execPath, [script, '--dir', root], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(written.status, 0, written.stderr); assert.match(written.stdout, /Wrote .*receipt\.json: 8 files/);
  const fromEnv = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, RELAY_DESK_PDF_TOOLS_DIR: root } });
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  for (const args of [['--dir'], ['--dir', 'relative'], ['--other', root]]) {
    const refused = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(refused.status, 1); assert.match(refused.stderr, /Usage/);
  }
});
