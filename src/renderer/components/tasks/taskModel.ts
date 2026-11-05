import type { BackgroundTask, WorkflowAgent, WorkflowPhase, WorkflowProgress } from '@shared/types';
import type { Translate } from '../../i18n';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';

/** Refresh interval of a read-only session's task list while the pane is open. */
export const TASKS_POLL_MS = 5000;

/** Refresh interval of a running agent's transcript in the detail view. */
export const TRANSCRIPT_POLL_MS = 3000;

const OPEN_STATUSES: ReadonlySet<BackgroundTask['status']> = new Set(['running', 'pending', 'paused']);

/** Running, pending or paused: work that is not over yet. */
export function isOpenTask(task: Pick<BackgroundTask, 'status'>): boolean {
  return OPEN_STATUSES.has(task.status);
}

/** Work its own stop button can end. */
export function isStoppable(task: Pick<BackgroundTask, 'status'>): boolean {
  return task.status === 'running' || task.status === 'pending';
}

/** Live session (engine events) or about to become one: the engine's list, no polling. */
export function isLiveView(view: SessionView): boolean {
  return hasOpenHandle(view) || view.opening || view.engineState === 'starting';
}

/** Saved session whose list the pane can fetch; an unopened side chat has no tasks of its own. */
export function savedSessionId(view: SessionView): string | undefined {
  return view.sideChatOf ? undefined : view.sessionId;
}

/** The title bar ⋮ menu offers the pane for a live view with tasks or for any saved session (the pane fetches). */
export function hasBackgroundWork(view: SessionView | null): boolean {
  if (!view) return false;
  if (isLiveView(view)) return (view.tasks?.length ?? 0) > 0;
  return Boolean(savedSessionId(view));
}

/**
 * Time column: running rows count up from startedAt (or from the last reported durationMs, measured from when it
 * arrived); finished rows show the total. Null when nothing is known.
 */
export function taskTime(task: BackgroundTask, now: number, reportedAt?: number): number | null {
  if (isOpenTask(task) && task.status !== 'paused') {
    if (task.startedAt !== undefined) return Math.max(0, now - task.startedAt);
    if (task.durationMs !== undefined) return task.durationMs + Math.max(0, now - (reportedAt ?? now));
    return null;
  }
  if (task.startedAt !== undefined && task.endedAt !== undefined) return Math.max(0, task.endedAt - task.startedAt);
  return task.durationMs ?? null;
}

/**
 * New work on top, finished or older work below: open tasks by newest start, then finished tasks by newest end
 * (start time when the end is unknown). Tasks without any time follow the timed ones of their group, later list
 * entries first.
 */
export function sortTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks
    .map((task, index) => {
      const open = isOpenTask(task);
      return { task, index, open, time: open ? task.startedAt : (task.endedAt ?? task.startedAt) };
    })
    .sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      if (a.time !== undefined && b.time !== undefined) {
        if (a.time !== b.time) return b.time - a.time;
      } else if (a.time !== undefined || b.time !== undefined) {
        return a.time === undefined ? 1 : -1;
      }
      return b.index - a.index;
    })
    .map((entry) => entry.task);
}

/** Row title: the description, a workflow's script name when it has none, else the kind. */
export function taskLabel(task: BackgroundTask, t: Translate): string {
  return task.description.trim() || (task.kind === 'workflow' ? task.workflowName?.trim() : '') || t(`tasks.kind.${task.kind}`);
}

export interface WorkflowSummary {
  /** 1-based position of the phase in progress. */
  current: number;
  total: number;
  done: number;
  agents: number;
  failed: number;
}

/**
 * Progress of a workflow: the current phase is the last one with running agents, else the last one that has agents.
 * Done, agent and failure counts are summed over the phases (they cover agents the list leaves out).
 */
export function workflowSummary(workflow: WorkflowProgress | undefined): WorkflowSummary | null {
  const phases = workflow?.phases ?? [];
  if (phases.length === 0) return null;
  let running = -1;
  let started = -1;
  phases.forEach((phase, position) => {
    if (phase.running > 0) running = position;
    if (phase.agents > 0) started = position;
  });
  const sum = (key: 'done' | 'agents' | 'failed'): number => phases.reduce((total, phase) => total + phase[key], 0);
  return {
    current: (running >= 0 ? running : Math.max(started, 0)) + 1,
    total: phases.length,
    done: sum('done'),
    agents: sum('agents'),
    failed: sum('failed'),
  };
}

/** "Phase 2 of 3 · 4/7 agents · 1 failed". */
export function workflowLine(summary: WorkflowSummary, t: Translate): string {
  const line = t('tasks.workflowProgress', {
    current: summary.current,
    total: summary.total,
    done: summary.done,
    agents: summary.agents,
  });
  return summary.failed > 0 ? `${line} · ${t('tasks.failedCount', { n: summary.failed })}` : line;
}

/** "4/6 agents · 1 failed" for one phase. */
export function phaseLine(phase: WorkflowPhase, t: Translate): string {
  const line = t('tasks.phaseAgents', { done: phase.done, total: phase.agents });
  return phase.failed > 0 ? `${line} · ${t('tasks.failedCount', { n: phase.failed })}` : line;
}

/** A stopped parent overrides nonterminal phase metadata, but retains completed and failed phases. */
export function phaseStatus(phase: WorkflowPhase, parentStatus?: BackgroundTask['status']): BackgroundTask['status'] {
  if (phase.running > 0) return parentStatus === 'stopped' ? 'stopped' : 'running';
  if (phase.agents > 0 && phase.done + phase.failed >= phase.agents) return phase.failed > 0 ? 'failed' : 'completed';
  return parentStatus === 'stopped' ? 'stopped' : 'pending';
}

/** A stopped workflow can retain a nonterminal agent state in its last native metadata. */
export function agentStatus(state: WorkflowAgent['state'], parentStatus?: BackgroundTask['status']): BackgroundTask['status'] {
  if (parentStatus === 'stopped' && (state === 'queued' || state === 'running')) return 'stopped';
  switch (state) {
    case 'running':
      return 'running';
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Agents grouped under their phases; agents of no listed phase come last. */
export function groupAgents(workflow: WorkflowProgress): { byPhase: Map<number, WorkflowAgent[]>; other: WorkflowAgent[] } {
  const byPhase = new Map<number, WorkflowAgent[]>(workflow.phases.map((phase) => [phase.index, []]));
  const other: WorkflowAgent[] = [];
  for (const agent of workflow.agents) {
    const list = agent.phaseIndex === undefined ? undefined : byPhase.get(agent.phaseIndex);
    if (list) list.push(agent);
    else other.push(agent);
  }
  return { byPhase, other };
}
