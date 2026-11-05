import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JsonRead = { state: 'missing' } | { state: 'ok'; value: unknown } | { state: 'invalid' };

/** Reads and parses a JSON file; a missing file and invalid JSON are reported, not thrown. */
export async function readJsonFile(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { state: 'missing' };
    throw error;
  }
  try {
    return { state: 'ok', value: JSON.parse(text.replace(/^﻿/, '')) as unknown };
  } catch {
    return { state: 'invalid' };
  }
}

const RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY'];

/** Writes to a temp file in the same folder, then renames over `path` (retrying briefly on Windows sharing errors). */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, path);
        return;
      } catch (error) {
        if (attempt >= 5 || !RETRY_CODES.some((code) => isCode(error, code))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Moves an unreadable file aside so the next write does not silently replace it. */
export async function quarantineFile(path: string): Promise<void> {
  try {
    // The random part keeps two quarantines in the same millisecond from replacing one another.
    await rename(path, `${path}.invalid-${Date.now()}-${randomBytes(3).toString('hex')}`);
  } catch {
    // Best effort: the store still falls back to defaults.
  }
}

/** Runs async tasks one at a time, in call order. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
