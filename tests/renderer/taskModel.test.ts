import { describe, expect, it } from 'vitest';
import type { BackgroundTask, WorkflowProgress } from '@shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { MAIN_SESSION_ID, MOCK_TASKS } from '../../src/renderer/mock/fixtures';
import {
  agentStatus,
  groupAgents,
  hasBackgroundWork,
  phaseStatus,
  sortTasks,
  taskLabel,
  taskTime,
  workflowLine,
  workflowSummary,
} from '../../src/renderer/components/tasks/taskModel';
import { createView } from '../../src/renderer/state/sessionReducer';

const t = createTranslator('en');

describe('task time column', () => {
  const base: BackgroundTask = { taskId: 't', kind: 'shell', description: 'npm run dev', status: 'running' };

  it('counts running tasks up from startedAt, else from the reported duration', () => {
    expect(taskTime({ ...base, startedAt: 1_000 }, 66_000)).toBe(65_000);
    expect(taskTime({ ...base, durationMs: 10_000 }, 50_000, 47_000)).toBe(13_000);
    expect(taskTime(base, 50_000)).toBeNull();
  });

  it('shows the total for finished tasks', () => {
    expect(taskTime({ ...base, status: 'completed', startedAt: 1_000, endedAt: 61_000, durationMs: 5 }, 999_999)).toBe(60_000);
    expect(taskTime({ ...base, status: 'failed', durationMs: 377_000 }, 999_999)).toBe(377_000);
    expect(taskTime({ ...base, status: 'stopped', startedAt: 1_000 }, 999_999)).toBeNull();
  });
});

describe('task order', () => {
  const task = (taskId: string, status: BackgroundTask['status'], times: Partial<BackgroundTask> = {}): BackgroundTask => ({
    taskId,
    kind: 'shell',
    description: taskId,
    status,
    ...times,
  });
  const ids = (tasks: BackgroundTask[]): string[] => sortTasks(tasks).map((entry) => entry.taskId);

  it('puts running, pending and paused work first, newest start first', () => {
    expect(
      ids([
        task('old-run', 'running', { startedAt: 100 }),
        task('done', 'completed', { startedAt: 500, endedAt: 900 }),
        task('new-run', 'running', { startedAt: 300 }),
        task('pending', 'pending', { startedAt: 200 }),
        task('paused', 'paused', { startedAt: 400 }),
      ]),
    ).toEqual(['paused', 'new-run', 'pending', 'old-run', 'done']);
  });

  it('orders finished work by newest end, then start time, then the reverse of list order', () => {
    expect(
      ids([
        task('ended-early', 'completed', { startedAt: 10, endedAt: 50 }),
        task('failed-late', 'failed', { startedAt: 20, endedAt: 400 }),
        task('stopped-start-only', 'stopped', { startedAt: 300 }),
        task('unknown-a', 'unknown'),
        task('unknown-b', 'completed'),
      ]),
    ).toEqual(['failed-late', 'stopped-start-only', 'ended-early', 'unknown-b', 'unknown-a']);
    // Equal times fall back to the list order as well: the later entry is the newer one.
    expect(ids([task('a', 'running', { startedAt: 5 }), task('b', 'running', { startedAt: 5 })])).toEqual(['b', 'a']);
    expect(ids([task('x', 'running'), task('y', 'running', { startedAt: 1 })])).toEqual(['y', 'x']);
  });

  it('keeps the input untouched', () => {
    const list = [task('a', 'completed', { endedAt: 1 }), task('b', 'running', { startedAt: 2 })];
    sortTasks(list);
    expect(list.map((entry) => entry.taskId)).toEqual(['a', 'b']);
  });
});

describe('workflow summary', () => {
  const fixture = MOCK_TASKS[MAIN_SESSION_ID]!.find((task) => task.kind === 'workflow')!;
  const phase = (index: number, agents: number, done: number, failed: number, running: number) => ({
    index,
    title: `P${index}`,
    agents,
    done,
    failed,
    running,
  });
  const flow = (...phases: ReturnType<typeof phase>[]): WorkflowProgress => ({ phases, agents: [] });

  it('projects only nonterminal agents of a stopped workflow to stopped without changing completed or failed states', () => {
    expect(agentStatus('running', 'stopped')).toBe('stopped');
    expect(agentStatus('queued', 'stopped')).toBe('stopped');
    expect(agentStatus('done', 'stopped')).toBe('completed');
    expect(agentStatus('failed', 'stopped')).toBe('failed');
    expect(agentStatus('running')).toBe('running');
    expect(agentStatus('queued')).toBe('pending');
    expect(agentStatus('running', 'running')).toBe('running');
    expect(agentStatus('queued', 'paused')).toBe('pending');
  });

  it('names the phase with running agents and sums the counts over the phases', () => {
    const summary = workflowSummary(fixture.workflow)!;
    expect(summary).toEqual({ current: 2, total: 3, done: 4, agents: 7, failed: 1 });
    expect(workflowLine(summary, t)).toBe('Phase 2 of 3 · 4/7 agents · 1 failed');
    expect(workflowLine({ ...summary, failed: 0 }, t)).toBe('Phase 2 of 3 · 4/7 agents');
  });

  it('takes the highest phase with running agents, else the last phase with agents', () => {
    expect(workflowSummary(flow(phase(1, 2, 1, 0, 1), phase(2, 3, 0, 0, 3), phase(3, 0, 0, 0, 0)))?.current).toBe(2);
    expect(workflowSummary(flow(phase(1, 2, 2, 0, 0), phase(2, 3, 3, 0, 0), phase(3, 0, 0, 0, 0)))?.current).toBe(2);
    expect(workflowSummary(flow(phase(0, 0, 0, 0, 0), phase(1, 0, 0, 0, 0)))?.current).toBe(1);
    // Positions, not the CLI's phase numbers: zero-based indices still read "Phase 1 of 2".
    expect(workflowSummary(flow(phase(0, 1, 0, 0, 1), phase(1, 0, 0, 0, 0)))).toMatchObject({ current: 1, total: 2 });
    expect(workflowSummary({ phases: [], agents: [] })).toBeNull();
    expect(workflowSummary(undefined)).toBeNull();
  });

  it('gives each phase a status and groups the agents under their phases', () => {
    expect(phaseStatus(phase(1, 2, 1, 0, 1))).toBe('running');
    expect(phaseStatus(phase(1, 2, 2, 0, 0))).toBe('completed');
    expect(phaseStatus(phase(1, 2, 1, 1, 0))).toBe('failed');
    expect(phaseStatus(phase(1, 2, 1, 0, 0))).toBe('pending');
    expect(phaseStatus(phase(1, 0, 0, 0, 0))).toBe('pending');
    const { byPhase, other } = groupAgents({
      ...fixture.workflow!,
      agents: [...fixture.workflow!.agents, { index: 99, label: 'Loose agent', state: 'queued' }],
    });
    expect(byPhase.get(2)?.map((agent) => agent.index)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(byPhase.get(3)).toEqual([]);
    expect(other.map((agent) => agent.label)).toEqual(['Loose agent']);
  });

  it('labels a workflow by its script name when it has no description', () => {
    expect(taskLabel({ ...fixture, description: '' }, t)).toBe('audit-routes');
    expect(taskLabel({ ...fixture, description: '', workflowName: undefined }, t)).toBe('Workflow');
    expect(taskLabel(fixture, t)).toBe('Audit every route handler for missing auth checks');
  });
});

describe('background work in the ⋮ menu', () => {
  const view = (patch: Parameters<typeof createView>[0]) => createView(patch);

  it('offers the pane for a live view with tasks and for every saved session', () => {
    const base = { key: 'k', profileId: 'default', cwd: 'D:\\r', title: 'x' };
    expect(hasBackgroundWork(null)).toBe(false);
    expect(hasBackgroundWork(view({ ...base, sessionId: 's1' }))).toBe(true);
    expect(hasBackgroundWork(view({ ...base, isNew: true }))).toBe(false);
    const live = { ...base, sessionId: 's1', handleId: 'h1', engineState: 'idle' as const };
    expect(hasBackgroundWork(view(live))).toBe(false);
    expect(hasBackgroundWork(view({ ...live, tasks: [{ taskId: 'a', kind: 'shell', description: 'x', status: 'completed' }] }))).toBe(true);
    expect(hasBackgroundWork(view({ ...base, sessionId: 's1', sideChatOf: 'other' }))).toBe(false);
  });
});
