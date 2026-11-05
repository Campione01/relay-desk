import { describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '@shared/types';
import {
  ACCOUNT_LABELS_KEY,
  anchorsMatch,
  checkAccountLabel,
  loadAccountLabels,
  saveAccountLabels,
  weeklyAnchor,
} from '../../src/renderer/state/accountLabel';

const MIN = 60_000;
const WEEK = 7 * 86_400_000;
const ANCHOR = Date.UTC(2026, 9, 22, 2, 0, 0);
const record = { email: 'me@example.com', weeklyAnchor: ANCHOR, seenAt: 1_000 };

describe('account label check', () => {
  it('stores the first label with its weekly anchor, and the label alone while no anchor is known', () => {
    expect(checkAccountLabel(undefined, 'me@example.com', ANCHOR, 5_000)).toEqual({
      record: { email: 'me@example.com', weeklyAnchor: ANCHOR, seenAt: 5_000 },
    });
    expect(checkAccountLabel(undefined, 'me@example.com', undefined, 5_000)).toEqual({
      record: { email: 'me@example.com', seenAt: 5_000 },
    });
    expect(checkAccountLabel(undefined, undefined, ANCHOR, 5_000)).toEqual({ record: undefined });
  });

  it('the same label refreshes the anchor and the time, keeping the old anchor when none is known now', () => {
    expect(checkAccountLabel(record, 'Me@Example.com', ANCHOR + WEEK, 9_000)).toEqual({
      record: { email: 'Me@Example.com', weeklyAnchor: ANCHOR + WEEK, seenAt: 9_000 },
    });
    expect(checkAccountLabel(record, 'me@example.com', undefined, 9_000)).toEqual({
      record: { ...record, seenAt: 9_000 },
    });
    expect(checkAccountLabel({ email: 'me@example.com', seenAt: 1 }, 'me@example.com', ANCHOR, 9_000).record).toEqual({
      email: 'me@example.com', weeklyAnchor: ANCHOR, seenAt: 9_000,
    });
  });

  it('a different label with a matching weekly anchor is drift: the remembered email stays', () => {
    for (const anchor of [ANCHOR, ANCHOR + WEEK, ANCHOR - 2 * WEEK]) {
      const check = checkAccountLabel(record, 'other@example.com', anchor, 9_000);
      expect(check.record).toBe(record);
      expect(check.drift).toEqual({ label: 'other@example.com', remembered: 'me@example.com' });
    }
  });

  it('a different label with a different weekly anchor is a real account change: the record is replaced', () => {
    const check = checkAccountLabel(record, 'other@example.com', ANCHOR + 3 * 86_400_000, 9_000);
    expect(check.drift).toBeUndefined();
    expect(check.record).toEqual({ email: 'other@example.com', weeklyAnchor: ANCHOR + 3 * 86_400_000, seenAt: 9_000 });
    const noAnchorBefore = checkAccountLabel({ email: 'me@example.com', seenAt: 1 }, 'other@example.com', ANCHOR, 9_000);
    expect(noAnchorBefore.drift).toBeUndefined();
    expect(noAnchorBefore.record).toEqual({ email: 'other@example.com', weeklyAnchor: ANCHOR, seenAt: 9_000 });
  });

  it('anchors match within two minutes of a whole number of weeks, not beyond', () => {
    expect(anchorsMatch(ANCHOR, ANCHOR + 2 * MIN)).toBe(true);
    expect(anchorsMatch(ANCHOR, ANCHOR - 2 * MIN)).toBe(true);
    expect(anchorsMatch(ANCHOR, ANCHOR + WEEK + 2 * MIN)).toBe(true);
    expect(anchorsMatch(ANCHOR, ANCHOR + WEEK - 2 * MIN)).toBe(true);
    expect(anchorsMatch(ANCHOR, ANCHOR + 2 * MIN + 1)).toBe(false);
    expect(anchorsMatch(ANCHOR, ANCHOR - 2 * MIN - 1)).toBe(false);
    expect(anchorsMatch(ANCHOR, ANCHOR + WEEK - 2 * MIN - 1)).toBe(false);
    expect(anchorsMatch(ANCHOR, ANCHOR + WEEK / 2)).toBe(false);
    const edge = checkAccountLabel(record, 'other@example.com', ANCHOR + 2 * MIN + 1, 9_000);
    expect(edge.drift).toBeUndefined();
    expect(edge.record?.email).toBe('other@example.com');
  });

  it('without a weekly anchor a different label never decides drift and keeps the record', () => {
    const check = checkAccountLabel(record, 'other@example.com', undefined, 9_000);
    expect(check).toEqual({ record, undecided: true });
  });

  it('reads the weekly anchor from the seven_day window only', () => {
    const usage = (windows: PlanUsage['windows']): PlanUsage => ({ profileId: 'default', available: true, windows, fetchedAt: 1 });
    expect(weeklyAnchor(usage([{ id: 'five_hour', percent: 1, resetsAt: 5 }, { id: 'seven_day', percent: 1, resetsAt: ANCHOR }]))).toBe(ANCHOR);
    expect(weeklyAnchor(usage([{ id: 'seven_day', percent: 0, resetsAt: null }]))).toBeUndefined();
    expect(weeklyAnchor(usage([{ id: 'seven_day_opus', percent: 1, resetsAt: ANCHOR }]))).toBeUndefined();
    expect(weeklyAnchor(undefined)).toBeUndefined();
  });
});

describe('account label storage', () => {
  it('round-trips records and treats corrupt data as no record', () => {
    saveAccountLabels({ default: record });
    expect(loadAccountLabels()).toEqual({ default: record });
    window.localStorage.setItem(ACCOUNT_LABELS_KEY, '{not json');
    expect(loadAccountLabels()).toEqual({});
    window.localStorage.setItem(ACCOUNT_LABELS_KEY, '[1,2]');
    expect(loadAccountLabels()).toEqual({});
    window.localStorage.setItem(ACCOUNT_LABELS_KEY, JSON.stringify({
      default: record,
      a: { email: 5, seenAt: 1 },
      b: { email: 'x@example.com', seenAt: 1, weeklyAnchor: 'soon' },
      c: null,
    }));
    expect(loadAccountLabels()).toEqual({ default: record });
  });

  it('storage that throws reads as no record and a failed write is ignored', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(loadAccountLabels()).toEqual({});
    expect(() => saveAccountLabels({ default: record })).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
