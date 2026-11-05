import type {
  SDKBackgroundTasksChangedMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask, BackgroundTaskKind, WorkflowAgent, WorkflowPhase, WorkflowProgress } from '@shared/types';
import { isRecord, str } from './mapTranscript';
import { redactSecrets } from './redaction';

export type TaskMessage =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage
  | SDKBackgroundTasksChangedMessage;

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
const TERMINAL = new Set<BackgroundTask['status']>(['completed', 'failed', 'stopped']);

export function isTaskMessage(message: { type: string; subtype?: unknown }): message is TaskMessage {
  return message.type === 'system' && typeof message.subtype === 'string' && TASK_SUBTYPES.has(message.subtype);
}

/** SDK task_type -> card kind; monitors are monitor_mcp / monitor_ws (CLI 2.1.302). */
export function taskKind(taskType: string | undefined): BackgroundTaskKind {
  if (taskType === 'local_bash') return 'shell';
  if (taskType === 'local_agent') return 'agent';
  if (taskType === 'local_workflow') return 'workflow';
  if (taskType?.startsWith('monitor')) return 'monitor';
  return 'other';
}

function taskStatus(status: string | undefined): BackgroundTask['status'] | undefined {
  switch (status) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'stopped':
      return status;
    case 'killed':
      return 'stopped';
    default:
      return undefined;
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Most agents of one workflow sent to the renderer (a run allows 1,000); the phase counts still cover all of them. */
export const MAX_WORKFLOW_AGENTS = 300;
const MAX_WORKFLOW_PHASES = 100;

function agentState(entry: Record<string, unknown>): WorkflowAgent['state'] {
  switch (entry.state) {
    case 'done':
      return 'done';
    case 'error':
    case 'failed':
    case 'killed':
    case 'stopped':
      return 'failed';
    default:
      return finite(entry.startedAt) !== undefined ? 'running' : 'queued';
  }
}

/**
 * Phases and agents of a workflow from the CLI's task_progress `workflow_progress` (not in the SDK typings, read
 * defensively): workflow_phase entries name the phases, workflow_agent entries carry each agent's latest state.
 */
export function parseWorkflowProgress(entries: unknown): WorkflowProgress | undefined {
  if (!Array.isArray(entries)) return undefined;
  const phases = new Map<number, WorkflowPhase>();
  const agents = new Map<number, WorkflowAgent>();
  const phaseOf = (index: number, title?: string): WorkflowPhase => {
    let phase = phases.get(index);
    if (!phase) {
      phase = { index, title: title || `Phase ${index}`, agents: 0, done: 0, failed: 0, running: 0 };
      phases.set(index, phase);
    }
    return phase;
  };
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const index = finite(entry.index);
    if (index === undefined) continue;
    if (entry.type === 'workflow_phase') {
      phaseOf(index).title = str(entry.title)?.trim() || `Phase ${index}`;
    } else if (entry.type === 'workflow_agent') {
      const phaseIndex = finite(entry.phaseIndex);
      const agentId = str(entry.agentId);
      const tokens = finite(entry.tokens);
      const toolCalls = finite(entry.toolCalls);
      const lastTool = str(entry.lastToolName);
      agents.set(index, {
        index,
        label: redactSecrets(str(entry.label)?.trim() || `Agent ${index}`),
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        state: agentState(entry),
        ...(agentId ? { agentId } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(lastTool ? { lastTool } : {}),
      });
      if (phaseIndex !== undefined) phaseOf(phaseIndex, str(entry.phaseTitle)?.trim());
    }
  }
  for (const agent of agents.values()) {
    if (agent.phaseIndex === undefined) continue;
    const phase = phaseOf(agent.phaseIndex);
    phase.agents++;
    if (agent.state === 'done') phase.done++;
    else if (agent.state === 'failed') phase.failed++;
    else if (agent.state === 'running') phase.running++;
  }
  const byIndex = <T extends { index: number }>(a: T, b: T): number => a.index - b.index;
  return {
    phases: [...phases.values()].sort(byIndex).slice(0, MAX_WORKFLOW_PHASES),
    agents: [...agents.values()].sort(byIndex).slice(-MAX_WORKFLOW_AGENTS),
  };
}

interface Tracked {
  task: BackgroundTask;
  runId?: string;
  /** output_file of the task's notification; read by engine.taskOutput, never sent to the renderer. */
  outputFile?: string;
  /** False while the task runs in the foreground with its tool call blocking on it. */
  backgrounded: boolean;
}

/**
 * Background tasks of one live session from the SDK task_* and background_tasks_changed messages.
 * Ambient and skip_transcript tasks and foreground tasks are left out; finished tasks stay listed.
 */
export class BackgroundTasks {
  private readonly tracked = new Map<string, Tracked>();
  private readonly skipped = new Set<string>();

  /** Applies one message; true when the visible list changed. */
  apply(message: TaskMessage, now: number): boolean {
    const before = this.snapshot();
    switch (message.subtype) {
      case 'task_started':
        this.onStarted(message, now);
        break;
      case 'task_progress':
        this.onProgress(message, now);
        break;
      case 'task_updated':
        this.onUpdated(message, now);
        break;
      case 'task_notification':
        this.onNotification(message, now);
        break;
      case 'background_tasks_changed':
        this.onLiveSet(message, now);
        break;
      default:
        break;
    }
    return this.snapshot() !== before;
  }

  /** The output file the CLI reported for a visible task. */
  outputFile(taskId: string): string | undefined {
    const entry = this.tracked.get(taskId);
    return entry?.backgrounded ? entry.outputFile : undefined;
  }

  /** Visible tasks in the order they were first seen. */
  list(): BackgroundTask[] {
    return [...this.tracked.values()].filter((entry) => entry.backgrounded).map((entry) => ({ ...entry.task }));
  }

  private snapshot(): string {
    return JSON.stringify(this.list());
  }

  private skip(taskId: string): void {
    this.skipped.add(taskId);
    this.tracked.delete(taskId);
  }

  /** A frame of an older run than the one shown is late and ignored. */
  private late(entry: Tracked | undefined, runId: string | undefined): boolean {
    return Boolean(entry?.runId && runId && runId < entry.runId);
  }

  private entry(taskId: string, now: number, init: Partial<BackgroundTask> = {}): Tracked {
    let entry = this.tracked.get(taskId);
    if (!entry) {
      entry = {
        task: { taskId, kind: 'other', description: '', status: 'running', startedAt: now, ...init },
        backgrounded: true,
      };
      this.tracked.set(taskId, entry);
    }
    return entry;
  }

  private finish(task: BackgroundTask, status: BackgroundTask['status'], now: number, endTime?: number): void {
    task.status = status;
    if (TERMINAL.has(status)) task.endedAt = endTime ?? task.endedAt ?? now;
    else delete task.endedAt;
  }

  private onStarted(message: SDKTaskStartedMessage, now: number): void {
    if (message.ambient || message.skip_transcript) return this.skip(message.task_id);
    if (this.skipped.has(message.task_id)) return;
    const existing = this.tracked.get(message.task_id);
    if (this.late(existing, message.run_id)) return;
    const newRun = Boolean(existing?.runId && message.run_id && message.run_id !== existing.runId);
    const entry = this.entry(message.task_id, now);
    const task = entry.task;
    if (newRun || (existing && TERMINAL.has(task.status) && !message.run_id)) {
      task.startedAt = now;
      for (const key of ['endedAt', 'durationMs', 'totalTokens', 'toolUses', 'lastTool', 'summary', 'workflow', 'hasOutput'] as const) delete task[key];
      delete entry.outputFile;
    }
    task.status = 'running';
    if (message.run_id) entry.runId = message.run_id;
    if (message.task_type) {
      task.taskType = message.task_type;
      task.kind = taskKind(message.task_type);
    } else if (message.subagent_type && task.kind === 'other') {
      task.kind = 'agent';
    }
    if (message.description.trim()) task.description = message.description.trim();
    if (message.tool_use_id) task.toolUseId = message.tool_use_id;
    if (message.parent_task_id) task.parentTaskId = message.parent_task_id;
    if (message.subagent_type) task.subagentType = message.subagent_type;
    if (message.workflow_name?.trim()) task.workflowName = message.workflow_name.trim();
    if (message.is_backgrounded !== undefined) entry.backgrounded = message.is_backgrounded;
  }

  private onProgress(message: SDKTaskProgressMessage, now: number): void {
    if (this.skipped.has(message.task_id)) return;
    if (this.late(this.tracked.get(message.task_id), message.run_id)) return;
    const entry = this.entry(message.task_id, now, message.subagent_type ? { kind: 'agent' } : {});
    const task = entry.task;
    if (message.run_id) entry.runId ??= message.run_id;
    if (task.status === 'pending' || task.status === 'unknown') task.status = 'running';
    // A workflow's progress description names its current agent; the row keeps the workflow's own description.
    if (message.description.trim() && task.kind !== 'workflow') task.description = message.description.trim();
    const workflow = parseWorkflowProgress((message as { workflow_progress?: unknown }).workflow_progress);
    if (workflow) task.workflow = workflow;
    const duration = finite(message.usage?.duration_ms);
    if (duration !== undefined) task.durationMs = duration;
    const tokens = finite(message.usage?.total_tokens);
    if (tokens !== undefined) task.totalTokens = tokens;
    const tools = finite(message.usage?.tool_uses);
    if (tools !== undefined) task.toolUses = tools;
    if (message.last_tool_name) task.lastTool = message.last_tool_name;
    if (message.summary?.trim()) task.summary = redactSecrets(message.summary.trim());
    if (message.tool_use_id) task.toolUseId = message.tool_use_id;
    if (message.subagent_type) task.subagentType = message.subagent_type;
  }

  private onUpdated(message: SDKTaskUpdatedMessage, now: number): void {
    if (this.skipped.has(message.task_id)) return;
    if (this.late(this.tracked.get(message.task_id), message.run_id)) return;
    const patch = message.patch ?? {};
    const entry = this.entry(message.task_id, now);
    const task = entry.task;
    if (message.run_id) entry.runId ??= message.run_id;
    if (patch.description?.trim()) task.description = patch.description.trim();
    if (patch.is_backgrounded !== undefined) entry.backgrounded = patch.is_backgrounded;
    const status = taskStatus(patch.status);
    if (status) this.finish(task, status, now, finite(patch.end_time));
    else if (finite(patch.end_time) !== undefined) task.endedAt = finite(patch.end_time);
    if (patch.error?.trim()) task.summary = redactSecrets(patch.error.trim());
  }

  private onNotification(message: SDKTaskNotificationMessage, now: number): void {
    if (message.ambient || message.skip_transcript) return this.skip(message.task_id);
    if (this.skipped.has(message.task_id)) return;
    if (this.late(this.tracked.get(message.task_id), message.run_id)) return;
    const summary = message.summary.trim();
    const entry = this.entry(message.task_id, now, summary ? { description: redactSecrets(summary) } : {});
    const task = entry.task;
    if (message.run_id) entry.runId ??= message.run_id;
    this.finish(task, taskStatus(message.status) ?? 'unknown', now);
    if (summary) task.summary = redactSecrets(summary);
    const duration = finite(message.usage?.duration_ms);
    if (duration !== undefined) task.durationMs = duration;
    const tokens = finite(message.usage?.total_tokens);
    if (tokens !== undefined) task.totalTokens = tokens;
    const tools = finite(message.usage?.tool_uses);
    if (tools !== undefined) task.toolUses = tools;
    if (message.tool_use_id) task.toolUseId = message.tool_use_id;
    if (message.output_file?.trim()) {
      entry.outputFile = message.output_file.trim();
      task.hasOutput = true;
    }
  }

  /** REPLACE semantics for the live set; finished tasks stay listed. */
  private onLiveSet(message: SDKBackgroundTasksChangedMessage, now: number): void {
    const live = new Set<string>();
    for (const item of Array.isArray(message.tasks) ? message.tasks : []) {
      if (item.ambient) {
        this.skip(item.task_id);
        continue;
      }
      if (this.skipped.has(item.task_id)) continue;
      const existing = this.tracked.get(item.task_id);
      if (this.late(existing, item.run_id)) continue;
      live.add(item.task_id);
      const newRun = Boolean(existing && item.run_id && existing.runId && item.run_id !== existing.runId);
      const entry = this.entry(item.task_id, now, { kind: taskKind(item.task_type), taskType: item.task_type });
      const task = entry.task;
      entry.backgrounded = true;
      if (item.run_id) entry.runId = item.run_id;
      if (newRun) {
        task.startedAt = now;
        this.finish(task, 'running', now);
      }
      if (!task.taskType && item.task_type) {
        task.taskType = item.task_type;
        task.kind = taskKind(item.task_type);
      }
      if (item.description?.trim() && !task.description) task.description = item.description.trim();
      if (item.parent_task_id) task.parentTaskId = item.parent_task_id;
      if (item.subagent_type) task.subagentType = item.subagent_type;
    }
    for (const [taskId, entry] of this.tracked) {
      if (live.has(taskId) || !entry.backgrounded || TERMINAL.has(entry.task.status)) continue;
      // Left the live set without a bookend; a late task_notification still corrects the status.
      this.finish(entry.task, 'unknown', now);
      entry.task.endedAt ??= now;
    }
  }
}
