import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryPage, TranscriptItem } from '@shared/types';
import { MOCK_HISTORY, MOCK_OLDER_HISTORY } from '../../src/renderer/mock/fixtures';
import type { AppController } from '../../src/renderer/state/controller';
import { createView, mergeLatestPage, prependHistory } from '../../src/renderer/state/sessionReducer';
import { MAIN_SESSION_ID, renderApp, sidebar, type Rendered } from './helpers';

const LONG = { sessionId: '22222222-3333-4444-8555-666666666666', title: 'Long session', cwd: 'D:\\demos\\long', lastModified: Date.UTC(2026, 9, 20) };
const OTHER = { sessionId: '33333333-4444-4555-8666-777777777777', title: 'Other session', cwd: 'D:\\demos\\other', lastModified: Date.UTC(2026, 9, 19) };

const asks = (id: string): TranscriptItem => ({ kind: 'user', id, text: `${id} question` });
const answers = (id: string): TranscriptItem => ({ kind: 'assistant', id, text: `${id} answer` });

const OLDEST = [asks('p0-u'), answers('p0-a')];
// Its last item opens the latest page too: a page edge seen twice.
const MIDDLE = [asks('p1-u'), answers('p1-a'), asks('p2-u')];
const LATEST = [asks('p2-u'), answers('p2-a')];

const cursor = (index: number): string => `mock-page:${LONG.sessionId}:${index}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Lets pending replies reach the controller and the UI. */
const settle = (): Promise<void> => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function openLong(language: 'en' | 'zh-TW' = 'en'): Promise<Rendered & { key: string }> {
  const rendered = await renderApp({
    sessions: [LONG, OTHER],
    history: { [LONG.sessionId]: LATEST, [OTHER.sessionId]: [answers('other')] },
    olderHistory: { [LONG.sessionId]: [OLDEST, MIDDLE] },
    settings: { language },
  });
  const list = language === 'en' ? sidebar() : screen.getByRole('complementary', { name: '工作階段' });
  await rendered.user.click(within(list).getByRole('button', { name: 'Long session' }));
  await screen.findByText('p2-a answer');
  return { ...rendered, key: rendered.controller.state.currentKey! };
}

const ids = (controller: AppController, key: string): string[] => controller.view(key)!.items.map((item) => item.id);
const earlier = (): HTMLElement => screen.getByRole('button', { name: 'Load earlier messages' });

describe('history pages (reducer)', () => {
  const base = createView({ key: 'k', profileId: 'default', sessionId: LONG.sessionId, cwd: LONG.cwd, title: 't' });

  it('an older page goes above the items once, and its cursor replaces the one used', () => {
    const view = { ...base, items: LATEST, olderHistory: { cursor: cursor(1), state: 'loading' as const } };
    const next = prependHistory(view, { items: MIDDLE, older: cursor(0) });
    expect(next.items.map((item) => item.id)).toEqual(['p1-u', 'p1-a', 'p2-u', 'p2-a']);
    expect(next.olderHistory).toEqual({ cursor: cursor(0), state: 'idle' });
    expect(prependHistory(next, { items: OLDEST }).olderHistory).toBeUndefined();
  });

  it('a latest page that starts among the shown items keeps the earlier ones and their cursor', () => {
    // `moved` sat above the page start before and now comes inside the page: it shows once, where the page has it.
    const view = {
      ...base,
      items: [...MIDDLE.slice(0, 2), answers('moved'), ...LATEST, answers('live')],
      olderHistory: { cursor: cursor(0), state: 'idle' as const },
    };
    const stale = new Set(view.items.slice(0, 5).map((item) => item.id));
    const next = mergeLatestPage(view, { items: [...LATEST, answers('moved'), answers('p2-b')], older: 'from-the-page' }, stale);
    expect(next.items.map((item) => item.id)).toEqual(['p1-u', 'p1-a', 'p2-u', 'p2-a', 'moved', 'p2-b', 'live']);
    expect(next.olderHistory).toEqual({ cursor: cursor(0), state: 'idle' });
    expect(next.history).toBe('loaded');
  });

  it('a latest page that does not meet the shown items replaces them and brings its own cursor', () => {
    const view = { ...base, items: [...MIDDLE, answers('p2-a')], olderHistory: { cursor: cursor(0), state: 'idle' as const } };
    const stale = new Set(view.items.map((item) => item.id));
    const next = mergeLatestPage(view, { items: [asks('n-u'), answers('n-a')], older: 'n-cursor' }, stale);
    expect(next.items.map((item) => item.id)).toEqual(['n-u', 'n-a']);
    expect(next.olderHistory).toEqual({ cursor: 'n-cursor', state: 'idle' });
    expect(mergeLatestPage(view, { items: [] }, stale).olderHistory).toBeUndefined();
  });
});

describe('Load earlier messages', () => {
  it('shows only while the saved history has a page before the one shown', async () => {
    const { user, controller } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await screen.findByText('Ran `npm install`');
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
    expect(controller.currentView()!.olderHistory).toBeUndefined();

    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    const button = await screen.findByRole('button', { name: 'Load earlier messages' });
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log.firstElementChild).toContainElement(button);
    expect(controller.currentView()!.olderHistory).toEqual({ cursor: `mock-page:${MAIN_SESSION_ID}:1`, state: 'idle' });
  });

  it('prepends each older page in order above the shown items, without duplicates, until the session start', async () => {
    const { api, user, controller, key } = await openLong();
    const history = vi.spyOn(api.sessions, 'history');
    await user.click(earlier());
    await screen.findByText('p1-a answer');
    expect(history).toHaveBeenLastCalledWith('default', LONG.sessionId, LONG.cwd, cursor(1));
    expect(ids(controller, key)).toEqual(['p1-u', 'p1-a', 'p2-u', 'p2-a']);
    expect(screen.getAllByTestId('user-message').map((row) => row.textContent)).toEqual(['p1-u question', 'p2-u question']);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: cursor(0), state: 'idle' });

    await user.click(earlier());
    await screen.findByText('p0-a answer');
    expect(history).toHaveBeenLastCalledWith('default', LONG.sessionId, LONG.cwd, cursor(0));
    expect(ids(controller, key)).toEqual(['p0-u', 'p0-a', 'p1-u', 'p1-a', 'p2-u', 'p2-a']);
    expect(controller.view(key)!.olderHistory).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('shows loading, ignores more clicks meanwhile and keeps keyboard focus on the button', async () => {
    const { api, user, controller, key } = await openLong();
    const page = deferred<HistoryPage>();
    const history = vi.spyOn(api.sessions, 'history').mockReturnValueOnce(page.promise);
    const button = earlier();
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAccessibleName('Loading earlier messages…');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveFocus();
    await user.click(button);
    expect(history).toHaveBeenCalledTimes(1);
    expect(controller.view(key)!.olderHistory?.state).toBe('loading');

    page.resolve({ items: MIDDLE, older: cursor(0) });
    await settle();
    expect(button).toHaveAccessibleName('Load earlier messages');
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
    expect(ids(controller, key)).toEqual(['p1-u', 'p1-a', 'p2-u', 'p2-a']);
  });

  it('waits while the latest page reloads', async () => {
    const { api, user, controller, key } = await openLong();
    const latest = deferred<HistoryPage>();
    const history = vi.spyOn(api.sessions, 'history').mockReturnValueOnce(latest.promise);
    let reload!: Promise<void>;
    act(() => {
      reload = controller.loadHistory(key);
    });
    expect(earlier()).toHaveAttribute('aria-disabled', 'true');
    expect(earlier()).not.toHaveAttribute('aria-busy');
    await user.click(earlier());
    expect(history).toHaveBeenCalledTimes(1);

    latest.resolve({ items: LATEST, older: cursor(1) });
    await act(async () => reload);
    expect(earlier()).not.toHaveAttribute('aria-disabled');
    await user.click(earlier());
    await screen.findByText('p1-a answer');
    expect(history).toHaveBeenLastCalledWith('default', LONG.sessionId, LONG.cwd, cursor(1));
  });

  it('a failed load shows a short error line whose retry asks for the same page again', async () => {
    const { api, user, controller, key } = await openLong();
    const history = vi
      .spyOn(api.sessions, 'history')
      .mockRejectedValueOnce(new Error("Error invoking remote method 'relay:sessions:history': Error: worker exited"));
    await user.click(earlier());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load earlier messages: worker exited');
    const retry = within(screen.getByTestId('load-earlier')).getByRole('button', { name: 'Retry' });
    expect(retry).toHaveAccessibleDescription('Could not load earlier messages: worker exited');
    expect(ids(controller, key)).toEqual(['p2-u', 'p2-a']);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: cursor(1), state: 'error', error: 'worker exited' });
    expect(screen.queryByTestId('inline-error')).not.toBeInTheDocument();

    await user.click(retry);
    await screen.findByText('p1-a answer');
    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1]).toEqual(history.mock.calls[0]);
    expect(history.mock.calls[1]![3]).toBe(cursor(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(ids(controller, key)).toEqual(['p1-u', 'p1-a', 'p2-u', 'p2-a']);
  });

  it('an answer that comes after the view reloaded is dropped and the button works again', async () => {
    const { api, user, controller, key } = await openLong();
    const late = deferred<HistoryPage>();
    const history = vi.spyOn(api.sessions, 'history').mockReturnValueOnce(late.promise);
    await user.click(earlier());
    await act(async () => controller.loadHistory(key));
    expect(history).toHaveBeenCalledTimes(2);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: cursor(1), state: 'idle' });
    late.resolve({ items: [asks('late')] });
    await settle();
    expect(ids(controller, key)).toEqual(['p2-u', 'p2-a']);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: cursor(1), state: 'idle' });

    await user.click(earlier());
    await screen.findByText('p1-a answer');
    expect(history).toHaveBeenLastCalledWith('default', LONG.sessionId, LONG.cwd, cursor(1));
  });

  it('an answer that comes after another session was opened is dropped', async () => {
    const { api, user, controller, key } = await openLong();
    const late = deferred<HistoryPage>();
    vi.spyOn(api.sessions, 'history').mockReturnValueOnce(late.promise);
    await user.click(earlier());
    await user.click(within(sidebar()).getByRole('button', { name: 'Other session' }));
    await screen.findByText('other answer');
    late.resolve({ items: MIDDLE, older: cursor(0) });
    await settle();
    expect(ids(controller, key)).toEqual(['p2-u', 'p2-a']);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: cursor(1), state: 'idle' });

    await user.click(within(sidebar()).getByRole('button', { name: 'Long session' }));
    await waitFor(() => expect(controller.view(key)!.history).toBe('loaded'));
    expect(earlier()).not.toHaveAttribute('aria-disabled');
  });

  it('a take-over reloads the latest page and keeps the earlier pages that still join it', async () => {
    const { api, user, controller } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await user.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    const [first, second] = MOCK_OLDER_HISTORY[MAIN_SESSION_ID]!;
    const latest = MOCK_HISTORY[MAIN_SESSION_ID]!;
    const key = controller.state.currentKey!;
    await waitFor(() => expect(ids(controller, key)).toEqual([...second!, ...latest].map((item) => item.id)));

    const history = vi.spyOn(api.sessions, 'history');
    await user.click(within(screen.getByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    expect(history).toHaveBeenCalledWith('default', MAIN_SESSION_ID, 'D:\\demos\\relay-desk');
    expect(ids(controller, key)).toEqual([...second!, ...latest].map((item) => item.id));
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: `mock-page:${MAIN_SESSION_ID}:0`, state: 'idle' });

    await user.click(earlier());
    await waitFor(() => expect(ids(controller, key)).toEqual([...first!, ...second!, ...latest].map((item) => item.id)));
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
  });

  it('a reloaded latest page that no longer meets the earlier pages replaces them and brings its cursor', async () => {
    const { api, user, controller, key } = await openLong();
    await user.click(earlier());
    await screen.findByText('p1-a answer');
    vi.spyOn(api.sessions, 'history').mockResolvedValueOnce({ items: [asks('n-u'), answers('n-a')], older: 'n-cursor' });
    await act(async () => controller.loadHistory(key));
    expect(ids(controller, key)).toEqual(['n-u', 'n-a']);
    expect(controller.view(key)!.olderHistory).toEqual({ cursor: 'n-cursor', state: 'idle' });
    expect(screen.queryByText('p1-a answer')).not.toBeInTheDocument();
  });

  it('keeps what the user is reading in place: scrollTop moves by the height the earlier page added', async () => {
    const { user } = await openLong();
    const scroller = screen.getByTestId('transcript-scroller');
    const ROW = 100;
    // jsdom has no layout: every child of the transcript column counts as one 100 px row.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scroller.querySelectorAll('.rd-transcript > *').length * ROW });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 150 });
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(scroller.scrollHeight).toBe(3 * ROW);

    await user.click(earlier());
    await screen.findByText('p1-a answer');
    // p1-u and p1-a went in above (p2-u was shown already).
    expect(scroller.scrollHeight).toBe(5 * ROW);
    expect(scroller.scrollTop).toBe(40 + 2 * ROW);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('speaks Traditional Chinese', async () => {
    const { api, user } = await openLong('zh-TW');
    vi.spyOn(api.sessions, 'history').mockRejectedValueOnce(new Error('worker exited'));
    await user.click(screen.getByRole('button', { name: '載入較早的訊息' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('無法載入較早的訊息：worker exited');
    expect(within(screen.getByTestId('load-earlier')).getByRole('button', { name: '重試' })).toBeInTheDocument();
  });
});
