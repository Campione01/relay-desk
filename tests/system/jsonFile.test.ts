import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quarantineFile } from '../../src/main/system/jsonFile';

describe('quarantineFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps both copies when two files are moved aside in the same millisecond', async () => {
    // Found by a flaky mcp.json test: the second rename replaced the first quarantined copy.
    const dir = await mkdtemp(join(tmpdir(), 'relay-json-'));
    try {
      vi.spyOn(Date, 'now').mockReturnValue(1_792_000_000_000);
      for (const text of ['{one', '{two']) {
        await writeFile(join(dir, 'a.json'), text);
        await quarantineFile(join(dir, 'a.json'));
      }
      const files = (await readdir(dir)).filter((name) => name.startsWith('a.json.invalid-1792000000000-')).sort();
      expect(files).toHaveLength(2);
      const texts = await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')));
      expect(texts.sort()).toEqual(['{one', '{two']);
      expect(await readdir(dir)).not.toContain('a.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
