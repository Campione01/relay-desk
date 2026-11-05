import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { createNativePdfToolsFromReceipt, createPackagedNativePdfTools } from './pdfResources';
import type { NativePdfTools } from './attachments';

export const PDF_TOOLS_ENV = 'RELAY_DESK_PDF_TOOLS_DIR';

export interface NativePdfToolsLocation { packaged: boolean; appPath: string; resourcesPath: string }

/**
 * PDF tools are optional: a builder supplies a Poppler folder and writes its receipt with tools/pdf/receipt.mjs.
 * Packaged builds verify resources/pdf-tools against that receipt. Development uses RELAY_DESK_PDF_TOOLS_DIR (a local
 * absolute path) or <app>/resources/pdf-tools; the receipt opts the folder in, and the folder is verified against it
 * here and again before every session. A folder that fails throws, and the caller turns PDF attachments off.
 * Without a receipt there are no PDF tools, and PDF attachments are refused.
 */
export function resolveNativePdfTools(location: NativePdfToolsLocation, env: NodeJS.ProcessEnv = process.env): NativePdfTools | undefined {
  if (location.packaged) {
    return existsSync(join(location.resourcesPath, 'pdf-tools', 'receipt.json'))
      ? createPackagedNativePdfTools({ resourcesPath: location.resourcesPath }) : undefined;
  }
  const configured = env[PDF_TOOLS_ENV];
  if (configured !== undefined && configured !== '' && (!win32.isAbsolute(configured) || /^[\\/]{2}/.test(configured))) return undefined;
  const root = configured || join(location.appPath, 'resources', 'pdf-tools');
  return existsSync(join(root, 'receipt.json')) ? createNativePdfToolsFromReceipt({ sourceRoot: root }) : undefined;
}
