import { useRef } from 'react';
import type { BackgroundTask } from '@shared/types';
import { useT } from '../../i18n';
import { useController, useCurrentView } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import { useNow } from '../tasks/TaskParts';
import { DetachedSessions, TaskRow, usePolledTasks, useTaskStop } from '../tasks/TasksPane';
import { isLiveView, isStoppable, savedSessionId, sortTasks } from '../tasks/taskModel';
import { PanelCard } from './PanelCard';
import type { SessionView } from '../../state/types';

/**
 * Background tasks card (in the right panel, next to the desktop's ⋮ pane): the session's
 * subagents, background commands and workflows, newest work on top; a row opens its detail in the pane.
 */
export function BackgroundCard() {
  const view = useCurrentView();
  const t = useT();
  // Header count: running work of a live session. The rows mount only while the card is open, so a saved session's
  // list is fetched only then.
  const summary = view && isLiveView(view) ? String((view.tasks ?? []).filter(isStoppable).length) : undefined;
  return (
    <PanelCard id="background" title={t('background.title')} summary={summary}>
      {view ? <BackgroundRows view={view} /> : <p className="rd-card__note">{t('tasks.noSession')}</p>}
      <DetachedSessions />
    </PanelCard>
  );
}

function BackgroundRows({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const { fetched, retry } = usePolledTasks(view);
  const { stopping, stop } = useTaskStop(view.key);
  const live = isLiveView(view);
  const stoppable = hasOpenHandle(view);
  const noSession = !live && !savedSessionId(view);
  const tasks: BackgroundTask[] | undefined = noSession ? undefined : live ? (view.tasks ?? []) : fetched?.tasks;
  const sorted = tasks ? sortTasks(tasks) : [];
  const now = useNow(sorted.some((task) => task.status === 'running'));
  const reported = useRef(new Map<string, { durationMs: number; at: number }>());
  for (const task of sorted) {
    if (task.durationMs === undefined) continue;
    const seen = reported.current.get(task.taskId);
    if (!seen || seen.durationMs !== task.durationMs) reported.current.set(task.taskId, { durationMs: task.durationMs, at: Date.now() });
  }

  if (noSession) return <p className="rd-card__note">{t('tasks.noSession')}</p>;
  if (tasks === undefined && !fetched?.error) return <p className="rd-card__note">{t('common.loading')}</p>;
  return (
    <>
      {fetched?.error ? (
        <p className="rd-card__note rd-task__error" data-testid="tasks-error">
          <span>{t('tasks.error')}</span>
          <button type="button" className="rd-link" onClick={retry}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}
      {tasks && tasks.length === 0 ? <p className="rd-card__note">{t('tasks.empty')}</p> : null}
      {sorted.length > 0 ? (
        <ul className="rd-tlist rd-tlist--card" aria-label={t('background.title')}>
          {sorted.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              now={now}
              reportedAt={reported.current.get(task.taskId)?.at}
              onOpen={() => controller.openTask(task.taskId)}
              onStop={stoppable && isStoppable(task) ? () => stop(task.taskId) : undefined}
              stopping={stopping.has(task.taskId)}
              stopSlot={stoppable}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
