import type { EngineEvent } from '@shared/events';
import type { PlanUsage, ProfileId } from '@shared/types';
import type { UsageMemory, UsageService, UsageServiceDeps, UsageSource } from '../engine/usage';
import { redactSecrets } from '../engine/redaction';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const tokens = (value: unknown): number | undefined =>
  nonnegative(value) !== undefined && Number.isSafeInteger(value) ? value as number : undefined;

export interface NativeUsageObservation {
  /** Only the windows actually reported; absence does not identify the account's plan. */
  planUsage?: PlanUsage;
  /** Cumulative session USD estimate, not a turn delta or a subscription quota. */
  sessionCostUsd?: number;
  /** Present on session.usage, not session.measure; changes on /clear. */
  sessionStartedAt?: number;
}

/** A local native snapshot, not an SDKControlGetUsageResponse or an account endpoint request. */
export interface NativePlanUsageSource {
  nativePlanUsage(): Promise<PlanUsage | null>;
}

interface NativeContextUsageSource {
  contextUsage(detail: 'summary'): Promise<unknown>;
}

type NativeUsageServiceDeps = Omit<Pick<UsageServiceDeps, 'emit' | 'getProfile' | 'liveSession' | 'isProfileBusy' | 'now'>, 'liveSession'> & {
  liveSession?(profileId: ProfileId): NativePlanUsageSource | NativeContextUsageSource | UsageSource | undefined;
};

/** Projects SessionUsage/SessionMeasureInput without a request, SDK ledger, or pricing estimate. */
export function nativeUsageObservation(value: unknown, profileId: ProfileId, now: number): NativeUsageObservation {
  if (!isRecord(value)) return {};
  const windows: PlanUsage['windows'] = [];
  for (const row of Array.isArray(value.rateLimits) ? value.rateLimits : []) {
    if (!isRecord(row) || typeof row.kind !== 'string' || !row.kind.trim()) continue;
    const percent = nonnegative(row.percentUsed);
    if (percent === undefined) continue;
    const reset = typeof row.resetsAt === 'string' ? Date.parse(row.resetsAt) : NaN;
    windows.push({ id: row.kind, percent, resetsAt: Number.isFinite(reset) ? reset : null,
      ...(!Number.isFinite(reset) ? { resetUnknown: true } : {}) });
  }
  const cost = isRecord(value.cost) ? nonnegative(value.cost.usd) : undefined;
  const startedAt = nonnegative(value.startedAt);
  return {
    ...(windows.length ? { planUsage: { profileId, available: true, windows, fetchedAt: now } } : {}),
    ...(cost !== undefined ? { sessionCostUsd: cost } : {}),
    ...(startedAt !== undefined ? { sessionStartedAt: startedAt } : {}),
  };
}

/** All native ModelUsage input components are required; partial input is unknown, not zero. */
export function nativeTurnTokens(value: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isRecord(value)) return {};
  const input = tokens(value.input_tokens);
  const read = tokens(value.cache_read_input_tokens);
  const write = tokens(value.cache_creation_input_tokens);
  const output = tokens(value.output_tokens);
  const total = input !== undefined && read !== undefined && write !== undefined ? tokens(input + read + write) : undefined;
  return { ...(total !== undefined ? { inputTokens: total } : {}), ...(output !== undefined ? { outputTokens: output } : {}) };
}

function nativeSnapshot(usage: PlanUsage): PlanUsage {
  const snapshot = structuredClone(usage);
  // Older/shared persistence readers retain null but not the native-only marker.
  for (const window of snapshot.windows) if (window.resetsAt === null) window.resetUnknown = true;
  return snapshot;
}

const CORE_WINDOWS: readonly string[] = ['five_hour', 'seven_day'];

/** As carryOver in engine/usage.ts: an ended core window starts again at 0 ("Starts when a message is sent"); other ended windows drop. */
function expire(usage: PlanUsage, now: number): PlanUsage {
  usage.windows = usage.windows.flatMap((window) => window.resetsAt === null || window.resetsAt > now ? [window]
    : CORE_WINDOWS.includes(window.id) ? [{ id: window.id, percent: 0, resetsAt: null }] : []);
  return usage;
}

/** Reads native observations only; there is deliberately no SDK probe path. */
export function createNativeUsageCache(memory?: UsageMemory, clock: () => number = Date.now) {
  const fresh = (usage: PlanUsage, now = clock()): PlanUsage => expire(structuredClone(usage), now);
  const values = new Map<ProfileId, PlanUsage>();
  const generations = new Map<ProfileId, number>();
  const generation = (id: ProfileId): number => generations.get(id) ?? 0;
  const invalidations = new Map<ProfileId, Promise<void>>();
  const loaded = memory?.load().then((rows) => {
    for (const [id, value] of Object.entries(rows)) {
      if (generation(id) === 0 && value?.profileId === id && value.available && !value.error && !values.has(id)) values.set(id, nativeSnapshot(value));
    }
  }).catch(() => {}) ?? Promise.resolve();
  const flights = new Map<string, Promise<PlanUsage>>();
  const pendingReads = new Set<Promise<PlanUsage>>();
  let disposed = false;
  function observe(event: EngineEvent, observedGeneration?: number): PlanUsage | undefined {
    if (event.type !== 'usage' || !event.usage.available || event.usage.error || disposed) return;
    const id = event.usage.profileId;
    if (invalidations.has(id) || observedGeneration !== undefined && observedGeneration !== generation(id)) return;
    const old = values.get(event.usage.profileId);
    if (old && event.usage.fetchedAt < old.fetchedAt) return fresh(old);
    const next = nativeSnapshot(event.usage);
    if (old) {
      for (const row of next.windows) {
        // An unknown reset cannot prove two readings belong to the same window.
        const prior = row.resetsAt !== null && Number.isFinite(row.resetsAt)
          ? old.windows.find((value) => value.id === row.id && value.resetsAt === row.resetsAt) : undefined;
        if (prior?.percent !== null && prior?.percent !== undefined && row.percent !== null) row.percent = Math.max(prior.percent, row.percent);
      }
    }
    values.set(next.profileId, next);
    try { memory?.save(structuredClone(next)); } catch { /* Persistence cannot break a live session's event delivery. */ }
    return fresh(next);
  }
  function invalidate(id: ProfileId): Promise<void> {
    const active = invalidations.get(id);
    if (active) return active;
    generations.set(id, generation(id) + 1);
    values.delete(id);
    flights.delete(id);
    const run = loaded.then(async () => {
      values.delete(id);
      await memory?.forget?.(id);
    }).finally(() => { if (invalidations.get(id) === run) invalidations.delete(id); });
    invalidations.set(id, run);
    return run;
  }
  function createService(deps: NativeUsageServiceDeps): UsageService {
    const now = deps.now ?? clock;
    const unavailable = (id: ProfileId, error: string): PlanUsage =>
      ({ profileId: id, available: false, windows: [], fetchedAt: now(), error });
    return {
      get(id, force = false) {
        const active = flights.get(id);
        if (active) return active;
        const requestedGeneration = generation(id);
        const invalidated = () => unavailable(id, 'Native usage was invalidated because this profile changed.');
        const run = (async (): Promise<PlanUsage> => {
          await loaded;
          try { await invalidations.get(id); }
          catch (error) { return unavailable(id, redactSecrets(error instanceof Error ? error.message : String(error))); }
          if (requestedGeneration !== generation(id)) return invalidated();
          try { await deps.getProfile(id); }
          catch (error) { return unavailable(id, redactSecrets(error instanceof Error ? error.message : String(error))); }
          if (requestedGeneration !== generation(id)) return invalidated();
          const previous = values.get(id);
          if (disposed) return previous ? fresh(previous, now()) : unavailable(id, 'Native usage service is closed.');
          const live = deps.liveSession?.(id);
          if (live && !deps.isProfileBusy?.(id) && (force || !previous)) {
            try {
              if ('nativePlanUsage' in live) {
                const usage = await live.nativePlanUsage();
                if (usage?.profileId === id) observe({ type: 'usage', usage }, requestedGeneration);
              } else if ('contextUsage' in live) {
                // Compatibility with earlier native sessions; this path emits its own reading.
                await live.contextUsage('summary');
              }
            } catch { /* Keep the last native reading; do not fall back to another request path. */ }
          }
          if (requestedGeneration !== generation(id)) return invalidated();
          const current = values.get(id);
          return current ? fresh(current, now()) : unavailable(id, disposed ? 'Native usage service is closed.'
            : 'No subscription usage reading has been reported by an interactive session yet; account eligibility is unknown.');
        })().finally(() => { if (flights.get(id) === run) flights.delete(id); pendingReads.delete(run); });
        flights.set(id, run);
        pendingReads.add(run);
        return run;
      },
      onRateLimit() { /* SDK-shaped events are not evidence of a native session.measure observation. */ },
      invalidate,
      async dispose() { disposed = true; await Promise.allSettled([...pendingReads, ...invalidations.values()]); },
    };
  }
  return { observe, createService, generation };
}
