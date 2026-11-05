import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import type { AppSettings } from '@shared/types';
import { readJsonFile, writeJsonFileAtomic, type JsonRead } from './system/jsonFile';

type Language = AppSettings['language'];

export type CloseAction = 'allow' | 'hide' | 'quit';

export interface CloseState {
  /** The engines are closed and the app is leaving: let the window go. */
  shutdownApproved: boolean;
  /** Windows is logging off or shutting down. */
  sessionEnding: boolean;
  trayAvailable: boolean;
}

/**
 * What the window close button (and Alt+F4) does. With a tray icon the window only hides; without one nobody could
 * bring it back, so it goes through the normal quit path as before.
 */
export function decideWindowClose(state: CloseState): CloseAction {
  if (state.shutdownApproved) return 'allow';
  if (state.sessionEnding || !state.trayAvailable) return 'quit';
  return 'hide';
}

/** The app quits when the last window is gone only if no tray icon keeps it alive. */
export function quitWhenAllWindowsClosed(trayAvailable: boolean): boolean {
  return !trayAvailable;
}

interface TrayText {
  tooltip: string;
  show: string;
  exit: string;
  noticeTitle: string;
  noticeBody: string;
}

const TEXT: Record<Language, TrayText> = {
  'zh-TW': {
    tooltip: 'Relay Desk',
    show: '顯示 Relay Desk',
    exit: '結束',
    noticeTitle: 'Relay Desk 仍在執行',
    noticeBody: '視窗已縮到通知區域的圖示，對話與背景工作會繼續進行。要完全結束，請在圖示上按右鍵並選「結束」。',
  },
  en: {
    tooltip: 'Relay Desk',
    show: 'Show Relay Desk',
    exit: 'Exit',
    noticeTitle: 'Relay Desk is still running',
    noticeBody: 'The window moved to the notification-area icon. Sessions and background work keep running. To quit, right-click the icon and choose Exit.',
  },
};

export function trayText(language: Language): TrayText {
  return TEXT[language] ?? TEXT.en;
}

/** Pure: the right-click menu of the tray icon. */
export function buildTrayMenuTemplate(language: Language, actions: { show(): void; exit(): void }): MenuItemConstructorOptions[] {
  const text = trayText(language);
  return [
    { label: text.show, click: () => actions.show() },
    { type: 'separator' },
    { label: text.exit, click: () => actions.exit() },
  ];
}

/**
 * Packaged builds do not ship build/, so electron-builder.yml copies the icon next to the app resources
 * (extraResources) and the tray reads it from there; a copied .ico keeps every size, unlike the
 * single bitmap app.getFileIcon() returns for the executable.
 */
export function trayIconPath(env: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return env.isPackaged ? join(env.resourcesPath, 'icon.ico') : join(env.appPath, 'build', 'icon.ico');
}

// ---------- one-time notice ----------

const NOTICE_FILE = 'tray-notice.json';

export interface TrayNoticeStore {
  /** True the first time it is asked (and remembers that); false afterwards, also when the file cannot be written. */
  claim(): Promise<boolean>;
}

/** Pure: whether a stored notice file says the notice was shown. */
export function noticeAlreadyShown(read: JsonRead): boolean {
  if (read.state !== 'ok') return false;
  const value = read.value;
  return !!value && typeof value === 'object' && (value as { shown?: unknown }).shown === true;
}

export function createTrayNoticeStore(userDataDir: string): TrayNoticeStore {
  const file = join(userDataDir, NOTICE_FILE);
  let claimed = false;
  return {
    async claim() {
      if (claimed) return false;
      claimed = true;
      try {
        if (noticeAlreadyShown(await readJsonFile(file))) return false;
        await writeJsonFileAtomic(file, { version: 1, shown: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------- controller ----------

export interface TrayLike {
  on(event: 'click' | 'double-click' | 'right-click', listener: () => void): unknown;
  setToolTip(tooltip: string): void;
  popUpContextMenu(menu: unknown): void;
  displayBalloon?(options: { title: string; content: string }): void;
  destroy(): void;
}

export interface TrayHost {
  /** Throws when the icon cannot be loaded, so an invisible tray never swallows the window. */
  createTray(iconPath: string): TrayLike;
  buildMenu(template: MenuItemConstructorOptions[]): unknown;
}

export interface TrayDeps {
  host: TrayHost;
  iconPath: string;
  getLanguage(): Promise<Language>;
  notices: TrayNoticeStore;
  onShow(): void;
  onExit(): void;
}

export interface TrayController {
  /** False when the icon could not be created: the window then closes the old way. */
  available(): boolean;
  /** Shows the first-hide notice once per installation. */
  noteHidden(): Promise<void>;
  destroy(): void;
}

export function createTrayController(deps: TrayDeps): TrayController {
  let tray: TrayLike | null = null;
  try {
    tray = deps.host.createTray(deps.iconPath);
  } catch (error) {
    console.error('[relay] tray icon unavailable; closing the window will quit', error);
  }

  if (tray) {
    const icon = tray;
    icon.setToolTip(trayText('en').tooltip);
    icon.on('click', deps.onShow);
    icon.on('double-click', deps.onShow);
    // Built on demand so the labels follow a language change made while running.
    icon.on('right-click', () => {
      void deps.getLanguage().then((language) => {
        icon.popUpContextMenu(deps.host.buildMenu(buildTrayMenuTemplate(language, { show: deps.onShow, exit: deps.onExit })));
      });
    });
  }

  return {
    available: () => tray !== null,
    async noteHidden() {
      const icon = tray;
      if (!icon || !(await deps.notices.claim())) return;
      const text = trayText(await deps.getLanguage());
      icon.displayBalloon?.({ title: text.noticeTitle, content: text.noticeBody });
    },
    destroy() {
      tray?.destroy();
      tray = null;
    },
  };
}
