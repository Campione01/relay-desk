import { useEffect } from 'react';
import { DEFAULT_PROFILE_ID, type Profile, type SharedCodeContextReport } from '@shared/types';
import { useT } from '../../i18n';
import { useAppState, useController, useCurrentView } from '../../state/context';
import { Dialog } from '../ui/Dialog';

function ContextReport({ report }: { report: SharedCodeContextReport }) {
  const t = useT();
  const observed = (value: boolean | undefined): string => value === undefined ? t('codeContext.unknown') : t(value ? 'codeContext.yes' : 'codeContext.no');
  return (
    <>
      <p>{t(report.mode === 'default' ? 'codeContext.mode.default' : 'codeContext.mode.shared')}</p>
      <p className="rd-card__note">{t('codeContext.preset')}</p>
      <p className="rd-card__note">{t('codeContext.credentials')}</p>
      <dl className="rd-context-details">
        <div><dt>{t('codeContext.configDirectory')}</dt><dd className="rd-context-path">{report.configDirectory}</dd></div>
        <div><dt>{t('codeContext.globalRoot')}</dt><dd className="rd-context-path">{report.globalRoot}</dd></div>
      </dl>
      <section className="rd-settings__section" aria-label={t('codeContext.entries')}>
        <h3 className="rd-settings__heading">{t('codeContext.entries')}</h3>
        <ul className="rd-card__rows">
          {report.entries.map((entry) => (
            <li key={entry.kind} className="rd-memory-file" data-testid={`context-entry-${entry.kind}`}>
              <strong>{t(`codeContext.kind.${entry.kind}`)}</strong>{' · '}{t(`codeContext.state.${entry.state}`)}
              <dl className="rd-context-details">
                <div><dt>{t('codeContext.source')}</dt><dd className="rd-context-path">{entry.sourcePath}</dd></div>
                <div><dt>{t('codeContext.target')}</dt><dd className="rd-context-path">{entry.targetPath}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      </section>
      <section className="rd-settings__section" aria-label={t('codeContext.memory')}>
        <h3 className="rd-settings__heading">{t('codeContext.memory')}</h3>
        <p className="rd-card__note">{t('codeContext.expectedOnly')}</p>
        <dl className="rd-context-details">
          <div><dt>{t('codeContext.memoryDirectory')}</dt><dd className="rd-context-path">{report.memory.directory ?? t('codeContext.noWorkingFolder')}</dd></div>
          <div><dt>{t('codeContext.memoryShared')}</dt><dd>{observed(report.memory.shared)}</dd></div>
          <div><dt>{t('codeContext.memoryEnabled')}</dt><dd>{observed(report.memory.enabled)}</dd></div>
          <div><dt>{t('codeContext.memoryIndex')}</dt><dd>{observed(report.memory.indexExists)}</dd></div>
        </dl>
      </section>
      <section className="rd-settings__section" aria-label={t('codeContext.permissions')}>
        <h3 className="rd-settings__heading">{t('codeContext.permissions')}</h3>
        {report.permissions ? (
          <p>{t('codeContext.permissionCounts', report.permissions)}<br />{t('codeContext.defaultMode')}: {report.permissions.defaultMode ?? t('codeContext.unknown')}</p>
        ) : <p className="rd-card__note">{t('codeContext.unknown')}</p>}
      </section>
      {report.warnings.length > 0 ? (
        <section className="rd-settings__section" aria-label={t('codeContext.warnings')}>
          <h3 className="rd-settings__heading">{t('codeContext.warnings')}</h3>
          <ul>{report.warnings.map((warning, index) => <li key={index} className="rd-context-path">{warning}</li>)}</ul>
        </section>
      ) : null}
      <p className="rd-card__note">{t('codeContext.noCloudSync')}</p>
    </>
  );
}

/** EC-2: per-account sharing switch and the "stop sharing" cleanup, for independent accounts only. */
function SharingControls({ profile, busy, unshared }: { profile: Profile; busy: boolean; unshared?: { kept: string[] } }) {
  const controller = useController();
  const t = useT();
  return (
    <section className="rd-settings__section" aria-label={t('codeContext.sharing')}>
      <label className="rd-check">
        <input
          type="checkbox"
          role="switch"
          checked={profile.sharedCodeContext !== false}
          disabled={busy}
          onChange={(event) => void controller.setSharedCodeContext(profile.id, event.target.checked)}
        />
        <span>{t('codeContext.sharing')}</span>
      </label>
      <p className="rd-card__note">{t('codeContext.sharingHint')}</p>
      <button type="button" className="rd-btn rd-btn--secondary" disabled={busy} onClick={() => void controller.unshareCodeContext(profile.id)}>
        {t('codeContext.unshare')}
      </button>
      {unshared ? (
        <div role="status" data-testid="unshare-result">
          <p>{t('codeContext.unsharedDone')}</p>
          {unshared.kept.length > 0 ? (
            <>
              <p>{t('codeContext.unsharedKept')}</p>
              <ul>{unshared.kept.map((line, index) => <li key={index} className="rd-context-path">{line}</li>)}</ul>
            </>
          ) : <p>{t('codeContext.unsharedNothingKept')}</p>}
        </div>
      ) : null}
    </section>
  );
}

export function CodeContextDialog() {
  const controller = useController();
  const t = useT();
  const inspection = useAppState((state) => state.codeContext);
  const profiles = useAppState((state) => state.profiles);
  const activeProfileId = useAppState((state) => state.activeProfileId);
  const view = useCurrentView();
  const profileId = view?.profileId ?? activeProfileId;
  const cwd = view?.cwd || undefined;
  useEffect(() => {
    if (inspection && (inspection.profileId !== profileId || inspection.cwd !== cwd)) {
      void controller.inspectCodeContext(profileId, cwd);
    }
  }, [controller, inspection?.profileId, inspection?.cwd, profileId, cwd]);
  if (!inspection) return null;
  const profile = profiles.find((p) => p.id === inspection.profileId);
  const name = profile?.name ?? inspection.profileId;
  const independent = profile && profile.id !== DEFAULT_PROFILE_ID && profile.configDir;
  return (
    <Dialog
      open
      size="medium"
      title={t('codeContext.title')}
      onClose={() => controller.closeCodeContext()}
      testId="code-context-dialog"
      footer={
        <>
          <button type="button" className="rd-btn rd-btn--secondary" disabled={inspection.state === 'loading'} onClick={() => void controller.inspectCodeContext(profileId, cwd)}>
            {t(inspection.state === 'error' ? 'common.retry' : 'common.refresh')}
          </button>
          <button type="button" className="rd-btn rd-btn--primary" onClick={() => controller.closeCodeContext()}>{t('common.close')}</button>
        </>
      }
    >
      <p className="rd-context-path">{t('codeContext.scope', { name, id: inspection.profileId })}<br />{inspection.cwd ?? t('env.noFolder')}</p>
      {independent ? <SharingControls profile={profile} busy={Boolean(inspection.busy)} unshared={inspection.unshared} /> : null}
      {inspection.state === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {inspection.state === 'error' ? <p role="alert" className="rd-context-path">{inspection.error}</p> : null}
      {inspection.state === 'loaded' && inspection.report ? <ContextReport report={inspection.report} /> : null}
    </Dialog>
  );
}
