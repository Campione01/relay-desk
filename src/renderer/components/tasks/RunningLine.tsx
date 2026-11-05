import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { ICON_SM } from '../ui/primitives';
import { useNow } from './TaskParts';
import { TaskRow, useTaskStop } from './TasksPane';
import { isStoppable, sortTasks } from './taskModel';

/**
 * Below the conversation's latest content: how many background tasks of the live session are running, as in the
 * desktop. A click unfolds the running tasks right there; a task opens its detail in the
 * Background tasks pane, and each has its own stop.
 */
export function RunningLine({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const [open, setOpen] = useState(false);
  const { stopping, stop } = useTaskStop(view.key);
  const live = hasOpenHandle(view);
  const running = live ? sortTasks((view.tasks ?? []).filter(isStoppable)) : [];
  const now = useNow(open && running.length > 0);
  if (running.length === 0) return null;
  return (
    <div className="rd-running" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="rd-running__head"
        data-testid="background-running"
        aria-expanded={open}
        aria-controls={`running-${view.key}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="rd-dot rd-dot--running" aria-hidden="true" />
        <span className="rd-tnum">{t('tasks.runningCount', { n: running.length })}</span>
        {open ? <ChevronDown {...ICON_SM} /> : <ChevronRight {...ICON_SM} />}
      </button>
      {open ? (
        <ul id={`running-${view.key}`} className="rd-tlist rd-running__list" aria-label={t('tasks.runningCount', { n: running.length })}>
          {running.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              now={now}
              onOpen={() => controller.openTask(task.taskId)}
              onStop={() => stop(task.taskId)}
              stopping={stopping.has(task.taskId)}
              stopSlot
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
