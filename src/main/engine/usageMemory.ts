import type { PlanUsage, PlanUsageWindow, ProfileId } from '@shared/types';
import { createSerialQueue, readJsonFile, writeJsonFileAtomic } from '../system/jsonFile';
import { isRecord } from './mapTranscript';
import type { UsageMemory } from './usage';

const VERSION = 1;
const MAX_WINDOWS = 32;
const MAX_ID_LENGTH = 100;
const STATUSES: readonly string[] = ['allowed', 'allowed_warning', 'rejected'];

interface StoredUsage {
  subscriptionType?: string;
  windows: PlanUsageWindow[];
  savedAt: number;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown): PlanUsageWindow | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > MAX_ID_LENGTH) return null;
  const percent = finiteOrNull(value.percent);
  const resetsAt = finiteOrNull(value.resetsAt);
  if (percent === undefined || resetsAt === undefined) return null;
  return { id: value.id, percent, resetsAt, ...(STATUSES.includes(value.status as string) ? { status: value.status as PlanUsageWindow['status'] } : {}) };
}

function parseStored(value: unknown): StoredUsage | null {
  if (!isRecord(value) || !Array.isArray(value.windows) || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null;
  const windows = value.windows.slice(0, MAX_WINDOWS).map(parseWindow).filter((w): w is PlanUsageWindow => w !== null);
  return {
    windows,
    savedAt: value.savedAt,
    ...(typeof value.subscriptionType === 'string' && value.subscriptionType ? { subscriptionType: value.subscriptionType } : {}),
  };
}

/**
 * The last good plan usage per account in userData (usage-cache.json: window ids, percents and reset times only), so the
 * limiter's figures a session saw survive a restart, with no extra requests.
 */
export function createUsageMemory(path: string): UsageMemory {
  const queue = createSerialQueue();
  // No prototype: profile ids come from a file.
  let stored: Record<ProfileId, StoredUsage> = Object.create(null) as Record<ProfileId, StoredUsage>;
  const ready = (async () => {
    try {
      const read = await readJsonFile(path);
      if (read.state !== 'ok' || !isRecord(read.value) || !isRecord(read.value.profiles)) return;
      for (const [id, value] of Object.entries(read.value.profiles)) {
        const usage = parseStored(value);
        if (usage) stored[id] = usage;
      }
    } catch {
      // Unreadable memory only means usage starts from what the CLI reports.
    }
  })();

  return {
    async load() {
      await ready;
      return Object.fromEntries(
        Object.entries(stored).map(([id, usage]): [ProfileId, PlanUsage] => [
          id,
          {
            profileId: id,
            available: true,
            ...(usage.subscriptionType ? { subscriptionType: usage.subscriptionType } : {}),
            windows: usage.windows.map((w) => ({ ...w })),
            fetchedAt: usage.savedAt,
          },
        ]),
      );
    },
    save(usage) {
      if (!usage.available || usage.error) return;
      void queue(async () => {
        await ready;
        stored = {
          ...stored,
          [usage.profileId]: {
            ...(usage.subscriptionType ? { subscriptionType: usage.subscriptionType } : {}),
            windows: usage.windows.map((w) => ({ ...w })),
            savedAt: usage.fetchedAt,
          },
        };
        await writeJsonFileAtomic(path, { version: VERSION, profiles: stored });
      }).catch(() => undefined);
    },
    forget(profileId) {
      return queue(async () => {
        await ready;
        const next = { ...stored };
        delete next[profileId];
        await writeJsonFileAtomic(path, { version: VERSION, profiles: next });
        stored = next;
      });
    },
  };
}
