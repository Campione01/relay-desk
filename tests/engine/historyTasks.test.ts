import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { deriveHistoryTasks, parseTaskNotifications } from '../../src/main/engine/historyTasks';

const SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-17T08:00:00.000Z');

interface Extra {
  parent?: string;
  at?: number;
  origin?: unknown;
}

/** Shaped like getSessionMessages() objects: `timestamp` and `origin` exist at runtime, not in the typings. */
function msg(uuid: string, type: 'user' | 'assistant', content: unknown, extra: Extra = {}): SessionMessage {
  return {
    type,
    uuid,
    session_id: SESSION,
    message: { role: type, content },
    parent_tool_use_id: extra.parent ?? null,
    parent_agent_id: null,
    ...(extra.at !== undefined ? { timestamp: new Date(T0 + extra.at * 1000).toISOString() } : {}),
    ...(extra.origin !== undefined ? { origin: extra.origin } : {}),
  } as SessionMessage;
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});
const call = (id: string, name: string, input: Record<string, unknown>, at: number, parent?: string) =>
  msg(`a-${id}`, 'assistant', [use(id, name, input)], { at, ...(parent ? { parent } : {}) });
const reply = (id: string, content: unknown, at: number, options: { isError?: boolean; parent?: string } = {}) =>
  msg(`u-${id}`, 'user', [result(id, content, options.isError)], { at, ...(options.parent ? { parent: options.parent } : {}) });

function notification(fields: { taskIds: string[]; toolUseId?: string; status?: string; summary?: string; extra?: string }): string {
  return [
    '<task-notification>',
    ...fields.taskIds.map((id) => `<task-id>${id}</task-id>`),
    ...(fields.toolUseId ? [`<tool-use-id>${fields.toolUseId}</tool-use-id>`] : []),
    '<output-file>C:\\Temp\\claude\\tasks\\x.output</output-file>',
    ...(fields.status ? [`<status>${fields.status}</status>`] : []),
    ...(fields.summary ? [`<summary>${fields.summary}</summary>`] : []),
    ...(fields.extra ? [fields.extra] : []),
    '</task-notification>',
  ].join('\n');
}

const notify = (uuid: string, text: string, at?: number, parent?: string) =>
  msg(uuid, 'user', text, {
    origin: { kind: 'task-notification', producer: 'session-task' },
    ...(at !== undefined ? { at } : {}),
    ...(parent ? { parent } : {}),
  });

const AGENT_LAUNCHED = (agentId: string) =>
  `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agentId} (internal ID - use SendMessage with to: '${agentId}' to continue this agent.)\nThe agent is working in the background.`;

describe('deriveHistoryTasks', () => {
  it('closes a background shell with its task notification, using entry timestamps', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_bg', 'Bash', { command: 'npm run dev', description: 'Start dev server', run_in_background: true }, 1),
      reply('toolu_bg', 'Command running in background with ID: b1x2y3z4q. Output is being written to: C:\\Temp\\b1x2y3z4q.output', 2),
      call('toolu_fg', 'Bash', { command: 'git status', description: 'Status' }, 3),
      reply('toolu_fg', 'On branch main', 4),
      notify('n1', notification({ taskIds: ['b1x2y3z4q'], toolUseId: 'toolu_bg', status: 'completed', summary: 'Background command &quot;Start dev server&quot; completed (exit code 0)' }), 65),
    ]);
    expect(tasks).toEqual([
      {
        taskId: 'b1x2y3z4q',
        kind: 'shell',
        taskType: 'local_bash',
        description: 'Start dev server',
        status: 'completed',
        startedAt: T0 + 1000,
        endedAt: T0 + 65_000,
        toolUseId: 'toolu_bg',
        summary: 'Background command "Start dev server" completed (exit code 0)',
      },
    ]);
  });

  it('lists shells moved to the background without the flag and describes them by the command, cut at 120 characters', () => {
    const long = `node scripts/watch.js\n  ${'a'.repeat(200)}`;
    const tasks = deriveHistoryTasks([
      call('toolu_moved', 'PowerShell', { command: long }, 1),
      reply('toolu_moved', 'Command was manually backgrounded by user with ID: bmoved001', 2),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: 'bmoved001', kind: 'shell', status: 'running' });
    expect(tasks[0]?.description.endsWith('…')).toBe(true);
    expect(tasks[0]?.description.length).toBe(121);
    expect(tasks[0]).not.toHaveProperty('endedAt');
  });

  it('follows a background agent through a failed stop, a SendMessage resume and the final completion with usage', () => {
    const agent = { description: 'Review the diff', subagent_type: 'code-reviewer', prompt: 'x', run_in_background: true };
    const tasks = deriveHistoryTasks([
      call('toolu_agent', 'Agent', agent, 10),
      reply('toolu_agent', [{ type: 'text', text: AGENT_LAUNCHED('a3a0b534bcad38704') }], 11),
      call('toolu_sub', 'Grep', { pattern: 'x' }, 12, 'toolu_agent'),
      notify('n1', notification({ taskIds: ['a3a0b534bcad38704'], toolUseId: 'toolu_agent', status: 'failed', summary: 'Agent "Review the diff" failed' }), 20),
      call('toolu_send', 'SendMessage', { to: 'a3a0b534bcad38704', message: 'continue' }, 30),
      reply('toolu_send', '{"success":true,"message":"Resuming agent a3a0b53","resumedAgentId":"a3a0b534bcad38704"}', 31),
      notify(
        'n2',
        notification({
          taskIds: ['a3a0b534bcad38704'],
          toolUseId: 'toolu_send',
          status: 'completed',
          summary: 'Agent "Review the diff" completed',
          extra: '<result>All good.</result>\n<usage><subagent_tokens>51234</subagent_tokens><tool_uses>17</tool_uses><duration_ms>93000</duration_ms></usage>',
        }),
        130,
      ),
    ]);
    expect(tasks).toEqual([
      {
        taskId: 'a3a0b534bcad38704',
        kind: 'agent',
        taskType: 'local_agent',
        description: 'Review the diff',
        status: 'completed',
        startedAt: T0 + 10_000,
        endedAt: T0 + 130_000,
        toolUseId: 'toolu_agent',
        subagentType: 'code-reviewer',
        lastTool: 'Grep',
        summary: 'Agent "Review the diff" completed',
        durationMs: 93_000,
        totalTokens: 51_234,
        toolUses: 17,
      },
    ]);
  });

  it('shows a resumed agent as running again until a new notification arrives', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_agent', 'Agent', { description: 'Long job', run_in_background: true }, 1),
      reply('toolu_agent', AGENT_LAUNCHED('aresumed01'), 2),
      notify('n1', notification({ taskIds: ['aresumed01'], status: 'failed', extra: '<usage><duration_ms>5000</duration_ms></usage>' }), 3),
      call('toolu_send', 'SendMessage', { to: 'aresumed01', message: 'go on' }, 4),
      reply('toolu_send', '{"success":true,"resumedAgentId":"aresumed01"}', 5),
    ]);
    expect(tasks[0]).toMatchObject({ taskId: 'aresumed01', status: 'running' });
    expect(tasks[0]).not.toHaveProperty('endedAt');
    expect(tasks[0]).not.toHaveProperty('durationMs');
  });

  it('closes a foreground agent with its tool result and links tasks its subagent started', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_fg', 'Task', { description: 'Explore tests', subagent_type: 'Explore', prompt: 'x' }, 1),
      call('toolu_inner', 'Bash', { command: 'npm test -- --watch', run_in_background: true }, 2, 'toolu_fg'),
      reply('toolu_inner', 'Command running in background with ID: binner001. Output is being written to: x', 3, { parent: 'toolu_fg' }),
      reply(
        'toolu_fg',
        [
          { type: 'text', text: 'Found 3 test files.' },
          { type: 'text', text: 'agentId: afg0000001 (use SendMessage to continue)\n<usage>total_tokens: 1200\ntool_uses: 3\nduration_ms: 4500</usage>' },
        ],
        9,
      ),
    ]);
    expect(tasks).toEqual([
      {
        taskId: 'afg0000001',
        kind: 'agent',
        taskType: 'local_agent',
        description: 'Explore tests',
        status: 'completed',
        startedAt: T0 + 1000,
        endedAt: T0 + 9000,
        toolUseId: 'toolu_fg',
        subagentType: 'Explore',
        lastTool: 'Bash',
        durationMs: 4500,
        totalTokens: 1200,
        toolUses: 3,
      },
      {
        taskId: 'binner001',
        kind: 'shell',
        taskType: 'local_bash',
        description: 'npm test -- --watch',
        status: 'running',
        startedAt: T0 + 2000,
        toolUseId: 'toolu_inner',
        parentTaskId: 'afg0000001',
      },
    ]);
  });

  it('derives workflows and monitors, applies TaskStop and skips starts that failed or were denied', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_wf', 'Workflow', { script: 'export const meta = {}', args: '{}' }, 1),
      reply('toolu_wf', 'Workflow launched in background. Task ID: w1yx01btj\nSummary: Build modules in parallel\nTranscript dir: C:\\x', 2),
      call('toolu_wf_off', 'Workflow', { script: 'x' }, 3),
      reply('toolu_wf_off', '<tool_use_error>Error: No such tool available: Workflow.</tool_use_error>', 4, { isError: true }),
      call('toolu_mon', 'Monitor', { command: 'tail -f log', description: 'Watch the build log', timeout_ms: 300000 }, 5),
      reply('toolu_mon', 'Monitor started (task bmon00001, expires in 5m unless the source ends first)', 6),
      call('toolu_denied', 'Agent', { description: 'Not allowed', prompt: 'x' }, 7),
      reply('toolu_denied', "The user doesn't want to proceed with this tool use.", 8, { isError: true }),
      call('toolu_stop', 'TaskStop', { task_id: 'w1yx01btj' }, 9),
      reply('toolu_stop', '{"message":"Successfully stopped task: w1yx01btj","task_id":"w1yx01btj","task_type":"local_workflow"}', 10),
    ]);
    expect(tasks.map((task) => [task.taskId, task.kind, task.status, task.description])).toEqual([
      ['w1yx01btj', 'workflow', 'stopped', 'Build modules in parallel'],
      ['bmon00001', 'monitor', 'running', 'Watch the build log'],
    ]);
    expect(tasks[0]).toMatchObject({ taskType: 'local_workflow', endedAt: T0 + 10_000 });
    expect(tasks[1]).not.toHaveProperty('taskType');
  });

  it('fails a foreground agent whose tool result is an error', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_fail', 'Agent', { description: 'Will crash', prompt: 'x' }, 1),
      reply('toolu_fail', 'API Error: 500', 2, { isError: true }),
    ]);
    expect(tasks).toEqual([
      expect.objectContaining({ taskId: 'toolu_fail', status: 'failed', endedAt: T0 + 2000 }),
    ]);
  });

  it('applies a notification that names several tasks to each and adds an unseen single task as other', () => {
    const tasks = deriveHistoryTasks([
      call('toolu_a', 'Agent', { description: 'One', run_in_background: true }, 1),
      reply('toolu_a', AGENT_LAUNCHED('aone000001'), 2),
      call('toolu_b', 'Agent', { description: 'Two', run_in_background: true }, 3),
      reply('toolu_b', AGENT_LAUNCHED('atwo000002'), 4),
      notify('n1', notification({ taskIds: ['aone000001', 'atwo000002', 'agone00003'], status: 'stopped', summary: '3 background agents were stopped' }), 5),
      notify('n2', notification({ taskIds: ['bearlier01'], status: 'killed', summary: 'Background command "old" was stopped' }), 6),
    ]);
    expect(tasks.map((task) => [task.taskId, task.kind, task.status, task.description])).toEqual([
      ['aone000001', 'agent', 'stopped', 'One'],
      ['atwo000002', 'agent', 'stopped', 'Two'],
      ['bearlier01', 'other', 'stopped', 'Background command "old" was stopped'],
    ]);
  });

  it('only treats real notifications as notifications', () => {
    const start = [
      call('toolu_bg', 'Bash', { command: 'sleep 100', run_in_background: true }, 1),
      reply('toolu_bg', 'Command running in background with ID: bsleep001. Output is being written to: x', 2),
    ];
    const done = notification({ taskIds: ['bsleep001'], status: 'completed' });
    expect(deriveHistoryTasks([...start, msg('p1', 'user', `Please explain this: ${done}`, { at: 3 })])[0]?.status).toBe('running');
    expect(deriveHistoryTasks([...start, msg('p2', 'user', [{ type: 'text', text: `\n${done}` }], { at: 3 })])[0]?.status).toBe(
      'completed',
    );
  });

  it('orders events by timestamp when every event has one, since subagent messages come after the main thread', () => {
    const messages = [
      call('toolu_agent', 'Agent', { description: 'Job', run_in_background: true }, 1),
      reply('toolu_agent', AGENT_LAUNCHED('ajob000001'), 2),
      call('toolu_send', 'SendMessage', { to: 'ajob000001' }, 30),
      reply('toolu_send', '{"success":true,"resumedAgentId":"ajob000001"}', 31),
      notify('n-sub', notification({ taskIds: ['ajob000001'], status: 'failed' }), 10, 'toolu_other'),
    ];
    expect(deriveHistoryTasks(messages)[0]?.status).toBe('running');
  });

  it('leaves start and end times unset when the messages carry no timestamps', () => {
    const plain = (m: SessionMessage) => {
      const copy = { ...m } as Record<string, unknown>;
      delete copy.timestamp;
      return copy as unknown as SessionMessage;
    };
    const tasks = deriveHistoryTasks(
      [
        call('toolu_bg', 'Bash', { command: 'serve', run_in_background: true }, 1),
        reply('toolu_bg', 'Command running in background with ID: bserve001. Output is being written to: x', 2),
        notify('n1', notification({ taskIds: ['bserve001'], status: 'failed' }), 3),
      ].map(plain),
    );
    expect(tasks).toEqual([
      { taskId: 'bserve001', kind: 'shell', taskType: 'local_bash', description: 'serve', status: 'failed', toolUseId: 'toolu_bg' },
    ]);
  });
});

describe('parseTaskNotifications', () => {
  it('reads ids, status, summary and usage of every block', () => {
    const text = `${notification({ taskIds: ['w1'], toolUseId: 'toolu_w', status: 'Completed', summary: 'Workflow done', extra: '<usage><agent_count>4</agent_count><subagent_tokens>99</subagent_tokens><tool_uses>7</tool_uses><duration_ms>1234</duration_ms></usage>' })}\n${notification({ taskIds: ['m1'], extra: '<event>line 3</event>' })}`;
    expect(parseTaskNotifications(text)).toEqual([
      { taskIds: ['w1'], toolUseId: 'toolu_w', status: 'completed', summary: 'Workflow done', durationMs: 1234, totalTokens: 99, toolUses: 7 },
      { taskIds: ['m1'] },
    ]);
  });
});
