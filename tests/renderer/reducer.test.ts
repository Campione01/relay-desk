import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@shared/events';
import { applyEngineEvent, createView, hasOpenHandle, mergeHistory } from '../../src/renderer/state/sessionReducer';
import type { SessionView } from '../../src/renderer/state/types';

const H = 'h-1';
const base = (): SessionView =>
  createView({ key: 'k', profileId: 'default', cwd: 'D:\\x', title: 't', handleId: H, engineState: 'idle' });
const apply = (view: SessionView, ...events: EngineEvent[]): SessionView =>
  events.reduce((v, e) => applyEngineEvent(v, e, 1_000), view);

describe('applyEngineEvent', () => {
  it('replaces an item with the same id in place and appends new ones', () => {
    const view = apply(
      base(),
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'a', text: 'one' } },
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'b', text: 'two' } },
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'a', text: 'one (final)' } },
    );
    expect(view.items.map((i) => (i.kind === 'assistant' ? i.text : ''))).toEqual(['one (final)', 'two']);
  });

  it('puts a new item right after its shown afterId, appends it when that item is not shown and replaces an existing id in place', () => {
    const shown = apply(
      base(),
      { type: 'item', handleId: H, item: { kind: 'user', id: 'cmd', text: '/compact' } },
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'later', text: 'later reply' } },
      { type: 'item', handleId: H, afterId: 'cmd', item: { kind: 'system', id: 'out', text: 'Compacted', level: 'info', durationMs: 167_846 } },
    );
    expect(shown.items.map((i) => i.id)).toEqual(['cmd', 'out', 'later']);
    const missing = apply(shown, { type: 'item', handleId: H, afterId: 'gone', item: { kind: 'system', id: 'note', text: 'Set effort', level: 'info' } });
    expect(missing.items.map((i) => i.id)).toEqual(['cmd', 'out', 'later', 'note']);
    const replaced = apply(missing, { type: 'item', handleId: H, afterId: 'later', item: { kind: 'system', id: 'out', text: 'Compacted (final)', level: 'info' } });
    expect(replaced.items.map((i) => i.id)).toEqual(['cmd', 'out', 'later', 'note']);
    expect(replaced.items[1]).toEqual({ kind: 'system', id: 'out', text: 'Compacted (final)', level: 'info' });
    const echoed = apply({ ...replaced, items: [...replaced.items, { kind: 'user', id: 'local-2', text: 'next' }], localEchoes: ['local-2'] },
      { type: 'item', handleId: H, afterId: 'cmd', item: { kind: 'user', id: 'u-2', text: 'next' } });
    expect(echoed.items.map((i) => i.id)).toEqual(['cmd', 'out', 'later', 'note', 'u-2']);
    expect(echoed.localEchoes).toEqual([]);
  });

  it('appends streaming deltas and creates the item when the delta comes first', () => {
    const view = apply(
      base(),
      { type: 'delta', handleId: H, itemId: 'a', text: 'Hel' },
      { type: 'delta', handleId: H, itemId: 'a', text: 'lo' },
    );
    expect(view.items).toEqual([{ kind: 'assistant', id: 'a', text: 'Hello', streaming: true }]);
  });

  it('swaps a local echo for the engine user item with the same text', () => {
    const echoed: SessionView = {
      ...base(),
      items: [{ kind: 'user', id: 'local-1', text: 'hi' }],
      localEchoes: ['local-1'],
    };
    const view = apply(echoed, { type: 'item', handleId: H, item: { kind: 'user', id: 'u-9', text: 'hi' } });
    expect(view.items).toEqual([{ kind: 'user', id: 'u-9', text: 'hi' }]);
    expect(view.localEchoes).toEqual([]);
  });

  it('a queued message moves after the reply it waited for once it is sent', () => {
    const view = apply(
      base(),
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'a1', text: 'working', streaming: true } },
      { type: 'item', handleId: H, item: { kind: 'user', id: 'q', text: 'later', queued: true } },
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'a1', text: 'done' } },
      { type: 'item', handleId: H, item: { kind: 'result', id: 'r1' } },
      { type: 'item', handleId: H, item: { kind: 'user', id: 'q', text: 'later' } },
    );
    expect(view.items.map((i) => i.id)).toEqual(['a1', 'r1', 'q']);
    expect(view.items.at(-1)).toEqual({ kind: 'user', id: 'q', text: 'later' });
  });

  it('adds permission and question cards and drops them on requestClosed', () => {
    const opened = apply(
      base(),
      { type: 'permission', request: { requestId: 'p1', handleId: H, toolName: 'Bash', input: {} } },
      { type: 'question', request: { requestId: 'q1', handleId: H, questions: [] } },
    );
    expect(opened.permissions).toHaveLength(1);
    expect(opened.questions).toHaveLength(1);
    const closed = apply(opened, { type: 'requestClosed', handleId: H, requestId: 'p1' });
    expect(closed.permissions).toEqual([]);
    expect(closed.questions).toHaveLength(1);
  });

  it('starts the timer on a new turn and keeps it while awaiting', () => {
    const running = apply(base(), { type: 'state', handleId: H, state: 'running' });
    expect(running.startedAt).toBe(1_000);
    const awaiting = applyEngineEvent(running, { type: 'state', handleId: H, state: 'awaiting', tokens: 5 }, 9_000);
    expect(awaiting.startedAt).toBe(1_000);
    expect(awaiting.tokens).toBe(5);
  });

  it('closing the handle clears the handle and pending cards', () => {
    const view = apply(
      base(),
      { type: 'permission', request: { requestId: 'p1', handleId: H, toolName: 'Bash', input: {} } },
      { type: 'state', handleId: H, state: 'closed' },
    );
    expect(view.engineState).toBe('closed');
    expect(view.handleId).toBeUndefined();
    expect(view.permissions).toEqual([]);
    expect(hasOpenHandle(view)).toBe(false);
  });

  it('closing a queued user item marks unknown delivery without losing its text or image references', () => {
    const queued = { kind: 'user' as const, id: 'q', text: 'Keep this request', queued: true,
      images: 1, imageRefs: [{ key: 'queued-image', mediaType: 'image/png' }] };
    const view = apply({ ...base(), items: [queued, { kind: 'user', id: 'sent', text: 'Already observed' }] },
      { type: 'state', handleId: H, state: 'closed' });
    expect(view.items[0]).toMatchObject({ ...queued, queued: undefined, deliveryUnconfirmed: true });
    expect(view.items[1]).toEqual({ kind: 'user', id: 'sent', text: 'Already observed' });
    expect(queued.queued).toBe(true);
  });

  it('a modal failure can mark queued intent unconfirmed without closing the healthy handle', () => {
    const queued = { kind: 'user' as const, id: 'modal-queued', text: 'Keep this request', queued: true,
      images: 1, imageRefs: [{ key: 'modal-image', mediaType: 'image/png' }] };
    const view = apply({ ...base(), engineState: 'idle', items: [queued] },
      { type: 'item', handleId: H, item: { ...queued, queued: undefined, deliveryUnconfirmed: true } });
    expect(view.engineState).toBe('idle');
    expect(view.handleId).toBe(H);
    expect(view.items).toEqual([{ ...queued, queued: undefined, deliveryUnconfirmed: true }]);
    expect(view.items).toHaveLength(1);
    expect(queued.queued).toBe(true);
  });

  it('preserves only explicit unconfirmed user items across stale history replacement and trusts actual matching IDs', () => {
    const closed = apply({ ...base(), items: [
      { kind: 'user', id: 'q', text: 'Identical words', queued: true, imageRefs: [{ key: 'queued-image', mediaType: 'image/png' }] },
      { kind: 'assistant', id: 'old-display', text: 'Old live display' },
    ] }, { type: 'state', handleId: H, state: 'closed' });
    const history = [{ kind: 'user' as const, id: 'different-actual-id', text: 'Identical words' }];
    const merged = mergeHistory(closed, history, new Set(closed.items.map((item) => item.id)));
    expect(merged.items.map((item) => item.id)).toEqual(['different-actual-id', 'q']);
    expect(merged.items[1]).toMatchObject({ deliveryUnconfirmed: true, imageRefs: [{ key: 'queued-image', mediaType: 'image/png' }] });
    const delivered = { kind: 'user' as const, id: 'q', text: 'Identical words' };
    expect(mergeHistory(merged, [...history, delivered], new Set(merged.items.map((item) => item.id))).items).toEqual([...history, delivered]);
  });

  it('does not match unconfirmed local intent by text and clears its status only on actual same-ID delivery', () => {
    const closed = apply({ ...base(), localEchoes: ['q'], items: [{ kind: 'user', id: 'q', text: 'Same words', queued: true }] },
      { type: 'state', handleId: H, state: 'closed' });
    const observed = apply({ ...closed, handleId: 'reopened', engineState: 'idle' },
      { type: 'item', handleId: 'reopened', item: { kind: 'user', id: 'actual-other', text: 'Same words' } });
    expect(observed.items.map((item) => item.id)).toEqual(['q', 'actual-other']);
    expect(observed.items[0]).toMatchObject({ deliveryUnconfirmed: true });
    const delivered = apply(observed, { type: 'item', handleId: 'reopened', item: { kind: 'user', id: 'q', text: 'Same words' } });
    expect(delivered.items).toEqual([
      { kind: 'user', id: 'q', text: 'Same words' },
      { kind: 'user', id: 'actual-other', text: 'Same words' },
    ]);
    const another = apply(delivered, { type: 'item', handleId: 'reopened', item: { kind: 'user', id: 'actual-third', text: 'Same words' } });
    expect(another.items.map((item) => item.id)).toEqual(['q', 'actual-other', 'actual-third']);
  });

  it('a fatal engine error offers to reopen the session', () => {
    const view = apply(base(), { type: 'error', handleId: H, message: 'boom', fatal: true });
    expect(view.errors).toEqual([expect.objectContaining({ message: 'boom', fatal: true, retry: { kind: 'open' } })]);
  });

  it('history goes first, live items that arrived earlier stay after it', () => {
    const live: SessionView = { ...base(), items: [{ kind: 'assistant', id: 'live', text: 'now' }] };
    const merged = mergeHistory(live, [{ kind: 'user', id: 'old', text: 'before' }]);
    expect(merged.items.map((i) => i.id)).toEqual(['old', 'live']);
    expect(merged.history).toBe('loaded');
  });
});
