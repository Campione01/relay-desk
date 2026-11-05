import { ChartColumn, Settings } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PlanUsage, PlanUsageWindow, ProfileId } from '@shared/types';
import { useLanguage, useT, type Translate } from '../../i18n';
import { formatPercent, formatTokens } from '../../lib/format';
import { useAppState, useController } from '../../state/context';
import type { SessionView } from '../../state/types';
import { ICON_SM, IconButton, Spinner } from '../ui/primitives';

/** Cached plan usage older than this is fetched again with force when the popover opens. */
export const USAGE_STALE_MS = 60_000;
/** The open popover re-renders this often so the reset countdown stays current. */
export const COUNTDOWN_TICK_MS = 15_000;
const MINUTE = 60_000;
const GAP = 10;
const WIDTH = 306;

/** A window whose reset time has passed is no longer at its limit, whatever its last reading said. */
export function windowAtLimit(window: PlanUsageWindow, now = Date.now()): boolean {
  if (window.resetsAt !== null && window.resetsAt <= now) return false;
  return window.status === 'rejected' || (window.percent !== null && window.percent >= 100);
}

/** True when any plan window of the account is at its limit (red ring and warning mark). */
export function usageAtLimit(usage: PlanUsage | undefined, now = Date.now()): boolean {
  return Boolean(usage?.available && usage.windows.some((window) => windowAtLimit(window, now)));
}

const MODEL_NAMES: Readonly<Record<string, string>> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', oauth_apps: 'OAuth apps' };

export function windowLabel(id: string, t: Translate): string {
  if (id === 'five_hour') return t('usage.session');
  if (id === 'seven_day' || id === 'seven_day_overage_included') return t('usage.weekly');
  const raw = id.startsWith('seven_day_') ? id.slice('seven_day_'.length) : id.slice(id.indexOf(':') + 1);
  const words = raw.replace(/[_-]+/g, ' ').trim();
  const model = MODEL_NAMES[raw] ?? (words ? words.charAt(0).toUpperCase() + words.slice(1) : id);
  return t('usage.weeklyModel', { model });
}

/** Full reset date in the UI language: "Tue, Oct 20, 10:00 PM", "10月20日週二 下午10:00". */
export function formatReset(at: number, language: string): string {
  return new Intl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

/** Time left before a reset: "in 2d 13h", "in 3h 12m" or "in 42m" with minutes rounded up; null once it has passed. */
export function formatCountdown(at: number, now: number, t: Translate): string | null {
  const minutes = Math.ceil((at - now) / MINUTE);
  if (minutes <= 0) return null;
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days > 0) return t('usage.inDays', { days, hours });
  if (hours > 0) return t('usage.inHours', { hours, minutes: minutes % 60 });
  return t('usage.inMinutes', { minutes });
}

function UsageRow({ label, percent, limit, sub, aside, thin }: {
  label: string;
  percent: number | null;
  limit: boolean;
  sub?: string;
  /** Right-aligned on the sub line (the reset countdown). */
  aside?: string | null;
  thin?: boolean;
}) {
  const t = useT();
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="rd-usage__row" data-limit={limit || undefined}>
      <div className="rd-usage__line">
        <span className="rd-usage__label">{label}</span>
        <span className="rd-usage__value">{percent === null ? '—' : t('usage.used', { percent: formatPercent(percent) })}</span>
      </div>
      <div
        className={thin ? 'rd-usage__bar rd-usage__bar--thin' : 'rd-usage__bar'}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
      >
        {value ? <span className="rd-usage__fill" style={{ width: `${value}%` }} /> : null}
      </div>
      {sub ? (
        <div className="rd-usage__sub">
          <span>{sub}</span>
          {aside ? <span className="rd-usage__countdown">{aside}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

interface UsagePopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  profileId: ProfileId;
  /** The session in view; without one the Context row is hidden. */
  view?: SessionView;
}

/** Plan usage popover on the bottom-right ring. */
export function UsagePopover({ anchor, open, onClose, profileId, view }: UsagePopoverProps) {
  const controller = useController();
  const t = useT();
  const language = useLanguage();
  const usage = useAppState((s) => s.usage[profileId]);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [style, setStyle] = useState<CSSProperties>({});
  const [loading, setLoading] = useState(false);
  const [, setTick] = useState(0);

  const refresh = (force: boolean): void => {
    setLoading(true);
    void controller.refreshUsage(profileId, force).finally(() => setLoading(false));
  };

  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor?.getBoundingClientRect() ?? { top: 0, right: 0 };
    setStyle({
      width: WIDTH,
      bottom: window.innerHeight - rect.top + GAP,
      right: Math.max(8, window.innerWidth - rect.right),
    });
    ref.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const cached = controller.state.usage[profileId];
    refresh(Boolean(cached && Date.now() - cached.fetchedAt > USAGE_STALE_MS));
  }, [open, profileId]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick((n) => n + 1), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    // Esc also closes when focus fell back to the page (e.g. the retry button went away).
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.activeElement !== document.body) return;
      event.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;

  const closeAndRestore = (): void => {
    onClose();
    anchor?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeAndRestore();
  };

  const now = Date.now();
  const windows = usage?.available ? usage.windows : [];
  const extra = usage?.available && usage.extraUsage?.enabled ? usage.extraUsage : undefined;
  const extraPercent = extra
    ? extra.percent ?? (extra.usedCredits !== null && extra.monthlyLimit ? (extra.usedCredits / extra.monthlyLimit) * 100 : null)
    : null;
  const context = view?.context;

  let status: { text: string; error?: boolean } | null = null;
  if (!usage) status = loading ? { text: t('usage.loading') } : null;
  else if (usage.error) status = { text: t('usage.loadFailed', { message: usage.error }), error: true };
  else if (!usage.available) status = { text: t('usage.unavailable') };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="rd-usage"
      style={style}
      data-testid="usage-popover"
      onKeyDown={onKeyDown}
    >
      <div className="rd-usage__head">
        <h2 id={titleId} className="rd-usage__title">
          {t('usage.title')}
        </h2>
        {loading ? <Spinner small label={t('usage.loading')} /> : null}
        <span className="rd-usage__tools">
          <IconButton
            label={t('usage.contextDetails')}
            icon={<ChartColumn {...ICON_SM} />}
            size="small"
            tipPlace="top"
            onClick={() => {
              onClose();
              controller.revealCard('context');
            }}
          />
          <IconButton
            label={t('accounts.manage')}
            icon={<Settings {...ICON_SM} />}
            size="small"
            tipPlace="top"
            onClick={() => {
              onClose();
              controller.revealCard('accounts');
            }}
          />
        </span>
      </div>
      {windows.map((w) => (
        <UsageRow
          key={w.id}
          label={windowLabel(w.id, t)}
          percent={w.percent}
          limit={windowAtLimit(w, now)}
          sub={w.resetsAt === null ? t(w.resetUnknown ? 'usage.resetUnknown' : 'usage.startsOnSend') : t('usage.resets', { when: formatReset(w.resetsAt, language) })}
          aside={w.resetsAt === null ? null : formatCountdown(w.resetsAt, now, t)}
        />
      ))}
      {extra ? <UsageRow label={t('usage.extra')} percent={extraPercent} limit={extraPercent !== null && extraPercent >= 100} thin /> : null}
      {status ? (
        <p className={status.error ? 'rd-usage__status rd-usage__status--error' : 'rd-usage__status'} role={status.error ? 'alert' : undefined}>
          {status.text}
          {status.error ? (
            <button
              type="button"
              className="rd-link"
              onClick={() => {
                ref.current?.focus({ preventScroll: true });
                refresh(true);
              }}
            >
              {t('common.retry')}
            </button>
          ) : null}
        </p>
      ) : null}
      {view ? (
        <UsageRow
          label={t('context.title')}
          percent={context ? context.percent : null}
          limit={false}
          sub={
            context
              ? t('usage.contextTokens', { used: formatTokens(context.usedTokens), max: formatTokens(context.maxTokens) })
              : t('context.none')
          }
        />
      ) : null}
    </div>,
    document.body,
  );
}
