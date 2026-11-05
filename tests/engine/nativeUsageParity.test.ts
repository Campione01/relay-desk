import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '../../src/shared/types';
import { createNativeUsageCache, nativeTurnTokens, nativeUsageObservation } from '../../src/main/native/usage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('An SDK usage probe is forbidden.'); } }));

const deps = {
  emit: vi.fn(),
  getProfile: async (id: string) => ({ id, name: id, configDir: null, createdAt: 0 }),
  now: () => 50,
};
const reading = (percent: number, resetsAt: number | null = 1000, fetchedAt = 10): PlanUsage =>
  ({ profileId: 'one', available: true, windows: [{ id: 'five_hour', percent, resetsAt }], fetchedAt });

describe('native usage contract projection', () => {
  it('preserves actual windows, over-limit spend, cumulative cost and launch time without a fabricated ledger', () => {
    const value = nativeUsageObservation({
      startedAt: 25, context: { tokens: 100, window: 1000 }, cost: { usd: 0.123 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-21T12:00:00Z' },
        { kind: 'spend_limit', percentUsed: 120.1 },
      ],
    }, 'one', 50);
    expect(value).toEqual({
      planUsage: { profileId: 'one', available: true, fetchedAt: 50, windows: [
        { id: 'five_hour', percent: 23.5, resetsAt: Date.parse('2026-10-21T12:00:00Z') },
        { id: 'spend_limit', percent: 120.1, resetsAt: null, resetUnknown: true },
      ] },
      sessionStartedAt: 25, sessionCostUsd: 0.123,
    });
    expect(value).not.toHaveProperty('session');
    expect(value.planUsage).not.toHaveProperty('subscriptionType');
    expect(value.planUsage).not.toHaveProperty('extraUsage');
    expect(value.planUsage).not.toHaveProperty('model_scoped');
  });

  it('keeps missing limits, costs and token readings unknown, including empty subscription readings', () => {
    for (const value of [undefined, null, [], {}, { rateLimits: [] }, { context: { tokens: 500, window: 1000 } }]) {
      expect(nativeUsageObservation(value, 'one', 50)).toEqual({});
    }
    expect(nativeUsageObservation({ cost: { usd: 0 }, rateLimits: [] }, 'one', 50)).toEqual({ sessionCostUsd: 0 });
  });

  it('uses explicit zeroes while rejecting negative, nonfinite and nonnumeric figures', () => {
    expect(nativeUsageObservation({ startedAt: 0, cost: { usd: 0 }, rateLimits: [
      { kind: 'seven_day', percentUsed: 0 },
    ] }, 'one', 50)).toEqual({ sessionStartedAt: 0, sessionCostUsd: 0,
      planUsage: { profileId: 'one', available: true, fetchedAt: 50, windows: [{ id: 'seven_day', percent: 0, resetsAt: null, resetUnknown: true }] } });
    for (const invalid of [-1, Infinity, NaN, '1', null, undefined]) {
      expect(nativeUsageObservation({ startedAt: invalid, cost: { usd: invalid },
        rateLimits: [{ kind: 'five_hour', percentUsed: invalid }] }, 'one', 50)).toEqual({});
    }
  });

  it('handles measurement events without session-start metadata and replaces cumulative cost after clear', () => {
    const first = nativeUsageObservation({ startedAt: 10, cost: { usd: 4 } }, 'one', 50);
    const measured = nativeUsageObservation({ changed: ['cost'], cost: { usd: 4.5 } }, 'one', 51);
    const cleared = nativeUsageObservation({ startedAt: 60, cost: { usd: 0 } }, 'one', 60);
    expect(first.sessionCostUsd).toBe(4);
    expect(measured).toEqual({ sessionCostUsd: 4.5 });
    expect(cleared).toEqual({ sessionCostUsd: 0, sessionStartedAt: 60 });
  });

  it('preserves arbitrary native window names and marks missing or invalid reset times unknown', () => {
    const value = nativeUsageObservation({ rateLimits: [
      { kind: 'seven_day_oauth_apps', percentUsed: 12, resetsAt: 'invalid' },
      { kind: 'future_window', percentUsed: 5, resetsAt: 500 },
      { kind: '', percentUsed: 99 }, { kind: ' ', percentUsed: 99 }, { percentUsed: 99 }, null,
    ] }, 'one', 50);
    expect(value.planUsage?.windows).toEqual([
      { id: 'seven_day_oauth_apps', percent: 12, resetsAt: null, resetUnknown: true },
      { id: 'future_window', percent: 5, resetsAt: null, resetUnknown: true },
    ]);
  });
});

describe('native turn token accounting', () => {
  it('adds only the three disjoint native input counts and keeps per-turn output separate', () => {
    expect(nativeTurnTokens({ input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3,
      output_tokens: 4, model: 'native-model' })).toEqual({ inputTokens: 15, outputTokens: 4 });
    // The retained isolated parent/fork/resume report records this exact usage shape.
    expect(nativeTurnTokens({ input_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      output_tokens: 12, model: 'claude-opus-5-5' })).toEqual({ inputTokens: 16, outputTokens: 12 });
  });

  it('does not turn missing, malformed or overflowing input components into a lower total', () => {
    const full = { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 4 };
    for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      for (const invalid of [undefined, null, -1, NaN, Infinity, 1.5, '3']) {
        expect(nativeTurnTokens({ ...full, [key]: invalid })).toEqual({ outputTokens: 4 });
      }
    }
    expect(nativeTurnTokens({ ...full, input_tokens: Number.MAX_SAFE_INTEGER })).toEqual({ outputTokens: 4 });
  });

  it('retains observed zero and omits absent or invalid output independently of input', () => {
    const input = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expect(nativeTurnTokens({ ...input, output_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0 });
    for (const output_tokens of [undefined, null, -1, NaN, Infinity, 1.5, '1']) {
      expect(nativeTurnTokens({ ...input, output_tokens })).toEqual({ inputTokens: 0 });
    }
    expect(nativeTurnTokens(undefined)).toEqual({});
    expect(nativeTurnTokens({ context: { tokens: 500 }, cost: { usd: 1 } })).toEqual({});
  });
});

describe('native observation cache accounting', () => {
  it('does not carry a high water mark across unknown reset periods or invent missing windows', async () => {
    const cache = createNativeUsageCache();
    const service = cache.createService(deps);
    cache.observe({ type: 'usage', usage: reading(95, null) });
    cache.observe({ type: 'usage', usage: reading(3, null, 20) });
    expect((await service.get('one')).windows).toEqual([{ id: 'five_hour', percent: 3, resetsAt: null, resetUnknown: true }]);
    cache.observe({ type: 'usage', usage: { ...reading(20, 2000, 30), windows: [{ id: 'seven_day', percent: 20, resetsAt: 2000 }] } });
    expect((await service.get('one')).windows).toEqual([{ id: 'seven_day', percent: 20, resetsAt: 2000 }]);
    await service.dispose();
  });

  it('rejects older snapshots and preserves the high water only for the exact observed reset', async () => {
    const cache = createNativeUsageCache();
    const service = cache.createService(deps);
    cache.observe({ type: 'usage', usage: reading(95, 1000, 10) });
    cache.observe({ type: 'usage', usage: reading(2, 2000, 20) });
    cache.observe({ type: 'usage', usage: reading(96, 1000, 15) });
    expect((await service.get('one')).windows[0]).toEqual({ id: 'five_hour', percent: 2, resetsAt: 2000 });
    cache.observe({ type: 'usage', usage: reading(1, 2000, 30) });
    expect((await service.get('one')).windows[0]?.percent).toBe(2);
    cache.observe({ type: 'usage', usage: reading(0, 3000, 40) });
    expect((await service.get('one')).windows[0]?.percent).toBe(0);
    await service.dispose();
  });

  it('isolates memory, persistence, observed events and returned snapshots from caller mutation', async () => {
    const initial = reading(12);
    const save = vi.fn((usage: PlanUsage) => { usage.windows[0]!.percent = 999; });
    const cache = createNativeUsageCache({ load: async () => ({ one: initial }), save });
    const service = cache.createService(deps);
    const read = await service.get('one');
    initial.windows[0]!.percent = 800;
    read.windows[0]!.percent = 700;
    expect((await service.get('one')).windows[0]?.percent).toBe(12);
    const event = reading(20, 1000, 20);
    const result = cache.observe({ type: 'usage', usage: event });
    event.windows[0]!.percent = 600;
    result!.windows[0]!.percent = 500;
    expect((await service.get('one')).windows[0]?.percent).toBe(20);
    await service.dispose();
  });

  it('does not load another profile under a mismatched key or accept unavailable/error memory', async () => {
    const cache = createNativeUsageCache({ load: async () => ({
      two: reading(40), three: { ...reading(40), profileId: 'three', available: false },
      four: { ...reading(40), profileId: 'four', error: 'stale failure' },
    }), save: vi.fn() });
    const service = cache.createService(deps);
    for (const id of ['one', 'two', 'three', 'four']) expect((await service.get(id)).available).toBe(false);
    await service.dispose();
  });

  it('restores unknown reset semantics after an older/shared memory reader loses the native marker', async () => {
    const stored = reading(12, null);
    const cache = createNativeUsageCache({ load: async () => ({ one: stored }), save: vi.fn() });
    const service = cache.createService(deps);
    expect((await service.get('one')).windows[0]).toEqual({ id: 'five_hour', percent: 12, resetsAt: null, resetUnknown: true });
    expect(stored.windows[0]).not.toHaveProperty('resetUnknown');
    cache.observe({ type: 'usage', usage: reading(13, 2000, 20) });
    expect((await service.get('one')).windows[0]).toEqual({ id: 'five_hour', percent: 13, resetsAt: 2000 });
    await service.dispose();
  });

  it('keeps real data when persistence fails without throwing into native event delivery', async () => {
    const cache = createNativeUsageCache({ load: async () => ({}), save: () => { throw new Error('disk unavailable'); } });
    const service = cache.createService(deps);
    expect(() => cache.observe({ type: 'usage', usage: reading(20) })).not.toThrow();
    expect((await service.get('one')).windows[0]?.percent).toBe(20);
    await service.dispose();
  });

  it('returns profile errors as unavailable, not a thrown exception or another cached account', async () => {
    const cache = createNativeUsageCache();
    cache.observe({ type: 'usage', usage: reading(20) });
    const service = cache.createService({ ...deps, getProfile: async () => { throw new Error('Unknown profile'); } });
    await expect(service.get('one', true)).resolves.toEqual({ profileId: 'one', available: false,
      windows: [], fetchedAt: 50, error: 'Unknown profile' });
    await service.dispose();
  });

  it('performs only a deduplicated local summary on explicit refresh and preserves the timestamp on failure', async () => {
    const cache = createNativeUsageCache();
    cache.observe({ type: 'usage', usage: reading(20) });
    const planUsage = vi.fn(async () => { throw new Error('SDK plan ledger must not be requested'); });
    const contextUsage = vi.fn(async () => { throw new Error('closed native session'); });
    const service = cache.createService({ ...deps, liveSession: () => ({ planUsage, contextUsage }) });
    await service.get('one');
    expect(contextUsage).not.toHaveBeenCalled();
    const first = service.get('one', true);
    const second = service.get('one', true);
    expect(first).toBe(second);
    expect(await first).toEqual(reading(20));
    expect(contextUsage).toHaveBeenCalledExactlyOnceWith('summary');
    expect(planUsage).not.toHaveBeenCalled();
    await service.dispose();
    await service.get('one', true);
    expect(contextUsage).toHaveBeenCalledTimes(1);
  });

  it('does not observe SDK rate-limit events as native evidence or launch requests for unknown data', async () => {
    const cache = createNativeUsageCache();
    const service = cache.createService(deps);
    service.onRateLimit('one', { status: 'rejected', rateLimitType: 'five_hour', utilization: 1 });
    expect(await service.get('one', true)).toMatchObject({ available: false, windows: [], fetchedAt: 50,
      error: expect.stringContaining('eligibility is unknown') });
    await service.dispose();
    cache.observe({ type: 'usage', usage: reading(10) });
    expect(await service.get('one')).toMatchObject({ available: false, windows: [], error: 'Native usage service is closed.' });
  });
});
