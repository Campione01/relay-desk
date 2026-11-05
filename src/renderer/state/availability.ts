import type { ShortcutAction } from '@shared/shortcuts';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import type { MessageKey } from '../i18n';
import { hasOpenHandle, isActiveState } from './sessionReducer';
import type { SessionView } from './types';

export type Availability = { ok: true } | { ok: false; reason: MessageKey };

const OK: Availability = { ok: true };
const no = (reason: MessageKey): Availability => ({ ok: false, reason });

/** Whether an action can run for the current view, and why not. Shared by the Hand-off card and the shortcut bar. */
export function actionAvailability(action: ShortcutAction, view: SessionView | null, activeProfileId: string): Availability {
  const profileId = view?.profileId ?? activeProfileId;
  const hasFolder = Boolean(view?.cwd);
  const hasSession = Boolean(view?.sessionId);
  // A side chat is an unsaved fork: nothing can be handed off from it.
  if (view?.sideChatOf && action.startsWith('handoff.')) return no('reason.sideChat');
  switch (action) {
    case 'handoff.toDesktop':
      if (!hasSession) return no('reason.noSession');
      if (profileId !== DEFAULT_PROFILE_ID) return no('reason.defaultOnly');
      return OK;
    case 'handoff.openFolderInDesktop':
      if (!hasFolder) return no('reason.noFolder');
      if (profileId !== DEFAULT_PROFILE_ID) return no('reason.defaultOnly');
      return OK;
    case 'handoff.openInTerminal':
    case 'handoff.openInTerminalFork':
      return hasSession ? OK : no('reason.noSession');
    case 'handoff.continueLatestInTerminal':
    case 'handoff.toCloud':
    case 'handoff.teleport':
    case 'handoff.remoteControl':
    case 'session.newInFolder':
      return hasFolder ? OK : no('reason.noFolder');
    // Like the desktop's "Model · this session": a pick before the open is remembered and sent with it.
    case 'ui.modelPicker':
    case 'ui.effortPicker':
    case 'ui.permissionPicker':
      return view ? OK : no('reason.noSession');
    case 'session.interrupt':
      return view && isActiveState(view.engineState) ? OK : no('reason.notRunning');
    default:
      return OK;
  }
}

/** Like main's engine/ipc.ts normalizedCwd: one separator style, no trailing separators, case-insensitive. */
export function normalizeFolder(cwd: string): string {
  return cwd.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Views whose Relay handle main closes before running the action (R4: confirm first). Continue latest closes every
 * writer of the account in the folder; the others close any writer of the same session id in the account.
 */
export function viewsClosedBy(action: ShortcutAction, view: SessionView | null, views: Iterable<SessionView>): SessionView[] {
  if (!view) return [];
  // Side chats run unsaved forks and never write a session, so they are not writers here.
  const open = [...views].filter((v) => hasOpenHandle(v) && !v.sideChatOf && v.profileId === view.profileId);
  if (action === 'handoff.continueLatestInTerminal') {
    if (!view.cwd) return [];
    const folder = normalizeFolder(view.cwd);
    return open.filter((v) => Boolean(v.cwd) && normalizeFolder(v.cwd) === folder);
  }
  if (!view.sessionId) return [];
  if (action !== 'handoff.toDesktop' && action !== 'handoff.openInTerminal' && action !== 'handoff.remoteControl') return [];
  const id = view.sessionId.toLowerCase();
  return open.filter((v) => v.sessionId?.toLowerCase() === id);
}

export function actionClosesSession(action: ShortcutAction, view: SessionView | null, views: Iterable<SessionView> = view ? [view] : []): boolean {
  return viewsClosedBy(action, view, views).length > 0;
}
