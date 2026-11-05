// Continue automatically at usage limit: the CLI's autoContinueAtUsageLimit runs only for interactive sessions, never
// for an SDK host, so main repeats it per session with the CLI's timings (2.1.302).
import { USAGE_LIMIT_ERROR_PREFIXES, type SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_CONTINUE_MAX, type AutoContinueState, type ProfileId } from '@shared/types';
import { AUTO_CONTINUE_NOTE } from './mapTranscript';
// usage.ts imports session.ts, which imports this module: read these only inside functions.
import { MODEL_SCOPED_PREFIX, toPlanUsage } from './usage';

/** The resume prompt goes out 30 to 90 s after the reset. */
export const JITTER_MIN_MS = 30_000;
export const JITTER_MAX_MS = 90_000;
/** Earliest second and third continue in a row, counted from when their wait began. */
export const REARM_SPACING_MS: readonly number[] = [60_000, 300_000];
/** A reset further out than this is not waited for. */
export const HORIZON_MS = 24 * 60 * 60_000;
/** A longer gap between two checks means the computer slept. */
export const SLEEP_GRACE_MS = 30 * 60_000;
export const CHECK_MS = 15_000;
/** A remembered rejection whose reset passed longer ago than this no longer tells the reset. */
export const STALE_REJECTION_MS = 5 * 60_000;

const AUTO_CONTINUE_NOTES = {
  horizon:
    'Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own',
  unknown: "Automatic continue stopped · the usage limit's reset time is unknown, so this task will not resume on its own",
  cap: `Automatic continue stopped · the usage limit was reached again after ${AUTO_CONTINUE_MAX} automatic continues; send a message to continue`,
  stale: 'Usage limit reset · the computer was asleep at the reset, so the task did not continue on its own',
  cancelled: 'Automatic continue cancelled',
  off: 'Automatic continue cancelled · turned off in Settings',
} as const;

function weeklyNote(resetsAt: number): string {
  return `Weekly usage limit reached · resets ${new Date(resetsAt).toLocaleString()}, so this task will not resume on its own`;
}

/** The CLI's usage-limit wording (a synthetic assistant message or an error result). */
export function isUsageLimitText(text: string): boolean {
  const trimmed = text.trim();
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Weekly windows (rate_limit_event types and plan usage ids), including the per-model buckets the server names. */
export function isWeeklyLimit(id: string | undefined): boolean {
  return id !== undefined && (id.startsWith('seven_day') || id.startsWith(MODEL_SCOPED_PREFIX));
}

/** A reached limit: its window and its reset in epoch ms, when known. */
export interface ReachedLimit {
  type?: string;
  resetsAt?: number;
}

/** When the resume prompt of continue number `attempt` in a row goes out; `random` is in [0, 1). */
export function fireTime(resetsAt: number, attempt: number, armedAt: number, random: number): number {
  const jitter = Math.round(JITTER_MIN_MS + random * (JITTER_MAX_MS - JITTER_MIN_MS));
  const spacing = attempt > 1 ? (REARM_SPACING_MS[attempt - 2] ?? REARM_SPACING_MS.at(-1) ?? 0) : 0;
  return Math.max(resetsAt + jitter, armedAt + spacing);
}

export type LimitDecision =
  | { kind: 'wait'; resetsAt: number; fireAt: number; attempt: number }
  | { kind: 'weekly'; resetsAt: number }
  | { kind: 'unknown' | 'horizon' | 'cap' };

/** What a turn stopped by a usage limit leads to, after `continued` automatic continues in a row. */
export function decideAtLimit(limit: ReachedLimit | undefined, continued: number, now: number, random: number): LimitDecision {
  const resetsAt = limit?.resetsAt;
  if (resetsAt === undefined || resetsAt < now - STALE_REJECTION_MS) return { kind: 'unknown' };
  if (isWeeklyLimit(limit?.type)) return { kind: 'weekly', resetsAt };
  if (resetsAt - now > HORIZON_MS) return { kind: 'horizon' };
  if (continued >= AUTO_CONTINUE_MAX) return { kind: 'cap' };
  const attempt = continued + 1;
  return { kind: 'wait', resetsAt, fireAt: fireTime(resetsAt, attempt, now, random), attempt };
}

/** A window of a plan usage answer whose limit is reached; a weekly one first, since requests stay blocked until it resets. */
export function reachedPlanLimit(profileId: ProfileId, response: unknown, now: number): ReachedLimit | undefined {
  const reached = toPlanUsage(profileId, response, now).windows.filter((w) => (w.percent ?? 0) >= 100);
  const window = reached.find((w) => isWeeklyLimit(w.id)) ?? reached[0];
  if (!window) return undefined;
  return { type: window.id, ...(window.resetsAt !== null ? { resetsAt: window.resetsAt } : {}) };
}

export interface IntervalTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimers: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface AutoContinueDeps {
  profileId: ProfileId;
  /** The session's choice at open. */
  enabled: boolean;
  now(): number;
  random(): number;
  timers: IntervalTimers;
  newId(): string;
  onState(state: AutoContinueState): void;
  onNote(id: string, text: string, level: 'info' | 'warn'): void;
  /** Sends the resume prompt under this uuid. */
  sendPrompt(uuid: string): void;
  /** The session's plan usage (experimental SDK API), for a limit no rate-limit event explained. */
  planUsage(): Promise<unknown>;
}

/** One session's automatic continue: limit stops, the wait for the reset and the resume prompt. */
export class AutoContinue {
  private state: AutoContinueState = { phase: 'idle' };
  private enabled: boolean;
  /** Automatic continues sent in a row. */
  private continued = 0;
  private limitStop = false;
  /** Kept across turns: the CLI may not send an unchanged status again. */
  private rejection: { type?: string; resetsAt: number } | undefined;
  private timer: unknown;
  private armedAt = 0;
  private lastCheck = 0;
  /** Bumped by anything that makes a decision still waiting for the plan usage obsolete. */
  private epoch = 0;
  private disposed = false;
  /** The last stop notice, so turns the CLI starts on its own do not repeat it. */
  private lastStop: string | undefined;

  constructor(private readonly deps: AutoContinueDeps) {
    this.enabled = deps.enabled;
  }

  onRateLimit(info: SDKRateLimitInfo): void {
    const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : undefined;
    if (info.status === 'rejected' && resetsAt !== undefined && info.isUsingOverage !== true && info.overageInUse !== true) {
      this.rejection = { ...(info.rateLimitType ? { type: info.rateLimitType } : {}), resetsAt };
    } else if (info.status !== 'rejected' && this.rejection && info.rateLimitType === this.rejection.type) {
      this.rejection = undefined;
    }
  }

  turnStarted(): void {
    this.limitStop = false;
  }

  /** A usage-limit message on the main thread of the current turn. */
  noteLimitStop(): void {
    this.limitStop = true;
  }

  /** The turn is over (not handed to a queued one). */
  turnEnded(aborted: boolean): void {
    const limited = this.limitStop;
    this.limitStop = false;
    if (this.disposed) return;
    if (aborted || !limited) {
      this.continued = 0;
      return;
    }
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    const now = this.deps.now();
    const known = this.rejection && this.rejection.resetsAt >= now - STALE_REJECTION_MS ? this.rejection : undefined;
    if (known) {
      this.decide(known);
      return;
    }
    void this.planLimit().then((limit) => {
      if (epoch === this.epoch && !this.disposed && this.enabled) this.decide(limit);
    });
  }

  /** A message the user sent: ends a wait silently and starts a new run. */
  humanMessage(): void {
    this.epoch++;
    this.continued = 0;
    this.lastStop = undefined;
    if (this.state.phase !== 'idle') this.toIdle();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) return;
    this.epoch++;
    this.continued = 0;
    if (this.state.phase === 'idle') return;
    this.toIdle();
    this.note('off', AUTO_CONTINUE_NOTES.off, 'info');
  }

  cancel(): void {
    if (this.state.phase === 'idle') return;
    this.epoch++;
    this.continued = 0;
    this.toIdle();
    this.note('cancelled', AUTO_CONTINUE_NOTES.cancelled, 'info');
  }

  /** The user's Continue (a wait, or a reset the computer slept through): like a message sent by hand, a new run. */
  continueNow(): void {
    if (this.state.phase === 'idle') throw new Error('Nothing is waiting to continue.');
    this.fire(true);
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.stopTimer();
  }

  private async planLimit(): Promise<ReachedLimit | undefined> {
    try {
      return reachedPlanLimit(this.deps.profileId, await this.deps.planUsage(), this.deps.now());
    } catch {
      return undefined;
    }
  }

  private decide(limit: ReachedLimit | undefined): void {
    const now = this.deps.now();
    if (this.state.phase === 'waiting') {
      this.replan(limit, now);
      return;
    }
    if (this.state.phase === 'stale') return;
    const decision = decideAtLimit(limit, this.continued, now, this.deps.random());
    switch (decision.kind) {
      case 'wait':
        this.lastStop = undefined;
        this.armedAt = now;
        this.lastCheck = now;
        this.setState({ phase: 'waiting', resetsAt: decision.resetsAt, fireAt: decision.fireAt, attempt: decision.attempt });
        this.startTimer();
        break;
      case 'weekly':
        this.stopNote('weekly', weeklyNote(decision.resetsAt), decision.resetsAt);
        break;
      default:
        this.stopNote(decision.kind, AUTO_CONTINUE_NOTES[decision.kind]);
        break;
    }
  }

  /** Another limit stop during a wait (a background task's turn): a later reset moves the wait, without a new continue. */
  private replan(limit: ReachedLimit | undefined, now: number): void {
    const resetsAt = limit?.resetsAt;
    if (this.state.phase !== 'waiting' || resetsAt === undefined || resetsAt < now - STALE_REJECTION_MS) return;
    if (isWeeklyLimit(limit?.type)) {
      this.toIdle();
      this.note('weekly', weeklyNote(resetsAt), 'warn');
      return;
    }
    if (resetsAt - now > HORIZON_MS) {
      this.toIdle();
      this.note('horizon', AUTO_CONTINUE_NOTES.horizon, 'warn');
      return;
    }
    if (resetsAt <= this.state.fireAt) return;
    const { attempt } = this.state;
    this.setState({ phase: 'waiting', resetsAt, fireAt: fireTime(resetsAt, attempt, this.armedAt, this.deps.random()), attempt });
  }

  private check(): void {
    if (this.disposed || this.state.phase !== 'waiting') {
      this.stopTimer();
      return;
    }
    const now = this.deps.now();
    const gap = now - this.lastCheck;
    this.lastCheck = now;
    if (now < this.state.fireAt) return;
    if (gap > SLEEP_GRACE_MS) {
      this.stopTimer();
      this.setState({ phase: 'stale', resetsAt: this.state.resetsAt });
      this.note('stale', AUTO_CONTINUE_NOTES.stale, 'info');
      return;
    }
    this.fire();
  }

  /** byUser: the user's Continue, which is not an automatic continue and starts a new run. */
  private fire(byUser = false): void {
    this.epoch++;
    this.toIdle();
    const uuid = this.deps.newId();
    this.deps.onNote(uuid, AUTO_CONTINUE_NOTE, 'info');
    this.continued = byUser ? 0 : this.continued + 1;
    this.deps.sendPrompt(uuid);
  }

  private toIdle(): void {
    this.stopTimer();
    this.setState({ phase: 'idle' });
  }

  private setState(state: AutoContinueState): void {
    this.state = state;
    if (!this.disposed) this.deps.onState(state);
  }

  private stopNote(kind: string, text: string, resetsAt?: number): void {
    const key = `${kind}:${resetsAt ?? ''}`;
    if (key === this.lastStop) return;
    this.lastStop = key;
    this.note(kind, text, 'warn');
  }

  private note(kind: string, text: string, level: 'info' | 'warn'): void {
    if (!this.disposed) this.deps.onNote(`autocontinue:${kind}:${this.deps.newId()}`, text, level);
  }

  private startTimer(): void {
    if (this.timer !== undefined) return;
    const timer = this.deps.timers.setInterval(() => this.check(), CHECK_MS);
    (timer as { unref?: () => void } | null)?.unref?.();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.deps.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
}
