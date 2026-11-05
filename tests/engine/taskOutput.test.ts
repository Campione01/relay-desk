import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskOutput } from '../../src/main/engine/taskOutput';

const dirs: string[] = [];
function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-task-output-'));
  dirs.push(dir);
  const path = join(dir, 'task.output');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readTaskOutput', () => {
  it('returns a short file whole, without ANSI codes and with secrets redacted', async () => {
    expect(await readTaskOutput(file('\u001b[1mbuild\u001b[0m ok\nANTHROPIC_API_KEY=sk-ant-synthetic-secret-value-123456\n'))).toBe(
      'build ok\nANTHROPIC_API_KEY=[redacted]\n',
    );
  });

  it('keeps only the end of a long file, starting at a full line', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, '0')}`).join('\n');
    const tail = await readTaskOutput(file(lines), 50);
    expect(tail).not.toContain('line 00');
    expect(tail?.startsWith('line ')).toBe(true);
    expect(tail?.endsWith('line 39')).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(50);
  });

  it('answers null for a missing file', async () => {
    expect(await readTaskOutput(join(tmpdir(), 'relay-no-such-dir', 'x.output'))).toBeNull();
  });
});
