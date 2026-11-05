import { win32 } from 'node:path';
import type { BackgroundTask, BackgroundTaskKind, WorkflowAgent, WorkflowProgress } from '@shared/types';
import { redactSecrets } from '../engine/redaction';
import { parseTaskNotifications } from '../engine/historyTasks';
import { parseWorkflowProgress } from '../engine/tasks';
import type { NativeEvent } from './contract';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const localPath = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\u0000-\u001f]/.test(value) ? value : undefined;
const xmlText = (value: string) => value.replace(/&(lt|gt|amp|quot|apos);/g, (_match, entity: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[entity]!);
const terminal = (status: BackgroundTask['status']) => ['completed', 'failed', 'stopped'].includes(status);
const statusOf = (value: unknown): BackgroundTask['status'] => {
  switch (value) {
    case 'pending': case 'running': case 'paused': case 'completed': case 'failed': case 'stopped': return value;
    case 'killed': return 'stopped';
    default: return 'unknown';
  }
};
const kindOf = (value: unknown): BackgroundTaskKind => {
  switch (value) {
    case 'shell': case 'local_bash': return 'shell';
    case 'subagent': case 'local_agent': return 'agent';
    case 'workflow': case 'local_workflow': return 'workflow';
    case 'monitor': case 'monitor_mcp': case 'monitor_ws': return 'monitor';
    default: return 'other';
  }
};

export interface NativeWorkflowRunObservation {
  runId: string;
  toolUseId?: string;
  taskId?: string;
  observedAgents: WorkflowAgent[];
  cachedAgentIndices?: number[];
  coverage: { phases: 'unobserved' | 'native-metadata'; agents: 'observed-only' | 'native-metadata'; journalReplay: 'not-covered' | 'native-journal-matched' };
}
export interface NativeWorkflowSource {
  runId: string;
  toolUseId?: string;
  taskId?: string;
  transcriptDir?: string;
  scriptPath?: string;
  metadataPath?: string;
  journalPath?: string;
}

interface WorkflowRun {
  runId: string;
  toolUseId?: string;
  taskId?: string;
  transcriptDir?: string;
  scriptPath?: string;
  observedLaunch?: boolean;
  progress?: WorkflowProgress;
  metadataAt?: number;
  cachedAgentIndices?: number[];
  journalAgentIds?: Set<string>;
  agents: Map<number, { index: number; label: string; agentId: string }>;
}
interface TrackedTask {
  task: BackgroundTask;
  run?: WorkflowRun;
  requiresNoticeIdentity?: boolean;
}
interface AgentFacts {
  turns: Map<string, { state: WorkflowAgent['state']; tokens?: number }>;
  state: WorkflowAgent['state'];
  tools: Set<string>;
  lastTool?: string;
}

/**
 * Read-only projection of native observations, not a workflow engine or native journal reader.
 * tool.call/agent.spawn carry { input, result }; task.notification carries UserMessage.props.task.
 */
export class NativeWorkflowState {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly agents = new Map<string, AgentFacts>();
  private readonly outputPaths = new Map<string, string>();
  private readonly appended = new Set<string>();
  private readonly settledTools = new Set<string>();
  private readonly stopTargets = new Map<string, string | undefined>();
  private lastSequence = -1;

  constructor(private readonly sessionId: string) {
    if (!sessionId) throw new Error('A native session identity is required.');
  }

  /** Ordered bridge events can be replayed into a fresh instance; this never executes a native operation. */
  observe(event: NativeEvent): boolean {
    if (event.sessionId !== this.sessionId || !count(event.sequence) || event.sequence <= this.lastSequence) return false;
    this.lastSequence = event.sequence;
    if (!record(event.data)) return false;
    const data = event.data;
    switch (event.event) {
      case 'tool.call': return this.tool(data);
      case 'agent.spawn': return this.spawn(data);
      case 'turn.start': {
        const agentId = text(data.agentId), turnId = text(data.turnId);
        if (!agentId || !turnId) return false;
        const facts = this.facts(agentId);
        if (facts.turns.has(turnId)) return false;
        facts.state = 'running';
        return true;
      }
      case 'turn.complete': return this.complete(data);
      case 'task.notification': return this.notification(data);
      case 'task.append': return this.append(data);
      case 'classic.Stop': return this.background(data);
      default: return false;
    }
  }

  /** Native summary rows retain typed tool results; API-shaped messages and unmarked user text do not. */
  rehydrate(messages: unknown): boolean {
    if (!Array.isArray(messages)) throw new Error('Native task history returned no message list.');
    const history = new NativeWorkflowState(this.sessionId);
    const uses = new Map<string, Record<string, unknown>>();
    for (const row of messages) {
      if (!record(row)) continue;
      if (row.role === 'assistant' && Array.isArray(row.toolUses)) {
        for (const use of row.toolUses) {
          if (!record(use) || !text(use.tool_use_id) || !text(use.tool) || !record(use.input)) continue;
          const input = { ...use.input, tool: use.tool, tool_use_id: use.tool_use_id };
          uses.set(use.tool_use_id as string, input);
          if (use.result !== undefined) history.tool({ input, result: { result: use.result, isError: use.isError } });
          if (use.tool === 'Agent' && text(use.agentId) && (!record(use.result) || !text(use.result.agentId))) {
            history.backgroundLaunch(use.agentId as string, use.tool_use_id as string, { kind: 'agent', taskType: 'local_agent',
              description: redactSecrets(text(use.input.description) ?? 'Agent'),
              status: use.isError === true ? 'failed' : count(use.durationMs) ? 'completed' : 'unknown',
              ...(count(use.durationMs) ? { durationMs: use.durationMs } : {}),
            });
          }
        }
      }
      if (row.role === 'user' && Array.isArray(row.toolResults)) {
        for (const result of row.toolResults) {
          if (!record(result) || !text(result.tool_use_id) || result.result === undefined) continue;
          const input = uses.get(result.tool_use_id as string);
          if (input) history.tool({ input, result: { result: result.result, isError: result.isError } });
        }
      }
    }
    let changed = false;
    for (const entry of history.tasks.values()) {
      // An old async launch is not proof that its process survived CLI resume.
      if (!terminal(entry.task.status)) entry.task.status = 'unknown';
      let run: WorkflowRun | undefined;
      if (entry.run) {
        run = this.run(entry.run.runId, entry.run.toolUseId);
        run.taskId ??= entry.run.taskId;
        run.transcriptDir ??= entry.run.transcriptDir;
        run.scriptPath ??= entry.run.scriptPath;
      }
      const prior = this.tasks.get(entry.task.taskId);
      if (!prior) { this.tasks.set(entry.task.taskId, { ...entry, ...(run ? { run } : {}) }); if (run) run.observedLaunch = true; changed = true; }
      else if (!prior.task.toolUseId || prior.task.toolUseId === entry.task.toolUseId) {
        const before = JSON.stringify(prior.task);
        prior.task = { ...entry.task, ...prior.task,
          ...(prior.task.kind === 'other' ? { kind: entry.task.kind, description: entry.task.description } : {}),
        };
        prior.run ??= run;
        if (run) run.observedLaunch = true;
        changed = JSON.stringify(prior.task) !== before || changed;
      }
      const current = this.tasks.get(entry.task.taskId)!;
      const output = history.outputPaths.get(entry.task.taskId);
      if (output && current.task.toolUseId === entry.task.toolUseId && !this.outputPaths.has(entry.task.taskId)) {
        this.outputPaths.set(entry.task.taskId, output); current.task.hasOutput = true; changed = true;
      }
    }
    for (const [id, target] of history.stopTargets) if (!this.stopTargets.has(id)) this.stopTargets.set(id, target);
    return changed;
  }

  /** Main-only native bindings. Reading still belongs to the caller's session/profile path boundary. */
  outputPath(taskId: string): string | undefined { return this.outputPaths.get(taskId); }
  workflowSources(): NativeWorkflowSource[] {
    return [...this.runs.values()].map(({ runId, toolUseId, taskId, transcriptDir, scriptPath }) => ({ runId,
      ...(toolUseId ? { toolUseId } : {}), ...(taskId ? { taskId } : {}),
      ...(transcriptDir ? { transcriptDir } : {}), ...(scriptPath ? { scriptPath } : {}),
      ...this.workflowPaths(runId, transcriptDir),
    }));
  }

  /** The captured native metadata owns phase/agent indices, including cached calls with no spawn event. */
  ingestMetadata(source: NativeWorkflowSource, value: unknown): boolean {
    const run = this.boundRun(source), current = source.taskId ? this.tasks.get(source.taskId) : undefined;
    if (!run || !current || current.run !== run || current.requiresNoticeIdentity || !record(value) ||
      value.runId !== source.runId || value.taskId !== source.taskId || !Array.isArray(value.workflowProgress)) return false;
    if (run.scriptPath && (typeof value.scriptPath !== 'string' || win32.normalize(value.scriptPath).toLowerCase() !== win32.normalize(run.scriptPath).toLowerCase())) return false;
    const timestamp = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp < (run.metadataAt ?? -Infinity)) return false;
    for (const entry of value.workflowProgress) {
      if (!record(entry) || !['workflow_phase', 'workflow_agent'].includes(String(entry.type))) continue;
      if (!count(entry.index) || entry.index < 1 || entry.type === 'workflow_agent' && entry.phaseIndex !== undefined && (!count(entry.phaseIndex) || entry.phaseIndex < 1)) return false;
    }
    const progress = parseWorkflowProgress(value.workflowProgress);
    if (!progress) return false;
    for (const phase of progress.phases) phase.title = redactSecrets(phase.title);
    const before = JSON.stringify({ task: current.task, progress: run.progress, cached: run.cachedAgentIndices });
    run.progress = progress; run.metadataAt = timestamp;
    run.cachedAgentIndices = value.workflowProgress.filter(record).filter((entry) => entry.type === 'workflow_agent' && entry.cached === true && count(entry.index)).map((entry) => entry.index as number);
    if (!terminal(current.task.status)) current.task.status = statusOf(value.status);
    if (count(value.startTime)) current.task.startedAt = value.startTime;
    if (count(value.durationMs)) current.task.durationMs = value.durationMs;
    if (count(value.totalTokens)) current.task.totalTokens = value.totalTokens;
    if (count(value.totalToolCalls)) current.task.toolUses = value.totalToolCalls;
    if (text(value.summary)) current.task.summary = redactSecrets(value.summary as string);
    return before !== JSON.stringify({ task: current.task, progress: run.progress, cached: run.cachedAgentIndices });
  }

  /** Read-only corroboration of native cache records; never runs the journal or fabricates agent indices. */
  ingestJournal(source: NativeWorkflowSource, contents: string): boolean {
    const run = this.boundRun(source);
    if (!run || typeof contents !== 'string') return false;
    const started = new Map<string, string>(), completed = new Set<string>();
    try {
      for (const line of contents.split(/\r?\n/).filter((row) => row.trim())) {
        const row: unknown = JSON.parse(line);
        if (!record(row) || !text(row.key) || !text(row.agentId)) continue;
        if (row.type === 'started') started.set(row.key as string, row.agentId as string);
        else if (row.type === 'result' && 'result' in row && started.get(row.key as string) === row.agentId) completed.add(row.agentId as string);
      }
    } catch { return false; }
    const changed = JSON.stringify([...(run.journalAgentIds ?? [])].sort()) !== JSON.stringify([...completed].sort());
    run.journalAgentIds = completed;
    return changed;
  }

  workflowAgentPath(agentId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return;
    for (const run of this.runs.values()) if (run.progress?.agents.some((agent) => agent.agentId === agentId) &&
      this.workflowPaths(run.runId, run.transcriptDir).metadataPath && run.transcriptDir) {
      return win32.join(run.transcriptDir, `agent-${agentId}.jsonl`);
    }
  }

  private workflowPaths(runId: string, transcriptDir?: string): Pick<NativeWorkflowSource, 'metadataPath' | 'journalPath'> {
    if (!transcriptDir || !/^wf_[A-Za-z0-9_-]+$/.test(runId)) return {};
    const normalized = win32.normalize(transcriptDir), workflows = win32.dirname(normalized), subagents = win32.dirname(workflows), session = win32.dirname(subagents);
    if (win32.basename(normalized) !== runId || win32.basename(workflows) !== 'workflows' || win32.basename(subagents) !== 'subagents' ||
      win32.basename(session).toLowerCase() !== this.sessionId.toLowerCase()) return {};
    return { metadataPath: win32.join(session, 'workflows', `${runId}.json`), journalPath: win32.join(normalized, 'journal.jsonl') };
  }

  private boundRun(source: NativeWorkflowSource): WorkflowRun | undefined {
    const run = this.runs.get(JSON.stringify([source.runId, source.toolUseId ?? null]));
    if (!run || !run.taskId || run.taskId !== source.taskId) return;
    const paths = this.workflowPaths(run.runId, run.transcriptDir);
    if (!paths.metadataPath || source.metadataPath !== paths.metadataPath || source.journalPath !== paths.journalPath) return;
    return run;
  }

  snapshot(): { tasks: BackgroundTask[]; runs: NativeWorkflowRunObservation[] } {
    const observations = [...this.runs.values()].map((run): NativeWorkflowRunObservation => ({
      runId: run.runId,
      ...(run.toolUseId ? { toolUseId: run.toolUseId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
      observedAgents: run.progress ? run.progress.agents.map((agent) => ({ ...agent })) : this.observedAgents(run),
      ...(run.cachedAgentIndices?.length ? { cachedAgentIndices: [...run.cachedAgentIndices] } : {}),
      coverage: { phases: run.progress ? 'native-metadata' : 'unobserved', agents: run.progress ? 'native-metadata' : 'observed-only',
        journalReplay: run.cachedAgentIndices?.length && run.cachedAgentIndices.every((index) => {
          const id = run.progress?.agents.find((agent) => agent.index === index)?.agentId;
          return id !== undefined && run.journalAgentIds?.has(id);
        }) ? 'native-journal-matched' : 'not-covered' },
    }));
    return { tasks: [...this.tasks.values()].map(({ task, run }) => ({ ...task,
      ...(run ? { workflow: run.progress ? { phases: run.progress.phases.map((phase) => ({ ...phase })), agents: run.progress.agents.map((agent) => ({ ...agent })) }
        : { phases: [], agents: this.observedAgents(run) } } : {}),
    })), runs: observations };
  }

  /** agent.list omits workflows and expires finished agents; it must not replace observed background rows. */
  mergeTasks(currentAgents: readonly BackgroundTask[]): BackgroundTask[] {
    const merged = new Map(currentAgents.map((task) => [task.taskId, { ...task }]));
    for (const task of this.snapshot().tasks) {
      const current = merged.get(task.taskId);
      merged.set(task.taskId, { ...current, ...task,
        // A generic completion notification has no type/description; keep a real agent.list identity.
        ...(current && task.kind === 'other' ? { kind: current.kind, description: current.description } : {}),
        ...(current && task.status === 'unknown' ? { status: current.status } : {}),
      });
    }
    return [...merged.values()];
  }

  private run(runId: string, toolUseId?: string): WorkflowRun {
    // agentIndex restarts on resume even though runId does not; tool_use_id names this invocation.
    const key = JSON.stringify([runId, toolUseId ?? null]);
    let run = this.runs.get(key);
    if (!run) { run = { runId, ...(toolUseId ? { toolUseId } : {}), agents: new Map() }; this.runs.set(key, run); }
    return run;
  }

  private facts(agentId: string): AgentFacts {
    let facts = this.agents.get(agentId);
    if (!facts) { facts = { turns: new Map(), state: 'running', tools: new Set() }; this.agents.set(agentId, facts); }
    return facts;
  }

  private tool(data: Record<string, unknown>): boolean {
    if (!record(data.input) || !record(data.result) || text(data.result.deny)) return false;
    const input = data.input, envelope = data.result, toolUseId = text(input.tool_use_id);
    if (!toolUseId || !text(input.tool) || !('result' in envelope)) return false;
    let changed = false;
    if (text(input.agentId)) {
      const facts = this.facts(input.agentId as string);
      if (!facts.tools.has(toolUseId)) { facts.tools.add(toolUseId); facts.lastTool = redactSecrets(input.tool as string); changed = true; }
    }
    const result = envelope.result;
    if (envelope.isError === true || !record(result)) return changed;
    if (input.tool === 'TaskStop') {
      if (this.settledTools.has(toolUseId) || !text(result.task_id) || result.task_id !== input.task_id || !text(result.task_type) || !text(result.message)) return changed;
      this.settledTools.add(toolUseId);
      const taskId = result.task_id as string, prior = this.tasks.get(taskId);
      const target = this.stopTargets.get(toolUseId);
      if (target && prior?.task.toolUseId && target !== prior.task.toolUseId) return changed;
      this.stopTargets.set(toolUseId, prior?.task.toolUseId);
      const task = prior?.task ?? { taskId, kind: kindOf(result.task_type), taskType: result.task_type as string,
        description: redactSecrets(text(result.command) ?? taskId), status: 'unknown' as const };
      task.status = 'stopped';
      this.tasks.set(taskId, { ...prior, task });
      return true;
    }
    if (input.tool === 'Bash' && text(result.backgroundTaskId)) {
      return this.backgroundLaunch(result.backgroundTaskId as string, toolUseId, { kind: 'shell', taskType: 'local_bash',
        description: redactSecrets(text(input.description) ?? text(input.command) ?? 'Bash'), status: 'running',
      }, localPath(result.rawOutputPath) ?? localPath(result.persistedOutputPath));
    }
    if (input.tool === 'Monitor' && text(result.taskId) && count(result.timeoutMs)) {
      return this.backgroundLaunch(result.taskId as string, toolUseId, { kind: 'monitor',
        description: redactSecrets(text(input.description) ?? 'Monitor'), status: 'running' });
    }
    if (input.tool === 'Agent' && text(result.agentId) && ['async_launched', 'completed'].includes(String(result.status))) {
      return this.backgroundLaunch(result.agentId as string, toolUseId, { kind: 'agent', taskType: 'local_agent',
        description: redactSecrets(text(input.description) ?? text(result.description) ?? 'Agent'), status: result.status === 'completed' ? 'completed' : 'running',
        ...(text(input.subagent_type) ? { subagentType: input.subagent_type as string } : {}),
        ...(count(result.totalDurationMs) ? { durationMs: result.totalDurationMs } : {}),
        ...(count(result.totalTokens) ? { totalTokens: result.totalTokens } : {}),
        ...(count(result.totalToolUseCount) ? { toolUses: result.totalToolUseCount } : {}),
      }, localPath(result.outputFile));
    }
    if (input.tool !== 'Workflow' || result.status !== 'async_launched' ||
      result.taskType !== 'local_workflow' || !text(result.taskId) || !text(result.runId)) return changed;
    const taskId = result.taskId as string, run = this.run(result.runId as string, toolUseId), prior = this.tasks.get(taskId);
    if (run.taskId && run.taskId !== taskId) return changed;
    // A repeated result must neither revive a finished task nor replace a newer resumed invocation.
    if (run.observedLaunch && prior?.run && prior.run !== run) return changed;
    run.taskId = taskId;
    run.observedLaunch = true;
    run.transcriptDir ??= localPath(result.transcriptDir);
    run.scriptPath ??= localPath(result.scriptPath);
    const sameInvocation = prior?.task.toolUseId === toolUseId || !prior?.task.toolUseId;
    if (!sameInvocation) this.outputPaths.delete(taskId);
    const workflowName = text(result.workflowName);
    this.tasks.set(taskId, { run,
      requiresNoticeIdentity: prior?.requiresNoticeIdentity || Boolean(prior?.run && prior.run !== run),
      task: { ...(sameInvocation ? prior?.task : undefined), taskId, kind: 'workflow', taskType: 'local_workflow',
        description: redactSecrets(workflowName ?? text(result.summary) ?? taskId),
        status: sameInvocation && prior?.task.status !== 'unknown' ? prior?.task.status ?? 'running' : 'running', toolUseId,
        ...(workflowName ? { workflowName: redactSecrets(workflowName) } : {}),
      },
    });
    return true;
  }

  private backgroundLaunch(taskId: string, toolUseId: string, fields: Omit<BackgroundTask, 'taskId' | 'toolUseId'>, output?: string): boolean {
    if (this.settledTools.has(toolUseId)) return false;
    this.settledTools.add(toolUseId);
    const prior = this.tasks.get(taskId);
    const same = !prior?.task.toolUseId || prior.task.toolUseId === toolUseId;
    const task = { ...fields, ...(same ? prior?.task : undefined), taskId, toolUseId,
      kind: fields.kind, description: fields.description,
      status: same && prior && terminal(prior.task.status) ? prior.task.status : fields.status,
    };
    if (output) { this.outputPaths.set(taskId, output); task.hasOutput = true; }
    else if (!same) this.outputPaths.delete(taskId);
    this.tasks.set(taskId, { task, requiresNoticeIdentity: prior?.requiresNoticeIdentity || Boolean(prior && !same) });
    return true;
  }

  private spawn(data: Record<string, unknown>): boolean {
    if (!record(data.input) || !record(data.result) || text(data.result.deny)) return false;
    const input = data.input, agentId = text(data.result.agentId);
    if (!record(input.workflow)) {
      const task = agentId ? this.tasks.get(agentId)?.task : undefined;
      if (!task || task.kind !== 'agent' || !record(input.resume) || input.resume.agentId !== agentId ||
        !text(input.tool_use_id) || task.toolUseId === input.tool_use_id) return false;
      task.status = 'running'; task.toolUseId = input.tool_use_id as string;
      if (text(input.description)) task.description = redactSecrets(input.description as string);
      for (const field of ['endedAt', 'durationMs', 'totalTokens', 'toolUses', 'lastTool', 'hasOutput'] as const) delete task[field];
      this.outputPaths.delete(agentId!);
      return true;
    }
    const workflow = input.workflow;
    if (!agentId || !text(workflow.runId) || !count(workflow.agentIndex) || workflow.agentIndex < 1) return false;
    const run = this.run(workflow.runId as string, text(input.tool_use_id));
    if (run.agents.get(workflow.agentIndex)?.agentId === agentId) return false;
    run.agents.set(workflow.agentIndex, { index: workflow.agentIndex,
      label: redactSecrets(text(input.description) ?? `Agent ${workflow.agentIndex}`), agentId });
    this.facts(agentId);
    return true;
  }

  private complete(data: Record<string, unknown>): boolean {
    const agentId = text(data.agentId), turnId = text(data.turnId);
    if (!agentId || !turnId || !['answer', 'aborted', 'refusal', 'error'].includes(String(data.reason))) return false;
    const facts = this.facts(agentId);
    if (facts.turns.has(turnId)) return false;
    const state = data.reason === 'answer' ? 'done' : 'failed';
    const usage = record(data.usage) ? data.usage : {};
    const counts = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map((key) => usage[key]);
    const tokens = count(usage.input_tokens) && count(usage.output_tokens) && counts.every((value) => value === undefined || count(value))
      ? counts.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0) : undefined;
    facts.turns.set(turnId, { state, ...(count(tokens) ? { tokens } : {}) });
    facts.state = state;
    return true;
  }

  private notification(data: Record<string, unknown>): boolean {
    const status = statusOf(data.status), toolUseId = text(data.toolUseId);
    if (!terminal(status)) return false;
    const taskId = text(data.id) ?? (toolUseId ? [...this.tasks.values()].find(({ task }) => task.toolUseId === toolUseId)?.task.taskId : undefined);
    if (!taskId) return false;
    const prior = this.tasks.get(taskId);
    if (prior?.task.toolUseId && toolUseId && prior.task.toolUseId !== toolUseId || prior?.requiresNoticeIdentity && !toolUseId) return false;
    const task = prior?.task ?? { taskId, kind: kindOf(data.type), description: taskId, status: 'unknown' as const };
    task.status = status;
    if (toolUseId) task.toolUseId = toolUseId;
    if (count(data.durationMs)) task.durationMs = data.durationMs;
    this.tasks.set(taskId, { ...prior, task });
    return true;
  }

  private append(data: Record<string, unknown>): boolean {
    if (!record(data.origin) || data.origin.kind !== 'task-notification' || !record(data.message) || !text(data.uuid) ||
      data.agentId !== undefined || data.message.type !== 'user' || !Array.isArray(data.message.content)) return false;
    if (this.appended.has(data.uuid as string)) return false;
    this.appended.add(data.uuid as string);
    const body = data.message.content.filter(record).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
    let changed = false;
    for (const block of body.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const notices = parseTaskNotifications(block[0]);
      for (const notice of notices) {
        const ids = notice.taskIds.length ? notice.taskIds : [...this.tasks.values()].filter(({ task }) => task.toolUseId === notice.toolUseId).map(({ task }) => task.taskId);
        for (const id of ids) {
          if (!this.notification({ id, status: notice.status, toolUseId: notice.toolUseId, durationMs: notice.durationMs })) continue;
          const task = this.tasks.get(id)!.task;
          if (notice.summary) task.summary = redactSecrets(notice.summary);
          if (count(notice.totalTokens)) task.totalTokens = notice.totalTokens;
          if (count(notice.toolUses)) task.toolUses = notice.toolUses;
          const path = /<output-file>\s*([^<]*?)\s*<\/output-file>/.exec(block[1])?.[1];
          const output = path === undefined ? undefined : localPath(xmlText(path));
          if (output && ids.length === 1) { this.outputPaths.set(id, output); task.hasOutput = true; }
          changed = true;
        }
      }
    }
    return changed;
  }

  private background(data: Record<string, unknown>): boolean {
    if (data.agent_id !== undefined || !Array.isArray(data.background_tasks)) return false;
    const live = new Set<string>();
    for (const row of data.background_tasks) {
      if (!record(row) || !text(row.id) || !text(row.type) || typeof row.description !== 'string') continue;
      const taskId = row.id as string, prior = this.tasks.get(taskId), kind = kindOf(row.type);
      live.add(taskId);
      this.tasks.set(taskId, { ...prior, task: { ...prior?.task, taskId,
        kind: prior?.run ? 'workflow' : kind,
        description: prior?.run ? prior.task.description : redactSecrets(row.description),
        status: prior && terminal(prior.task.status) ? prior.task.status : statusOf(row.status),
        ...(text(row.name) ? { workflowName: redactSecrets(row.name as string) } : {}),
        ...(text(row.agent_type) ? { subagentType: redactSecrets(row.agent_type as string) } : {}),
      } });
    }
    // Stop supplies in-flight work, not terminal outcomes. Absence never means success.
    for (const { task } of this.tasks.values()) if (!live.has(task.taskId) && !terminal(task.status)) task.status = 'unknown';
    return true;
  }

  private observedAgents(run: WorkflowRun): WorkflowAgent[] {
    return [...run.agents.values()].sort((a, b) => a.index - b.index).map((agent) => {
      const facts = this.agents.get(agent.agentId)!;
      const turns = [...facts.turns.values()], tokens = turns.reduce((sum, turn) => sum + (turn.tokens ?? 0), 0);
      return { ...agent, state: facts.state,
        ...(turns.length > 0 && turns.every((turn) => turn.tokens !== undefined) && count(tokens) ? { tokens } : {}),
        ...(facts.tools.size ? { toolCalls: facts.tools.size, lastTool: facts.lastTool } : {}),
      };
    });
  }
}
