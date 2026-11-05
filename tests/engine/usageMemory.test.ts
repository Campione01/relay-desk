import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '@shared/types';
import { createUsageMemory } from '../../src/main/engine/usageMemory';

const dirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-usage-memory-'));
  dirs.push(dir);
  return join(dir, 'usage-cache.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const USAGE: PlanUsage = {
  profileId: 'default',
  available: true,
  subscriptionType: 'pro',
  windows: [
    { id: 'five_hour', percent: 99, resetsAt: 1_792_333_800_000, status: 'allowed_warning' },
    { id: 'model_scoped:Fable', percent: 0, resetsAt: 1_792_634_400_000 },
  ],
  fetchedAt: 1_792_330_000_000,
  extraUsage: { enabled: false, percent: null, usedCredits: null, monthlyLimit: null, currency: null },
};

describe('usage memory', () => {
  it('saves windows per account and loads them in a new instance; failures and unusable entries are skipped', async () => {
    const path = await tempFile();
    const memory = createUsageMemory(path);
    expect(await memory.load()).toEqual({});
    memory.save(USAGE);
    memory.save({ profileId: 'work', available: false, windows: [], fetchedAt: 5, error: 'probe failed' });
    memory.save({ ...USAGE, profileId: 'work', subscriptionType: undefined, windows: [{ id: 'seven_day', percent: null, resetsAt: null }] });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8')).profiles.work).toBeDefined());
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toEqual({
      version: 1,
      profiles: {
        default: { subscriptionType: 'pro', windows: USAGE.windows, savedAt: USAGE.fetchedAt },
        work: { windows: [{ id: 'seven_day', percent: null, resetsAt: null }], savedAt: USAGE.fetchedAt },
      },
    });
    expect(await createUsageMemory(path).load()).toEqual({
      default: { profileId: 'default', available: true, subscriptionType: 'pro', windows: USAGE.windows, fetchedAt: USAGE.fetchedAt },
      work: { profileId: 'work', available: true, windows: [{ id: 'seven_day', percent: null, resetsAt: null }], fetchedAt: USAGE.fetchedAt },
    });
  });

  it('ignores a broken file and malformed entries, and keeps a "__proto__" id as plain data', async () => {
    const path = await tempFile();
    await writeFile(path, 'not json', 'utf8');
    expect(await createUsageMemory(path).load()).toEqual({});
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: {
          a: { windows: [{ id: 'five_hour', percent: '9', resetsAt: 1 }, { id: '', percent: 1, resetsAt: 1 }, { id: 'seven_day', percent: 2, resetsAt: 3, status: 'odd' }], savedAt: 7 },
          b: { windows: 'none', savedAt: 7 },
          c: { windows: [], savedAt: 'later' },
          proto_placeholder: { windows: [{ id: 'five_hour', percent: 1, resetsAt: 2 }], savedAt: 7 },
        },
      }).replace('"proto_placeholder"', '"__proto__"'),
      'utf8',
    );
    const loaded = await createUsageMemory(path).load();
    expect(Object.keys(loaded).sort()).toEqual(['__proto__', 'a']);
    expect(loaded.a?.windows).toEqual([{ id: 'seven_day', percent: 2, resetsAt: 3 }]);
    expect(({} as Record<string, unknown>).windows).toBeUndefined();
  });

  it('serializes forgetting one profile after prior saves and preserves other profiles across restart', async () => {
    const path = await tempFile();
    const memory = createUsageMemory(path);
    memory.save(USAGE);
    memory.save({ ...USAGE, profileId: 'default-extra' });
    memory.save({ ...USAGE, profileId: 'work' });
    await memory.forget!('default');
    expect(Object.keys(await memory.load()).sort()).toEqual(['default-extra', 'work']);
    const restarted = createUsageMemory(path);
    expect(Object.keys(await restarted.load()).sort()).toEqual(['default-extra', 'work']);
    expect(JSON.parse(await readFile(path, 'utf8')).profiles.default).toBeUndefined();
  });

  it('awaits the initial disk load and removes a literal __proto__ profile without affecting siblings', async () => {
    const path = await tempFile();
    const memory = createUsageMemory(path);
    memory.save(USAGE);
    memory.save({ ...USAGE, profileId: '__proto__' });
    await memory.forget!('missing');
    const restarted = createUsageMemory(path);
    await restarted.forget!('__proto__');
    expect(Object.keys(await createUsageMemory(path).load())).toEqual(['default']);
    expect(({} as Record<string, unknown>).windows).toBeUndefined();
  });

  it('does not discard a later replacement save queued after forgetting', async () => {
    const path = await tempFile();
    const memory = createUsageMemory(path);
    memory.save(USAGE);
    const forgotten = memory.forget!('default');
    const replacement = { ...USAGE, subscriptionType: 'max', fetchedAt: USAGE.fetchedAt + 1 };
    memory.save(replacement);
    await forgotten;
    await memory.forget!('missing');
    expect((await createUsageMemory(path).load()).default).toMatchObject({ subscriptionType: 'max', fetchedAt: replacement.fetchedAt });
  });

  it('reports persistent deletion failures to the authentication-source caller', async () => {
    const path = await tempFile();
    await writeFile(path, 'not a directory', 'utf8');
    const memory = createUsageMemory(join(path, 'usage-cache.json'));
    await expect(memory.forget!('default')).rejects.toThrow();
  });
});
