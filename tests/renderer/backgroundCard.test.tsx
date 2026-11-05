import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundAgent, BackgroundTask } from '@shared/types';
import { renderApp, sidebar, takeOverMain } from './helpers';

const now = Date.now();
const task = (taskId: string, patch: Partial<BackgroundTask>): BackgroundTask => ({
  taskId,
  kind: 'agent',
  taskType: 'local_agent',
  description: taskId,
  status: 'running',
  startedAt: now - 60_000,
  ...patch,
});
const LIVE: BackgroundTask[] = [
  task('a-old', { description: 'Review the renderer', status: 'completed', startedAt: now - 300_000, endedAt: now - 200_000 }),
  task('w-new', { kind: 'workflow', taskType: 'local_workflow', description: 'Audit every route', startedAt: now - 10_000 }),
  task('b-mid', { kind: 'shell', taskType: 'local_bash', description: 'npm run dev', startedAt: now - 30_000 }),
];

const card = (): HTMLElement => screen.getByTestId('card-background');
const header = (): HTMLElement => card().querySelector<HTMLElement>('.rd-card__head')!;

describe('background tasks card (back in the right panel)', () => {
  it('keeps fresh detached sessions when an old account background read rejects after a profile switch', async () => {
    const rendered = await renderApp();
    let rejectOld!: (error: Error) => void;
    const old = new Promise<BackgroundAgent[]>((_resolve, reject) => { rejectOld = reject; });
    const fresh: BackgroundAgent[] = [{ id: 'work-owned', name: 'Fresh work account session', cwd: 'D:\\synthetic-work' }];
    const detached = vi.spyOn(rendered.api.handoff, 'backgroundAgents').mockReturnValueOnce(old).mockResolvedValueOnce(fresh);
    await rendered.user.click(header());
    expect(detached).toHaveBeenCalledWith('default');
    await act(async () => rendered.controller.setActiveProfile('profile-work'));
    await act(async () => rendered.controller.loadBackground());
    expect(detached).toHaveBeenLastCalledWith('profile-work');
    expect(within(card()).getByText('Fresh work account session')).toBeInTheDocument();

    await act(async () => rejectOld(new Error('Old account background failure')));
    expect(rendered.controller.state.background).toEqual({ list: fresh, state: 'loaded' });
    expect(within(card()).getByText('Fresh work account session')).toBeInTheDocument();
    expect(within(card()).queryByText('Old account background failure')).not.toBeInTheDocument();
  });

  it.each(['response', 'error'] as const)('ignores an obsolete background %s after switching away and back to the same account', async (outcome) => {
    const rendered = await renderApp();
    let resolveOld!: (list: BackgroundAgent[]) => void;
    let rejectOld!: (error: Error) => void;
    const old = new Promise<BackgroundAgent[]>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const fresh: BackgroundAgent[] = [{ id: 'fresh-default', name: 'Newest default account session' }];
    vi.spyOn(rendered.api.handoff, 'backgroundAgents').mockReturnValueOnce(old).mockResolvedValueOnce([]).mockResolvedValueOnce(fresh);
    await rendered.user.click(header());
    await act(async () => rendered.controller.setActiveProfile('profile-work'));
    await act(async () => rendered.controller.loadBackground());
    await act(async () => rendered.controller.setActiveProfile('default'));
    await act(async () => rendered.controller.loadBackground());
    expect(within(card()).getByText('Newest default account session')).toBeInTheDocument();

    await act(async () => {
      if (outcome === 'response') resolveOld([{ id: 'stale-default', name: 'Obsolete default account session' }]);
      else rejectOld(new Error('Obsolete default account failure'));
    });
    expect(rendered.controller.state.background).toEqual({ list: fresh, state: 'loaded' });
    expect(within(card()).getByText('Newest default account session')).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('Obsolete default account');
  });

  it('counts running work in its header, lists it newest first and opens a row in the pane', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: LIVE }));
    expect(within(header()).getByText('2')).toBeInTheDocument();
    await rendered.user.click(header());
    const rows = within(card()).getAllByTestId('task-row');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['workflow', 'shell', 'agent']);
    expect(within(card()).getAllByRole('button', { name: 'Stop this task' })).toHaveLength(2);

    await rendered.user.click(within(rows[1]!).getByRole('button', { name: /npm run dev/ }));
    const pane = await screen.findByTestId('tasks-pane');
    expect(within(pane).getByTestId('task-detail')).toHaveTextContent('npm run dev');
    expect(rendered.controller.state.ui.tasksPaneTask).toBe('b-mid');
    // Another session in view starts the pane on its list again.
    act(() => rendered.controller.showHome());
    expect(rendered.controller.state.ui.tasksPaneTask).toBeNull();
  });

  it('stops a running task of a live session from the card', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const stop = vi.spyOn(rendered.api.engine, 'stopTask');
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: LIVE }));
    await rendered.user.click(header());
    await rendered.user.click(within(card()).getAllByRole('button', { name: 'Stop this task' })[0]!);
    await waitFor(() => expect(stop).toHaveBeenCalledWith(handleId, 'w-new'));
  });

  it('fetches a saved session\'s tasks only while open, and keeps the detached sessions below', async () => {
    const rendered = await renderApp();
    const fetch = vi.spyOn(rendered.api.sessions, 'tasks');
    const detached = vi.spyOn(rendered.api.handoff, 'backgroundAgents');
    await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    expect(fetch).not.toHaveBeenCalled();
    expect(within(header()).queryByText(/\d/)).toBeNull();
    await rendered.user.click(header());
    await waitFor(() => expect(within(card()).getAllByTestId('task-row')).toHaveLength(3));
    expect(fetch).toHaveBeenCalled();
    expect(within(card()).queryByRole('button', { name: 'Stop this task' })).not.toBeInTheDocument();
    await waitFor(() => expect(detached).toHaveBeenCalled());
    expect(within(card()).getByText('Detached sessions (claude --bg)')).toBeInTheDocument();
  });
});

describe('running count under the latest content (desktop parity)', () => {
  it('shows how many background tasks of the live session run and unfolds them in place, newest first', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const stop = vi.spyOn(rendered.api.engine, 'stopTask');
    expect(screen.queryByTestId('background-running')).not.toBeInTheDocument();
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: LIVE }));
    const head = screen.getByTestId('background-running');
    expect(head).toHaveTextContent('2 running');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head.closest('[role=log]')?.lastElementChild).toBe(head.parentElement);
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: [...LIVE].reverse() }));
    await rendered.user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: '2 running' });
    const rows = within(list).getAllByTestId('task-row');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['workflow', 'shell']);
    expect(screen.queryByTestId('tasks-pane')).not.toBeInTheDocument();
    await rendered.user.click(within(rows[1]!).getByRole('button', { name: 'Stop this task' }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(handleId, 'b-mid'));
    // A task opens its detail in the pane.
    await rendered.user.click(within(rows[0]!).getByRole('button', { name: /Audit every route/ }));
    const pane = await screen.findByTestId('tasks-pane');
    expect(within(pane).getByTestId('task-detail')).toHaveTextContent('Audit every route');
    await rendered.user.click(head);
    expect(screen.queryByRole('list', { name: '2 running' })).not.toBeInTheDocument();
    act(() =>
      rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: LIVE.map((t) => ({ ...t, status: 'completed' as const, endedAt: now })) }),
    );
    expect(screen.queryByTestId('background-running')).not.toBeInTheDocument();
  });

  it('is gone once the engine is closed, though its last list still claims running work', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => rendered.api.mock.emitEngine({ type: 'tasks', handleId, tasks: LIVE }));
    expect(screen.getByTestId('background-running')).toHaveTextContent('2 running');
    act(() => rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'closed' }));
    expect(rendered.controller.currentView()?.tasks?.filter((t) => t.status === 'running')).toHaveLength(2);
    expect(screen.queryByTestId('background-running')).not.toBeInTheDocument();
  });

  it('is not shown for a saved session, whose list may still claim running work', async () => {
    const rendered = await renderApp();
    await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    expect(screen.queryByTestId('background-running')).not.toBeInTheDocument();
  });
});
