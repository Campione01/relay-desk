import { Activity, Bot, CircleDashed, Square, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BackgroundTask, BackgroundTaskKind } from '@shared/types';
import { useT, type Translate } from '../../i18n';
import { formatTokens } from '../../lib/format';
import { ICON } from '../ui/primitives';

const KIND_ICON: Record<BackgroundTaskKind, LucideIcon> = {
  shell: SquareTerminal,
  agent: Bot,
  workflow: Workflow,
  monitor: Activity,
  other: CircleDashed,
};

export function KindIcon({ kind, className }: { kind: BackgroundTaskKind; className?: string }) {
  const t = useT();
  const Icon = KIND_ICON[kind] ?? CircleDashed;
  return <Icon {...ICON} className={className} role="img" aria-label={t(`tasks.kind.${kind}`)} aria-hidden={undefined} />;
}

/** Filled, so a row's stop never reads as a checkbox. */
export function StopGlyph() {
  return <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />;
}

export function StatusDot({ status }: { status: BackgroundTask['status'] }) {
  return <span className={`rd-tdot rd-tdot--${status}`} aria-hidden="true" />;
}

/** "● Running · Subagent · lean-reviewer"; a workflow with its own description names its script there. */
export function TaskMeta({ task }: { task: BackgroundTask }) {
  const t = useT();
  const extra = task.subagentType ?? (task.kind === 'workflow' && task.description.trim() ? task.workflowName : undefined);
  return (
    <span className="rd-trow__meta">
      <StatusDot status={task.status} />
      <span className="rd-trow__status">{t(`tasks.status.${task.status}`)}</span>
      <span aria-hidden="true">·</span>
      <span>{t(`tasks.kind.${task.kind}`)}</span>
      {extra ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="rd-trow__extra">{extra}</span>
        </>
      ) : null}
    </span>
  );
}

/** Token, tool and summary lines of a task's detail. */
export function factLines(task: BackgroundTask, t: Translate): string[] {
  const lines: string[] = [];
  if (task.totalTokens !== undefined) lines.push(t('tasks.tokens', { n: formatTokens(task.totalTokens) }));
  if (task.toolUses !== undefined) lines.push(t('tasks.toolUses', { n: task.toolUses }));
  if (task.lastTool) lines.push(t('tasks.lastTool', { name: task.lastTool }));
  if (task.summary) lines.push(task.summary);
  return lines;
}

/** 1 s clock while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
