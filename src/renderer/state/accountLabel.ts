import type { PlanUsage, ProfileId } from '@shared/types';

/**
 * The email that `claude auth status` and a session's account info report is a label in the shared Claude Code
 * settings, which any Claude Code process using the same config folder may rewrite (the desktop's Code feature signed
 * in as another account does). The token, and so the real account, stays the same. The weekly reset time of the usage
 * API is fixed per account and only moves in steps of 7 days, so it tells whether a changed label still belongs to the
 * same account without touching any credential.
 */
export const ACCOUNT_LABELS_KEY = 'relay.accountLabels';

const WEEK_MS = 7 * 86_400_000;
export const ANCHOR_TOLERANCE_MS = 2 * 60_000;

export interface AccountLabelRecord {
  email: string;
  /** Weekly ('seven_day') reset time seen with this email; absent until usage reported one. */
  weeklyAnchor?: number;
  seenAt: number;
}

export interface AccountLabelDrift {
  /** The label the shared settings show now. */
  label: string;
  /** The email Relay saw for this account before the label changed. */
  remembered: string;
}

export interface AccountLabelCheck {
  record: AccountLabelRecord | undefined;
  drift?: AccountLabelDrift;
  /** A different label arrived but no weekly anchor allows a decision yet; the record is kept as it was. */
  undecided?: boolean;
}

/** The weekly reset time of an account's usage, or undefined (no usage, failed fetch, weekly window not started). */
export function weeklyAnchor(usage: PlanUsage | undefined): number | undefined {
  const resetsAt = usage?.windows.find((w) => w.id === 'seven_day')?.resetsAt;
  return typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : undefined;
}

/** Same account: the two weekly reset times differ by a whole number of weeks, within the tolerance. */
export function anchorsMatch(a: number, b: number): boolean {
  const rest = Math.abs(a - b) % WEEK_MS;
  return Math.min(rest, WEEK_MS - rest) <= ANCHOR_TOLERANCE_MS;
}

const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Compares a newly reported label with the remembered one. Never calls anything; the caller stores the record. */
export function checkAccountLabel(
  record: AccountLabelRecord | undefined,
  email: string | undefined,
  anchor: number | undefined,
  now: number,
): AccountLabelCheck {
  if (!email) return { record };
  if (!record) return { record: { email, ...(anchor !== undefined ? { weeklyAnchor: anchor } : {}), seenAt: now } };
  if (sameEmail(record.email, email)) {
    const kept = anchor ?? record.weeklyAnchor;
    return { record: { email, ...(kept !== undefined ? { weeklyAnchor: kept } : {}), seenAt: now } };
  }
  if (anchor === undefined) return { record, undecided: true };
  if (record.weeklyAnchor !== undefined && anchorsMatch(record.weeklyAnchor, anchor)) {
    return { record, drift: { label: email, remembered: record.email } };
  }
  return { record: { email, weeklyAnchor: anchor, seenAt: now } };
}

function isRecord(value: unknown): value is AccountLabelRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<AccountLabelRecord>;
  return typeof r.email === 'string' && r.email !== '' && typeof r.seenAt === 'number' &&
    (r.weeklyAnchor === undefined || (typeof r.weeklyAnchor === 'number' && Number.isFinite(r.weeklyAnchor)));
}

/** Remembered labels per profile; unreadable or malformed entries count as no record. */
export function loadAccountLabels(): Record<ProfileId, AccountLabelRecord> {
  const records: Record<ProfileId, AccountLabelRecord> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACCOUNT_LABELS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return records;
    for (const [id, value] of Object.entries(parsed)) {
      if (isRecord(value)) records[id] = value;
    }
  } catch {
    // Corrupt or unavailable storage: no records.
  }
  return records;
}

export function saveAccountLabels(records: Record<ProfileId, AccountLabelRecord>): void {
  try {
    window.localStorage.setItem(ACCOUNT_LABELS_KEY, JSON.stringify(records));
  } catch {
    // The check starts over next time.
  }
}
