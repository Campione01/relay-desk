// Loaded first by vite.web.config.ts (npm run dev:web) so the app sees window.relay as in Electron.
// URL options: ?demo=0 turns the scripted turn off; ?launch=resume opens the take-over flow for the
// main fixture session, as if the desktop mod had launched Relay Desk; ?lang=en and ?theme=dark seed
// the settings.
import { createMockApi } from './api';
import { MAIN_SESSION_ID, MOCK_SESSIONS } from './fixtures';

const params = new URLSearchParams(window.location.search);
const main = MOCK_SESSIONS.find((s) => s.sessionId === MAIN_SESSION_ID);
const theme = params.get('theme');

window.relay = createMockApi({
  demo: params.get('demo') !== '0',
  latencyMs: 40,
  settings: {
    ...(params.get('lang') === 'en' ? { language: 'en' as const } : {}),
    ...(theme === 'dark' || theme === 'light' ? { theme } : {}),
    defaultEffort: 'xhigh',
    defaultPermissionMode: 'bypassPermissions',
    recentFolders: ['D:\\demos\\relay-desk', 'D:\\work\\business', 'D:\\notes\\reading'],
  },
  launchRequest:
    params.get('launch') === 'resume' && main
      ? { action: 'resume', sessionId: main.sessionId, cwd: main.cwd, profileId: 'default' }
      : null,
});
