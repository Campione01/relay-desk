import { open } from 'node:fs/promises';
import { stripAnsi } from './mapTranscript';
import { redactSecrets } from './redaction';

/** Bytes read from the end of a task's output file. */
export const TASK_OUTPUT_TAIL_BYTES = 64 * 1024;

/** End of a background task's output file, ANSI stripped and redacted; null when the file cannot be read. */
export async function readTaskOutput(path: string, limit = TASK_OUTPUT_TAIL_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // A cut in the middle of a line or a multi-byte character starts at the next full line.
    if (size > length) text = text.slice(text.indexOf('\n') + 1);
    return redactSecrets(stripAnsi(text));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
