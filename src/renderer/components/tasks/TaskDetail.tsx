import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackgroundTask, WorkflowAgent, WorkflowPhase } from '@shared/types';
import { useT } from '../../i18n';
import { formatElapsed, formatTokens } from '../../lib/format';
import { useController } from '../../state/context';
import { ICON_SM, ICON_XS, IconButton } from '../ui/primitives';
import { AgentTranscript } from './AgentTranscript';
import { KindIcon, StatusDot, StopGlyph, TaskMeta, factLines } from './TaskParts';
import {
  agentStatus,
  groupAgents,
  isOpenTask,
  phaseLine,
  phaseStatus,
  taskLabel,
  taskTime,
  workflowLine,
  workflowSummary,
} from './taskModel';

const OTHER_GROUP = 'other';

function Nav({ back, onBack, crumb, children }: { back: string; onBack(): void; crumb: string; children?: ReactNode }) {
  return (
    <div className="rd-tdetail__nav">
      <IconButton label={back} icon={<ArrowLeft {...ICON_SM} />} size="small" muted onClick={onBack} />
      <span className="rd-tdetail__crumb">{crumb}</span>
      {children}
    </div>
  );
}

function AgentRow({ agent, parentStatus, onOpen }: { agent: WorkflowAgent; parentStatus: BackgroundTask['status']; onOpen(agent: WorkflowAgent): void }) {
  const t = useT();
  const status = agentStatus(agent.state, parentStatus);
  const meta = [t(`tasks.status.${status}`), agent.tokens !== undefined ? t('tasks.tokens', { n: formatTokens(agent.tokens) }) : null]
    .filter(Boolean)
    .join(' · ');
  const body = (
    <>
      <StatusDot status={status} />
      <span className="rd-tagent__label">{agent.label}</span>
      <span className="rd-tagent__meta rd-tnum">{meta}</span>
    </>
  );
  return (
    <li className="rd-tagent" data-testid="workflow-agent" data-state={status === 'stopped' ? status : agent.state}>
      {agent.agentId ? (
        <button type="button" className="rd-tagent__main" data-tip={agent.label} data-tip-place="left" onClick={() => onOpen(agent)}>
          {body}
        </button>
      ) : (
        <div className="rd-tagent__main">{body}</div>
      )}
    </li>
  );
}

function PhaseRow({
  title,
  phase,
  agents,
  parentStatus,
  open,
  onToggle,
  onOpenAgent,
}: {
  title: string;
  phase: WorkflowPhase;
  agents: WorkflowAgent[];
  parentStatus: BackgroundTask['status'];
  open: boolean;
  onToggle(): void;
  onOpenAgent(agent: WorkflowAgent): void;
}) {
  const t = useT();
  const expandable = agents.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  const head = (
    <>
      {expandable ? <Chevron {...ICON_XS} className="rd-tphase__chev" /> : <span className="rd-tphase__chev" />}
      <StatusDot status={phaseStatus(phase, parentStatus)} />
      <span className="rd-tphase__title">{title}</span>
      <span className="rd-tphase__count rd-tnum">{phaseLine(phase, t)}</span>
    </>
  );
  return (
    <li className="rd-tphase" data-testid="workflow-phase">
      {expandable ? (
        <button type="button" className="rd-tphase__head" aria-expanded={open} onClick={onToggle}>
          {head}
        </button>
      ) : (
        <div className="rd-tphase__head">{head}</div>
      )}
      {open && expandable ? (
        <ul className="rd-tagents" aria-label={title}>
          {agents.map((agent) => (
            <AgentRow key={agent.index} agent={agent} parentStatus={parentStatus} onOpen={onOpenAgent} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Phases with their agent counts; a phase opens to its agents. */
function WorkflowView({
  task,
  expanded,
  onToggle,
  onOpenAgent,
}: {
  task: BackgroundTask;
  expanded: ReadonlySet<string>;
  onToggle(id: string): void;
  onOpenAgent(agent: WorkflowAgent): void;
}) {
  const t = useT();
  const workflow = task.workflow;
  if (!workflow || (workflow.phases.length === 0 && workflow.agents.length === 0)) {
    return <p className="rd-tpane__note">{t('tasks.workflowPending')}</p>;
  }
  const summary = workflowSummary(workflow);
  const { byPhase, other } = groupAgents(workflow);
  const count = (state: WorkflowAgent['state']): number => other.filter((agent) => agent.state === state).length;
  const otherPhase: WorkflowPhase = { index: -1, title: '', agents: other.length, done: count('done'), failed: count('failed'), running: count('running') };
  return (
    <section className="rd-tflow" aria-label={t('tasks.kind.workflow')}>
      {summary ? (
        <p className="rd-tflow__progress rd-tnum" data-testid="workflow-progress">
          {workflowLine(summary, t)}
        </p>
      ) : null}
      <ul className="rd-tphases">
        {workflow.phases.map((phase) => (
          <PhaseRow
            key={phase.index}
            title={phase.title}
            phase={phase}
            agents={byPhase.get(phase.index) ?? []}
            parentStatus={task.status}
            open={expanded.has(String(phase.index))}
            onToggle={() => onToggle(String(phase.index))}
            onOpenAgent={onOpenAgent}
          />
        ))}
        {other.length > 0 ? (
          <PhaseRow
            key={OTHER_GROUP}
            title={t('tasks.otherAgents')}
            phase={otherPhase}
            agents={other}
            parentStatus={task.status}
            open={expanded.has(OTHER_GROUP)}
            onToggle={() => onToggle(OTHER_GROUP)}
            onOpenAgent={onOpenAgent}
          />
        ) : null}
      </ul>
    </section>
  );
}

/** End of a command's output file, read once the CLI reports one. */
function TaskOutput({ viewKey, task }: { viewKey: string; task: BackgroundTask }) {
  const t = useT();
  const controller = useController();
  const [loaded, setLoaded] = useState<{ key: string; text?: string | null; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${viewKey}\u0000${task.taskId}`;
  const hasOutput = task.hasOutput === true;
  // Output files are only known for commands that end while Relay runs the session (task_notification).
  const finished = task.status !== 'running' && task.status !== 'pending' && task.status !== 'paused';

  useEffect(() => {
    if (!hasOutput) return;
    let cancelled = false;
    controller.taskOutput(viewKey, task.taskId).then(
      (text) => {
        if (!cancelled) setLoaded({ key, text });
      },
      () => {
        if (!cancelled) setLoaded({ key, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller, viewKey, task.taskId, key, hasOutput, attempt]);

  const current = loaded?.key === key ? loaded : null;
  let body: ReactNode;
  if (hasOutput && !current) {
    body = <p className="rd-tpane__note">{t('common.loading')}</p>;
  } else if (current?.error) {
    body = (
      <p className="rd-tpane__note rd-tpane__error" data-testid="output-error">
        <span>{t('tasks.outputError')}</span>
        <button type="button" className="rd-link" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </p>
    );
  } else if (!hasOutput || current?.text == null) {
    body = (
      <p className="rd-tpane__note" data-testid="output-pending">
        {finished ? t('tasks.outputUnavailable') : t('tasks.outputPending')}
      </p>
    );
  } else {
    body = (
      <pre className="rd-toutput rd-mono rd-selectable" data-testid="task-output" tabIndex={0}>
        {current.text}
      </pre>
    );
  }
  return (
    <section className="rd-tdetail__section" aria-label={t('tasks.output')}>
      <h4 className="rd-tdetail__label">{t('tasks.output')}</h4>
      {body}
    </section>
  );
}

export interface TaskDetailProps {
  viewKey: string;
  task: BackgroundTask;
  now: number;
  reportedAt?: number;
  onBack(): void;
  /** Set for a running or pending task of a live view. */
  onStop?: () => void;
  stopping?: boolean;
}

/** One task in the pane: a subagent's transcript, a workflow's phases and agents, or a command's output. */
export function TaskDetail({ viewKey, task, now, reportedAt, onBack, onStop, stopping }: TaskDetailProps) {
  const t = useT();
  const [agentIndex, setAgentIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const lastAgent = useRef<WorkflowAgent | null>(null);
  const found = agentIndex === null ? undefined : task.workflow?.agents.find((agent) => agent.index === agentIndex);
  if (found) lastAgent.current = found;
  const agent = agentIndex === null ? null : (found ?? (lastAgent.current?.index === agentIndex ? lastAgent.current : null));
  const label = taskLabel(task, t);

  if (agent?.agentId) {
    const status = agentStatus(agent.state, task.status);
    const meta = [
      t(`tasks.status.${status}`),
      agent.tokens !== undefined ? t('tasks.tokens', { n: formatTokens(agent.tokens) }) : null,
      agent.toolCalls !== undefined ? t('tasks.toolUses', { n: agent.toolCalls }) : null,
      agent.lastTool ? t('tasks.lastTool', { name: agent.lastTool }) : null,
    ].filter(Boolean);
    // A queued agent has no transcript yet; it is polled until it starts unless the workflow is over.
    const running = isOpenTask(task) && (agent.state === 'running' || agent.state === 'queued');
    return (
      <div className="rd-tdetail" data-testid="task-detail" data-kind="workflow-agent">
        <Nav back={t('tasks.backToWorkflow')} onBack={() => setAgentIndex(null)} crumb={label} />
        <div className="rd-tdetail__head" data-status={status}>
          <KindIcon kind="agent" className="rd-trow__icon" />
          <div className="rd-tdetail__text">
            <h3 className="rd-tdetail__title rd-selectable">{agent.label}</h3>
            <span className="rd-trow__meta">
              <StatusDot status={status} />
              <span className="rd-trow__extra">{meta.join(' · ')}</span>
            </span>
          </div>
        </div>
        <AgentTranscript viewKey={viewKey} agentId={agent.agentId} running={running} />
      </div>
    );
  }

  const time = taskTime(task, now, reportedAt);
  const facts = factLines(task, t);
  return (
    <div className="rd-tdetail" data-testid="task-detail" data-kind={task.kind}>
      <Nav back={t('tasks.backToList')} onBack={onBack} crumb={t(`tasks.kind.${task.kind}`)}>
        {onStop ? (
          <button
            type="button"
            className="rd-btn rd-btn--secondary rd-tdetail__stop"
            data-tip={t('tasks.stopTip')}
            disabled={stopping}
            onClick={onStop}
          >
            <StopGlyph />
            {t('tasks.stop')}
          </button>
        ) : null}
      </Nav>
      <div className="rd-tdetail__head" data-status={task.status}>
        <KindIcon kind={task.kind} className="rd-trow__icon" />
        <div className="rd-tdetail__text">
          <h3 className="rd-tdetail__title rd-selectable">{label}</h3>
          <TaskMeta task={task} />
        </div>
        <span className="rd-trow__time rd-tnum" data-testid="task-time">
          {time === null ? '' : formatElapsed(time)}
        </span>
      </div>
      {facts.length > 0 ? (
        <ul className="rd-tdetail__facts rd-selectable">
          {facts.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
      {task.kind === 'agent' ? (
        <AgentTranscript viewKey={viewKey} agentId={task.taskId} running={isOpenTask(task)} />
      ) : task.kind === 'workflow' ? (
        <WorkflowView
          task={task}
          expanded={expanded}
          onToggle={(id) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (!next.delete(id)) next.add(id);
              return next;
            })
          }
          onOpenAgent={(picked) => setAgentIndex(picked.index)}
        />
      ) : (
        <TaskOutput viewKey={viewKey} task={task} />
      )}
    </div>
  );
}
