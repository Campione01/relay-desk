import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '../../src/shared/types';
import { createNativeUsageCache } from '../../src/main/native/usage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('No SDK query is allowed during invalidation.'); } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const profile = (id: string) => ({ id, name: id, configDir: null, createdAt: 0 });
const deps = { emit: vi.fn(), getProfile: async (id: string) => profile(id), now: () => 50 };
const reading = (percent = 25, profileId = 'one'): PlanUsage =>
  ({ profileId, available: true, windows: [{ id: 'five_hour', percent, resetsAt: 1000 }], fetchedAt: 40 });

describe('native authentication-source usage invalidation', () => {
  it('awaits initial memory, removes exactly one profile and prevents old memory or reads from returning it', async () => {
    const loaded = deferred<Record<string, PlanUsage>>();
    const forget = vi.fn(async () => undefined);
    const cache = createNativeUsageCache({ load: () => loaded.promise, save: vi.fn(), forget });
    const service = cache.createService(deps);
    cache.observe({ type: 'usage', usage: reading(30) });
    const pending = service.get('one');
    const invalidating = service.invalidate!('one');
    expect(cache.generation('one')).toBe(1);
    expect(forget).not.toHaveBeenCalled();
    loaded.resolve({ one: reading(90), two: reading(8, 'two') });
    await invalidating;
    expect(forget).toHaveBeenCalledExactlyOnceWith('one');
    expect(await pending).toMatchObject({ available: false, windows: [], error: expect.stringContaining('invalidated') });
    expect((await service.get('one')).available).toBe(false);
    expect((await service.get('two')).windows[0]?.percent).toBe(8);
    await service.dispose();
  });

  it('deduplicates invalidation and holds fresh reads and observations behind persistent forgetting', async () => {
    const forgotten = deferred<void>();
    const forget = vi.fn(() => forgotten.promise);
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({}), save, forget });
    const nativePlanUsage = vi.fn(async () => reading(3));
    const service = cache.createService({ ...deps, liveSession: () => ({ nativePlanUsage }) });
    const first = service.invalidate!('one');
    expect(service.invalidate!('one')).toBe(first);
    const fresh = service.get('one', true);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    cache.observe({ type: 'usage', usage: reading(99) });
    expect(nativePlanUsage).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    forgotten.resolve();
    await first;
    expect((await fresh).windows[0]?.percent).toBe(3);
    expect(nativePlanUsage).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('ignores a late native result and does not let its finally remove a newer in-flight read', async () => {
    const old = deferred<PlanUsage>(), fresh = deferred<PlanUsage>();
    const save = vi.fn();
    const cache = createNativeUsageCache({ load: async () => ({}), save, forget: async () => undefined });
    const nativePlanUsage = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const service = cache.createService({ ...deps, liveSession: () => ({ nativePlanUsage }) });
    const before = service.get('one', true);
    await vi.waitFor(() => expect(nativePlanUsage).toHaveBeenCalledTimes(1));
    await service.invalidate!('one');
    const after = service.get('one', true);
    await vi.waitFor(() => expect(nativePlanUsage).toHaveBeenCalledTimes(2));
    old.resolve(reading(99));
    expect(await before).toMatchObject({ available: false, windows: [], error: expect.stringContaining('invalidated') });
    expect(service.get('one', true)).toBe(after);
    expect(save).not.toHaveBeenCalled();
    fresh.resolve(reading(3));
    expect((await after).windows[0]?.percent).toBe(3);
    expect(save).toHaveBeenCalledExactlyOnceWith(reading(3));
    await service.dispose();
  });

  it('does not start a native read after invalidation during profile lookup', async () => {
    const lookup = deferred<ReturnType<typeof profile>>();
    const getProfile = vi.fn(() => lookup.promise), nativePlanUsage = vi.fn(async () => reading());
    const cache = createNativeUsageCache();
    const service = cache.createService({ ...deps, getProfile, liveSession: () => ({ nativePlanUsage }) });
    const pending = service.get('one', true);
    await vi.waitFor(() => expect(getProfile).toHaveBeenCalledTimes(1));
    await service.invalidate!('one');
    lookup.resolve(profile('one'));
    expect(await pending).toMatchObject({ available: false, windows: [] });
    expect(nativePlanUsage).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('rejects identifiable old-session observations after forgetting and accepts the new session generation', async () => {
    const cache = createNativeUsageCache(undefined, () => 50);
    const service = cache.createService(deps);
    const oldSessionGeneration = cache.generation('one');
    await service.invalidate!('one');
    expect(cache.observe({ type: 'usage', usage: reading(99) }, oldSessionGeneration)).toBeUndefined();
    expect((await service.get('one')).available).toBe(false);
    const newSessionGeneration = cache.generation('one');
    expect(cache.observe({ type: 'usage', usage: reading(3) }, newSessionGeneration)?.windows[0]?.percent).toBe(3);
    expect((await service.get('one')).windows[0]?.percent).toBe(3);
    await service.dispose();
  });

  it('propagates forget failure and permits a later explicit retry without reviving memory', async () => {
    const forget = vi.fn().mockRejectedValueOnce(new Error('persistent removal failed')).mockResolvedValueOnce(undefined);
    const cache = createNativeUsageCache({ load: async () => ({ one: reading(99) }), save: vi.fn(), forget });
    const service = cache.createService(deps);
    await expect(service.invalidate!('one')).rejects.toThrow('persistent removal failed');
    expect((await service.get('one')).available).toBe(false);
    await service.invalidate!('one');
    expect(forget).toHaveBeenCalledTimes(2);
    expect(cache.generation('one')).toBe(2);
    await service.dispose();
  });

  it('disposal still waits for old reads detached by invalidation', async () => {
    const pending = deferred<PlanUsage>();
    const nativePlanUsage = vi.fn(() => pending.promise);
    const cache = createNativeUsageCache();
    const service = cache.createService({ ...deps, liveSession: () => ({ nativePlanUsage }) });
    const readingPromise = service.get('one', true);
    await vi.waitFor(() => expect(nativePlanUsage).toHaveBeenCalledTimes(1));
    await service.invalidate!('one');
    let closed = false;
    const closing = service.dispose().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve(reading());
    await closing;
    expect(await readingPromise).toMatchObject({ available: false, windows: [] });
    expect(closed).toBe(true);
  });
});
