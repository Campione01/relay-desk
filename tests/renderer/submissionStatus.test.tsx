import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryPage, NativePanel } from '@shared/types';
import { translate } from '../../src/renderer/i18n';
import { createView } from '../../src/renderer/state/sessionReducer';
import { renderApp, takeOverMain } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function ready() {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  return { ...rendered, handleId, key: rendered.controller.state.currentKey!, box: screen.getByRole('textbox', { name: 'Message' }) };
}

afterEach(() => vi.useRealTimers());

describe('submission request lifecycle', () => {
  it('shows no per-send status rail while a command is pending or after it ended, and keeps its bookkeeping', async () => {
    const { api, controller, key, handleId } = await ready();
    const command = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValue(command.promise);
    const history = vi.spyOn(api.sessions, 'history');
    let sent!: Promise<boolean>;
    act(() => { sent = controller.send(key, '/compact'); });
    act(() => api.mock.emitEngine({ type: 'item', handleId, item: { kind: 'user', id: 'send-1', text: '/compact' } }));
    expect(screen.queryByTestId('submission-status')).not.toBeInTheDocument();
    expect(document.querySelector('.rd-submissions')).toBeNull();
    expect(controller.view(key)?.submissions[0]).toMatchObject({ command: 'compact', phase: 'waiting' });
    expect(controller.view(key)?.submissions[0]).not.toHaveProperty('preview');
    await act(async () => { command.resolve(undefined); await sent; });
    expect(controller.view(key)?.submissions[0]?.phase).toBe('ended');
    // The output comes from main's transcript read-back, not from a history reload.
    act(() => api.mock.emitEngine({ type: 'item', handleId, afterId: 'send-1',
      item: { kind: 'system', id: 'compact-output', text: 'Native compact output', level: 'info' } }));
    expect(screen.getByText('Native compact output')).toBeInTheDocument();
    expect(history).not.toHaveBeenCalled();
    expect(screen.queryByTestId('submission-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-box').textContent).not.toMatch(/#\d+|Waiting for CLI|Command ended/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tracks each explicit submission once and distinguishes the backend queue from native confirmation', async () => {
    const { api, controller, key, handleId } = await ready();
    const first = deferred<void>();
    const second = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    act(() => {
      a = controller.send(key, '/compact');
      b = controller.send(key, 'after compact', true);
    });
    expect(send).toHaveBeenNthCalledWith(2, handleId, 'after compact', { queue: true });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['waiting', 'queued']);
    expect(new Set(controller.view(key)?.submissions.map((entry) => entry.id)).size).toBe(2);
    await act(async () => { first.resolve(undefined); await a; });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['ended', 'waiting']);
    expect(controller.view(key)?.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user', text: 'after compact' })]));
    await act(async () => { second.resolve(undefined); await b; });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['ended', 'accepted']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('tracks identical messages as separate submissions through a history refresh', async () => {
    const { api, controller, key, handleId } = await ready();
    const pending = Array.from({ length: 2 }, () => deferred<void>());
    const send = vi.spyOn(api.engine, 'send');
    for (const request of pending) send.mockReturnValueOnce(request.promise);
    vi.spyOn(api.sessions, 'history').mockResolvedValue({ items: [] });
    const repeated = `Please check   this\n\nrequest ${'long details '.repeat(15)}`;
    let sent!: Promise<boolean>[];
    act(() => { sent = [controller.send(key, repeated), controller.send(key, repeated)]; });
    const submissions = controller.view(key)!.submissions;
    expect(new Set(submissions.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(submissions.map((entry) => entry.echoId)).size).toBe(2);
    await act(async () => {
      pending.forEach((request) => request.resolve(undefined));
      await Promise.all(sent);
      await controller.loadHistory(key, handleId);
    });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['accepted', 'accepted']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit Send again action for an unconfirmed message and leaves a newer draft untouched', async () => {
    const { api, controller, key, handleId, box, user } = await ready();
    const pending = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    let sent!: Promise<boolean>;
    act(() => {
      controller.setDraft(key, 'original request');
      sent = controller.send(key, 'original request');
    });
    fireEvent.change(box, { target: { value: 'a newer draft' } });
    await act(async () => { pending.reject(new Error('unconfirmed response')); await sent; });
    expect(send).toHaveBeenCalledTimes(1);
    expect(box).toHaveValue('a newer draft');
    const error = screen.getByTestId('inline-error');
    expect(error.querySelector('.rd-errrow__text')).toHaveTextContent(/^unconfirmed response$/);
    expect(error).not.toHaveTextContent(/#\d+|original request:/);
    expect(within(error).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await user.click(within(error).getByRole('button', { name: 'Send again' }));
    expect(send).toHaveBeenNthCalledWith(2, handleId, 'original request', undefined);
    expect(send).toHaveBeenCalledTimes(2);
    expect(box).toHaveValue('a newer draft');
  });

  it('keeps a newer draft and the failed request intent without replaying or creating an unsafe retry', async () => {
    const { api, controller, key, box } = await ready();
    const pending = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    let sent!: Promise<boolean>;
    act(() => {
      controller.setDraft(key, '/compact original arguments');
      sent = controller.send(key, '/compact original arguments');
    });
    fireEvent.change(box, { target: { value: 'my new draft' } });
    await act(async () => { pending.reject(new Error('Response channel lost')); await sent; });
    expect(box).toHaveValue('my new draft');
    expect(controller.view(key)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '/compact original arguments', deliveryUnconfirmed: true }),
    ]));
    expect(controller.view(key)?.errors.at(-1)?.retry).toEqual({ kind: 'none' });
    expect(controller.view(key)?.submissions[0]?.phase).toBe('unconfirmed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(controller.view(key)?.submissions[0]).not.toHaveProperty('text');
  });

  it('retains multiple explicit submissions while one session opening is pending', async () => {
    const { api, controller } = await ready();
    const opening = deferred<Awaited<ReturnType<typeof api.engine.open>>>();
    const first = deferred<void>();
    const second = deferred<void>();
    const open = vi.spyOn(api.engine, 'open').mockReturnValue(opening.promise);
    const send = vi.spyOn(api.engine, 'send').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    act(() => {
      controller.store.set((state) => ({ ...state, currentKey: 'new', views: { ...state.views,
        new: createView({ key: 'new', title: 'new', profileId: 'default', cwd: 'D:\\fixture', isNew: true, confirmed: true }),
      } }));
      a = controller.send('new', '/compact');
      b = controller.send('new', 'next request');
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(controller.view('new')?.submissions.map((entry) => entry.phase)).toEqual(['preparing', 'preparing']);
    await act(async () => { opening.resolve({ handleId: 'new-handle', profileId: 'default', cwd: 'D:\\fixture' }); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(controller.view('new')?.submissions.map((entry) => entry.phase)).toEqual(['waiting', 'queued']);
    await act(async () => { first.resolve(undefined); second.resolve(undefined); await Promise.all([a, b]); });
    expect(controller.view('new')?.submissions.map((entry) => entry.phase)).toEqual(['ended', 'accepted']);
  });

  it('does not let an older failed submission restore its draft after a newer one was sent', async () => {
    const { api, controller, key } = await ready();
    const first = deferred<void>();
    const second = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    act(() => {
      controller.setDraft(key, 'first');
      a = controller.send(key, 'first');
      controller.setDraft(key, 'second');
      b = controller.send(key, 'second');
    });
    await act(async () => { first.reject(new Error('first failed')); await a; });
    expect(controller.state.drafts[key]).toBe('');
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['unconfirmed', 'waiting']);
    await act(async () => { second.resolve(undefined); await b; });
  });

  it('does not restore an old draft after the user deliberately edits and clears the composer', async () => {
    const { api, controller, key } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    let sent!: Promise<boolean>;
    act(() => {
      controller.setDraft(key, 'old');
      sent = controller.send(key, 'old');
      controller.setDraft(key, 'new');
      controller.setDraft(key, '');
    });
    await act(async () => { pending.reject(new Error('late')); await sent; });
    expect(controller.state.drafts[key]).toBe('');
  });

  it('preserves native error output even when a command promise fulfills', async () => {
    const { api, controller, key, handleId } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = controller.send(key, '/compact');
      api.mock.emitEngine({ type: 'error', handleId, message: 'Native command reported a problem', fatal: false });
    });
    await act(async () => { pending.resolve(undefined); await sent; });
    expect(controller.view(key)?.submissions[0]?.phase).toBe('ended');
    expect(screen.getByText('Native command reported a problem')).toBeInTheDocument();
    expect(controller.view(key)?.errors).toHaveLength(1);
  });

  it('updates a previously accepted native queued message to unconfirmed by its observed item identity', async () => {
    const { api, controller, key, handleId } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    let sent!: Promise<boolean>;
    act(() => {
      sent = controller.send(key, 'queued request', true);
      api.mock.emitEngine({ type: 'item', handleId, item: { kind: 'user', id: 'native-queued', text: 'queued request', queued: true } });
    });
    await act(async () => { pending.resolve(undefined); await sent; });
    expect(controller.view(key)?.submissions[0]).toMatchObject({ phase: 'accepted', nativeItemId: 'native-queued' });
    act(() => api.mock.emitEngine({ type: 'item', handleId,
      item: { kind: 'user', id: 'native-queued', text: 'queued request', deliveryUnconfirmed: true } }));
    expect(controller.view(key)?.submissions[0]?.phase).toBe('unconfirmed');
  });

  it.each(['resolve', 'reject'] as const)('isolates a late %s from a closed and reopened handle and preserves the current draft', async (outcome) => {
    const { api, controller, key, handleId } = await ready();
    const old = deferred<void>();
    const fresh = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const history = vi.spyOn(api.sessions, 'history');
    let previous!: Promise<boolean>;
    let current!: Promise<boolean>;
    // A rewind is the command whose end reads history again.
    act(() => { previous = controller.send(key, '/rewind'); });
    act(() => {
      api.mock.emitEngine({ type: 'state', handleId, state: 'closed' });
      controller.store.set((state) => ({ ...state,
        views: { ...state.views, [key]: { ...state.views[key]!, handleId: 'replacement', engineState: 'idle' } },
        handleToKey: { ...state.handleToKey, replacement: key },
      }));
      current = controller.send(key, '/rewind');
      controller.setDraft(key, 'current draft');
    });
    await act(async () => {
      if (outcome === 'resolve') old.resolve(undefined);
      else old.reject(new Error('old failure'));
      expect(await previous).toBe(false);
    });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['unconfirmed', 'waiting']);
    expect(controller.state.drafts[key]).toBe('current draft');
    expect(controller.view(key)?.errors).toEqual([]);
    expect(history).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => { fresh.resolve(undefined); await current; });
    expect(controller.view(key)?.submissions[1]?.phase).toBe('ended');
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('does not move a result to another selected view or refresh background command history', async () => {
    const { api, controller, key } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    const history = vi.spyOn(api.sessions, 'history');
    let sent!: Promise<boolean>;
    act(() => {
      sent = controller.send(key, '/rewind');
      controller.store.set((state) => ({ ...state, views: { ...state.views,
        other: createView({ key: 'other', cwd: '', profileId: 'default', title: 'other' }),
      } }));
      controller.navigate('other');
      controller.setDraft('other', 'other draft');
    });
    await act(async () => { pending.resolve(undefined); await sent; });
    expect(controller.view(key)?.submissions[0]?.phase).toBe('ended');
    expect(controller.view('other')?.submissions).toEqual([]);
    expect(controller.state.drafts.other).toBe('other draft');
    expect(history).not.toHaveBeenCalled();
  });

  it('drops a command history refresh after its live handle was replaced', async () => {
    const { api, controller, key, handleId } = await ready();
    const history = deferred<HistoryPage>();
    vi.spyOn(api.engine, 'send').mockResolvedValue(undefined);
    const read = vi.spyOn(api.sessions, 'history').mockReturnValue(history.promise);
    await act(async () => { await controller.send(key, '/rewind'); });
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      api.mock.emitEngine({ type: 'state', handleId, state: 'closed' });
      controller.store.set((state) => ({ ...state, views: { ...state.views,
        [key]: { ...state.views[key]!, handleId: 'replacement', engineState: 'idle', items: [{ kind: 'assistant', id: 'new', text: 'new output' }] },
      } }));
    });
    await act(async () => { history.resolve({ items: [{ kind: 'assistant', id: 'old', text: 'old history' }] }); });
    expect(controller.view(key)?.items).toEqual([{ kind: 'assistant', id: 'new', text: 'new output' }]);
  });

  it('asks with the normal running-session text before closing while a command is pending, and preserves history', async () => {
    const { api, controller, key, handleId, user } = await ready();
    const pending = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    const close = vi.spyOn(api.engine, 'close');
    const interrupt = vi.spyOn(api.engine, 'interrupt');
    let sent!: Promise<boolean>;
    act(() => { sent = controller.send(key, '/compact'); });
    const before = controller.view(key)!.items.length;
    expect(screen.queryByRole('button', { name: 'End Relay session' })).not.toBeInTheDocument();
    act(() => { void controller.closeSession(key); });
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this session?' });
    expect(dialog).toHaveTextContent('A turn is still running and will be interrupted. The transcript is kept and you can continue later.');
    expect(close).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('closed'));
    expect(close).toHaveBeenCalledWith(handleId);
    expect(controller.view(key)?.items).toHaveLength(before);
    expect(controller.view(key)?.submissions[0]?.phase).toBe('unconfirmed');
    await act(async () => { pending.reject(new Error('closed')); await sent; });
    expect(interrupt).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not let an old close completion close a replacement handle', async () => {
    const { api, controller, key, handleId } = await ready();
    const closing = deferred<void>();
    vi.spyOn(api.engine, 'close').mockReturnValue(closing.promise);
    let closed!: Promise<void>;
    act(() => { closed = controller.closeSession(key); });
    act(() => {
      api.mock.emitEngine({ type: 'state', handleId, state: 'closed' });
      controller.store.set((state) => ({ ...state, views: { ...state.views,
        [key]: { ...state.views[key]!, handleId: 'replacement', engineState: 'idle' },
      } }));
    });
    await act(async () => { closing.resolve(undefined); await closed; });
    expect(controller.view(key)).toMatchObject({ handleId: 'replacement', engineState: 'idle' });
  });
});

const PANEL: NativePanel = {
  revision: 1,
  command: 'config',
  columns: 40,
  mouse: false,
  styles: [{}],
  rows: [{ runs: [{ text: ' Settings  Status  Config', s: 0 }] }],
};

describe('a running slash command', () => {
  it('shows "Running /<name>…" with its elapsed time, and Stop and Esc still interrupt', async () => {
    const { api, controller, key, handleId, box, user } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    const interrupt = vi.spyOn(api.engine, 'interrupt').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let sent!: Promise<boolean>;
    act(() => {
      sent = controller.send(key, '/context');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    act(() => { vi.advanceTimersByTime(65_000); });
    const line = screen.getByTestId('status-line');
    expect(line).toHaveTextContent('1m 5s · Running /context…');
    expect(within(line).getByRole('status')).toHaveTextContent('Running /context…');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(interrupt).toHaveBeenCalledWith(handleId);
    box.focus();
    await user.keyboard('{Escape}');
    expect(interrupt).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(undefined);
      await sent;
      api.mock.emitEngine({ type: 'state', handleId, state: 'idle' });
    });
    expect(screen.queryByTestId('status-line')).not.toBeInTheDocument();
  });

  it('says "Compacting conversation…" for /compact, and a plain turn still says Thinking', async () => {
    const { api, controller, key, handleId } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    let sent!: Promise<boolean>;
    act(() => {
      sent = controller.send(key, '/compact keep the plan');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Compacting conversation…');
    expect(translate('zh-TW', 'status.compacting')).toBe('正在壓縮對話…');
    expect(translate('zh-TW', 'status.command', { name: 'context' })).toBe('正在執行 /context…');
    await act(async () => { pending.resolve(undefined); await sent; });
    await act(async () => { await controller.send(key, 'a plain question'); });
    expect(screen.getByTestId('status-line')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('status-line')).not.toHaveTextContent('Compacting');
  });

  it('keeps "Compacting conversation…" while a message typed during it waits behind the command', async () => {
    const { api, controller, key, handleId } = await ready();
    const command = deferred<void>();
    const message = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValueOnce(command.promise).mockReturnValueOnce(message.promise);
    act(() => {
      void controller.send(key, '/compact');
      void controller.send(key, 'typed while compacting');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['waiting', 'queued']);
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Compacting conversation…');
  });

  it('names the command when it is the newest pending submission of the handle', async () => {
    const { api, controller, key, handleId } = await ready();
    const message = deferred<void>();
    const command = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValueOnce(message.promise).mockReturnValueOnce(command.promise);
    act(() => {
      void controller.send(key, 'a plain question');
      void controller.send(key, '/context');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    expect(controller.view(key)?.submissions.map((entry) => entry.phase)).toEqual(['waiting', 'queued']);
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Running /context…');
  });

  it('hides the status line while the native panel is shown; the panel card is the indicator', async () => {
    const { api, controller, key, handleId } = await ready();
    const pending = deferred<void>();
    vi.spyOn(api.engine, 'send').mockReturnValue(pending.promise);
    act(() => {
      void controller.send(key, '/config');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Running /config…');
    act(() => api.mock.emitEngine({ type: 'panel', handleId, panel: PANEL }));
    expect(await screen.findByTestId('native-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('status-line')).not.toBeInTheDocument();
    act(() => api.mock.emitEngine({ type: 'panel', handleId, panel: null }));
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Running /config…');
  });
});

describe('slash commands Relay answers itself', () => {
  it.each(['/clear', '/new', '/reset '])('%s starts a new session in the same folder and account and clears the draft', async (text) => {
    const { api, controller, key } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    const open = vi.spyOn(api.engine, 'open');
    const origin = controller.view(key)!;
    act(() => controller.setDraft(key, text));
    await act(async () => { expect(await controller.send(key, text)).toBe(true); });
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const fresh = controller.currentView()!;
    expect(fresh.key).not.toBe(key);
    expect(fresh).toMatchObject({ isNew: true, cwd: origin.cwd, profileId: origin.profileId });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ cwd: origin.cwd, profileId: origin.profileId }));
    expect(open.mock.calls[0]![0]).not.toHaveProperty('resumeSessionId');
    expect(controller.state.drafts[key]).toBe('');
    expect(controller.view(key)?.submissions).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['/resume', '/continue'])('%s brings the session list into view with its search focused', async (text) => {
    const { api, controller, key } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    act(() => controller.toggleSidebar());
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).not.toBeInTheDocument();
    await act(async () => { await controller.send(key, text); });
    const search = within(screen.getByRole('complementary', { name: 'Sessions' })).getByRole('searchbox', { name: 'Search' });
    expect(search).toHaveFocus();
    expect(controller.state.ui).toMatchObject({ sidebar: true, sessionSearch: false });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['/continue', '/bg', '/rc', '/new', '/reset', '/quit'])('%s goes to the CLI as typed when the session has its own command of exactly that name', async (text) => {
    const { api, controller, key, handleId } = await ready();
    act(() => api.mock.emitEngine({ type: 'commands', handleId, commands: [{ name: 'resume', description: 'Resume a conversation' },
      { name: 'clear', description: 'Clear the conversation' }, { name: text.slice(1), description: 'My own command' }] }));
    const send = vi.spyOn(api.engine, 'send').mockResolvedValue(undefined);
    const close = vi.spyOn(api.engine, 'close');
    act(() => controller.setDraft(key, text));
    await act(async () => { expect(await controller.send(key, text)).toBe(true); });
    expect(send).toHaveBeenCalledExactlyOnceWith(handleId, text, undefined);
    expect(controller.view(key)?.submissions).toEqual([expect.objectContaining({ command: text.slice(1), phase: 'ended' })]);
    expect(controller.state).toMatchObject({ currentKey: key, toasts: [], drafts: { [key]: '' } });
    expect(close).not.toHaveBeenCalled();
  });

  it('routes /resume and /clear by their canonical names even though the session lists them', async () => {
    const { api, controller, key, handleId } = await ready();
    act(() => api.mock.emitEngine({ type: 'commands', handleId, commands: [{ name: 'resume', description: 'Resume a conversation' },
      { name: 'clear', description: 'Clear the conversation' }] }));
    const send = vi.spyOn(api.engine, 'send');
    act(() => controller.toggleSidebar());
    await act(async () => { await controller.send(key, '/resume'); });
    expect(within(screen.getByRole('complementary', { name: 'Sessions' })).getByRole('searchbox', { name: 'Search' })).toHaveFocus();
    await act(async () => { await controller.send(key, '/continue'); });
    await act(async () => { expect(await controller.send(key, '/clear')).toBe(true); });
    await waitFor(() => expect(controller.currentView()?.key).not.toBe(key));
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['/login', '/logout'])('%s opens the accounts card', async (text) => {
    const { api, controller, key } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    const logout = vi.spyOn(api.accounts, 'logout');
    act(() => controller.setCard('accounts', false));
    await act(async () => { await controller.send(key, text); });
    expect(controller.state.ui.rightPanel).toBe(true);
    expect(controller.state.ui.cards.accounts).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('/exit closes the idle session at once and /quit asks first while a turn runs', async () => {
    const { api, controller, key, handleId, user } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    const close = vi.spyOn(api.engine, 'close');
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() }));
    act(() => { void controller.send(key, '/quit'); });
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this session?' });
    expect(dialog).toHaveTextContent('A turn is still running and will be interrupted.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(close).not.toHaveBeenCalled();
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'idle' }));
    await act(async () => { await controller.send(key, '/exit'); });
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('closed'));
    expect(close).toHaveBeenCalledWith(handleId);
    expect(send).not.toHaveBeenCalled();
  });

  it('/model and /effort without arguments open the footer pickers; with arguments they go to the CLI', async () => {
    const { api, controller, key, handleId } = await ready();
    const send = vi.spyOn(api.engine, 'send').mockResolvedValue(undefined);
    await act(async () => { await controller.send(key, '/model'); });
    expect(controller.state.ui.footerMenu).toBe('model');
    act(() => controller.openFooterMenu(null));
    await act(async () => { await controller.send(key, '/effort  '); });
    expect(controller.state.ui.footerMenu).toBe('effort');
    expect(send).not.toHaveBeenCalled();
    act(() => controller.openFooterMenu(null));
    await act(async () => { await controller.send(key, '/model sonnet'); });
    await act(async () => { await controller.send(key, '/effort high'); });
    expect(send.mock.calls).toEqual([[handleId, '/model sonnet', undefined], [handleId, '/effort high', undefined]]);
    expect(controller.state.ui.footerMenu).toBeNull();
  });

  it.each(['/tui', '/focus', '/background', '/bg', '/BG fix it', '/cd D:\\demos', '/terminal-setup', '/migrate-installer'])(
    '%s sends nothing and leaves a short note that it needs a terminal', async (text) => {
      const { api, controller, key } = await ready();
      const send = vi.spyOn(api.engine, 'send');
      act(() => controller.setDraft(key, text));
      await act(async () => { expect(await controller.send(key, text)).toBe(false); });
      expect(controller.state.toasts.at(-1)).toMatchObject({ kind: 'info', text: 'This command only works in a terminal.' });
      expect(screen.getByText('This command only works in a terminal.')).toBeInTheDocument();
      expect(controller.state.drafts[key]).toBe(text);
      expect(controller.view(key)).toMatchObject({ submissions: [], errors: [] });
      expect(send).not.toHaveBeenCalled();
    });

  it('pressing Enter again on a refused command keeps one copy of its note instead of stacking them', async () => {
    const { controller, key } = await ready();
    act(() => controller.setDraft(key, '/tui'));
    for (let press = 0; press < 3; press++) await act(async () => { await controller.send(key, '/tui'); });
    expect(controller.state.toasts.map((toast) => toast.text)).toEqual(['This command only works in a terminal.']);
    expect(screen.getAllByText('This command only works in a terminal.')).toHaveLength(1);
    const retry = (): void => undefined;
    act(() => { controller.toast('error', 'other failure', retry); controller.toast('error', 'other failure', retry); });
    expect(controller.state.toasts.map((toast) => toast.text))
      .toEqual(['This command only works in a terminal.', 'other failure', 'other failure']);
  });

  it('does not send a new slash command while one is pending; a note names it and plain text still goes', async () => {
    const { api, controller, key, handleId } = await ready();
    const compact = deferred<void>();
    const send = vi.spyOn(api.engine, 'send').mockReturnValueOnce(compact.promise).mockResolvedValue(undefined);
    let first!: Promise<boolean>;
    act(() => { first = controller.send(key, '/compact'); });
    act(() => controller.setDraft(key, '/context'));
    await act(async () => { expect(await controller.send(key, '/context')).toBe(false); });
    expect(controller.state.toasts.at(-1)).toMatchObject({ kind: 'info', text: 'Finish /compact first.' });
    expect(controller.state.drafts[key]).toBe('/context');
    expect(controller.view(key)?.submissions.map((entry) => entry.command)).toEqual(['compact']);
    expect(translate('zh-TW', 'slash.finishFirst', { name: 'compact' })).toBe('請先完成 /compact。');
    expect(translate('zh-TW', 'slash.terminalOnly')).toBe('這個指令只能在終端機中使用。');
    act(() => { void controller.send(key, 'plain text meanwhile', true); });
    expect(send).toHaveBeenLastCalledWith(handleId, 'plain text meanwhile', { queue: true });
    await act(async () => { compact.resolve(undefined); await first; });
    await act(async () => { await controller.send(key, '/context'); });
    expect(send).toHaveBeenLastCalledWith(handleId, '/context', undefined);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
