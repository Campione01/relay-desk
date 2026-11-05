import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackgroundTasks, MAX_WORKFLOW_AGENTS, isTaskMessage, parseWorkflowProgress, taskKind, type TaskMessage } from '../../src/main/engine/tasks';

const msg = (subtype: string, extra: Record<string, unknown>): TaskMessage =>
  ({ type: 'system', subtype, uuid: `u-${subtype}`, session_id: 's', ...extra }) as unknown as TaskMessage;

const started = (taskId: string, extra: Record<string, unknown> = {}) =>
  msg('task_started', { task_id: taskId, description: `task ${taskId}`, ...extra });

describe('taskKind', () => {
  it('maps SDK task types to card kinds', () => {
    expect(taskKind('local_bash')).toBe('shell');
    expect(taskKind('local_agent')).toBe('agent');
    expect(taskKind('local_workflow')).toBe('workflow');
    expect(taskKind('monitor_mcp')).toBe('monitor');
    expect(taskKind('monitor_ws')).toBe('monitor');
    expect(taskKind('mcp_task')).toBe('other');
    expect(taskKind(undefined)).toBe('other');
  });

  it('recognises only the task system messages', () => {
    expect(isTaskMessage({ type: 'system', subtype: 'task_progress' })).toBe(true);
    expect(isTaskMessage({ type: 'system', subtype: 'background_tasks_changed' })).toBe(true);
    expect(isTaskMessage({ type: 'system', subtype: 'init' })).toBe(false);
    expect(isTaskMessage({ type: 'user', subtype: 'task_started' })).toBe(false);
  });
});

describe('BackgroundTasks', () => {
  it('follows a shell from start through progress to completion with timing and usage', () => {
    const tasks = new BackgroundTasks();
    expect(tasks.apply(started('b1', { task_type: 'local_bash', tool_use_id: 'tu1', is_backgrounded: true }), 1_000)).toBe(true);
    expect(tasks.list()).toEqual([
      { taskId: 'b1', kind: 'shell', taskType: 'local_bash', description: 'task b1', status: 'running', startedAt: 1_000, toolUseId: 'tu1' },
    ]);
    expect(
      tasks.apply(
        msg('task_progress', {
          task_id: 'b1',
          description: 'npm test',
          usage: { total_tokens: 12, tool_uses: 3, duration_ms: 4_000 },
          last_tool_name: 'Bash',
          summary: 'running tests',
        }),
        5_000,
      ),
    ).toBe(true);
    expect(tasks.list()[0]).toMatchObject({ description: 'npm test', durationMs: 4_000, totalTokens: 12, toolUses: 3, lastTool: 'Bash', summary: 'running tests', status: 'running' });
    expect(tasks.apply(msg('task_updated', { task_id: 'b1', patch: { status: 'completed', end_time: 6_500 } }), 7_000)).toBe(true);
    expect(tasks.list()[0]).toMatchObject({ status: 'completed', startedAt: 1_000, endedAt: 6_500 });
    expect(
      tasks.apply(
        msg('task_notification', { task_id: 'b1', status: 'completed', summary: 'All green', output_file: 'x', usage: { total_tokens: 20, tool_uses: 4, duration_ms: 5_500 } }),
        8_000,
      ),
    ).toBe(true);
    expect(tasks.list()[0]).toMatchObject({ status: 'completed', endedAt: 6_500, summary: 'All green', durationMs: 5_500, totalTokens: 20, toolUses: 4 });
    expect(tasks.apply(msg('task_notification', { task_id: 'b1', status: 'completed', summary: 'All green', output_file: 'x', usage: { total_tokens: 20, tool_uses: 4, duration_ms: 5_500 } }), 9_000)).toBe(false);
  });

  it('maps killed to stopped, stamps the end time when the patch has none and reopens on running', () => {
    const tasks = new BackgroundTasks();
    tasks.apply(started('a1', { task_type: 'local_agent', subagent_type: 'general-purpose', is_backgrounded: true }), 10);
    tasks.apply(msg('task_updated', { task_id: 'a1', patch: { status: 'killed' } }), 50);
    expect(tasks.list()[0]).toMatchObject({ kind: 'agent', subagentType: 'general-purpose', status: 'stopped', endedAt: 50 });
    tasks.apply(msg('task_updated', { task_id: 'a1', patch: { status: 'paused' } }), 60);
    expect(tasks.list()[0]?.status).toBe('paused');
    expect(tasks.list()[0]).not.toHaveProperty('endedAt');
    tasks.apply(msg('task_updated', { task_id: 'a1', patch: { status: 'failed', error: 'boom' } }), 70);
    expect(tasks.list()[0]).toMatchObject({ status: 'failed', endedAt: 70, summary: 'boom' });
  });

  it('skips ambient, skip_transcript and foreground tasks, including their later frames', () => {
    const tasks = new BackgroundTasks();
    expect(tasks.apply(started('amb', { ambient: true, task_type: 'monitor_ws' }), 1)).toBe(false);
    expect(tasks.apply(started('hk', { skip_transcript: true }), 1)).toBe(false);
    expect(tasks.apply(msg('task_progress', { task_id: 'amb', description: 'x', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }), 2)).toBe(false);
    expect(tasks.apply(msg('task_notification', { task_id: 'hk', status: 'completed', summary: 'done', output_file: '' }), 3)).toBe(false);
    expect(tasks.apply(started('fg', { task_type: 'local_agent', is_backgrounded: false }), 4)).toBe(false);
    expect(tasks.list()).toEqual([]);
    expect(tasks.apply(msg('task_updated', { task_id: 'fg', patch: { is_backgrounded: true } }), 5)).toBe(true);
    expect(tasks.list()).toEqual([expect.objectContaining({ taskId: 'fg', kind: 'agent', startedAt: 4 })]);
    tasks.apply(started('amb2', { task_type: 'local_bash' }), 6);
    tasks.apply(msg('task_notification', { task_id: 'amb2', status: 'completed', summary: 'x', output_file: '', ambient: true }), 7);
    expect(tasks.list().map((t) => t.taskId)).toEqual(['fg']);
  });

  it('replaces the live set on background_tasks_changed but keeps finished tasks, in start order', () => {
    const tasks = new BackgroundTasks();
    tasks.apply(started('w1', { task_type: 'local_workflow', run_id: 'r1' }), 100);
    tasks.apply(started('b2', { task_type: 'local_bash', run_id: 'r1' }), 200);
    tasks.apply(msg('task_notification', { task_id: 'w1', status: 'failed', summary: 'Workflow failed', output_file: '' }), 300);
    const changed = msg('background_tasks_changed', {
      tasks: [
        { task_id: 'b2', run_id: 'r1', task_type: 'local_bash', description: 'other text' },
        { task_id: 'm3', task_type: 'monitor_mcp', description: 'watch logs', parent_task_id: 'w1' },
        { task_id: 'amb', task_type: 'local_bash', description: 'hidden', ambient: true },
      ],
    });
    expect(tasks.apply(changed, 400)).toBe(true);
    expect(tasks.list().map((t) => [t.taskId, t.kind, t.status, t.description])).toEqual([
      ['w1', 'workflow', 'failed', 'task w1'],
      ['b2', 'shell', 'running', 'task b2'],
      ['m3', 'monitor', 'running', 'watch logs'],
    ]);
    expect(tasks.list()[2]).toMatchObject({ startedAt: 400, parentTaskId: 'w1', taskType: 'monitor_mcp' });

    expect(tasks.apply(msg('background_tasks_changed', { tasks: [{ task_id: 'm3', task_type: 'monitor_mcp', description: 'watch logs' }] }), 500)).toBe(true);
    expect(tasks.list().find((t) => t.taskId === 'b2')).toMatchObject({ status: 'unknown', endedAt: 500 });
    tasks.apply(msg('task_notification', { task_id: 'b2', status: 'completed', summary: 'ok', output_file: '' }), 600);
    expect(tasks.list().find((t) => t.taskId === 'b2')).toMatchObject({ status: 'completed', endedAt: 500 });
    expect(tasks.list().map((t) => t.taskId)).toEqual(['w1', 'b2', 'm3']);
  });

  it('ignores frames of an older run and restarts the clock for a newer run', () => {
    const tasks = new BackgroundTasks();
    tasks.apply(started('a1', { task_type: 'local_agent', run_id: 'run-2' }), 100);
    expect(tasks.apply(msg('task_updated', { task_id: 'a1', run_id: 'run-1', patch: { status: 'completed' } }), 150)).toBe(false);
    tasks.apply(msg('task_notification', { task_id: 'a1', run_id: 'run-2', status: 'completed', summary: 'done', output_file: '' }), 200);
    tasks.apply(started('a1', { task_type: 'local_agent', run_id: 'run-3' }), 300);
    expect(tasks.list()).toEqual([{ taskId: 'a1', kind: 'agent', taskType: 'local_agent', description: 'task a1', status: 'running', startedAt: 300 }]);
  });
});

describe('workflows and task output (desktop tasks pane)', () => {
  const phase = (index: number, title: string) => ({ type: 'workflow_phase', index, title, kind: 'phase' });
  const agent = (index: number, extra: Record<string, unknown>) => ({ type: 'workflow_agent', index, label: `agent ${index}`, lastProgressAt: 1, ...extra });

  it('reads phases and the latest state of each agent from workflow_progress', () => {
    const progress = parseWorkflowProgress([
      phase(1, 'Discover'),
      phase(2, ' Audit '),
      agent(1, { phaseIndex: 1, state: 'done', agentId: 'a1', tokens: 100, toolCalls: 2 }),
      agent(2, { phaseIndex: 2, state: 'progress', startedAt: 5, lastToolName: 'Read' }),
      agent(3, { phaseIndex: 2, state: 'start', queuedAt: 6 }),
      agent(4, { phaseIndex: 2, state: 'error', error: 'boom' }),
      agent(5, { phaseIndex: 3, phaseTitle: 'Verify', state: 'start', startedAt: 7 }),
      { type: 'workflow_log', index: 9, message: 'hidden' },
      'junk',
      { type: 'workflow_agent', label: 'no index' },
    ]);
    expect(progress?.phases).toEqual([
      { index: 1, title: 'Discover', agents: 1, done: 1, failed: 0, running: 0 },
      { index: 2, title: 'Audit', agents: 3, done: 0, failed: 1, running: 1 },
      { index: 3, title: 'Verify', agents: 1, done: 0, failed: 0, running: 1 },
    ]);
    expect(progress?.agents.map((a) => [a.index, a.state])).toEqual([
      [1, 'done'],
      [2, 'running'],
      [3, 'queued'],
      [4, 'failed'],
      [5, 'running'],
    ]);
    expect(progress?.agents[0]).toEqual({ index: 1, label: 'agent 1', phaseIndex: 1, state: 'done', agentId: 'a1', tokens: 100, toolCalls: 2 });
    expect(progress?.agents[1]).toMatchObject({ lastTool: 'Read' });
    expect(parseWorkflowProgress(undefined)).toBeUndefined();
    expect(parseWorkflowProgress({})).toBeUndefined();
  });

  it('keeps the newest agents when a run has more than the cap, while the phase counts cover all of them', () => {
    const entries = [phase(1, 'Fan out'), ...Array.from({ length: MAX_WORKFLOW_AGENTS + 5 }, (_, i) => agent(i + 1, { phaseIndex: 1, state: 'done' }))];
    const progress = parseWorkflowProgress(entries)!;
    expect(progress.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(progress.agents[0]!.index).toBe(6);
    expect(progress.phases[0]).toMatchObject({ agents: MAX_WORKFLOW_AGENTS + 5, done: MAX_WORKFLOW_AGENTS + 5 });
  });

  it('names a workflow, keeps its own description while agents report, and stores its progress', () => {
    const tasks = new BackgroundTasks();
    tasks.apply(started('w1', { task_type: 'local_workflow', workflow_name: 'audit-routes', description: 'Audit every route' }), 100);
    tasks.apply(
      msg('task_progress', {
        task_id: 'w1',
        description: 'Audit: src/routes/users.ts',
        usage: { total_tokens: 900, tool_uses: 7, duration_ms: 2_000 },
        last_tool_name: 'src/routes/users.ts',
        workflow_progress: [phase(1, 'Audit'), agent(1, { phaseIndex: 1, state: 'progress', startedAt: 1 })],
      }),
      200,
    );
    const [workflow] = tasks.list();
    expect(workflow).toMatchObject({ kind: 'workflow', workflowName: 'audit-routes', description: 'Audit every route', totalTokens: 900 });
    expect(workflow?.workflow?.phases).toEqual([{ index: 1, title: 'Audit', agents: 1, done: 0, failed: 0, running: 1 }]);
    // A frame without workflow_progress (throttled by the CLI) keeps the last one.
    tasks.apply(msg('task_progress', { task_id: 'w1', description: 'Audit: x', usage: { total_tokens: 950, tool_uses: 8, duration_ms: 2_500 } }), 300);
    expect(tasks.list()[0]?.workflow?.agents).toHaveLength(1);
    // Other kinds still take the progress description.
    tasks.apply(started('b1', { task_type: 'local_bash', description: 'old' }), 100);
    tasks.apply(msg('task_progress', { task_id: 'b1', description: 'npm test', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 } }), 200);
    expect(tasks.list().find((t) => t.taskId === 'b1')?.description).toBe('npm test');
  });

  it('remembers the output file of a notification for engine.taskOutput, without sending the path to the renderer', () => {
    const tasks = new BackgroundTasks();
    tasks.apply(started('b1', { task_type: 'local_bash' }), 100);
    expect(tasks.outputFile('b1')).toBeUndefined();
    tasks.apply(msg('task_notification', { task_id: 'b1', status: 'completed', summary: 'ok', output_file: 'C:\Temp\claude\tasks\b1.output' }), 200);
    expect(tasks.outputFile('b1')).toBe('C:\Temp\claude\tasks\b1.output');
    expect(tasks.list()[0]).toMatchObject({ hasOutput: true });
    expect(JSON.stringify(tasks.list())).not.toContain('b1.output');
    // A new run forgets the old file.
    tasks.apply(started('b1', { task_type: 'local_bash', run_id: 'r2' }), 300);
    tasks.apply(started('b1', { task_type: 'local_bash', run_id: 'r3' }), 400);
    expect(tasks.outputFile('b1')).toBeUndefined();
    expect(tasks.list()[0]?.hasOutput).toBeUndefined();
    // Foreground tasks are not listed, so their files are not served either.
    tasks.apply(started('f1', { task_type: 'local_bash', is_backgrounded: false }), 500);
    tasks.apply(msg('task_notification', { task_id: 'f1', status: 'completed', summary: 'ok', output_file: 'C:\f1.output' }), 600);
    expect(tasks.outputFile('f1')).toBeUndefined();
  });
});

describe('real CLI 2.1.302 task messages (probe: one background command, one background subagent)', () => {
  it('lists both while they run and keeps them, completed, after the live set empties', () => {
    const messages = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'tasks-cli-2.1.302.json'), 'utf8')) as TaskMessage[];
    const tasks = new BackgroundTasks();
    let now = 1_000;
    const seen: string[][] = [];
    for (const message of messages) {
      expect(isTaskMessage(message)).toBe(true);
      tasks.apply(message, (now += 100));
      seen.push(tasks.list().map((t) => `${t.kind}:${t.status}`));
    }
    expect(seen[3]).toEqual(['shell:running', 'agent:running']);
    expect(tasks.list().map((t) => [t.kind, t.status, t.description, Boolean(t.hasOutput)])).toEqual([
      ['shell', 'completed', 'Ping localhost in background', true],
      ['agent', 'completed', 'Reply done', true],
    ]);
    expect(tasks.list()[1]).toMatchObject({ subagentType: 'general-purpose', taskType: 'local_agent' });
  });
});

describe('real CLI 2.1.302 workflow messages (probe: a two-phase workflow of two Haiku agents)', () => {
  const messages = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'workflow-cli-2.1.302.json'), 'utf8')) as TaskMessage[];

  it('tracks the run by its script name, phases and agents, and keeps the progress between snapshots', () => {
    const tasks = new BackgroundTasks();
    let now = 1_000;
    const seen: string[] = [];
    for (const message of messages) {
      expect(isTaskMessage(message)).toBe(true);
      tasks.apply(message, (now += 100));
      const [task] = tasks.list();
      const agents = task?.workflow?.agents.map((a) => `${a.label}:${a.state}`).join(',') ?? '-';
      seen.push(task ? `${task.status}|${agents}` : 'none');
    }
    // The first snapshot: agent "first" runs; plain progress messages in between keep it.
    expect(seen[2]).toBe('running|first:running');
    expect(seen[3]).toBe('running|first:running');
    expect(seen[7]).toBe('running|first:done,second:running');
    const [task] = tasks.list();
    expect(task).toMatchObject({
      kind: 'workflow',
      taskType: 'local_workflow',
      status: 'completed',
      description: 'Two tiny agents in two phases',
      workflowName: 'relay-probe',
      hasOutput: true,
    });
    expect(task?.workflow?.phases).toEqual([
      { index: 1, title: 'Ask', agents: 1, done: 1, failed: 0, running: 0 },
      { index: 2, title: 'Check', agents: 1, done: 1, failed: 0, running: 0 },
    ]);
    expect(task?.workflow?.agents.map((a) => [a.label, a.phaseIndex, a.state, a.agentId, a.lastTool])).toEqual([
      ['first', 1, 'done', 'a0000000000000001', 'ToolSearch'],
      ['second', 2, 'done', 'a0000000000000002', 'ToolSearch'],
    ]);
  });
});
