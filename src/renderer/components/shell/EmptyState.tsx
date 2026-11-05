import { Folder, FolderOpen, MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import { useLanguage, useT } from '../../i18n';
import { folderName, middleTruncate } from '../../lib/format';
import { useAppState, useController } from '../../state/context';
import { ICON } from '../ui/primitives';

const RECENT_SESSIONS = 5;
const RECENT_FOLDERS = 6;

function useRelativeTime(): (ts: number) => string {
  const language = useLanguage();
  return useMemo(() => {
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
    return (ts: number) => {
      const diff = (ts - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (abs < 60) return format.format(Math.round(diff), 'second');
      if (abs < 3600) return format.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return format.format(Math.round(diff / 3600), 'hour');
      return format.format(Math.round(diff / 86400), 'day');
    };
  }, [language]);
}

/** New-session page (§6.5): greeting, folder picker, recent folders and sessions. */
export function EmptyState() {
  const controller = useController();
  const t = useT();
  const sessions = useAppState((s) => s.sessions);
  const folders = useAppState((s) => s.settings.recentFolders);
  const relative = useRelativeTime();
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, RECENT_SESSIONS),
    [sessions],
  );

  return (
    <div className="rd-home" data-testid="home">
      <div className="rd-home__inner">
        <h1 className="rd-home__greeting">{t('home.greeting')}</h1>
        <p className="rd-home__lead">{t('home.lead')}</p>
        <div>
          <button type="button" className="rd-btn rd-btn--primary rd-home__pick" onClick={() => void controller.pickFolderAndStart()}>
            <FolderOpen {...ICON} />
            {t('home.pickFolder')}
          </button>
        </div>
        {folders.length > 0 ? (
          <section className="rd-home__section" aria-labelledby="home-folders">
            <h2 id="home-folders" className="rd-home__heading">
              {t('home.recentFolders')}
            </h2>
            <ul className="rd-home__list">
              {folders.slice(0, RECENT_FOLDERS).map((folder) => (
                <li key={folder}>
                  <button type="button" className="rd-home__row" onClick={() => void controller.newSession(folder)}>
                    <Folder {...ICON} />
                    <span className="rd-home__row-title">{folderName(folder) || folder}</span>
                    <span className="rd-home__row-meta" title={folder}>
                      {middleTruncate(folder, 48)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {recent.length > 0 ? (
          <section className="rd-home__section" aria-labelledby="home-sessions">
            <h2 id="home-sessions" className="rd-home__heading">
              {t('home.recentSessions')}
            </h2>
            <ul className="rd-home__list">
              {recent.map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className="rd-home__row"
                    title={session.title || session.sessionId}
                    data-tip={session.title || session.sessionId}
                    onClick={() => controller.openSummary(session)}
                  >
                    <MessageSquare {...ICON} />
                    <span className="rd-home__row-title">{session.title || session.sessionId}</span>
                    <span className="rd-home__row-meta">
                      {folderName(session.cwd)}
                      {folderName(session.cwd) ? ' · ' : ''}
                      {relative(session.lastModified)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
