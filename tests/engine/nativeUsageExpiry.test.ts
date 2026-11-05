import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '../../src/shared/types';
import { createNativeUsageCache } from '../../src/main/native/usage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('SDK query is forbidden in native usage.'); } }));

const deps = { emit: vi.fn(), getProfile: async (id: string) => ({ id, name: id, configDir: null, createdAt: 0 }) };
const limited = (fetchedAt = 10): PlanUsage => ({ profileId: 'one', available: true, fetchedAt, windows: [
  { id: 'five_hour', percent: 100, resetsAt: 1000, status: 'rejected' },
  { id: 'seven_day', percent: 40, resetsAt: 9000 },
  { id: 'seven_day_opus', percent: 70, resetsAt: 1000 },
] });

describe('native usage window expiry', () => {
  it('restarts an ended core window at zero and drops other ended windows once their reset passes', async () => {
    let now = 500;
    const cache = createNativeUsageCache(undefined, () => now);
    const service = cache.createService(deps);
    expect(cache.observe({ type: 'usage', usage: limited() })?.windows).toEqual(limited().windows);
    expect((await service.get('one')).windows).toEqual(limited().windows);
    now = 1000;
    expect((await service.get('one')).windows).toEqual([
      { id: 'five_hour', percent: 0, resetsAt: null },
      { id: 'seven_day', percent: 40, resetsAt: 9000 },
    ]);
    now = 9000;
    expect((await service.get('one')).windows).toEqual([
      { id: 'five_hour', percent: 0, resetsAt: null },
      { id: 'seven_day', percent: 0, resetsAt: null },
    ]);
    await service.dispose();
    expect((await service.get('one')).windows.map((window) => window.percent)).toEqual([0, 0]);
  });

  it('expires stale persisted readings on load without rewriting memory', async () => {
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({ one: limited() }), save }, () => 2000);
    const service = cache.createService(deps);
    expect((await service.get('one')).windows).toEqual([
      { id: 'five_hour', percent: 0, resetsAt: null },
      { id: 'seven_day', percent: 40, resetsAt: 9000 },
    ]);
    expect(save).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('expires an observed reading that the CLI still reports after its reset, and the stale-snapshot reply too', async () => {
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({}), save }, () => 2000);
    const service = cache.createService({ ...deps, now: () => 2000 });
    expect(cache.observe({ type: 'usage', usage: limited(20) })?.windows.map((window) => window.id)).toEqual(['five_hour', 'seven_day']);
    expect(save).toHaveBeenCalledExactlyOnceWith(limited(20));
    expect(cache.observe({ type: 'usage', usage: limited(15) })?.windows[0]).toEqual({ id: 'five_hour', percent: 0, resetsAt: null });
    expect((await service.get('one')).windows[0]).toEqual({ id: 'five_hour', percent: 0, resetsAt: null });
    await service.dispose();
  });
});
