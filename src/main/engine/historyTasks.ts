import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask, BackgroundTaskKind } from '@shared/types';
import { asToolResult, asToolUse, isDenialText, isRecord, str } from './mapTranscript';

/** Longest description built from a command. */
export const TASK_DESCRIPTION_LIMIT = 120;
const SUMMARY_LIMIT = 300;

type StartKind = Exclude<BackgroundTaskKind, 'other'>;

/** Task id in the tool_result text the CLI writes when a background task starts. */
const START_ID: Record<StartKind, RegExp> = {
  shell: /^Command\b[^\n]*?\bbackground[^\n]*?\bID:\s*([A-Za-z0-9_-]+)/i,
  agent: /\bagentId:\s*([A-Za-z0-9_-]+)/,
  workflow: /\bTask ID:\s*([A-Za-z0-9_-]+)/i,
  monitor: /\(task\s+([A-Za-z0-9_-]+)/i,
};

const TASK_TYPES: Partial<Record<StartKind, string>> = {
  shell: 'local_bash',
  agent: 'local_agent',
  workflow: 'local_workflow',
};

const OPEN_STATUSES: ReadonlySet<BackgroundTask['status']> = new Set(['pending', 'running', 'paused']);

interface Use {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ts?: number;
  parentToolUseId?: string;
}

interface Result {
  isError: boolean;
  text: string;
  ts?: number;
}

interface Usage {
  durationMs?: number;
  totalTokens?: number;
  toolUses?: number;
}

interface Notice extends Usage {
  taskIds: string[];
  toolUseId?: string;
  status?: string;
  summary?: string;
}

type TaskEvent = { ts?: number; order: number } & (
  | { type: 'notice'; notice: Notice }
  | { type: 'stop'; taskId: string }
  | { type: 'resume'; taskId: string }
);

function timestampOf(message: SessionMessage): number | undefined {
  // Not in the SessionMessage typings, but present on the objects getSessionMessages() returns.
  const raw = (message as unknown as Record<string, unknown>).timestamp;
  const ms = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit).trimEnd()}…` : line;
}

/** Numbers of a `<usage>` block, either `key: N` lines or `<key>N</key>` tags. */
function usageOf(text: string): Usage {
  const block = /<usage>([\s\S]*?)<\/usage>/.exec(text)?.[1];
  if (block === undefined) return {};
  const number = (pattern: string): number | undefined => {
    const match = new RegExp(`\\b(?:${pattern})(?:>|:)\\s*(\\d+)`).exec(block);
    return match ? Number(match[1]) : undefined;
  };
  const usage: Usage = {};
  const durationMs = number('duration_ms');
  const totalTokens = number('total_tokens|subagent_tokens');
  const toolUses = number('tool_uses');
  if (durationMs !== undefined) usage.durationMs = durationMs;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  return usage;
}

/** Every `<task-notification>` block of a text; one block may name several task ids. */
export function parseTaskNotifications(text: string): Notice[] {
  const notices: Notice[] = [];
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = match[1] ?? '';
    const taskIds = [...body.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)].map((m) => m[1] ?? '').filter(Boolean);
    const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(body)?.[1];
    const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(body)?.[1];
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
    if (taskIds.length === 0 && !toolUseId) continue;
    notices.push({
      taskIds,
      ...(toolUseId ? { toolUseId } : {}),
      ...(status ? { status: status.toLowerCase() } : {}),
      ...(summary?.trim() ? { summary: oneLine(decodeEntities(summary), SUMMARY_LIMIT) } : {}),
      ...usageOf(body),
    });
  }
  return notices;
}

function notificationText(message: SessionMessage): string | undefined {
  if (message.type !== 'user' || !isRecord(message.message)) return undefined;
  const content = message.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
        : '';
  const origin = (message as unknown as Record<string, unknown>).origin;
  const fromOrigin = isRecord(origin) && origin.kind === 'task-notification';
  // A user prompt that only mentions the tag is not a notification.
  return fromOrigin || text.trimStart().startsWith('<task-notification>') ? text : undefined;
}

function mapStatus(raw: string): BackgroundTask['status'] {
  if (/^(completed?|success|succeeded|done)$/.test(raw)) return 'completed';
  if (/^(failed|error|errored)$/.test(raw)) return 'failed';
  if (/^(stopped|killed|cancell?ed|aborted)$/.test(raw)) return 'stopped';
  if (raw === 'running' || raw === 'pending' || raw === 'paused') return raw;
  return 'unknown';
}

function startKind(use: Use, result: Result | undefined): StartKind | undefined {
  switch (use.name) {
    case 'Bash':
    case 'PowerShell':
      // Commands the user or the CLI moved to the background say so in their result.
      return use.input.run_in_background === true || (result && START_ID.shell.test(result.text.trimStart()))
        ? 'shell'
        : undefined;
    case 'Agent':
    case 'Task':
      return 'agent';
    case 'Workflow':
      return 'workflow';
    case 'Monitor':
      return 'monitor';
    default:
      return undefined;
  }
}

function describeTask(use: Use, kind: StartKind, result: Result | undefined): string {
  const description = str(use.input.description)?.trim();
  if (description) return description;
  const command = str(use.input.command);
  if (command?.trim()) return oneLine(command, TASK_DESCRIPTION_LIMIT);
  if (kind === 'workflow' && result) {
    const summary = /^Summary:\s*(.+)$/m.exec(result.text)?.[1];
    if (summary?.trim()) return oneLine(summary, TASK_DESCRIPTION_LIMIT);
  }
  return use.name;
}

/**
 * Pure: background tasks of a saved session (U5), from getSessionMessages() output plus subagent messages.
 * Background Bash/PowerShell commands, Agent/Task subagents (background or not), Workflow and Monitor runs;
 * running until a task notification, TaskStop or (for foreground agents) the tool result closes them.
 */
export function deriveHistoryTasks(messages: readonly SessionMessage[]): BackgroundTask[] {
  const uses = new Map<string, Use>();
  const results = new Map<string, Result>();
  const events: TaskEvent[] = [];
  const lastToolOf = new Map<string, string>();

  messages.forEach((message, order) => {
    const ts = timestampOf(message);
    const parent = message.parent_tool_use_id ?? undefined;
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
    if (message.type === 'assistant') {
      for (const block of content) {
        const use = asToolUse(block);
        if (!use) continue;
        uses.set(use.id, {
          id: use.id,
          name: use.name,
          input: isRecord(use.input) ? use.input : {},
          ...(ts !== undefined ? { ts } : {}),
          ...(parent ? { parentToolUseId: parent } : {}),
        });
        if (parent) lastToolOf.set(parent, use.name);
      }
      return;
    }
    if (message.type !== 'user') return;
    for (const block of content) {
      const result = asToolResult(block);
      if (!result) continue;
      results.set(result.toolUseId, { isError: result.isError, text: result.text, ...(ts !== undefined ? { ts } : {}) });
      const use = uses.get(result.toolUseId);
      if (!use || result.isError) continue;
      if (use.name === 'TaskStop' || use.name === 'KillShell') {
        const taskId = str(use.input.task_id) ?? str(use.input.shell_id);
        if (taskId) events.push({ type: 'stop', taskId, ts, order });
      } else if (use.name === 'SendMessage' && !/"success"\s*:\s*false/.test(result.text)) {
        const taskId = /"resumedAgentId"\s*:\s*"([^"]+)"/.exec(result.text)?.[1] ?? str(use.input.to);
        if (taskId) events.push({ type: 'resume', taskId, ts, order });
      }
    }
    const text = notificationText(message);
    if (text !== undefined) for (const notice of parseTaskNotifications(text)) events.push({ type: 'notice', notice, ts, order });
  });

  const tasks: BackgroundTask[] = [];
  const byTaskId = new Map<string, BackgroundTask>();
  const byToolUse = new Map<string, BackgroundTask>();
  const parents = new Map<BackgroundTask, string>();

  for (const use of uses.values()) {
    const result = results.get(use.id);
    const kind = startKind(use, result);
    if (!kind) continue;
    const background =
      kind !== 'agent' ||
      use.input.run_in_background === true ||
      (result !== undefined && /\bAsync agent launched\b/i.test(result.text));
    // A background start that failed or was denied never became a task.
    if (result?.isError && (background || isDenialText(result.text))) continue;
    const taskId = (result && START_ID[kind].exec(result.text)?.[1]) || use.id;
    const task: BackgroundTask = {
      taskId,
      kind,
      ...(TASK_TYPES[kind] ? { taskType: TASK_TYPES[kind] } : {}),
      description: describeTask(use, kind, result),
      status: 'running',
      ...(use.ts !== undefined ? { startedAt: use.ts } : {}),
      toolUseId: use.id,
      ...(kind === 'agent' && str(use.input.subagent_type) ? { subagentType: str(use.input.subagent_type) } : {}),
    };
    const lastTool = lastToolOf.get(use.id);
    if (kind === 'agent' && lastTool) task.lastTool = lastTool;
    if (result && !background) {
      task.status = result.isError ? 'failed' : 'completed';
      if (result.ts !== undefined) task.endedAt = result.ts;
      Object.assign(task, usageOf(result.text));
    }
    tasks.push(task);
    byTaskId.set(taskId, task);
    byToolUse.set(use.id, task);
    if (use.parentToolUseId) parents.set(task, use.parentToolUseId);
  }
  for (const [task, parentToolUseId] of parents) {
    const parent = byToolUse.get(parentToolUseId);
    if (parent) task.parentTaskId = parent.taskId;
  }

  // Main-thread messages come before subagent messages; timestamps restore the real order when every event has one.
  const ordered = events.every((event) => event.ts !== undefined)
    ? [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.order - b.order)
    : events;
  for (const event of ordered) {
    if (event.type === 'stop') {
      const task = byTaskId.get(event.taskId);
      if (!task || !OPEN_STATUSES.has(task.status)) continue;
      task.status = 'stopped';
      if (event.ts !== undefined) task.endedAt = event.ts;
      continue;
    }
    if (event.type === 'resume') {
      const task = byTaskId.get(event.taskId);
      if (!task) continue;
      task.status = 'running';
      delete task.endedAt;
      delete task.durationMs;
      continue;
    }
    const { notice } = event;
    let targets = notice.taskIds.flatMap((id) => byTaskId.get(id) ?? []);
    if (targets.length === 0 && notice.toolUseId) targets = byToolUse.has(notice.toolUseId) ? [byToolUse.get(notice.toolUseId)!] : [];
    if (targets.length === 0 && notice.taskIds.length === 1) {
      // Started before the part of the history the SDK returns (e.g. before a compaction).
      const taskId = notice.taskIds[0]!;
      const task: BackgroundTask = { taskId, kind: 'other', description: notice.summary ?? taskId, status: 'unknown' };
      tasks.push(task);
      byTaskId.set(taskId, task);
      targets = [task];
    }
    for (const task of targets) {
      if (notice.status) {
        task.status = mapStatus(notice.status);
        if (OPEN_STATUSES.has(task.status)) delete task.endedAt;
        else if (event.ts !== undefined) task.endedAt = event.ts;
      }
      if (notice.summary) task.summary = notice.summary;
      if (notice.durationMs !== undefined) task.durationMs = notice.durationMs;
      if (notice.totalTokens !== undefined) task.totalTokens = notice.totalTokens;
      if (notice.toolUses !== undefined) task.toolUses = notice.toolUses;
    }
  }

  // Stable: tasks without a start time keep their order after the others.
  return [...tasks].sort((a, b) =>
    a.startedAt === undefined ? (b.startedAt === undefined ? 0 : 1) : b.startedAt === undefined ? -1 : a.startedAt - b.startedAt,
  );
}
