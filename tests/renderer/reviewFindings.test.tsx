import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask, PlanUsageWindow, TranscriptItem } from '@shared/types';
import { usageAtLimit, windowAtLimit } from '../../src/renderer/components/prompt/UsagePopover';
import { MOCK_SESSIONS } from '../../src/renderer/mock/fixtures';
import { createView, mergeHistory } from '../../src/renderer/state/sessionReducer';
import { readSessionPrefs } from '../../src/renderer/state/sessionPrefs';
import { MAIN_SESSION_ID, renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function live(): Promise<Rendered & { handleId: string; key: string }> {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  return { ...rendered, handleId, key: rendered.controller.state.currentKey! };
}

const init = (rendered: Rendered, handleId: string, patch: Record<string, unknown>) => {
  const view = rendered.controller.currentView()!;
  rendered.api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: view.model ?? 'opus',
    slashCommands: [], tools: [], cwd: view.cwd, ...patch });
};

describe('setting picks revert only to what the CLI confirmed', () => {
  it('a refused older model pick does not undo a newer one; the newer one is remembered', async () => {
    const rendered = await live();
    const { api, controller, key } = rendered;
    const older = deferred();
    const newer = deferred();
    vi.spyOn(api.engine, 'setModel').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = controller.setModel(key, 'sonnet'); b = controller.setModel(key, 'haiku'); });
    await act(async () => { newer.resolve(); await b; });
    await act(async () => { older.reject(new Error('older refused')); await a; });
    expect(controller.view(key)?.model).toBe('haiku');
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({ model: 'haiku' });
    expect(controller.state.toasts.at(-1)?.text).toBe('older refused');
  });

  it('a refused newest pick goes back to the last confirmed value, never to an earlier unconfirmed pick', async () => {
    const rendered = await live();
    const { api, controller, key } = rendered;
    const start = controller.view(key)!.model;
    const first = deferred();
    const second = deferred();
    vi.spyOn(api.engine, 'setModel').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = controller.setModel(key, 'sonnet'); b = controller.setModel(key, 'haiku'); });
    await act(async () => { first.reject(new Error('first refused')); await a; });
    expect(controller.view(key)?.model).toBe('haiku');
    await act(async () => { second.reject(new Error('second refused')); await b; });
    expect(controller.view(key)?.model).toBe(start);
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toBeUndefined();
  });

  it('after an older pick succeeded, a refused newer one goes back to it', async () => {
    const rendered = await live();
    const { api, controller, key } = rendered;
    const first = deferred();
    const second = deferred();
    vi.spyOn(api.engine, 'setEffort').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = controller.setEffort(key, 'high'); b = controller.setEffort(key, 'max'); });
    await act(async () => { first.resolve(); await a; });
    await act(async () => { second.reject(new Error('max refused')); await b; });
    expect(controller.view(key)?.effort).toBe('high');
    expect(readSessionPrefs('default', MAIN_SESSION_ID)).toEqual({ effort: 'high' });
  });

  it('what the CLI reports meanwhile (init) is what a refused permission mode or effort goes back to', async () => {
    const rendered = await live();
    const { api, controller, key, handleId } = rendered;
    const before = controller.view(key)!;
    expect(before.permissionMode).not.toBe('acceptEdits');
    expect(before.effort).not.toBe('low');
    const mode = deferred();
    const effort = deferred();
    vi.spyOn(api.engine, 'setPermissionMode').mockReturnValueOnce(mode.promise);
    vi.spyOn(api.engine, 'setEffort').mockReturnValueOnce(effort.promise);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = controller.setPermissionMode(key, 'plan'); b = controller.setEffort(key, 'max'); });
    act(() => init(rendered, handleId, { permissionMode: 'acceptEdits', effort: 'low' }));
    await act(async () => {
      mode.reject(new Error('mode refused'));
      effort.reject(new Error('effort refused'));
      await Promise.all([a, b]);
    });
    expect(controller.view(key)).toMatchObject({ permissionMode: 'acceptEdits', permissionOverride: before.permissionOverride, effort: 'low' });
  });

  it('fast mode and ultracode follow the same rule', async () => {
    const rendered = await live();
    const { api, controller, key } = rendered;
    const fastOn = deferred();
    const ultraOn = deferred();
    const ultraOff = deferred();
    vi.spyOn(api.engine, 'setFastMode').mockReturnValueOnce(fastOn.promise).mockResolvedValueOnce(undefined);
    vi.spyOn(api.engine, 'setUltracode').mockReturnValueOnce(ultraOn.promise).mockReturnValueOnce(ultraOff.promise);
    let fast!: Promise<void>;
    let ultra!: Promise<void>;
    let ultraBack!: Promise<void>;
    act(() => { fast = controller.setFastMode(key, true); });
    await act(async () => { await controller.setFastMode(key, false); });
    await act(async () => { fastOn.reject(new Error('fast refused')); await fast; });
    expect(controller.view(key)?.fastMode).toBe(false);
    act(() => { ultra = controller.setUltracode(key, true); ultraBack = controller.setUltracode(key, false); });
    await act(async () => { ultraOn.reject(new Error('on refused')); await ultra; });
    expect(controller.view(key)?.ultracode).toBe(false);
    await act(async () => { ultraOff.reject(new Error('off refused')); await ultraBack; });
    expect(controller.view(key)?.ultracode).toBeUndefined();
  });
});

const now = Date.now();
const TASKS: BackgroundTask[] = [
  { taskId: 'w1', kind: 'workflow', taskType: 'local_workflow', description: 'Audit every route', status: 'running', startedAt: now - 10_000 },
  { taskId: 'b1', kind: 'shell', taskType: 'local_bash', description: 'npm run dev', status: 'running', startedAt: now - 30_000 },
];

describe('a task stop in flight', () => {
  it('disables that task’s Stop in the Background card until the stop settled', async () => {
    const rendered = await live();
    const stopping = deferred();
    const stop = vi.spyOn(rendered.api.engine, 'stopTask').mockReturnValueOnce(stopping.promise);
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId: rendered.handleId, tasks: TASKS }));
    const card = screen.getByTestId('card-background');
    await rendered.user.click(card.querySelector<HTMLElement>('.rd-card__head')!);
    const stops = () => within(card).getAllByRole('button', { name: 'Stop this task' });
    await rendered.user.click(stops()[0]!);
    expect(stop).toHaveBeenCalledWith(rendered.handleId, 'w1');
    expect(stops()[0]).toBeDisabled();
    expect(stops()[1]).toBeEnabled();
    await act(async () => { stopping.resolve(); await stopping.promise; });
    expect(stops()[0]).toBeEnabled();
  });

  it('disables that task’s Stop under the running count until the stop settled', async () => {
    const rendered = await live();
    const stopping = deferred();
    vi.spyOn(rendered.api.engine, 'stopTask').mockReturnValueOnce(stopping.promise);
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId: rendered.handleId, tasks: TASKS }));
    await rendered.user.click(screen.getByTestId('background-running'));
    const list = screen.getByRole('list', { name: '2 running' });
    const stops = () => within(list).getAllByRole('button', { name: 'Stop this task' });
    await rendered.user.click(stops()[1]!);
    expect(stops()[1]).toBeDisabled();
    expect(stops()[0]).toBeEnabled();
    await act(async () => { stopping.reject(new Error('stop refused')); await stopping.promise.catch(() => undefined); });
    expect(stops()[1]).toBeEnabled();
  });
});

const SIDE_SESSION = { sessionId: '51111111-2222-4333-8444-555555555555', title: 'Side chat fixture', cwd: 'D:\\demos\\fixture', lastModified: 1 };
const SIDE_ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'How does the release work?' },
  { kind: 'assistant', id: 'a1', text: 'The release script signs the installer first.' },
];

describe('a side chat keeps its transcript', () => {
  it('a slash command or a reopen in the fork never reloads the unsaved fork id', async () => {
    const rendered = await renderApp({ sessions: [SIDE_SESSION], history: { [SIDE_SESSION.sessionId]: SIDE_ITEMS } });
    const { api, controller, user } = rendered;
    await user.click(within(sidebar()).getByRole('button', { name: SIDE_SESSION.title }));
    await screen.findByTestId('assistant-message');
    const key = await act(async () => controller.startSideChat(controller.state.currentKey!, 'The release script'));
    await act(async () => { await controller.send(key!, 'Why sign first?'); });
    await waitFor(() => expect(controller.view(key!)?.engineState).toBe('idle'));
    const fork = controller.view(key!)!.sessionId!;
    expect(fork).not.toBe(SIDE_SESSION.sessionId);
    const history = vi.spyOn(api.sessions, 'history');
    // A rewind is the command whose end reads history again.
    await act(async () => { await controller.send(key!, '/rewind'); });
    await waitFor(() => expect(controller.view(key!)?.engineState).toBe('idle'));
    act(() => api.mock.emitEngine({ type: 'state', handleId: controller.view(key!)!.handleId!, state: 'closed' }));
    await act(async () => { await controller.send(key!, 'again'); });
    await waitFor(() => expect(controller.view(key!)?.engineState).toBe('idle'));
    expect(history.mock.calls.filter((call) => call[1] === fork)).toEqual([]);
    expect(controller.view(key!)!.items.map((item) => item.id)).toEqual(expect.arrayContaining(['u1', 'a1']));
    expect(controller.view(key!)!.items.filter((item) => item.kind === 'user').map((item) => item.kind === 'user' && item.text))
      .toEqual(['How does the release work?', 'Why sign first?', '/rewind', 'again']);
  });

  it('a new session offers a side chat once the saved session list shows it, not on a result row', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    await act(async () => controller.newSession('D:\\demos\\demo-app'));
    const fresh = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(fresh)?.engineState).toBe('idle'));
    await act(async () => { await controller.send(fresh, 'hello'); });
    await waitFor(() => expect(controller.view(fresh)?.items.some((item) => item.kind === 'result')).toBe(true));
    expect(controller.sideChatBlocked(fresh)).toBe('selection.sideChatNeedsSession');
    const sessionId = controller.view(fresh)!.sessionId!;
    vi.spyOn(api.sessions, 'list').mockResolvedValue([...MOCK_SESSIONS, { sessionId, title: 'hello', cwd: 'D:\\demos\\demo-app', lastModified: Date.now() }]);
    await act(async () => controller.loadSessions());
    expect(controller.sideChatBlocked(fresh)).toBeNull();
  });
});

describe('history reload keeps live intent and native results in place', () => {
  it('anchors kept items after their nearest surviving neighbour; queued ones stay last', () => {
    const view = createView({ key: 'k', profileId: 'default', cwd: 'D:\\x', title: 't', handleId: 'h', engineState: 'idle', items: [
      { kind: 'user', id: 'u1', text: 'first' },
      { kind: 'assistant', id: 'a1', text: 'one' },
      { kind: 'result', id: 'native-result:t1', isError: true, text: 'Turn failed' },
      { kind: 'user', id: 'lost', text: 'unconfirmed', deliveryUnconfirmed: true },
      { kind: 'result', id: 'r-sdk', durationMs: 1 },
      { kind: 'user', id: 'u2', text: 'second' },
      { kind: 'assistant', id: 'a2', text: 'two' },
      { kind: 'user', id: 'q', text: 'later', queued: true },
      { kind: 'assistant', id: 'fresh', text: 'arrived while loading' },
    ] });
    const stale = new Set(view.items.filter((item) => item.id !== 'fresh').map((item) => item.id));
    const history: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'first' },
      { kind: 'assistant', id: 'a1', text: 'one' },
      { kind: 'user', id: 'u2', text: 'second' },
      { kind: 'assistant', id: 'a2', text: 'two' },
      { kind: 'user', id: 'u3', text: 'third' },
    ];
    const merged = mergeHistory(view, history, stale);
    expect(merged.items.map((item) => item.id)).toEqual(['u1', 'a1', 'native-result:t1', 'lost', 'u2', 'a2', 'u3', 'fresh', 'q']);
  });
});

describe('a reopened handle answers the Reopen offer', () => {
  it('drops errors that offer Reopen once a new handle is adopted, and keeps the others', async () => {
    const rendered = await live();
    const { api, controller, key, handleId } = rendered;
    act(() => {
      api.mock.emitEngine({ type: 'error', handleId, fatal: false, message: 'A note that stays' });
      api.mock.emitEngine({ type: 'error', handleId, fatal: true, message: 'Native interactive process exited (1).' });
    });
    await act(async () => { await api.engine.close(handleId); });
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('closed'));
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    await act(async () => { await controller.send(key, 'hello again'); });
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    expect(controller.view(key)!.handleId).not.toBe(handleId);
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(controller.view(key)!.errors.map((error) => error.message)).toEqual(['A note that stays']);
  });
});

describe('usage limit after its reset time', () => {
  const at = (patch: Partial<PlanUsageWindow>): PlanUsageWindow => ({ id: 'five_hour', percent: 100, resetsAt: now + 60_000, ...patch });

  it('a window whose reset time has passed is no longer at its limit', () => {
    expect(windowAtLimit(at({}), now)).toBe(true);
    expect(windowAtLimit(at({ resetsAt: null }), now)).toBe(true);
    expect(windowAtLimit(at({ resetsAt: now - 1 }), now)).toBe(false);
    expect(windowAtLimit(at({ percent: 20, status: 'rejected', resetsAt: now - 1 }), now)).toBe(false);
    const usage = { profileId: 'default', available: true, fetchedAt: now, windows: [at({ resetsAt: now - 1 }), at({ id: 'seven_day', percent: 40 })] };
    expect(usageAtLimit(usage, now)).toBe(false);
    expect(usageAtLimit({ ...usage, windows: [...usage.windows, at({ id: 'seven_day_opus', status: 'rejected', percent: 1 })] }, now)).toBe(true);
  });

  it('the footer shows no limit mark for a passed reset', async () => {
    const rendered = await renderApp({ usage: { available: true, windows: [{ id: 'five_hour', percent: 100, resetsAt: Date.now() - 60_000 }] } });
    await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    await waitFor(() => expect(rendered.controller.state.usage.default?.windows).toHaveLength(1));
    expect(within(screen.getByTestId('prompt-footer')).queryByRole('img', { name: 'Usage limit reached' })).not.toBeInTheDocument();
  });
});
