import { ArrowRightLeft, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { shortId } from '../../lib/format';
import { actionAvailability } from '../../state/availability';
import { useAppState, useController } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { Dialog } from '../ui/Dialog';
import { ICON, ICON_SM, IconButton } from '../ui/primitives';

/** R4 take-over confirmation, shown before Relay resumes a session it did not start. */
export function TakeoverDialog() {
  const controller = useController();
  const t = useT();
  const prompt = useAppState((s) => s.takeover);
  const view = useAppState((s) => (s.takeover ? (s.views[s.takeover.key] ?? null) : null));
  const profiles = useAppState((s) => s.profiles);
  if (!prompt || !view) return null;
  const profile = profiles.find((p) => p.id === view.profileId);
  return (
    <Dialog
      open
      role="alertdialog"
      testId="takeover-dialog"
      icon={<TriangleAlert {...ICON} color="var(--rd-banner-icon)" className="rd-dialog__icon" />}
      title={t('takeover.title')}
      onClose={() => controller.cancelTakeover()}
      footer={
        <>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => controller.cancelTakeover()}>
            {t('takeover.cancel')}
          </button>
          <button type="button" data-autofocus="" className="rd-btn rd-btn--primary" onClick={() => controller.confirmTakeover()}>
            {t('takeover.confirm')}
          </button>
        </>
      }
    >
      <p>{t('takeover.body')}</p>
      <p className="rd-takeover__warn">{t('takeover.warning')}</p>
      <dl className="rd-kv">
        <dt>{t('takeover.session')}</dt>
        <dd>{view.title || (view.sessionId ? shortId(view.sessionId) : '')}</dd>
        <dt>{t('takeover.folder')}</dt>
        <dd className="rd-mono">{view.cwd || '—'}</dd>
        <dt>{t('takeover.account')}</dt>
        <dd>{profile?.name ?? view.profileId}</dd>
      </dl>
      {prompt.pendingText ? (
        <div className="rd-field">
          <span className="rd-field__label">{t('takeover.pending')}</span>
          <blockquote className="rd-takeover__quote">{prompt.pendingText}</blockquote>
        </div>
      ) : null}
    </Dialog>
  );
}

const NOTICE_KEY = 'relay.takeoverNotice';

/** null = never shown; `active:<handleId>` = showing for that take-over; 'done' = never again. */
function readNotice(): string | null {
  try {
    return window.localStorage.getItem(NOTICE_KEY);
  } catch {
    return null;
  }
}

function writeNotice(value: string): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, value);
  } catch {
    // Without storage the notice can show again after a restart; nothing else depends on it.
  }
}

/**
 * One-time warning above the shortcut bar: only for the first confirmed take-over ever, until its
 * × or the end of that take-over; afterwards the hand-back stays in the title menu and the Hand-off card.
 */
export function TakeoverBanner({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const [notice, setNotice] = useState(readNotice);
  const owner = notice?.startsWith('active:') ? notice.slice('active:'.length) : null;
  const ownerOpen = useAppState((s) =>
    owner !== null && Object.values(s.views).some((v) => v.handleId === owner && v.takeover && hasOpenHandle(v)),
  );
  const eligible = view.takeover && hasOpenHandle(view) && Boolean(view.handleId);

  useEffect(() => {
    let next: string | null = null;
    if (notice === null && eligible) next = `active:${view.handleId}`;
    else if (owner !== null && !ownerOpen) next = 'done';
    if (next === null) return;
    writeNotice(next);
    setNotice(next);
  }, [notice, eligible, view.handleId, owner, ownerOpen]);

  if (!eligible || (notice !== null && notice !== `active:${view.handleId}`)) return null;
  const handBack = actionAvailability('handoff.toDesktop', view, activeProfileId);
  const dismiss = (): void => {
    writeNotice('done');
    setNotice('done');
  };
  return (
    <div className="rd-banner" role="status" data-testid="takeover-banner">
      <TriangleAlert {...ICON} className="rd-banner__icon" />
      <p className="rd-banner__title" data-tip={t('banner.desc')} data-tip-place="top">
        {t('banner.title')}
      </p>
      <button
        type="button"
        className="rd-btn rd-btn--primary"
        disabled={!handBack.ok}
        data-tip={handBack.ok ? `${t('banner.desc')}\nclaude --desktop --resume <id>` : t(handBack.reason)}
        data-tip-place="top"
        onClick={() => void controller.handBack(view.key)}
      >
        <ArrowRightLeft size={14} strokeWidth={1.75} aria-hidden />
        {t('handoff.toDesktop')}
      </button>
      <IconButton
        label={t('banner.dismiss')}
        icon={<X {...ICON_SM} />}
        size="small"
        muted
        tipPlace="top"
        className="rd-banner__close"
        onClick={dismiss}
      />
    </div>
  );
}

/** Explains that a listed session is shown read-only until the user takes it over. */
export function ReadOnlyNote({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  if (view.launch && !hasOpenHandle(view) && !view.opening) {
    // AS-2: a link opened this folder; say where (and with which account) before anything runs.
    const params = { folder: view.launch.cwd, account: view.launch.account ?? '' };
    return (
      <div className="rd-readonly" role="status" data-testid="launch-note">
        <span>{t(view.launch.account ? 'launch.newNoteAccount' : 'launch.newNote', params)}</span>
      </div>
    );
  }
  if (!view.sessionId || view.isNew || view.sideChatOf || hasOpenHandle(view) || view.opening) return null;
  return (
    <div className="rd-readonly" data-testid="readonly-note">
      <span>{view.handedOff?.ok ? t('readonly.handedBack') : t('readonly.note')}</span>
      {view.cwd ? (
        <button type="button" className="rd-link" onClick={() => void controller.takeOver(view.key, 'menu')}>
          {t('session.takeOver')}
        </button>
      ) : null}
    </div>
  );
}
