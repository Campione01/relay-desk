import { RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BackgroundTask } from '@shared/types';
import { useT } from '../../i18n';
import { errorText, formatElapsed, middleTruncate } from '../../lib/format';
import { useAppState, useController } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { ICON_SM, ICON_XS, IconButton } from '../ui/primitives';
import { TaskDetail } from './TaskDetail';
import { KindIcon, StopGlyph, TaskMeta, useNow } from './TaskParts';
import {
  TASKS_POLL_MS,
  isLiveView,
  isStoppable,
  savedSessionId,
  sortTasks,
  taskLabel,
  taskTime,
  workflowLine,
  workflowSummary,
} from './taskModel';

type Fetched = { key: string; tasks?: BackgroundTask[]; error?: string };

/** Read-only view: sessions.tasks() when the pane (or the card) opens and every TASKS_POLL_MS while it stays open. */
export function usePolledTasks(view: SessionView): { fetched: Fetched | null; retry(): void } {
  const controller = useController();
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sessionId = savedSessionId(view);
  const key = !isLiveView(view) && sessionId ? `${view.profileId}\u0000${sessionId}` : null;
  const profileId = view.profileId;
  const cwd = view.cwd || undefined;

  useEffect(() => {
    if (!key || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (): void => {
      controller.relay.sessions
        .tasks(profileId, sessionId, cwd)
        .then(
          (tasks) => {
            if (!cancelled) setFetched({ key, tasks });
          },
          (error: unknown) => {
            if (!cancelled) setFetched((prev) => ({ key, tasks: prev?.key === key ? prev.tasks : undefined, error: errorText(error) }));
          },
        )
        .finally(() => {
          if (!cancelled) timer = setTimeout(run, TASKS_POLL_MS);
        });
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [controller, key, profileId, sessionId, cwd, attempt]);

  return { fetched: fetched && fetched.key === key ? fetched : null, retry: () => setAttempt((n) => n + 1) };
}

/** Stops a task of the view's live session; its stop stays disabled until that call settled. */
export function useTaskStop(viewKey: string): { stopping: ReadonlySet<string>; stop(taskId: string): void } {
  const controller = useController();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const stop = (taskId: string): void => {
    setStopping((prev) => new Set(prev).add(taskId));
    void controller.stopTask(viewKey, taskId).finally(() =>
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      }),
    );
  };
  return { stopping, stop };
}

export function TaskRow({
  task,
  now,
  reportedAt,
  onOpen,
  onStop,
  stopping,
  stopSlot,
}: {
  task: BackgroundTask;
  now: number;
  reportedAt?: number;
  onOpen(): void;
  onStop?: () => void;
  stopping: boolean;
  /** Live view: rows without a stop keep its room, so the time column lines up. */
  stopSlot: boolean;
}) {
  const t = useT();
  const label = taskLabel(task, t);
  const time = taskTime(task, now, reportedAt);
  const summary = task.kind === 'workflow' ? workflowSummary(task.workflow) : null;
  return (
    <li className="rd-trow" data-testid="task-row" data-status={task.status} data-kind={task.kind}>
      <button type="button" className="rd-trow__main" data-tip={label} data-tip-place="left" onClick={onOpen}>
        <KindIcon kind={task.kind} className="rd-trow__icon" />
        <span className="rd-trow__text">
          <span className="rd-trow__desc">{label}</span>
          <TaskMeta task={task} />
          {summary ? (
            <span className="rd-trow__progress rd-tnum" data-testid="workflow-progress">
              {workflowLine(summary, t)}
            </span>
          ) : null}
        </span>
        <span className="rd-trow__time rd-tnum" data-testid="task-time">
          {time === null ? '' : formatElapsed(time)}
        </span>
      </button>
      {onStop ? (
        <IconButton
          className="rd-trow__stop"
          label={t('tasks.stopTip')}
          icon={<StopGlyph />}
          size="small"
          muted
          tipPlace="left"
          disabled={stopping}
          onClick={onStop}
        />
      ) : stopSlot ? (
        <span className="rd-trow__stop rd-trow__stop--none" aria-hidden="true" />
      ) : null}
    </li>
  );
}

/** The `claude --bg` sessions of the active account, below the session's own tasks. */
export function DetachedSessions() {
  const controller = useController();
  const t = useT();
  const background = useAppState((s) => s.background);
  return (
    <section className="rd-tsection" aria-label={t('tasks.detached')}>
      <h3 className="rd-tsection__head">
        <span>{t('tasks.detached')}</span>
        <button
          type="button"
          className="rd-tsection__refresh"
          aria-label={t('common.refresh')}
          data-tip={t('common.refresh')}
          onClick={() => void controller.loadBackground()}
        >
          <RotateCw {...ICON_XS} />
        </button>
      </h3>
      {background.state === 'loading' ? <p className="rd-tpane__note">{t('common.loading')}</p> : null}
      {background.state === 'error' ? (
        <p className="rd-tpane__note rd-tpane__note--error" role="alert">
          {background.error}
        </p>
      ) : null}
      {background.state === 'loaded' && background.list.length === 0 ? <p className="rd-tpane__note">{t('background.empty')}</p> : null}
      <ul className="rd-tbg">
        {background.list.map((agent) => (
          <li key={agent.id} className="rd-tbg__row" data-testid="background-row">
            <span className="rd-tbg__text">
              <span className="rd-tbg__name">{agent.name ?? agent.id}</span>
              <span className="rd-tbg__desc">
                {[agent.state ?? agent.status, agent.cwd ? middleTruncate(agent.cwd, 32) : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button
              type="button"
              className="rd-link"
              data-tip={`claude attach ${agent.id}`}
              data-tip-place="left"
              onClick={() => void controller.attachBackground(agent.id)}
            >
              {t('background.attach')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Background tasks side pane (desktop: title bar ⋮ > Background tasks): subagents, background commands and workflows
 * of the session in view, newest work on top; a row opens its detail, a running row of a live session has its own stop.
 */
export function TasksPane({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const { fetched, retry } = usePolledTasks(view);
  const live = isLiveView(view);
  const stoppable = hasOpenHandle(view);
  const noSession = !live && !savedSessionId(view);
  const tasks: BackgroundTask[] | undefined = noSession ? undefined : live ? (view.tasks ?? []) : fetched?.tasks;
  const sorted = tasks ? sortTasks(tasks) : [];
  const now = useNow(sorted.some((task) => task.status === 'running'));
  const selected = useAppState((s) => s.ui.tasksPaneTask);
  const setSelected = (taskId: string | null): void => controller.openTask(taskId);
  const { stopping, stop } = useTaskStop(view.key);

  // When a running task reports only durationMs, count on from the moment that value arrived.
  const reported = useRef(new Map<string, { durationMs: number; at: number }>());
  for (const task of sorted) {
    if (task.durationMs === undefined) continue;
    const seen = reported.current.get(task.taskId);
    if (!seen || seen.durationMs !== task.durationMs) reported.current.set(task.taskId, { durationMs: task.durationMs, at: Date.now() });
  }

  // A refreshed list may drop the task on show; its detail stays with the last known state.
  const last = useRef<BackgroundTask | null>(null);
  const found = selected === null ? undefined : sorted.find((task) => task.taskId === selected);
  if (found) last.current = found;
  const detail = selected === null ? null : (found ?? (last.current?.taskId === selected ? last.current : null));

  const stopFor =(task: BackgroundTask): (() => void) | undefined =>
    stoppable && isStoppable(task) ? () => stop(task.taskId) : undefined;

  return (
    <aside className="rd-tpane" aria-label={t('tasks.paneLabel')} data-testid="tasks-pane">
      <header className="rd-tpane__head">
        <h2 className="rd-tpane__title">{t('background.title')}</h2>
        <IconButton label={t('common.close')} icon={<X {...ICON_SM} />} size="small" muted onClick={() => controller.toggleTasksPane(false)} />
      </header>
      <div className="rd-tpane__body">
        {detail ? (
          <TaskDetail
            key={detail.taskId}
            viewKey={view.key}
            task={detail}
            now={now}
            reportedAt={reported.current.get(detail.taskId)?.at}
            onBack={() => setSelected(null)}
            onStop={stopFor(detail)}
            stopping={stopping.has(detail.taskId)}
          />
        ) : (
          <>
            {noSession ? (
              <p className="rd-tpane__note">{t('tasks.noSession')}</p>
            ) : tasks === undefined && !fetched?.error ? (
              <p className="rd-tpane__note">{t('common.loading')}</p>
            ) : null}
            {fetched?.error ? (
              <p className="rd-tpane__note rd-tpane__error" data-testid="tasks-error">
                <span>{t('tasks.error')}</span>
                <button type="button" className="rd-link" onClick={retry}>
                  {t('common.retry')}
                </button>
              </p>
            ) : null}
            {tasks && tasks.length === 0 ? <p className="rd-tpane__note">{t('tasks.noWork')}</p> : null}
            {sorted.length > 0 ? (
              <ul className="rd-tlist" aria-label={t('background.title')}>
                {sorted.map((task) => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    now={now}
                    reportedAt={reported.current.get(task.taskId)?.at}
                    onOpen={() => setSelected(task.taskId)}
                    onStop={stopFor(task)}
                    stopping={stopping.has(task.taskId)}
                    stopSlot={stoppable}
                  />
                ))}
              </ul>
            ) : null}
            <DetachedSessions />
          </>
        )}
      </div>
    </aside>
  );
}
