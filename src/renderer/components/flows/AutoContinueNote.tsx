import { ClockAlert, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { AUTO_CONTINUE_MAX } from '@shared/types';
import { useLanguage, useT } from '../../i18n';
import { useController } from '../../state/context';
import type { SessionView } from '../../state/types';
import { formatReset } from '../prompt/UsagePopover';
import { ICON_SM } from '../ui/primitives';

/** Reset time in the UI language: the time alone today ("3:30 PM", "下午3:30"), else with the date as in the usage popover. */
export function formatResetTime(at: number, language: string, now = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const sameDay =
    day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth() && day.getDate() === today.getDate();
  return sameDay ? new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(at) : formatReset(at, language);
}

/**
 * Above the shortcut bar while a usage limit stopped the turn: the wait for the reset (Cancel), or the reset the computer
 * slept through (Continue / Dismiss). Main sends the resume prompt; this only shows the state and ends it.
 */
export function AutoContinueNote({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const language = useLanguage();
  const [busy, setBusy] = useState(false);
  const state = view.autoContinue;
  if (!state || state.phase === 'idle') return null;

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  if (state.phase === 'native-waiting') {
    return (
      <div className="rd-autocont" role="status" data-testid="auto-continue-note" data-phase="native-waiting">
        <Hourglass {...ICON_SM} className="rd-autocont__icon" />
        <p className="rd-autocont__text">{t('autoContinue.nativeWaiting', { message: state.message })}</p>
        {state.canContinue ? (
          <button type="button" className="rd-btn rd-btn--secondary rd-autocont__btn"
            aria-label={t('autoContinue.continueLabel')} data-tip={t('autoContinue.continueLabel')} data-tip-place="top"
            disabled={busy} onClick={() => run(() => controller.continueAfterLimit(view.key))}>
            {t('common.continue')}
          </button>
        ) : null}
        <button type="button" className="rd-btn rd-btn--ghost rd-autocont__btn"
          aria-label={t('autoContinue.cancelLabel')} data-tip={t('autoContinue.cancelLabel')} data-tip-place="top"
          disabled={busy} onClick={() => run(() => controller.cancelAutoContinue(view.key))}>
          {t('common.cancel')}
        </button>
      </div>
    );
  }
  // A second or third continue may be armed after its reset passed: then the time it goes out is what matters.
  const time = formatResetTime(state.phase === 'waiting' && state.resetsAt <= Date.now() ? state.fireAt : state.resetsAt, language);

  if (state.phase === 'waiting') {
    const text = state.attempt > 1
      ? t('autoContinue.waitingAttempt', { time, attempt: state.attempt, max: AUTO_CONTINUE_MAX })
      : t('autoContinue.waiting', { time });
    return (
      <div className="rd-autocont" role="status" data-testid="auto-continue-note" data-phase="waiting">
        <Hourglass {...ICON_SM} className="rd-autocont__icon" />
        <p className="rd-autocont__text">{text}</p>
        <button
          type="button"
          className="rd-btn rd-btn--ghost rd-autocont__btn"
          aria-label={t('autoContinue.cancelLabel')}
          data-tip={t('autoContinue.cancelLabel')}
          data-tip-place="top"
          disabled={busy}
          onClick={() => run(() => controller.cancelAutoContinue(view.key))}
        >
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  return (
    <div className="rd-autocont" role="status" data-testid="auto-continue-note" data-phase="stale">
      <ClockAlert {...ICON_SM} className="rd-autocont__icon" />
      <p className="rd-autocont__text">{t('autoContinue.stale', { time })}</p>
      <button
        type="button"
        className="rd-btn rd-btn--secondary rd-autocont__btn"
        aria-label={t('autoContinue.continueLabel')}
        data-tip={t('autoContinue.continueLabel')}
        data-tip-place="top"
        disabled={busy}
        onClick={() => run(() => controller.continueAfterLimit(view.key))}
      >
        {t('common.continue')}
      </button>
      <button
        type="button"
        className="rd-btn rd-btn--ghost rd-autocont__btn"
        disabled={busy}
        onClick={() => run(() => controller.cancelAutoContinue(view.key))}
      >
        {t('autoContinue.dismiss')}
      </button>
    </div>
  );
}
