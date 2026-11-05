import { useEffect, useState } from 'react';
import { AppShell } from './components/shell/AppShell';
import { I18nProvider } from './i18n';
import { AppController } from './state/controller';
import { ControllerProvider } from './state/context';
import { useStoreValue } from './state/store';

/** Root: one controller over window.relay (preload in Electron, mock in dev:web and tests). */
export function App({ controller: injected }: { controller?: AppController } = {}) {
  const [controller] = useState(() => injected ?? new AppController(window.relay));
  const language = useStoreValue(controller.store, (s) => s.settings.language);
  useEffect(() => controller.start(), [controller]);
  return (
    <ControllerProvider controller={controller}>
      <I18nProvider language={language}>
        <AppShell />
      </I18nProvider>
    </ControllerProvider>
  );
}
