import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { PlanUsage, Profile } from '@shared/types';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
}));

const { applyRateLimit, carryOver, createUsageService, keepHigher, toPlanUsage } = await import('../../src/main/engine/usage');
const { AUTH_ERROR_MESSAGE } = await import('../../src/main/engine/session');
type UsageServiceDeps = import('../../src/main/engine/usage').UsageServiceDeps;

const PROFILE: Profile = { id: 'work', name: 'Work', configDir: 'C:\\synthetic\\work', createdAt: 0 };
const ENV = { PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\synthetic\\work' };
const RESET = '2026-10-17T00:30:00.000Z';

const RESPONSE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    seven_day_sonnet: { utilization: 3, resets_at: null },
    zeta_window: { utilization: 1, resets_at: RESET },
    seven_day: { utilization: 7, resets_at: '2026-10-21T11:00:00.000Z' },
    seven_day_opus: null,
    five_hour: { utilization: 69, resets_at: RESET },
    seven_day_oauth_apps: { utilization: null, resets_at: 'not a date' },
    model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: RESET }],
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD' },
  },
  behaviors: null,
};

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4343;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    queueMicrotask(() => this.exit(signal === 'SIGKILL' ? 9 : 1));
    return true;
  });

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
    this.stderr.end();
  }
}

/** The child the next spawn returns: the probe being constructed. */
const spawning: { child?: FakeChild } = {};

/** Stand-in for one probe query: records its options and drains its prompt like the SDK does. */
class FakeProbe {
  readonly child = new FakeChild();
  readonly prompts: SDKUserMessage[] = [];
  promptEnded = false;
  closed = false;
  private finish: (() => void) | undefined;
  readonly usage = vi.fn(async (_opts?: { skipBehaviors?: boolean }): Promise<unknown> => RESPONSE);

  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, exitOnClose: boolean) {
    void (async () => {
      for await (const message of params.prompt) this.prompts.push(message);
      this.promptEnded = true;
    })();
    spawning.child = this.child;
    params.options.spawnClaudeCodeProcess?.({
      command: 'C:\\fake\\claude.exe',
      args: [],
      cwd: params.options.cwd,
      env: params.options.env ?? {},
      signal: new AbortController().signal,
    });
    if (exitOnClose) this.onClose = () => this.child.exit(0);
  }

  onClose: () => void = () => undefined;

  asQuery(): Query {
    const self = this;
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts?: { skipBehaviors?: boolean }) => self.usage(opts),
      close: () => {
        self.closed = true;
        self.finish?.();
        self.onClose();
      },
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            self.closed
              ? Promise.resolve({ value: undefined, done: true as const })
              : new Promise<IteratorResult<never, undefined>>((resolve) => {
                  self.finish = () => resolve({ value: undefined, done: true });
                }),
        };
      },
    } as unknown as Query;
  }
}

function setup(options: { exitOnClose?: boolean; deps?: Partial<UsageServiceDeps>; usage?: (opts?: { skipBehaviors?: boolean }) => Promise<unknown> } = {}) {
  const events: EngineEvent[] = [];
  const probes: FakeProbe[] = [];
  let clock = 1_000_000;
  const getProfile = vi.fn(async (id: string) => {
    if (id !== PROFILE.id) throw new Error(`Unknown profile ${id}`);
    return PROFILE;
  });
  const service = createUsageService({
    emit: (event) => events.push(event),
    getProfile,
    query: (params) => {
      const probe = new FakeProbe(params, options.exitOnClose ?? true);
      if (options.usage) probe.usage.mockImplementation(options.usage);
      probes.push(probe);
      return probe.asQuery();
    },
    spawn: vi.fn(() => spawning.child as never),
    resolveBinary: () => 'C:\\fake\\claude.exe',
    buildEnv: () => ({ ...ENV }),
    now: () => clock,
    closeTimeoutMs: 50,
    ...options.deps,
  });
  return {
    service,
    events,
    probes,
    getProfile,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('toPlanUsage', () => {
  it('orders the windows, drops null and non-window entries and maps extra usage', () => {
    expect(toPlanUsage('work', RESPONSE, 42)).toEqual({
      profileId: 'work',
      available: true,
      subscriptionType: 'pro',
      windows: [
        { id: 'five_hour', percent: 69, resetsAt: Date.parse(RESET) },
        { id: 'seven_day', percent: 7, resetsAt: Date.parse('2026-10-21T11:00:00.000Z') },
        { id: 'seven_day_sonnet', percent: 3, resetsAt: null },
        { id: 'model_scoped:Fable', percent: 5, resetsAt: Date.parse(RESET) },
        { id: 'seven_day_oauth_apps', percent: null, resetsAt: null },
        { id: 'zeta_window', percent: 1, resetsAt: Date.parse(RESET) },
      ],
      extraUsage: { enabled: true, percent: 25, usedCredits: 12.5, monthlyLimit: 50, currency: 'USD' },
      fetchedAt: 42,
    });
  });

  it('adds the server-named weekly model buckets (model_scoped) right after the fixed windows', () => {
    const response = {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 45, resets_at: RESET },
        seven_day: { utilization: 5, resets_at: '2026-10-22T02:00:00Z' },
        seven_day_oauth_apps: { utilization: 1, resets_at: null },
        alpha_window: { utilization: 2, resets_at: null },
        model_scoped: [
          { display_name: 'Fable', utilization: 0, resets_at: '2026-10-22T02:00:00+00:00' },
          { display_name: ' Fable ', utilization: 9, resets_at: null },
          { display_name: '', utilization: 3, resets_at: null },
          { utilization: 4, resets_at: null },
          'junk',
        ],
      },
    };
    expect(toPlanUsage('work', response, 7).windows).toEqual([
      { id: 'five_hour', percent: 45, resetsAt: Date.parse(RESET) },
      { id: 'seven_day', percent: 5, resetsAt: Date.parse('2026-10-22T02:00:00Z') },
      { id: 'model_scoped:Fable', percent: 0, resetsAt: Date.parse('2026-10-22T02:00:00Z') },
      { id: 'alpha_window', percent: 2, resetsAt: null },
      { id: 'seven_day_oauth_apps', percent: 1, resetsAt: null },
    ]);
  });

  it('reports API-key accounts as unavailable without windows', () => {
    expect(toPlanUsage('work', { subscription_type: null, rate_limits_available: false, rate_limits: null }, 1)).toEqual({
      profileId: 'work',
      available: false,
      windows: [],
      fetchedAt: 1,
    });
  });
});

describe('applyRateLimit', () => {
  const base: PlanUsage = {
    profileId: 'work',
    available: true,
    windows: [
      { id: 'five_hour', percent: 69, resetsAt: 1 },
      { id: 'seven_day', percent: 7, resetsAt: 2 },
    ],
    fetchedAt: 0,
  };

  it('updates the event window from a 0-1 utilization and epoch-second reset, adding missing windows in order', () => {
    expect(applyRateLimit(base, { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.912, resetsAt: 1_800_000_000 }).windows).toEqual([
      { id: 'five_hour', percent: 91.2, resetsAt: 1_800_000_000_000, status: 'allowed_warning' },
      { id: 'seven_day', percent: 7, resetsAt: 2 },
    ]);
    expect(applyRateLimit(base, { status: 'rejected', rateLimitType: 'seven_day_opus' }).windows.map((w) => [w.id, w.status, w.percent])).toEqual([
      ['five_hour', undefined, 69],
      ['seven_day', undefined, 7],
      ['seven_day_opus', 'rejected', null],
    ]);
    expect(applyRateLimit(base, { status: 'rejected', rateLimitType: 'overage' })).toEqual(base);
  });

  it('reads the per-window header snapshot when the CLI sends it', () => {
    const info = { status: 'allowed' as const, unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1_900_000_000 } } };
    expect(applyRateLimit(base, info).windows[1]).toEqual({ id: 'seven_day', percent: 50, resetsAt: 1_900_000_000_000 });
  });
});

describe('createUsageService', () => {
  it('probes with a non-persisted, settings-free CLI in a neutral folder, then closes it and waits for its exit', async () => {
    const { service, events, probes } = setup();
    const usage = await service.get('work');
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;
    expect(probe.params.options).toMatchObject({
      cwd: tmpdir(),
      persistSession: false,
      settingSources: [],
      env: ENV,
      pathToClaudeCodeExecutable: 'C:\\fake\\claude.exe',
    });
    expect(probe.params.options).not.toHaveProperty('canUseTool');
    expect(probe.params.options).not.toHaveProperty('resume');
    expect(probe.usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(probe.prompts).toEqual([]);
    await vi.waitFor(() => expect(probe.promptEnded).toBe(true));
    expect(probe.closed).toBe(true);
    expect(probe.child.exitCode).toBe(0);
    expect(probe.child.kill).not.toHaveBeenCalled();
    expect(usage).toEqual(toPlanUsage('work', RESPONSE, usage.fetchedAt));
    expect(events).toEqual([{ type: 'usage', usage }]);
  });

  it('caches for 60 s unless forced and runs one probe at a time per account', async () => {
    const { service, probes, events, advance } = setup();
    const [a, b] = await Promise.all([service.get('work'), service.get('work', true)]);
    expect(a).toBe(b);
    expect(probes).toHaveLength(1);
    advance(59_000);
    await expect(service.get('work')).resolves.toBe(a);
    expect(probes).toHaveLength(1);
    await service.get('work', true);
    expect(probes).toHaveLength(2);
    advance(61_000);
    await service.get('work');
    expect(probes).toHaveLength(3);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(3);
  });

  it('prefers an open session of the account and falls back to a probe when it cannot answer', async () => {
    const planUsage = vi.fn(async () => ({ ...RESPONSE, subscription_type: 'max' }));
    const live = { planUsage };
    const liveSession = vi.fn((profileId: string) => (profileId === 'work' ? live : undefined));
    const { service, probes } = setup({ deps: { liveSession } });
    await expect(service.get('work')).resolves.toMatchObject({ subscriptionType: 'max' });
    expect(probes).toHaveLength(0);
    planUsage.mockRejectedValueOnce(new Error('This session is closed.'));
    await expect(service.get('work', true)).resolves.toMatchObject({ subscriptionType: 'pro' });
    expect(probes).toHaveLength(1);
  });

  it('probes when the open session answers from its header snapshot without the per-model buckets', async () => {
    // Seen live: a session that had talked to the API left model_scoped out; a fresh CLI sent Fable.
    const { model_scoped: _buckets, ...seeded } = RESPONSE.rate_limits;
    // The snapshot carries the limiter's figures: ahead of the probe for the same reset, another reset, an extra window.
    const snapshot = {
      ...seeded,
      five_hour: { utilization: 98, resets_at: '2026-10-17T00:30:00Z' },
      seven_day: { utilization: 1, resets_at: '2026-10-28T11:00:00Z' },
      seven_day_cowork: { utilization: 2, resets_at: null },
    };
    const planUsage = vi.fn(async (): Promise<unknown> => ({ ...RESPONSE, subscription_type: 'max', rate_limits: snapshot }));
    const { service, probes } = setup({ deps: { liveSession: () => ({ planUsage }) as never } });
    const usage = await service.get('work');
    expect(planUsage).toHaveBeenCalledTimes(1);
    expect(probes).toHaveLength(1);
    expect(usage.subscriptionType).toBe('pro');
    expect(usage.windows.map((w) => w.id)).toContain('model_scoped:Fable');
    expect(usage.windows.find((w) => w.id === 'five_hour')).toEqual({ id: 'five_hour', percent: 98, resetsAt: Date.parse(RESET) });
    expect(usage.windows.find((w) => w.id === 'seven_day')?.percent).toBe(7);
    expect(usage.windows.find((w) => w.id === 'seven_day_cowork')).toEqual({ id: 'seven_day_cowork', percent: 2, resetsAt: null });
    // An empty list is a complete answer (the plan has no model buckets), and so is an account without limits.
    planUsage.mockResolvedValueOnce({ ...RESPONSE, subscription_type: 'max', rate_limits: { ...seeded, model_scoped: [] } });
    await expect(service.get('work', true)).resolves.toMatchObject({ subscriptionType: 'max' });
    planUsage.mockResolvedValueOnce({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    await expect(service.get('work', true)).resolves.toMatchObject({ available: false, windows: [] });
    expect(probes).toHaveLength(1);
  });

  it('keeps the higher figure of the same window across fetches and rate-limit events; a new window starts over', async () => {
    const answers: unknown[] = [RESPONSE, RESPONSE, { ...RESPONSE, rate_limits: { five_hour: { utilization: 3, resets_at: '2026-10-17T05:30:00Z' } } }];
    const { service } = setup({ usage: async () => answers.shift() });
    expect((await service.get('work')).windows.find((w) => w.id === 'five_hour')?.percent).toBe(69);
    // The limiter of a live turn reports the same window further along (resetsAt in epoch seconds).
    service.onRateLimit('work', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.98, resetsAt: Date.parse(RESET) / 1000 });
    const again = await service.get('work', true);
    expect(again.windows.find((w) => w.id === 'five_hour')).toEqual({ id: 'five_hour', percent: 98, resetsAt: Date.parse(RESET), status: 'allowed_warning' });
    // Windows only the cache had are not carried into a fresh answer.
    expect(again.windows.map((w) => w.id)).toEqual((await service.get('work')).windows.map((w) => w.id));
    const reset = await service.get('work', true);
    expect(reset.windows.find((w) => w.id === 'five_hour')).toEqual({ id: 'five_hour', percent: 3, resetsAt: Date.parse('2026-10-17T05:30:00Z') });
    // The weekly windows the answer left out are still in their period (carryOver).
    expect(reset.windows.find((w) => w.id === 'model_scoped:Fable')?.percent).toBe(5);
  });

  it('carries the windows a new answer lacks while their period runs; an ended core window starts at 0', () => {
    const known: PlanUsage = {
      profileId: 'work',
      available: true,
      windows: [
        { id: 'five_hour', percent: 99, resetsAt: 1_000, status: 'allowed_warning' },
        { id: 'seven_day', percent: 10, resetsAt: 9_000 },
        { id: 'seven_day_opus', percent: 40, resetsAt: 1_500 },
        { id: 'model_scoped:Fable', percent: 2, resetsAt: 9_000 },
      ],
      fetchedAt: 1,
    };
    const empty: PlanUsage = { profileId: 'work', available: true, windows: [], fetchedAt: 2_000 };
    expect(carryOver(empty, known, 2_000).windows).toEqual([
      { id: 'five_hour', percent: 0, resetsAt: null },
      { id: 'seven_day', percent: 10, resetsAt: 9_000 },
      { id: 'model_scoped:Fable', percent: 2, resetsAt: 9_000 },
    ]);
    const fresh = { ...empty, windows: [{ id: 'five_hour', percent: 4, resetsAt: 20_000 }] };
    expect(carryOver(fresh, known, 2_000).windows[0]).toEqual({ id: 'five_hour', percent: 4, resetsAt: 20_000 });
    expect(carryOver(fresh, known, 999).windows.find((w) => w.id === 'seven_day_opus')).toEqual({ id: 'seven_day_opus', percent: 40, resetsAt: 1_500 });
    const failed: PlanUsage = { profileId: 'work', available: false, windows: [], fetchedAt: 3, error: 'x' };
    expect(carryOver(failed, known, 2_000)).toBe(failed);
    expect(carryOver(empty, { ...known, available: false }, 2_000)).toBe(empty);
  });

  it('remembers the last good usage: a restart and an answer without data keep the weekly buckets, a failed fetch does not erase them', async () => {
    const save = vi.fn();
    const stored: PlanUsage = { profileId: 'work', available: true, subscriptionType: 'pro', windows: [{ id: 'model_scoped:Fable', percent: 5, resetsAt: Date.parse(RESET) }, { id: 'five_hour', percent: 99, resetsAt: Date.parse(RESET) }], fetchedAt: 1 };
    const answers: Array<unknown> = [{ ...RESPONSE, rate_limits: null }, new Error('probe failed')];
    const { service } = setup({
      usage: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      // A slow read: the first fetch must wait for it.
      deps: { memory: { load: () => new Promise((resolve) => setTimeout(() => resolve({ work: stored }), 20)), save } },
    });
    const first = await service.get('work');
    expect(first.windows).toEqual(stored.windows.slice().reverse());
    expect(save).toHaveBeenLastCalledWith(first);
    const failed = await service.get('work', true);
    expect(failed.error).toBe('probe failed');
    expect(save).toHaveBeenCalledTimes(1);
    service.onRateLimit('work', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1, resetsAt: Date.parse('2026-10-21T11:00:00.000Z') / 1000 });
    const after = await service.get('work');
    expect(after.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'model_scoped:Fable']);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('keepHigher leaves unavailable answers, failed fetches and windows without a reset time alone', () => {
    const base: PlanUsage = { profileId: 'work', available: true, windows: [{ id: 'five_hour', percent: 10, resetsAt: null }], fetchedAt: 1 };
    const higher: PlanUsage = { ...base, windows: [{ id: 'five_hour', percent: 90, resetsAt: null }] };
    expect(keepHigher(base, higher)).toEqual(base);
    const timed = { ...base, windows: [{ id: 'five_hour', percent: 10, resetsAt: 5_000_000 }] };
    expect(keepHigher(timed, { ...higher, windows: [{ id: 'five_hour', percent: 90, resetsAt: 5_000_000 + 2 * 60_000 }] }).windows[0]!.percent).toBe(90);
    expect(keepHigher(timed, { ...higher, windows: [{ id: 'five_hour', percent: 90, resetsAt: 5_000_000 + 2 * 60_000 + 1 }] }).windows[0]!.percent).toBe(10);
    expect(keepHigher(timed, { ...higher, error: 'failed', windows: [{ id: 'five_hour', percent: 90, resetsAt: 5_000_000 }] })).toEqual(timed);
    const unavailable: PlanUsage = { profileId: 'work', available: false, windows: [], fetchedAt: 1 };
    expect(keepHigher(unavailable, higher, true)).toBe(unavailable);
    expect(keepHigher(timed, unavailable, true)).toBe(timed);
  });

  it('returns redacted errors instead of throwing, kills a probe that will not exit, and times out', async () => {
    const failing = setup({ exitOnClose: false, usage: async () => { throw new Error('upstream said sk-ant-api03-SYNTHETICSECRET'); } });
    const failed = await failing.service.get('work');
    expect(failed).toEqual({ profileId: 'work', available: false, windows: [], fetchedAt: failed.fetchedAt, error: 'upstream said sk-ant-[redacted]' });
    expect(failing.probes[0]?.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(failing.events).toEqual([{ type: 'usage', usage: failed }]);

    const auth = setup({ usage: async () => { throw new Error('Not logged in · Please run /login'); } });
    await expect(auth.service.get('work')).resolves.toMatchObject({ available: false, error: AUTH_ERROR_MESSAGE });

    const slow = setup({ deps: { probeTimeoutMs: 20 }, usage: () => new Promise(() => undefined) });
    await expect(slow.service.get('work')).resolves.toMatchObject({ available: false, error: 'Claude Code did not report the plan usage in time.' });
    expect(slow.probes[0]?.closed).toBe(true);

    const unknown = setup();
    await expect(unknown.service.get('ghost')).resolves.toMatchObject({ available: false, error: 'Unknown profile ghost' });
    expect(unknown.probes).toHaveLength(0);
  });

  it('does not probe an account that is busy with sign-in or account changes', async () => {
    const { service, probes, getProfile } = setup({ deps: { isProfileBusy: (id) => id === 'work' } });
    await expect(service.get('work')).resolves.toMatchObject({ available: false, error: expect.stringContaining('busy') });
    expect(probes).toHaveLength(0);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('folds rate-limit events into the cached usage and emits only changes', async () => {
    const { service, events } = setup();
    const fetched = await service.get('work');
    events.length = 0;
    service.onRateLimit('work', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.95, resetsAt: 1_800_000_000 });
    expect(events).toHaveLength(1);
    const updated = events[0]?.type === 'usage' ? events[0].usage : undefined;
    expect(updated?.windows[0]).toEqual({ id: 'five_hour', percent: 95, resetsAt: 1_800_000_000_000, status: 'allowed_warning' });
    expect(updated?.windows.slice(1)).toEqual(fetched.windows.slice(1));
    expect(updated?.extraUsage).toEqual(fetched.extraUsage);
    service.onRateLimit('work', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.95, resetsAt: 1_800_000_000 });
    expect(events).toHaveLength(1);
    await expect(service.get('work')).resolves.toEqual(updated);

    service.onRateLimit('other', { status: 'rejected', rateLimitType: 'seven_day' });
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { profileId: 'other', available: true, windows: [{ id: 'seven_day', status: 'rejected' }] } });
  });

  it('dispose ends a running probe', async () => {
    let release = (): void => undefined;
    const { service, probes } = setup({ usage: () => new Promise((resolve) => { release = () => resolve(RESPONSE); }) });
    const pending = service.get('work');
    await vi.waitFor(() => expect(probes).toHaveLength(1));
    await service.dispose();
    expect(probes[0]?.closed).toBe(true);
    expect(probes[0]?.child.exitCode).toBe(0);
    release();
    await pending;
  });
});
