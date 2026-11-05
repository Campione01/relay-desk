import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '../../src/shared/types';
import { createNativeUsageCache, nativeUsageObservation, type NativePlanUsageSource } from '../../src/main/native/usage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('SDK queries are forbidden in native usage.'); } }));

const deps = {
  emit: vi.fn(),
  getProfile: async (id: string) => ({ id, name: id, configDir: null, createdAt: 0 }),
  now: () => 50,
};
const reading = (percent = 25, profileId = 'one', at = 40): PlanUsage => nativeUsageObservation({
  rateLimits: [{ kind: 'five_hour', percentUsed: percent }],
}, profileId, at).planUsage!;

function source(read: NativePlanUsageSource['nativePlanUsage']) {
  return {
    nativePlanUsage: vi.fn(read),
    contextUsage: vi.fn(async () => { throw new Error('No extra context request is allowed.'); }),
    planUsage: vi.fn(async () => { throw new Error('No SDK ledger request is allowed.'); }),
  };
}

describe('native plan API compatibility', () => {
  it('consumes a direct native reading without depending on a usage event or fabricating an SDK response', async () => {
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({}), save });
    const live = source(async () => reading());
    const service = cache.createService({ ...deps, liveSession: () => live });
    const result = await service.get('one', true);
    expect(result).toEqual(reading());
    expect(result).not.toHaveProperty('session');
    expect(result).not.toHaveProperty('subscriptionType');
    expect(live.nativePlanUsage).toHaveBeenCalledExactlyOnceWith();
    expect(live.contextUsage).not.toHaveBeenCalled();
    expect(live.planUsage).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledExactlyOnceWith(reading());
    await service.dispose();
  });

  it('treats absent native windows as unknown without falling back to context or an account endpoint', async () => {
    const live = source(async () => null);
    const service = createNativeUsageCache().createService({ ...deps, liveSession: () => live });
    expect(await service.get('one', true)).toMatchObject({ available: false, windows: [],
      error: expect.stringContaining('eligibility is unknown') });
    expect(live.nativePlanUsage).toHaveBeenCalledTimes(1);
    expect(live.contextUsage).not.toHaveBeenCalled();
    expect(live.planUsage).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('reuses cache normally, deduplicates a forced read, and retains the actual timestamp on failure', async () => {
    const cache = createNativeUsageCache();
    cache.observe({ type: 'usage', usage: reading() });
    const live = source(async () => { throw new Error('native session closed'); });
    const service = cache.createService({ ...deps, liveSession: () => live });
    expect(await service.get('one')).toEqual(reading());
    expect(live.nativePlanUsage).not.toHaveBeenCalled();
    const first = service.get('one', true);
    expect(service.get('one', true)).toBe(first);
    expect(await first).toEqual(reading());
    expect(live.nativePlanUsage).toHaveBeenCalledTimes(1);
    expect(live.contextUsage).not.toHaveBeenCalled();
    expect(live.planUsage).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('does not cache or disclose a direct response from another profile', async () => {
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({}), save });
    const live = source(async () => reading(85, 'other'));
    const service = cache.createService({ ...deps, liveSession: () => live });
    expect(await service.get('one', true)).toMatchObject({ profileId: 'one', available: false, windows: [] });
    expect(save).not.toHaveBeenCalled();
    expect(live.contextUsage).not.toHaveBeenCalled();
    expect(live.planUsage).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('does not call SDK-shaped sources, and prevents reads while profile changes are busy', async () => {
    const sdk = { planUsage: vi.fn(async () => { throw new Error('SDK only'); }) };
    const service = createNativeUsageCache().createService({ ...deps, liveSession: () => sdk });
    expect((await service.get('one', true)).available).toBe(false);
    expect(sdk.planUsage).not.toHaveBeenCalled();
    await service.dispose();
    const live = source(async () => reading());
    const busyService = createNativeUsageCache().createService({ ...deps, liveSession: () => live, isProfileBusy: () => true });
    expect((await busyService.get('one', true)).available).toBe(false);
    expect(live.nativePlanUsage).not.toHaveBeenCalled();
    await busyService.dispose();
  });

  it('ignores a late reading after disposal instead of persisting a closed source', async () => {
    let resolve!: (usage: PlanUsage) => void;
    const live = source(() => new Promise((done) => { resolve = done; }));
    const save = vi.fn();
    const service = createNativeUsageCache({ load: async () => ({}), save }).createService({ ...deps, liveSession: () => live });
    const pending = service.get('one', true);
    await vi.waitFor(() => expect(live.nativePlanUsage).toHaveBeenCalledTimes(1));
    const closing = service.dispose();
    resolve(reading());
    expect(await pending).toMatchObject({ available: false, windows: [], error: 'Native usage service is closed.' });
    await closing;
    await service.get('one', true);
    expect(live.nativePlanUsage).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('retains the legacy local-summary path only when the explicit native method is absent', async () => {
    const cache = createNativeUsageCache();
    const contextUsage = vi.fn(async () => { cache.observe({ type: 'usage', usage: reading() }); });
    const service = cache.createService({ ...deps, liveSession: () => ({ contextUsage }) });
    expect(await service.get('one', true)).toEqual(reading());
    expect(contextUsage).toHaveBeenCalledExactlyOnceWith('summary');
    await service.dispose();
  });
});
