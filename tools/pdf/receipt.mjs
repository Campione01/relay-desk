// Writes receipt.json for a Poppler x64 folder that the builder supplies, so Relay Desk can use it for PDF attachments.
//
//   node tools/pdf/receipt.mjs [--dir <absolute folder>]
//
// The folder defaults to RELAY_DESK_PDF_TOOLS_DIR, then resources/pdf-tools. It must hold Library/bin/pdfinfo.exe and
// pdftoppm.exe with every DLL they load (Visual C++ runtime DLLs included), Library/etc/fonts, Library/share/fonts,
// share/poppler and a manifest.json written by the builder. Nothing is downloaded or run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectNativePdfResources, verifyNativePdfResources } from '../../src/main/native/pdfResources.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USAGE = 'Usage: node tools/pdf/receipt.mjs [--dir <absolute folder>]';

export function defaultPdfToolsDir(env = process.env, root = ROOT) {
  const configured = env.RELAY_DESK_PDF_TOOLS_DIR;
  if (configured) {
    if (!path.win32.isAbsolute(configured) || /^[\\/]{2}/.test(configured)) throw new Error('RELAY_DESK_PDF_TOOLS_DIR must be a local absolute path.');
    return path.resolve(configured);
  }
  return path.join(root, 'resources', 'pdf-tools');
}

/** Selects the dependency closure of the two PDF executables, writes receipt.json and verifies it. */
export function writePdfReceipt(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('The PDF tools folder must be an absolute path.');
  const receipt = selectNativePdfResources(directory);
  const file = path.join(directory, 'receipt.json');
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  verifyNativePdfResources(directory, JSON.parse(readFileSync(file, 'utf8')));
  return { file, receipt };
}

export function runCli(args, env = process.env) {
  let directory;
  if (args.length === 2 && args[0] === '--dir') directory = args[1];
  else if (args.length) throw new Error(USAGE);
  if (directory !== undefined && !path.isAbsolute(directory)) throw new Error(USAGE);
  const { file, receipt } = writePdfReceipt(directory === undefined ? defaultPdfToolsDir(env) : path.resolve(directory));
  const bytes = receipt.files.reduce((sum, item) => sum + item.bytes, 0);
  console.log(`Wrote ${file}: ${receipt.files.length} files, ${bytes} bytes; system DLLs: ${receipt.systemDlls.join(', ') || 'none'}.`);
  console.log('Poppler is GPL software: keep its license and source offer with any build you share.');
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
