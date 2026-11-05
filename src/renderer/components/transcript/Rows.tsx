import {
  ArrowRightLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleEllipsis,
  Info,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TaskNote, TranscriptItem } from '@shared/types';
import { useT, type Translate } from '../../i18n';
import { formatElapsed, formatTokens } from '../../lib/format';
import type { PlanState, ThinkingItem } from '../../lib/toolActivity';
import { useController } from '../../state/context';
import { isActiveState, runningCommand } from '../../state/sessionReducer';
import type { SessionView, ViewError } from '../../state/types';
import { ErrorMessage } from '../ui/ErrorMessage';
import { ICON_SM, ICON_XS, IconButton, Spinner } from '../ui/primitives';
import { ImagePlaceholders, ImageThumbs } from './ImageViewer';

type UserItem = Extract<TranscriptItem, { kind: 'user' }>;
type SystemItem = Extract<TranscriptItem, { kind: 'system' }>;
type ResultItem = Extract<TranscriptItem, { kind: 'result' }>;

export function UserMessage({ item, viewKey, running }: { item: UserItem; viewKey: string; running: boolean }) {
  const controller = useController();
  const t = useT();
  const refs = item.imageRefs ?? [];
  const count = refs.length > 0 ? refs.length : (item.images ?? 0);
  const queued = item.queued && !item.deliveryUnconfirmed;
  return (
    <div className="rd-user" data-testid="user-message" data-queued={queued ? 'true' : undefined}
      data-delivery-unconfirmed={item.deliveryUnconfirmed ? 'true' : undefined}>
      {item.text || count === 0 ? <div className="rd-user__bubble rd-selectable">{item.text}</div> : null}
      {count > 0 ? (
        <div className="rd-user__images" role="group" aria-label={t('transcript.images', { n: count })}>
          {refs.length > 0 ? (
            <ImageThumbs images={refs} label={t('image.pasted')} variant="user" itemId={item.id} />
          ) : (
            <ImagePlaceholders count={Math.min(count, 4)} variant="user" />
          )}
        </div>
      ) : null}
      {queued || item.deliveryUnconfirmed ? (
        <div className="rd-user__queued">
          <span className="rd-badge">{t(item.deliveryUnconfirmed ? 'transcript.deliveryUnconfirmed' : 'transcript.queued')}</span>
          {queued && running ? (
            <button
              type="button"
              className="rd-user__sendnow"
              data-tip={t('transcript.sendNowHint')}
              onClick={() => void controller.interrupt(viewKey)}
            >
              {t('transcript.sendNow')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingRow({ item, inCard }: { item: ThinkingItem; inCard?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = item.streaming ? t('transcript.thinkingLive') : t('transcript.thinking');
  return (
    <div className={inCard ? 'rd-thinking rd-thinking--card' : 'rd-thinking'} data-testid="thinking" data-streaming={item.streaming ? 'true' : undefined}>
      <button type="button" className="rd-thinking__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="rd-thinking__label">{label}</span>
        {open ? <ChevronDown {...ICON_XS} /> : <ChevronRight {...ICON_SM} />}
      </button>
      {/* Capped height with its own scroll; focusable so the keyboard can scroll it. */}
      {open ? (
        <div className="rd-thinking__body rd-selectable" role="region" aria-label={label} tabIndex={0}>
          {item.text}
        </div>
      ) : null}
    </div>
  );
}

/** Lines a command's output shows before "Show more". */
export const SYSTEM_TEXT_LINES = 3;

/** "Background task completed: npm test" in the UI language. */
export function taskLine(task: TaskNote, t: Translate): string {
  const label =
    task.status === 'completed' || task.status === 'failed' || task.status === 'stopped'
      ? t(`transcript.task.${task.status}`)
      : t('transcript.task.other', { status: task.status });
  return task.summary ? t('transcript.task.line', { label, summary: task.summary }) : label;
}

/** Background tasks: one truncated line each, the whole line in the tooltip (the desktop shows no long command dumps). */
function TaskLines({ tasks }: { tasks: readonly TaskNote[] }) {
  const t = useT();
  return (
    <div className="rd-sysrow__body">
      {tasks.map((task, index) => {
        const line = taskLine(task, t);
        return (
          <span key={index} className="rd-sysrow__task rd-selectable" data-tip={line} data-tip-place="top" data-testid="task-line">
            {line}
          </span>
        );
      })}
    </div>
  );
}

/** Command output and notes keep their line breaks; beyond SYSTEM_TEXT_LINES lines they fold behind "Show more". */
function FoldedText({ text, suffix }: { text: string; suffix?: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggled = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const check = (): void => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, suffix, expanded]);
  useLayoutEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    // The button sits under the text: the fold stays in view, from its start when it is taller than the view.
    bodyRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);
  const clipped = overflowing && !expanded;
  const after = suffix ? <span className="rd-sysrow__duration">{` · ${suffix}`}</span> : null;
  const toggle = (): void => {
    toggled.current = true;
    setExpanded(!expanded);
  };
  const more = overflowing || expanded ? (
    <button type="button" className="rd-link rd-sysrow__more" aria-expanded={expanded} onClick={toggle}>
      {expanded ? t('transcript.showLess') : t('transcript.showMore')}
    </button>
  ) : null;
  return (
    <div ref={bodyRef} className="rd-sysrow__body">
      <span ref={ref} className="rd-sysrow__text rd-selectable" data-folded={expanded ? undefined : 'true'}>
        {text}
        {clipped ? null : after}
      </span>
      {/* The clamp would cut the suffix off with the hidden lines; the button keeps one place so it keeps focus. */}
      {more ? <span className="rd-sysrow__foot">{more}{clipped ? after : null}</span> : null}
    </div>
  );
}

/** Shortest command run whose result row names its duration. */
const COMMAND_DURATION_MIN_MS = 2000;

export function SystemRow({ item }: { item: SystemItem }) {
  const t = useT();
  const Icon = item.level === 'error' ? CircleAlert : item.level === 'warn' ? TriangleAlert : Info;
  const took = item.durationMs !== undefined && item.durationMs >= COMMAND_DURATION_MIN_MS
    ? t('transcript.took', { time: formatElapsed(item.durationMs) }) : undefined;
  return (
    <div className={`rd-sysrow rd-sysrow--${item.level}`} role={item.level === 'error' ? 'alert' : undefined}>
      <Icon {...ICON_SM} />
      {item.tasks?.length ? <TaskLines tasks={item.tasks} /> : <FoldedText text={item.text} suffix={took} />}
    </div>
  );
}

export function ResultRow({ item }: { item: ResultItem }) {
  const t = useT();
  if (!item.isError) return null;
  return (
    <div className="rd-sysrow rd-sysrow--error" role="alert">
      <CircleAlert {...ICON_SM} />
      <span className="rd-selectable">{item.text || t('transcript.turnFailed')}</span>
    </div>
  );
}

export function ErrorRow({ viewKey, error }: { viewKey: string; error: ViewError }) {
  const controller = useController();
  const t = useT();
  const retryLabel =
    error.retry.kind === 'none' ? null : (error.retryLabel ?? (error.retry.kind === 'open' ? t('error.reopen') : t('common.retry')));
  return (
    <div className="rd-errrow" role="alert" data-testid="inline-error">
      <CircleAlert {...ICON_SM} />
      <ErrorMessage className="rd-errrow__text" message={error.message} />
      {retryLabel ? (
        <button type="button" className="rd-btn rd-btn--secondary rd-errrow__retry" onClick={() => void controller.retryError(viewKey, error.id)}>
          <RotateCw {...ICON_XS} />
          {retryLabel}
        </button>
      ) : null}
      <IconButton
        label={t('common.dismiss')}
        icon={<X {...ICON_SM} />}
        size="small"
        muted
        onClick={() => controller.dismissError(viewKey, error.id)}
      />
    </div>
  );
}

/** Top of a view whose saved history starts after the session start: loads the page before it. */
export function LoadEarlier({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const errorId = useId();
  const older = view.olderHistory;
  if (!older) return null;
  const loading = older.state === 'loading';
  const failed = older.state === 'error';
  const blocked = loading || view.history === 'loading';
  const message = failed ? t('transcript.earlierFailed', { message: older.error ?? '' }) : '';
  return (
    <div className="rd-earlier" data-testid="load-earlier">
      {failed ? (
        <span className="rd-earlier__error" role="alert" data-tip={message} data-tip-place="top">
          <CircleAlert {...ICON_SM} />
          <span id={errorId} className="rd-earlier__text">{message}</span>
        </span>
      ) : null}
      {/* aria-disabled rather than disabled: a keyboard user keeps focus on it through loading and retry. */}
      <button
        type="button"
        className="rd-earlier__btn"
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        aria-describedby={failed ? errorId : undefined}
        onClick={() => void controller.loadOlderHistory(view.key)}
      >
        {loading ? <Spinner small /> : failed ? <RotateCw {...ICON_XS} /> : <ArrowUp {...ICON_SM} />}
        {loading ? t('transcript.loadingEarlier') : failed ? t('common.retry') : t('transcript.loadEarlier')}
      </button>
    </div>
  );
}

export function HandedOffRow({ result }: { result: NonNullable<SessionView['handedOff']> }) {
  const t = useT();
  return (
    <div className={result.ok ? 'rd-sysrow rd-sysrow--info' : 'rd-sysrow rd-sysrow--error'} data-testid="handoff-result">
      <ArrowRightLeft {...ICON_SM} />
      <span className="rd-selectable">
        {result.ok ? t('handoff.handedBack') : t('common.failed')}
        {result.message ? ` · ${result.message}` : ''}
      </span>
    </div>
  );
}

/** Plan / checklist card (§4.8) from the latest TodoWrite call. */
export function PlanCard({ plan }: { plan: PlanState }) {
  const t = useT();
  return (
    <section className="rd-plan" aria-label={plan.stale ? t('plan.before') : t('plan.title')} data-testid="plan-card">
      <div className="rd-plan__head">{plan.stale ? t('plan.before') : t('plan.title')}</div>
      <ul className="rd-plan__list">
        {plan.todos.map((todo, index) => {
          const Icon =
            todo.status === 'completed' ? CircleCheck : todo.status === 'in_progress' ? CircleEllipsis : CircleDashed;
          return (
            <li key={index} className={`rd-plan__item rd-plan__item--${todo.status}`}>
              <Icon {...ICON_SM} aria-label={t(`plan.status.${todo.status}`)} aria-hidden={undefined} role="img" />
              <span>{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Working indicator (§4.9): dots, elapsed time, tokens and a state word; `stepShown` while an activity line runs. */
export function StatusLine({ view, stepShown }: { view: SessionView; stepShown: boolean }) {
  const t = useT();
  const active = isActiveState(view.engineState);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (view.engineState === 'starting' || view.opening) {
    return (
      <div className="rd-status" data-testid="status-line">
        <Spinner />
        <span className="rd-status__text">{t('status.starting')}</span>
      </div>
    );
  }
  // An open CLI panel above the composer already shows what runs.
  if (!active || view.panel) return null;

  const pending = runningCommand(view);
  // A running call is shown by its own activity line (dots, step, elapsed), as in the desktop. The row keeps its
  // height meanwhile, or the transcript would jump each time a call starts or ends. A pending command keeps its line.
  if (stepShown && !pending) return <div className="rd-status" data-testid="status-line" data-hidden="true" aria-hidden="true" />;
  const command = view.engineState === 'running' ? pending?.command : undefined;
  const word = view.engineState === 'awaiting'
    ? t('status.awaiting')
    : command === 'compact' ? t('status.compacting') : command ? t('status.command', { name: command }) : t('status.thinking');
  const tokens = view.tokens !== undefined ? t('status.tokens', { n: formatTokens(view.tokens) }) : null;
  // The engine restarts its clock when a turn the command waited for ends; the command runs since it was sent.
  const since = pending?.createdAt ?? view.startedAt;
  const elapsed = since ? formatElapsed(now - since) : null;

  return (
    <div className="rd-status" data-testid="status-line">
      <Spinner />
      <span className="rd-visually-hidden" role="status">
        {word}
      </span>
      <span className="rd-status__text rd-tnum" aria-hidden="true">
        {[elapsed, tokens, word].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
}
