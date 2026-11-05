import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrayMenuTemplate,
  createTrayController,
  createTrayNoticeStore,
  decideWindowClose,
  noticeAlreadyShown,
  quitWhenAllWindowsClosed,
  trayIconPath,
  type TrayHost,
  type TrayLike,
  type TrayNoticeStore,
} from '../../src/main/tray';

const base = { shutdownApproved: false, sessionEnding: false, trayAvailable: true };

describe('decideWindowClose', () => {
  it('hides the window instead of closing it while the tray icon exists', () => {
    expect(decideWindowClose(base)).toBe('hide');
  });

  it('goes through the quit path when there is no tray icon to bring the window back', () => {
    expect(decideWindowClose({ ...base, trayAvailable: false })).toBe('quit');
  });

  it('quits when Windows logs off or shuts down, even with a tray icon', () => {
    expect(decideWindowClose({ ...base, sessionEnding: true })).toBe('quit');
  });

  it('lets the window go once the engines are closed', () => {
    expect(decideWindowClose({ ...base, shutdownApproved: true })).toBe('allow');
    expect(decideWindowClose({ shutdownApproved: true, sessionEnding: true, trayAvailable: false })).toBe('allow');
  });
});

describe('quitWhenAllWindowsClosed', () => {
  it('keeps running only while the tray icon exists', () => {
    expect(quitWhenAllWindowsClosed(true)).toBe(false);
    expect(quitWhenAllWindowsClosed(false)).toBe(true);
  });
});

describe('buildTrayMenuTemplate', () => {
  it('has Show and Exit in the saved language and calls the matching action', () => {
    const actions = { show: vi.fn(), exit: vi.fn() };
    const zh = buildTrayMenuTemplate('zh-TW', actions);
    expect(zh.filter((item) => item.type !== 'separator').map((item) => item.label)).toEqual(['顯示 Relay Desk', '結束']);
    const en = buildTrayMenuTemplate('en', actions);
    expect(en.filter((item) => item.type !== 'separator').map((item) => item.label)).toEqual(['Show Relay Desk', 'Exit']);

    en[0]!.click!({} as never, undefined, {} as never);
    expect(actions.show).toHaveBeenCalledTimes(1);
    expect(actions.exit).not.toHaveBeenCalled();
    en[en.length - 1]!.click!({} as never, undefined, {} as never);
    expect(actions.exit).toHaveBeenCalledTimes(1);
  });

  it('falls back to English for a language it does not know', () => {
    const menu = buildTrayMenuTemplate('fr' as never, { show: vi.fn(), exit: vi.fn() });
    expect(menu.filter((item) => item.type !== 'separator').map((item) => item.label)).toEqual(['Show Relay Desk', 'Exit']);
  });
});

describe('trayIconPath', () => {
  it('reads build/icon.ico in development and the copied resource when packaged', () => {
    const env = { resourcesPath: 'C:\\App\\resources', appPath: 'D:\\dev\\relay-desk' };
    expect(trayIconPath({ ...env, isPackaged: false })).toBe(join('D:\\dev\\relay-desk', 'build', 'icon.ico'));
    expect(trayIconPath({ ...env, isPackaged: true })).toBe(join('C:\\App\\resources', 'icon.ico'));
  });
});

describe('tray notice store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-tray-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('claims once, persists it in userData and stays claimed in a new process', async () => {
    expect(await createTrayNoticeStore(dir).claim()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'tray-notice.json'), 'utf8'))).toMatchObject({ shown: true });
    expect(await createTrayNoticeStore(dir).claim()).toBe(false);
  });

  it('does not claim twice in one process', async () => {
    const store = createTrayNoticeStore(dir);
    expect(await store.claim()).toBe(true);
    expect(await store.claim()).toBe(false);
  });

  it('claims again when the stored file is unreadable or says not shown', async () => {
    writeFileSync(join(dir, 'tray-notice.json'), '{not json');
    expect(await createTrayNoticeStore(dir).claim()).toBe(true);
    writeFileSync(join(dir, 'tray-notice.json'), JSON.stringify({ shown: false }));
    expect(await createTrayNoticeStore(dir).claim()).toBe(true);
  });

  it('recognises only an explicit shown flag', () => {
    expect(noticeAlreadyShown({ state: 'missing' })).toBe(false);
    expect(noticeAlreadyShown({ state: 'invalid' })).toBe(false);
    expect(noticeAlreadyShown({ state: 'ok', value: null })).toBe(false);
    expect(noticeAlreadyShown({ state: 'ok', value: { shown: 'yes' } })).toBe(false);
    expect(noticeAlreadyShown({ state: 'ok', value: { shown: true } })).toBe(true);
  });
});

function fakeTray() {
  const listeners = new Map<string, () => void>();
  const tray = {
    on: vi.fn((event: string, listener: () => void) => void listeners.set(event, listener)),
    setToolTip: vi.fn(),
    popUpContextMenu: vi.fn(),
    displayBalloon: vi.fn(),
    destroy: vi.fn(),
  };
  return { tray, listeners };
}

function setup(options: { language?: 'zh-TW' | 'en'; claim?: boolean; createFails?: boolean } = {}) {
  const { tray, listeners } = fakeTray();
  let language = options.language ?? 'zh-TW';
  const host: TrayHost = {
    createTray: vi.fn(() => {
      if (options.createFails) throw new Error('no icon');
      return tray as unknown as TrayLike;
    }),
    buildMenu: vi.fn((template) => ({ template })),
  };
  const notices: TrayNoticeStore = { claim: vi.fn(async () => options.claim ?? true) };
  const onShow = vi.fn();
  const onExit = vi.fn();
  const controller = createTrayController({
    host,
    iconPath: 'icon.ico',
    getLanguage: async () => language,
    notices,
    onShow,
    onExit,
  });
  return { controller, tray, listeners, host, notices, onShow, onExit, setLanguage: (l: 'zh-TW' | 'en') => (language = l) };
}

describe('createTrayController', () => {
  it('creates the icon from the given path and shows the window on click and double click', () => {
    const t = setup();
    expect(t.host.createTray).toHaveBeenCalledWith('icon.ico');
    expect(t.controller.available()).toBe(true);
    t.listeners.get('click')!();
    t.listeners.get('double-click')!();
    expect(t.onShow).toHaveBeenCalledTimes(2);
    expect(t.onExit).not.toHaveBeenCalled();
  });

  it('pops up the menu in the current language on right click, with working Show and Exit', async () => {
    const t = setup({ language: 'zh-TW' });
    t.setLanguage('en');
    t.listeners.get('right-click')!();
    await vi.waitFor(() => expect(t.tray.popUpContextMenu).toHaveBeenCalledTimes(1));
    const menu = t.tray.popUpContextMenu.mock.calls[0]![0] as { template: Array<{ label?: string; click?: () => void }> };
    const labels = menu.template.filter((item) => item.label).map((item) => item.label);
    expect(labels).toEqual(['Show Relay Desk', 'Exit']);
    menu.template.find((item) => item.label === 'Exit')!.click!();
    expect(t.onExit).toHaveBeenCalledTimes(1);
  });

  it('is unavailable, and the close button then quits, when the icon cannot be created', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({ createFails: true });
    expect(t.controller.available()).toBe(false);
    expect(decideWindowClose({ ...base, trayAvailable: t.controller.available() })).toBe('quit');
  });

  it('shows the keeps-running balloon on the first hide only, in the saved language', async () => {
    const first = setup({ language: 'en', claim: true });
    await first.controller.noteHidden();
    expect(first.tray.displayBalloon).toHaveBeenCalledTimes(1);
    expect(first.tray.displayBalloon.mock.calls[0]![0]).toMatchObject({ title: 'Relay Desk is still running' });

    const later = setup({ claim: false });
    await later.controller.noteHidden();
    expect(later.tray.displayBalloon).not.toHaveBeenCalled();
  });

  it('destroys the icon and reports unavailable afterwards', () => {
    const t = setup();
    t.controller.destroy();
    expect(t.tray.destroy).toHaveBeenCalledTimes(1);
    expect(t.controller.available()).toBe(false);
  });
});
