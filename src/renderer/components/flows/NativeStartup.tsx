import type { NativeStartupKey } from '@shared/types';
import { useId, useLayoutEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import type { SessionView } from '../../state/types';

const MENU_KEYS: NativeStartupKey[] = ['up', 'down', 'left', 'right', 'tab', 'escape', 'enter'];
const KEYBOARD_KEYS: Record<string, NativeStartupKey> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'escape',
};

/** A read-only native screen with explicit menu controls, not another chat or login form. */
export function NativeStartup({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const hintId = useId();
  const screenRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    // Native menus live at the terminal's bottom, including after an explicit menu key.
    const followPrompt = (): void => { screen.scrollTop = screen.scrollHeight; };
    followPrompt();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(followPrompt);
    observer?.observe(screen);
    return () => observer?.disconnect();
  }, [view.opening, view.startup?.requestId, view.startup?.revision]);
  if (!view.opening) return null;
  const startup = view.startup;
  const waiting = Boolean(startup?.text.trim());
  const input = (key: NativeStartupKey): void => {
    if (startup) void controller.startupInput(view.key, startup.requestId, { revision: startup.revision, key });
  };

  return (
    <section className="rd-startup" aria-label={t('startup.title')} data-testid="native-startup">
      <h2 className="rd-perm__heading">{t(waiting ? 'startup.title' : 'status.starting')}</h2>
      {waiting ? <>
        <p className="rd-startup__hint" id={hintId}>{t('startup.hint')}</p>
        <pre
          ref={screenRef}
          className="rd-startup__screen"
          role="region"
          aria-label={t('startup.screen')}
          aria-describedby={hintId}
          aria-busy={startup?.inputPending}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            const key = KEYBOARD_KEYS[event.key];
            if (!key) return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) input(key);
          }}
        >{startup!.text}</pre>
        {startup?.error ? <p className="rd-startup__error" role="alert">{startup.error}</p> : null}
      </> : null}
      <footer className="rd-startup__footer" data-testid="native-startup-footer">
        {waiting ? <>
          <div className="rd-startup__keys" role="group" aria-label={t('startup.keys')}>
            {MENU_KEYS.map((key) => (
              <button key={key} type="button" className="rd-btn rd-btn--secondary" disabled={startup?.inputPending} onClick={() => input(key)}>
                {t(`startup.key.${key}`)}
              </button>
            ))}
          </div>
          <p className="rd-startup__hint">{t('startup.accountHint')}</p>
        </> : null}
        <div className="rd-startup__actions">
          {waiting ? <button type="button" className="rd-btn rd-btn--ghost" onClick={() => controller.openSettings(true)}>{t('startup.accounts')}</button> : null}
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => void controller.closeSession(view.key)}>{t('startup.cancel')}</button>
        </div>
      </footer>
    </section>
  );
}
