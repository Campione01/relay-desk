import { win32 } from 'node:path';

// Windows path rules are applied explicitly (win32) so validation does not depend on the host platform.

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Normalised absolute local path (drive letter + root), or null when `input` is not one:
 * rejects UNC and device paths (\\server\share, \\?\, \\.\), drive-relative paths, `..` segments,
 * control characters and characters Windows does not allow in names.
 */
export function toLocalAbsolutePath(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) return null;
  if (CONTROL_CHARS.test(input)) return null;
  if (!/^[A-Za-z]:[\\/]/.test(input)) return null;
  const rest = input.slice(3);
  if (/[<>:"|?*]/.test(rest)) return null;
  if (rest.split(/[\\/]+/).some((segment) => segment === '..')) return null;
  const normalized = win32.normalize(input);
  // Drop a trailing separator except on the drive root ("D:\").
  return normalized.length > 3 ? normalized.replace(/[\\]+$/, '') : normalized;
}

/** True when `child` equals `parent` or lies inside it (case-insensitive, Windows rules). */
export function isSameOrInside(child: string, parent: string): boolean {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel));
}
