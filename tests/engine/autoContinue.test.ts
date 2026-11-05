import { tmpdir } from 'node:os';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AUTO_CONTINUE_MAX, type AutoContinueState } from '@shared/types';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
}));

const {
  AutoContinue,
  CHECK_MS,
  HORIZON_MS,
  SLEEP_GRACE_MS,
  decideAtLimit,
  fireTime,
  isUsageLimitText,
  isWeeklyLimit,
  reachedPlanLimit,
} = await import('../../src/main/engine/autoContinue');
const { MODEL_SCOPED_PREFIX } = await import('../../src/main/engine/usage');

const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const HOUR = 60 * 60_000;
const FIRED = 'Usage limit reset · Claude is continuing your task';
const NOTES = {
  horizon: 'Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own',
  unknown: "Automatic continue stopped · the usage limit's reset time is unknown, so this task will not resume on its own",
  cap: 'Automatic continue stopped · the usage limit was reached again after 3 automatic continues; send a message to continue',
  stale: 'Usage limit reset · the computer was asleep at the reset, so the task did not continue on its own',
  cancelled: 'Automatic continue cancelled',
  off: 'Automatic continue cancelled · turned off in Settings',
};
const weekly = (resetsAt: number) =>
  `Weekly usage limit reached · resets ${new Date(resetsAt).toLocaleString()}, so this task will not resume on its own`;

/** rate_limit_event info; resetsAt in epoch seconds as the SDK sends it. */
const rejected = (resetsAt: number, extra: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo => ({
  status: 'rejected',
  rateLimitType: 'five_hour',
  resetsAt: resetsAt / 1000,
  ...extra,
});

const planAnswer = (limits: Record<string, unknown>) => ({ rate_limits_available: true, rate_limits: limits });

class FakeInterval {
  cleared = false;
  readonly unref = vi.fn();
  constructor(
    readonly callback: () => void,
    readonly ms: number,
  ) {}
}

function harness(options: { enabled?: boolean; random?: number; planUsage?: () => Promise<unknown> } = {}) {
  const clock = { now: NOW };
  const intervals: FakeInterval[] = [];
  const states: AutoContinueState[] = [];
  const notes: Array<{ id: string; text: string; level: string }> = [];
  const sent: string[] = [];
  let ids = 0;
  const planUsage = vi.fn(options.planUsage ?? (async () => planAnswer({})));
  const auto = new AutoContinue({
    profileId: 'default',
    enabled: options.enabled ?? true,
    now: () => clock.now,
    random: () => options.random ?? 0,
    timers: {
      setInterval: (callback, ms) => {
        const interval = new FakeInterval(callback, ms);
        intervals.push(interval);
        return interval;
      },
      clearInterval: (handle) => {
        (handle as FakeInterval).cleared = true;
      },
    },
    newId: () => `n${++ids}`,
    onState: (state) => states.push(state),
    onNote: (id, text, level) => notes.push({ id, text, level }),
    sendPrompt: (uuid) => sent.push(uuid),
    planUsage,
  });
  const live = (): FakeInterval | undefined => intervals.filter((interval) => !interval.cleared).at(-1);
  /** Runs the interval every CHECK_MS for `ms`, as on an awake computer. */
  const advance = (ms: number): void => {
    const end = clock.now + ms;
    while (clock.now + CHECK_MS <= end) {
      clock.now += CHECK_MS;
      live()?.callback();
    }
    clock.now = end;
  };
  /** Moves the clock without any check (asleep), then runs one check. */
  const wake = (ms: number): void => {
    clock.now += ms;
    live()?.callback();
  };
  /** A turn that a usage limit stopped. */
  const limitTurn = (): void => {
    auto.turnStarted();
    auto.noteLimitStop();
    auto.turnEnded(false);
  };
  const waiting = () => states.filter((state): state is Extract<AutoContinueState, { phase: 'waiting' }> => state.phase === 'waiting');
  return { auto, clock, intervals, states, notes, sent, planUsage, live, advance, wake, limitTurn, waiting };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('automatic continue helpers', () => {
  it('recognises the CLI usage-limit wording at the start of the text only', () => {
    for (const text of [
      "You've hit your session limit · resets 9:10pm (America/Los_Angeles)",
      "  You've hit your weekly limit · resets Oct 24, 9am",
      "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai, to continue.",
      'Your org is out of usage · add funds to continue',
    ]) {
      expect(isUsageLimitText(text)).toBe(true);
    }
    for (const text of ['API Error: 429 rate_limit_error', 'Rate limited, retry later', "Note: You've hit your session limit", '']) {
      expect(isUsageLimitText(text)).toBe(false);
    }
  });

  it('counts every seven_day window and the per-model buckets as weekly, and nothing else', () => {
    for (const id of ['seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'seven_day_oauth_apps', `${MODEL_SCOPED_PREFIX}Fable`]) {
      expect(isWeeklyLimit(id)).toBe(true);
    }
    for (const id of ['five_hour', 'overage', 'extra_usage', undefined]) expect(isWeeklyLimit(id)).toBe(false);
  });

  it('fires 30 to 90 s after the reset, never before its wait began, and spaces the second and third continue', () => {
    const reset = NOW + HOUR;
    expect(fireTime(reset, 1, NOW, 0)).toBe(reset + 30_000);
    expect(fireTime(reset, 1, NOW, 0.5)).toBe(reset + 60_000);
    expect(fireTime(reset, 1, NOW, 0.999_999)).toBe(reset + 90_000);
    expect(fireTime(NOW - 120_000, 1, NOW, 0)).toBe(NOW);
    expect(fireTime(NOW, 2, NOW, 0)).toBe(NOW + 60_000);
    expect(fireTime(NOW, 3, NOW, 0)).toBe(NOW + 300_000);
    expect(fireTime(NOW, 4, NOW, 0)).toBe(NOW + 300_000);
    expect(fireTime(NOW + 10 * 60_000, 3, NOW, 0)).toBe(NOW + 10 * 60_000 + 30_000);
  });

  it('decides unknown, weekly, horizon and cap in that order, else a wait for the next continue', () => {
    const soon = NOW + HOUR;
    expect(decideAtLimit(undefined, 0, NOW, 0)).toEqual({ kind: 'unknown' });
    expect(decideAtLimit({ type: 'seven_day' }, 3, NOW, 0)).toEqual({ kind: 'unknown' });
    expect(decideAtLimit({ type: 'five_hour', resetsAt: NOW - 5 * 60_000 - 1 }, 0, NOW, 0)).toEqual({ kind: 'unknown' });
    expect(decideAtLimit({ type: 'five_hour', resetsAt: NOW - 5 * 60_000 }, 0, NOW, 0)).toMatchObject({ kind: 'wait', fireAt: NOW });
    expect(decideAtLimit({ type: 'seven_day', resetsAt: NOW + 3 * 24 * HOUR }, 3, NOW, 0)).toEqual({ kind: 'weekly', resetsAt: NOW + 3 * 24 * HOUR });
    expect(decideAtLimit({ type: 'five_hour', resetsAt: NOW + HORIZON_MS + 1 }, 3, NOW, 0)).toEqual({ kind: 'horizon' });
    expect(decideAtLimit({ type: 'five_hour', resetsAt: NOW + HORIZON_MS }, 0, NOW, 0)).toEqual({
      kind: 'wait',
      resetsAt: NOW + HORIZON_MS,
      fireAt: NOW + HORIZON_MS + 30_000,
      attempt: 1,
    });
    expect(decideAtLimit({ resetsAt: soon }, AUTO_CONTINUE_MAX, NOW, 0)).toEqual({ kind: 'cap' });
    expect(decideAtLimit({ resetsAt: soon }, AUTO_CONTINUE_MAX - 1, NOW, 0)).toEqual({ kind: 'wait', resetsAt: soon, fireAt: soon + 30_000, attempt: 3 });
  });

  it('takes a reached weekly plan window before the five-hour one, with the reset when the plan reports one', () => {
    const reset = '2026-10-20T12:00:00.000Z';
    expect(reachedPlanLimit('default', planAnswer({ five_hour: { utilization: 40, resets_at: reset } }), NOW)).toBeUndefined();
    expect(
      reachedPlanLimit('default', planAnswer({ seven_day: { utilization: 100, resets_at: reset }, five_hour: { utilization: 100, resets_at: reset } }), NOW),
    ).toEqual({ type: 'seven_day', resetsAt: Date.parse(reset) });
    expect(
      reachedPlanLimit('default', planAnswer({ seven_day: { utilization: 80, resets_at: reset }, five_hour: { utilization: 100, resets_at: reset } }), NOW),
    ).toEqual({ type: 'five_hour', resetsAt: Date.parse(reset) });
    expect(
      reachedPlanLimit('default', planAnswer({ five_hour: { utilization: 99.9, resets_at: reset }, model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: null }] }), NOW),
    ).toEqual({ type: `${MODEL_SCOPED_PREFIX}Fable` });
    expect(reachedPlanLimit('default', null, NOW)).toBeUndefined();
  });
});

describe('AutoContinue waits and continues', () => {
  it('waits for a rejected limit, checks every 15 s on an unref-ed interval and sends the resume prompt once at the fire time', () => {
    const h = harness({ random: 0.5 });
    const reset = NOW + HOUR;
    h.auto.onRateLimit(rejected(reset));
    h.limitTurn();
    expect(h.states).toEqual([{ phase: 'waiting', resetsAt: reset, fireAt: reset + 60_000, attempt: 1 }]);
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0]?.ms).toBe(CHECK_MS);
    expect(h.intervals[0]?.unref).toHaveBeenCalledTimes(1);
    expect(h.planUsage).not.toHaveBeenCalled();

    h.advance(HOUR + 45_000);
    expect(h.sent).toEqual([]);
    h.advance(15_000);
    expect(h.sent).toEqual(['n1']);
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
    expect(h.notes).toEqual([{ id: 'n1', text: FIRED, level: 'info' }]);
    expect(h.intervals[0]?.cleared).toBe(true);
    h.advance(10 * 60_000);
    expect(h.sent).toEqual(['n1']);
  });

  it('continues at most three times in a row, spacing the second and third, then stops with the cap notice', () => {
    const h = harness();
    for (let continued = 0; continued < AUTO_CONTINUE_MAX; continued++) {
      h.auto.onRateLimit(rejected(h.clock.now + 10_000));
      const armedAt = h.clock.now;
      h.limitTurn();
      const wait = h.waiting().at(-1)!;
      expect(wait.attempt).toBe(continued + 1);
      expect(wait.fireAt).toBe([armedAt + 40_000, armedAt + 60_000, armedAt + 300_000][continued]);
      h.advance(wait.fireAt - h.clock.now + CHECK_MS);
      expect(h.sent).toHaveLength(continued + 1);
    }
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    expect(h.waiting()).toHaveLength(AUTO_CONTINUE_MAX);
    expect(h.notes.at(-1)).toEqual({ id: expect.stringMatching(/^autocontinue:cap:/), text: NOTES.cap, level: 'warn' });
    h.limitTurn();
    expect(h.waiting()).toHaveLength(AUTO_CONTINUE_MAX);
  });

  it('starts a new run after a message sent by hand, which also ends a wait silently', () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      h.auto.onRateLimit(rejected(h.clock.now + 10_000));
      h.limitTurn();
      h.advance(10 * 60_000);
    }
    expect(h.sent).toHaveLength(2);
    h.auto.humanMessage();
    h.auto.onRateLimit(rejected(h.clock.now + HOUR));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);

    const notes = h.notes.length;
    h.auto.humanMessage();
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
    expect(h.notes).toHaveLength(notes);
    expect(h.live()).toBeUndefined();
    h.advance(2 * HOUR);
    expect(h.sent).toHaveLength(2);
  });

  it('ends the run when a turn ends without the limit or is stopped, and decides nothing for a stopped turn', () => {
    const h = harness();
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    h.advance(10 * 60_000);
    h.auto.turnStarted();
    h.auto.turnEnded(false);
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);
    h.advance(10 * 60_000);

    // A fresh rejection: a stopped turn would otherwise decide at once from it.
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.auto.turnStarted();
    h.auto.noteLimitStop();
    h.auto.turnEnded(true);
    expect(h.waiting()).toHaveLength(2);
    expect(h.planUsage).not.toHaveBeenCalled();
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);
  });

  it('forgets a limit stop when a new turn starts before the turn ends', () => {
    const h = harness();
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.auto.noteLimitStop();
    h.auto.turnStarted();
    h.auto.turnEnded(false);
    expect(h.states).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('does nothing while turned off, and waits again once turned back on', () => {
    const h = harness({ enabled: false });
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    h.auto.onRateLimit(rejected(NOW + 30 * HOUR));
    h.limitTurn();
    expect(h.states).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.planUsage).not.toHaveBeenCalled();
    h.auto.setEnabled(true);
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    expect(h.waiting()).toHaveLength(1);
  });
});

describe('AutoContinue stops without waiting', () => {
  it('reports a weekly limit with its reset time and does not wait for it', () => {
    for (const rateLimitType of ['seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included'] as const) {
      const h = harness();
      const reset = NOW + 2 * HOUR;
      h.auto.onRateLimit(rejected(reset, { rateLimitType }));
      h.limitTurn();
      expect(h.states).toEqual([]);
      expect(h.intervals).toEqual([]);
      expect(h.notes).toEqual([{ id: 'autocontinue:weekly:n1', text: weekly(reset), level: 'warn' }]);
    }
  });

  it('says it once while turns the CLI starts on its own hit the same limit, and again after a message sent by hand', () => {
    const h = harness();
    const reset = NOW + 2 * HOUR;
    h.auto.onRateLimit(rejected(reset, { rateLimitType: 'seven_day' }));
    h.limitTurn();
    h.limitTurn();
    expect(h.notes.map((note) => note.text)).toEqual([weekly(reset)]);
    const later = reset + HOUR;
    h.auto.onRateLimit(rejected(later, { rateLimitType: 'seven_day' }));
    h.limitTurn();
    expect(h.notes.map((note) => note.text)).toEqual([weekly(reset), weekly(later)]);
    h.auto.humanMessage();
    h.limitTurn();
    expect(h.notes.map((note) => note.text)).toEqual([weekly(reset), weekly(later), weekly(later)]);
  });

  it('waits for a reset exactly 24 hours out but not one a minute later', () => {
    const edge = harness();
    edge.auto.onRateLimit(rejected(NOW + HORIZON_MS));
    edge.limitTurn();
    expect(edge.waiting()).toHaveLength(1);

    const late = harness();
    late.auto.onRateLimit(rejected(NOW + HORIZON_MS + 60_000));
    late.limitTurn();
    expect(late.states).toEqual([]);
    expect(late.notes).toEqual([{ id: 'autocontinue:horizon:n1', text: NOTES.horizon, level: 'warn' }]);
  });

  it('asks the plan usage when no rejection is known and reports an unknown reset when it cannot tell', async () => {
    const failing = harness({ planUsage: async () => Promise.reject(new Error('closed')) });
    failing.limitTurn();
    expect(failing.notes).toEqual([]);
    await settle();
    expect(failing.planUsage).toHaveBeenCalledTimes(1);
    expect(failing.notes).toEqual([{ id: 'autocontinue:unknown:n1', text: NOTES.unknown, level: 'warn' }]);

    const nothing = harness({ planUsage: async () => planAnswer({ five_hour: { utilization: 80, resets_at: '2026-10-20T12:00:00.000Z' } }) });
    nothing.limitTurn();
    await settle();
    expect(nothing.notes.map((note) => note.text)).toEqual([NOTES.unknown]);
    expect(nothing.states).toEqual([]);
  });

  it('waits for a plan window at its limit, and treats a reached per-model bucket as weekly', async () => {
    const reset = '2026-10-20T12:00:00.000Z';
    const five = harness({ planUsage: async () => planAnswer({ five_hour: { utilization: 100, resets_at: reset } }) });
    five.limitTurn();
    await settle();
    expect(five.states).toEqual([{ phase: 'waiting', resetsAt: Date.parse(reset), fireAt: Date.parse(reset) + 30_000, attempt: 1 }]);

    const fable = harness({ planUsage: async () => planAnswer({ model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: reset }] }) });
    fable.limitTurn();
    await settle();
    expect(fable.states).toEqual([]);
    expect(fable.notes).toEqual([{ id: 'autocontinue:weekly:n1', text: weekly(Date.parse(reset)), level: 'warn' }]);
  });
});

describe('AutoContinue rejection memory', () => {
  it('keeps a rejection across turns until an event of the same window says otherwise', async () => {
    const h = harness();
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.auto.turnStarted();
    h.auto.turnEnded(false);
    h.auto.onRateLimit({ status: 'allowed', rateLimitType: 'seven_day' });
    h.auto.onRateLimit({ status: 'allowed' });
    h.limitTurn();
    expect(h.waiting().at(-1)?.resetsAt).toBe(NOW + HOUR);
    h.auto.humanMessage();

    h.auto.onRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour' });
    h.limitTurn();
    await settle();
    expect(h.planUsage).toHaveBeenCalledTimes(1);
    expect(h.notes.at(-1)?.text).toBe(NOTES.unknown);
  });

  it('ignores rejections served by extra usage, without a reset, or whose reset passed more than five minutes ago', async () => {
    for (const info of [
      rejected(NOW + HOUR, { isUsingOverage: true }),
      rejected(NOW + HOUR, { overageInUse: true }),
      { status: 'rejected', rateLimitType: 'five_hour' } as SDKRateLimitInfo,
      rejected(NOW - 5 * 60_000 - 1_000),
    ]) {
      const h = harness();
      h.auto.onRateLimit(info);
      h.limitTurn();
      await settle();
      expect(h.planUsage).toHaveBeenCalledTimes(1);
      expect(h.states).toEqual([]);
    }
    const recent = harness();
    recent.auto.onRateLimit(rejected(NOW - 4 * 60_000));
    recent.limitTurn();
    expect(recent.planUsage).not.toHaveBeenCalled();
    expect(recent.waiting()).toEqual([{ phase: 'waiting', resetsAt: NOW - 4 * 60_000, fireAt: NOW, attempt: 1 }]);
  });

  it('drops a plan answer that arrives after a message, a newer decision, the setting going off or the close', async () => {
    const reset = '2026-10-20T12:00:00.000Z';
    const answers: Array<(value: unknown) => void> = [];
    const pending = () =>
      new Promise((resolve) => {
        answers.push(resolve);
      });
    const reached = planAnswer({ five_hour: { utilization: 100, resets_at: reset } });
    for (const interrupt of ['message', 'off', 'dispose'] as const) {
      const h = harness({ planUsage: pending });
      h.limitTurn();
      if (interrupt === 'message') h.auto.humanMessage();
      if (interrupt === 'off') h.auto.setEnabled(false);
      if (interrupt === 'dispose') h.auto.dispose();
      answers.at(-1)?.(reached);
      await settle();
      expect(h.states).toEqual([]);
      expect(h.notes).toEqual([]);
    }
    const twice = harness({ planUsage: pending });
    twice.limitTurn();
    twice.auto.onRateLimit(rejected(NOW + 2 * HOUR));
    twice.limitTurn();
    answers.at(-1)?.(reached);
    await settle();
    expect(twice.states).toEqual([{ phase: 'waiting', resetsAt: NOW + 2 * HOUR, fireAt: NOW + 2 * HOUR + 30_000, attempt: 1 }]);
  });
});

describe('AutoContinue sleep, cancel and continue now', () => {
  it('sends nothing when the computer slept through the reset and offers to continue instead', () => {
    const h = harness();
    const reset = NOW + HOUR;
    h.auto.onRateLimit(rejected(reset));
    h.limitTurn();
    h.advance(30 * 60_000);
    h.wake(HOUR);
    expect(h.sent).toEqual([]);
    expect(h.states.at(-1)).toEqual({ phase: 'stale', resetsAt: reset });
    expect(h.notes).toEqual([{ id: 'autocontinue:stale:n1', text: NOTES.stale, level: 'info' }]);
    expect(h.live()).toBeUndefined();

    h.auto.continueNow();
    expect(h.sent).toEqual(['n2']);
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
    expect(h.notes.at(-1)).toEqual({ id: 'n2', text: FIRED, level: 'info' });
    // The user's Continue starts a new run, as a message sent by hand does.
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);
  });

  it('still continues after a check gap of exactly 30 minutes, or a sleep that ended before the fire time', () => {
    const edge = harness();
    edge.auto.onRateLimit(rejected(NOW + 20 * 60_000));
    edge.limitTurn();
    edge.wake(SLEEP_GRACE_MS);
    expect(edge.sent).toEqual(['n1']);

    const early = harness();
    early.auto.onRateLimit(rejected(NOW + 3 * HOUR));
    early.limitTurn();
    early.wake(2 * HOUR);
    expect(early.states.at(-1)?.phase).toBe('waiting');
    early.advance(HOUR + 60_000);
    expect(early.sent).toEqual(['n1']);
  });

  it('cancels a wait or a missed reset with a notice and starts a new run, and does nothing when idle', () => {
    const h = harness();
    h.auto.cancel();
    expect(h.states).toEqual([]);
    expect(h.notes).toEqual([]);
    for (let i = 0; i < 2; i++) {
      h.auto.onRateLimit(rejected(h.clock.now + 10_000));
      h.limitTurn();
      h.advance(10 * 60_000);
    }
    h.auto.onRateLimit(rejected(h.clock.now + HOUR));
    h.limitTurn();
    h.auto.cancel();
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
    expect(h.notes.at(-1)).toEqual({ id: expect.stringMatching(/^autocontinue:cancelled:/), text: NOTES.cancelled, level: 'info' });
    expect(h.live()).toBeUndefined();
    h.advance(2 * HOUR);
    expect(h.sent).toHaveLength(2);
    h.auto.onRateLimit(rejected(h.clock.now + HOUR));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);

    h.wake(2 * HOUR);
    expect(h.states.at(-1)?.phase).toBe('stale');
    h.auto.cancel();
    expect(h.notes.at(-1)?.text).toBe(NOTES.cancelled);
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
  });

  it('ends a wait or a missed reset with the Settings notice when turned off', () => {
    const h = harness();
    h.auto.setEnabled(false);
    expect(h.notes).toEqual([]);
    h.auto.setEnabled(true);
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    h.auto.setEnabled(false);
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
    expect(h.notes).toEqual([{ id: 'autocontinue:off:n1', text: NOTES.off, level: 'info' }]);
    expect(h.live()).toBeUndefined();

    h.auto.setEnabled(true);
    h.limitTurn();
    h.wake(2 * HOUR);
    h.auto.setEnabled(false);
    expect(h.notes.at(-1)?.text).toBe(NOTES.off);
    expect(h.states.at(-1)).toEqual({ phase: 'idle' });
  });

  it('continues now from a wait, and refuses when nothing waits', () => {
    const h = harness();
    expect(() => h.auto.continueNow()).toThrow('Nothing is waiting to continue.');
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    h.auto.continueNow();
    expect(h.sent).toEqual(['n1']);
    expect(h.live()).toBeUndefined();
    expect(() => h.auto.continueNow()).toThrow('Nothing is waiting to continue.');
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(1);
  });

  it('stops checking on dispose and reports nothing afterwards', () => {
    const h = harness();
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    const interval = h.intervals[0]!;
    const events = h.states.length;
    h.auto.dispose();
    expect(interval.cleared).toBe(true);
    h.clock.now += 2 * HOUR;
    interval.callback();
    h.auto.cancel();
    h.limitTurn();
    expect(h.sent).toEqual([]);
    expect(h.states).toHaveLength(events);
    expect(h.notes).toEqual([]);
  });
});

describe('AutoContinue limit stops during a wait', () => {
  it('moves the wait to a later reset without counting a new continue, and keeps it for an earlier or unknown one', async () => {
    const h = harness();
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    h.auto.onRateLimit(rejected(NOW + 2 * HOUR));
    h.limitTurn();
    expect(h.waiting()).toEqual([
      { phase: 'waiting', resetsAt: NOW + HOUR, fireAt: NOW + HOUR + 30_000, attempt: 1 },
      { phase: 'waiting', resetsAt: NOW + 2 * HOUR, fireAt: NOW + 2 * HOUR + 30_000, attempt: 1 },
    ]);
    expect(h.intervals).toHaveLength(1);
    h.auto.onRateLimit(rejected(NOW + 30 * 60_000));
    h.limitTurn();
    h.auto.onRateLimit({ status: 'allowed', rateLimitType: 'five_hour' });
    h.limitTurn();
    await settle();
    expect(h.waiting()).toHaveLength(2);
    expect(h.notes).toEqual([]);
    h.advance(2 * HOUR + 45_000);
    expect(h.sent).toEqual(['n1']);
    h.auto.onRateLimit(rejected(h.clock.now + 10_000));
    h.limitTurn();
    expect(h.waiting().at(-1)?.attempt).toBe(2);
  });

  it('ends the wait when the newer limit is weekly or resets beyond 24 hours', () => {
    const weeklyStop = harness();
    weeklyStop.auto.onRateLimit(rejected(NOW + HOUR));
    weeklyStop.limitTurn();
    weeklyStop.auto.onRateLimit(rejected(NOW + 50 * HOUR, { rateLimitType: 'seven_day' }));
    weeklyStop.limitTurn();
    expect(weeklyStop.states.at(-1)).toEqual({ phase: 'idle' });
    expect(weeklyStop.notes).toEqual([{ id: 'autocontinue:weekly:n1', text: weekly(NOW + 50 * HOUR), level: 'warn' }]);
    expect(weeklyStop.live()).toBeUndefined();

    const far = harness();
    far.auto.onRateLimit(rejected(NOW + HOUR));
    far.limitTurn();
    far.auto.onRateLimit(rejected(NOW + 25 * HOUR));
    far.limitTurn();
    expect(far.states.at(-1)).toEqual({ phase: 'idle' });
    expect(far.notes.map((note) => note.text)).toEqual([NOTES.horizon]);
  });

  it('keeps a missed reset offer when another limit stop arrives', () => {
    const h = harness();
    h.auto.onRateLimit(rejected(NOW + HOUR));
    h.limitTurn();
    h.wake(2 * HOUR);
    const states = h.states.length;
    h.auto.onRateLimit(rejected(h.clock.now + HOUR));
    h.limitTurn();
    expect(h.states).toHaveLength(states);
    expect(h.states.at(-1)?.phase).toBe('stale');
  });
});
