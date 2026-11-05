import { tmpdir } from 'node:os';
import { query as sdkQuery, type SDKControlGetUsageResponse, type SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '@shared/events';
import type { PlanUsage, PlanUsageWindow, Profile, ProfileId } from '@shared/types';
import { resolveClaudeBinary } from '../system/claudeBinary';
import { buildChildEnv } from '../system/env';
import { isRecord } from './mapTranscript';
import { redactSecrets } from './redaction';
import {
  AUTH_ERROR_MESSAGE,
  CLOSE_TIMEOUT_MS,
  InputQueue,
  isAuthFailure,
  ProcessTracker,
  spawnHidden,
  withTimeout,
  type QueryFunction,
  type SpawnChild,
} from './session';

type RateLimitInfo = SDKRateLimitEvent['rate_limit_info'];

const PROBE_TIMEOUT_MS = 30_000;
const CACHE_MS = 60_000;
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** What the usage service needs from an open session of the profile. */
export interface UsageSource {
  planUsage(): Promise<SDKControlGetUsageResponse>;
}

export interface UsageServiceDeps {
  emit(event: EngineEvent): void;
  /** Rejects for unknown ids. */
  getProfile(id: ProfileId): Promise<Profile>;
  /** A started session of the profile whose query can answer, if any. */
  liveSession?(profileId: ProfileId): UsageSource | undefined;
  isProfileBusy?(profileId: ProfileId): boolean;
  query?: QueryFunction;
  spawn?: SpawnChild;
  resolveBinary?(): string;
  buildEnv?(profile: Profile): NodeJS.ProcessEnv;
  now?(): number;
  probeTimeoutMs?: number;
  closeTimeoutMs?: number;
  cacheMs?: number;
  /** Last good usage per account across restarts (usageMemory.ts). */
  memory?: UsageMemory;
}

export interface UsageMemory {
  load(): Promise<Partial<Record<ProfileId, PlanUsage>>>;
  save(usage: PlanUsage): void;
  /** Persist removal of one profile after all earlier queued writes. */
  forget?(profileId: ProfileId): Promise<void>;
}

export interface UsageService {
  /** Cached for 60 s unless force; one fetch at a time per profile. Errors come back as `error`, never thrown. */
  get(profileId: ProfileId, force?: boolean): Promise<PlanUsage>;
  /** rate_limit_event of a live session: updates that window of the cached usage. */
  onRateLimit(profileId: ProfileId, info: RateLimitInfo): void;
  /** Discard readings from the previous authentication source, when supported by the backend. */
  invalidate?(profileId: ProfileId): Promise<void>;
  /** Ends running probes (app quit). */
  dispose(): Promise<void>;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Per-model weekly buckets the server names itself (rate_limits.model_scoped, e.g. "Fable"). */
export const MODEL_SCOPED_PREFIX = 'model_scoped:';
const MAX_MODEL_NAME = 60;

function windowRank(id: string): number {
  const index = WINDOW_ORDER.indexOf(id);
  if (index >= 0) return index;
  return id.startsWith(MODEL_SCOPED_PREFIX) ? WINDOW_ORDER.length : WINDOW_ORDER.length + 1;
}

/** five_hour, seven_day, seven_day_opus, seven_day_sonnet, the server-named model buckets, then the rest alphabetically. */
export function sortWindows(windows: PlanUsageWindow[]): PlanUsageWindow[] {
  return [...windows].sort((a, b) => windowRank(a.id) - windowRank(b.id) || a.id.localeCompare(b.id));
}

/** Maps the experimental /usage answer; utilization is already 0-100 there. */
export function toPlanUsage(profileId: ProfileId, response: unknown, now: number): PlanUsage {
  const body = isRecord(response) ? response : {};
  const limits = isRecord(body.rate_limits) ? body.rate_limits : {};
  const windows: PlanUsageWindow[] = [];
  for (const [id, value] of Object.entries(limits)) {
    if (!isRecord(value) || !('utilization' in value) || !('resets_at' in value)) continue;
    const resets = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    windows.push({ id, percent: finite(value.utilization), resetsAt: Number.isFinite(resets) ? resets : null });
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const bucket of limits.model_scoped) {
      if (!isRecord(bucket) || typeof bucket.display_name !== 'string') continue;
      const name = bucket.display_name.trim();
      const id = `${MODEL_SCOPED_PREFIX}${name}`;
      if (!name || name.length > MAX_MODEL_NAME || windows.some((w) => w.id === id)) continue;
      const resets = typeof bucket.resets_at === 'string' ? Date.parse(bucket.resets_at) : NaN;
      windows.push({ id, percent: finite(bucket.utilization), resetsAt: Number.isFinite(resets) ? resets : null });
    }
  }
  const extra = isRecord(limits.extra_usage) ? limits.extra_usage : undefined;
  return {
    profileId,
    available: body.rate_limits_available === true,
    ...(typeof body.subscription_type === 'string' && body.subscription_type ? { subscriptionType: body.subscription_type } : {}),
    windows: sortWindows(windows),
    ...(extra
      ? {
          extraUsage: {
            enabled: extra.is_enabled === true,
            percent: finite(extra.utilization),
            usedCredits: finite(extra.used_credits),
            monthlyLimit: finite(extra.monthly_limit),
            currency: typeof extra.currency === 'string' ? extra.currency : null,
          },
        }
      : {}),
    fetchedAt: now,
  };
}

/**
 * A session that has already called the API answers from a snapshot seeded by response headers, which carries no
 * per-model weekly buckets: the CLI then leaves `model_scoped` out, while a fresh read always sends it (empty when
 * the plan has none). API-key accounts have no rate limits at all.
 */
export function isCompleteUsage(response: unknown): boolean {
  const body = isRecord(response) ? response : {};
  return !isRecord(body.rate_limits) || 'model_scoped' in body.rate_limits;
}

const SAME_WINDOW_MS = 2 * 60_000;

/** The endpoint and the response headers state one reset a fraction of a second apart. */
function sameWindow(a: PlanUsageWindow, b: PlanUsageWindow): boolean {
  return a.resetsAt !== null && b.resetsAt !== null && Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_MS;
}

/**
 * Usage only grows inside one window, and the two official sources can disagree: the limiter (the
 * rate-limit headers of a live turn, which decide rejections) may show a higher five_hour than the usage endpoint for
 * the same reset. So the higher figure of the same window wins; `addMissing` also takes windows only `other` has.
 */
export function keepHigher(base: PlanUsage, other: PlanUsage | undefined, addMissing = false): PlanUsage {
  if (!base.available || !other?.available || other.error) return base;
  const windows = base.windows.map((window) => {
    const match = other.windows.find((candidate) => candidate.id === window.id);
    return match && sameWindow(window, match) && (match.percent ?? -1) > (window.percent ?? -1) ? { ...match } : window;
  });
  if (addMissing) {
    for (const extra of other.windows) if (!windows.some((window) => window.id === extra.id)) windows.push({ ...extra });
  }
  return { ...base, windows: sortWindows(windows) };
}

const CORE_WINDOWS: readonly string[] = ['five_hour', 'seven_day'];

/**
 * The usage endpoint may answer with no data at all (rate_limits null right after a 5-hour reset)
 * or without a window it sent before. Windows of the last good usage that the new one lacks stay while their period
 * runs; an ended core window starts again at 0 ("Starts when a message is sent"); other ended windows drop.
 */
export function carryOver(next: PlanUsage, known: PlanUsage | undefined, now: number): PlanUsage {
  if (!next.available || next.error || !known?.available) return next;
  const windows = [...next.windows];
  for (const old of known.windows) {
    if (windows.some((window) => window.id === old.id)) continue;
    if (old.resetsAt !== null && old.resetsAt > now) windows.push({ ...old });
    else if (CORE_WINDOWS.includes(old.id)) windows.push({ id: old.id, percent: 0, resetsAt: null });
  }
  return { ...next, windows: sortWindows(windows) };
}

function errorUsage(profileId: ProfileId, message: string, now: number): PlanUsage {
  return { profileId, available: false, windows: [], fetchedAt: now, error: message };
}

/** Folds one rate_limit_event into a usage snapshot; resetsAt there is epoch seconds and utilization a 0-1 fraction. */
export function applyRateLimit(usage: PlanUsage, info: RateLimitInfo): PlanUsage {
  const windows = usage.windows.map((window) => ({ ...window }));
  const upsert = (id: string, patch: Partial<PlanUsageWindow>): void => {
    const existing = windows.find((window) => window.id === id);
    if (existing) Object.assign(existing, patch);
    else windows.push({ id, percent: null, resetsAt: null, ...patch });
  };
  const percentOf = (fraction: unknown): Partial<PlanUsageWindow> => {
    const value = finite(fraction);
    return value === null ? {} : { percent: Math.round(value * 1000) / 10 };
  };
  const resetOf = (seconds: unknown): Partial<PlanUsageWindow> => {
    const value = finite(seconds);
    return value === null ? {} : { resetsAt: value * 1000 };
  };
  // @internal per-window snapshot of the response headers; read only when present.
  const unified = (info as { unifiedWindows?: unknown }).unifiedWindows;
  if (isRecord(unified)) {
    for (const [id, value] of Object.entries(unified)) {
      if (isRecord(value)) upsert(id, { ...percentOf(value.utilization), ...resetOf(value.resetsAt) });
    }
  }
  const type = info.rateLimitType;
  if (type && type !== 'overage') {
    upsert(type, { status: info.status, ...percentOf(info.utilization), ...resetOf(info.resetsAt) });
  }
  return { ...usage, windows: sortWindows(windows) };
}

/** Runs one non-persisted CLI just long enough to answer the usage request; no hooks or project settings load. */
async function probe(profile: Profile, deps: UsageServiceDeps, register: (stop: () => Promise<void>) => () => void): Promise<SDKControlGetUsageResponse> {
  const input = new InputQueue();
  const tracker = new ProcessTracker(deps.spawn ?? spawnHidden, undefined);
  const query = (deps.query ?? sdkQuery)({
    prompt: input,
    options: {
      cwd: tmpdir(),
      persistSession: false,
      settingSources: [],
      env: (deps.buildEnv ?? buildChildEnv)(profile),
      pathToClaudeCodeExecutable: (deps.resolveBinary ?? resolveClaudeBinary)(),
      spawnClaudeCodeProcess: tracker.spawn,
    },
  });
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      input.end();
      try {
        query.close();
      } catch {
        // already closed
      }
      await tracker.waitForExit(deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    })();
    return stopped;
  };
  const unregister = register(stop);
  void (async () => {
    for await (const _message of query) {
      // drained so the SDK never waits on an unread stream
    }
  })().catch(() => undefined);
  try {
    return await withTimeout(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      'Claude Code did not report the plan usage in time.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(isAuthFailure(message) || isAuthFailure(tracker.tail) ? AUTH_ERROR_MESSAGE : message);
  } finally {
    try {
      await stop();
    } finally {
      unregister();
    }
  }
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? Date.now;
  const cache = new Map<ProfileId, PlanUsage>();
  const fetchedAt = new Map<ProfileId, number>();
  const inflight = new Map<ProfileId, Promise<PlanUsage>>();
  const probes = new Set<() => Promise<void>>();
  /** Last good usage per account: what new answers are merged with (a failed fetch does not replace it). */
  const known = new Map<ProfileId, PlanUsage>();
  const ready = deps.memory
    ? deps.memory.load().then(
        (stored) => {
          for (const [id, usage] of Object.entries(stored)) if (usage && !known.has(id)) known.set(id, usage);
        },
        () => undefined,
      )
    : Promise.resolve();
  const remember = (usage: PlanUsage): void => {
    if (!usage.available || usage.error) return;
    known.set(usage.profileId, usage);
    deps.memory?.save(usage);
  };

  const emit = (usage: PlanUsage): void => {
    try {
      deps.emit({ type: 'usage', usage });
    } catch (error) {
      console.error('[relay:usage] could not deliver usage', error);
    }
  };

  const fetchUsage = async (profileId: ProfileId): Promise<PlanUsage> => {
    let usage: PlanUsage;
    try {
      if (deps.isProfileBusy?.(profileId)) throw new Error('This account is busy with sign-in or account changes.');
      await ready;
      const profile = await deps.getProfile(profileId);
      const live = deps.liveSession?.(profileId);
      let response: SDKControlGetUsageResponse | undefined;
      if (live) {
        try {
          response = await live.planUsage();
        } catch {
          // The session may be closing; a probe still answers.
        }
      }
      if (response && isCompleteUsage(response)) {
        usage = toPlanUsage(profileId, response, now());
      } else {
        const probed = toPlanUsage(
          profileId,
          await probe(profile, deps, (stop) => {
            probes.add(stop);
            return () => probes.delete(stop);
          }),
          now(),
        );
        // The snapshot still holds the limiter's own figures; the probe adds the per-model buckets.
        usage = response ? keepHigher(probed, toPlanUsage(profileId, response, now()), true) : probed;
      }
      const last = known.get(profileId);
      usage = carryOver(keepHigher(usage, last), last, now());
      remember(usage);
    } catch (error) {
      usage = errorUsage(profileId, redactSecrets(error instanceof Error ? error.message : String(error)), now());
    }
    cache.set(profileId, usage);
    fetchedAt.set(profileId, usage.fetchedAt);
    emit(usage);
    return usage;
  };

  return {
    get(profileId, force = false) {
      const running = inflight.get(profileId);
      if (running) return running;
      const cached = cache.get(profileId);
      const at = fetchedAt.get(profileId);
      if (!force && cached && at !== undefined && now() - at < (deps.cacheMs ?? CACHE_MS)) return Promise.resolve(cached);
      const pending = fetchUsage(profileId).finally(() => inflight.delete(profileId));
      inflight.set(profileId, pending);
      return pending;
    },
    onRateLimit(profileId, info) {
      const cached = cache.get(profileId);
      // Rate-limit events come only for plan accounts, so they replace a failed fetch.
      const base = known.get(profileId) ?? { profileId, available: true, windows: [], fetchedAt: now() };
      const next = applyRateLimit(base, info);
      if (cached && !cached.error && JSON.stringify(next.windows) === JSON.stringify(cached.windows)) return;
      cache.set(profileId, next);
      remember(next);
      emit(next);
    },
    async dispose() {
      await Promise.allSettled([...probes].map((stop) => stop()));
    },
  };
}
