import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '../../src/shared/types';
import { createNativeUsageCache } from '../../src/main/native/usage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('SDK query is forbidden in native usage.'); } }));

function reading(profileId = 'one', percent = 25, resetsAt = 1000): PlanUsage {
  return { profileId, available: true, windows: [{ id: 'five_hour', percent, resetsAt }], fetchedAt: 10 };
}
const deps = { emit: vi.fn(), getProfile: async (id: string) => ({ id, name: id, configDir: null, createdAt: 0 }), now: () => 50 };

describe('native-only usage', () => {
  it('reports unavailable without starting an SDK probe or inventing a zero', async () => {
    const service = createNativeUsageCache().createService(deps);
    expect(await service.get('one', true)).toMatchObject({ available: false, windows: [], error: expect.stringContaining('No subscription usage') });
    await service.dispose();
  });

  it('keeps account boundaries and same-window high water while permitting a real reset', async () => {
    const cache = createNativeUsageCache();
    const first = reading();
    cache.observe({ type: 'usage', usage: first });
    first.windows[0]!.percent = 99;
    cache.observe({ type: 'usage', usage: reading('one', 20) });
    const service = cache.createService(deps);
    expect((await service.get('one')).windows[0]?.percent).toBe(25);
    expect((await service.get('two')).available).toBe(false);
    cache.observe({ type: 'usage', usage: reading('one', 3, 2000) });
    expect((await service.get('one')).windows[0]?.percent).toBe(3);
    await service.dispose();
  });

  it('deduplicates refresh, uses an existing idle native session and never probes busy sessions', async () => {
    const cache = createNativeUsageCache();
    const contextUsage = vi.fn(async () => { cache.observe({ type: 'usage', usage: reading() }); });
    let busy = true;
    const service = cache.createService({ ...deps, liveSession: () => ({ planUsage: vi.fn(), contextUsage }), isProfileBusy: () => busy });
    await service.get('one', true);
    expect(contextUsage).not.toHaveBeenCalled();
    busy = false;
    const a = service.get('one', true);
    const b = service.get('one', true);
    expect(a).toBe(b);
    expect((await a).available).toBe(true);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    expect(contextUsage).toHaveBeenCalledWith('summary');
    await service.dispose();
    await service.get('one', true);
    expect(contextUsage).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a live reading with older memory and preserves last-known data on refresh failure', async () => {
    let finish!: (rows: Record<string, PlanUsage>) => void;
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: () => new Promise((resolve) => { finish = resolve; }), save });
    cache.observe({ type: 'usage', usage: reading('one', 40) });
    finish({ one: reading('one', 10) });
    const service = cache.createService({ ...deps, liveSession: () => ({ planUsage: vi.fn(), contextUsage: async () => { throw new Error('offline'); } }) });
    expect((await service.get('one', true)).windows[0]?.percent).toBe(40);
    cache.observe({ type: 'usage', usage: { ...reading('one', 0), available: false, error: 'offline' } });
    expect(save).toHaveBeenCalledTimes(1);
    await service.dispose();
  });
});
