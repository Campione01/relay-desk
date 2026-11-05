import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SID = '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01';

const h = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: Array<{
    options: Record<string, unknown>;
    handlers: Map<string, (...args: unknown[]) => unknown>;
    openHandler?: (details: { url: string }) => { action: string };
    restore: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeTray {
    handlers = new Map<string, () => void>();
    constructor(public image: unknown) {
      trays.push(this);
    }
    on = vi.fn((event: string, cb: () => void) => void this.handlers.set(event, cb));
    setToolTip = vi.fn();
    popUpContextMenu = vi.fn();
    displayBalloon = vi.fn();
    destroy = vi.fn();
  }
  class FakeBrowserWindow {
    webContents: Record<string, unknown>;
    restore = vi.fn();
    focus = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    record: (typeof windows)[number];
    constructor(options: Record<string, unknown>) {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      this.record = { options, handlers, restore: this.restore, focus: this.focus, show: this.show, hide: this.hide };
      windows.push(this.record);
      this.webContents = {
        on: (event: string, cb: (...args: unknown[]) => unknown) => handlers.set(event, cb),
        setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => (this.record.openHandler = fn),
        getURL: () => 'file:///app/index.html',
        send: vi.fn(),
        copyImageAt: vi.fn(),
        isLoading: () => false,
      };
    }
    once = vi.fn();
    on = vi.fn((event: string, cb: (...args: unknown[]) => unknown) => this.record.handlers.set(`window:${event}`, cb));
    isDestroyed = () => false;
    isMinimized = () => true;
    isVisible = () => true;
    loadURL = vi.fn(async () => {});
    loadFile = vi.fn(async () => {});
  }
  const trays: FakeTray[] = [];
  const clipboard = { writeText: vi.fn() };
  const popups: Array<{ template: Array<Record<string, unknown>> }> = [];
  const permissionHandlers: { request?: (...a: unknown[]) => void; check?: (...a: unknown[]) => boolean } = {};
  const electron = {
    app: {
      requestSingleInstanceLock: vi.fn(() => true),
      setAppUserModelId: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(() => true),
      getAppPath: () => 'D:\\dev\\relay-desk',
      getPath: vi.fn(() => ''),
      isPackaged: false,
      on: (event: string, cb: (...args: unknown[]) => unknown) => appHandlers.set(event, cb),
      whenReady: () => Promise.resolve(),
      quit: vi.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template: Array<Record<string, unknown>>) => ({
        template,
        popup: vi.fn(() => void popups.push({ template })),
      }),
      setApplicationMenu: vi.fn(),
    },
    nativeImage: { createFromPath: (path: string) => ({ path, isEmpty: () => false }) },
    clipboard,
    ipcMain: { handle: vi.fn() },
    nativeTheme: {
      themeSource: 'system',
      get shouldUseDarkColors() {
        return this.themeSource === 'dark';
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (fn: (...a: unknown[]) => void) => (permissionHandlers.request = fn),
        setPermissionCheckHandler: (fn: (...a: unknown[]) => boolean) => (permissionHandlers.check = fn),
      },
    },
    shell: { openExternal: vi.fn(async () => {}) },
  };
  const pushLaunchRequest = vi.fn();
  const isAccountBusy = vi.fn(() => false);
  const shutdownAuth = vi.fn(async () => undefined);
  const claudeAiSignIn = vi.fn((_profile: unknown) => false);
  const registerSystemIpc = vi.fn(() => ({ pushLaunchRequest, isAccountBusy, claudeAiSignIn, shutdown: shutdownAuth }));
  const closeAll = vi.fn(async () => {});
  const prepareSharedCodeContext = vi.fn();
  const registerEngineIpc = vi.fn(() => ({ close: async () => {}, findBySession: () => undefined, findByCwd: () => [], findByProfile: () => [], closeAll }));
  const createNativeServices = vi.fn();
  return { appHandlers, windows, trays, popups, clipboard, electron, pushLaunchRequest, registerSystemIpc, registerEngineIpc, isAccountBusy, claudeAiSignIn, closeAll, shutdownAuth, prepareSharedCodeContext, permissionHandlers, createNativeServices };
});

vi.mock('electron', () => h.electron);
vi.mock('../../src/main/engine/ipc', () => ({ registerEngineIpc: h.registerEngineIpc }));
vi.mock('../../src/main/system/ipc', () => ({ registerSystemIpc: h.registerSystemIpc }));
vi.mock('../../src/main/system/sharedCodeContext', () => ({ prepareSharedCodeContext: h.prepareSharedCodeContext }));
vi.mock('../../src/main/native/prototypeServices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/native/prototypeServices')>();
  h.createNativeServices.mockImplementation(actual.createNativeServices);
  return { ...actual, createNativeServices: h.createNativeServices };
});

// Mock call records are cleared between hooks and tests here, so start-up calls are copied out.
let protocolCalls: unknown[][] = [];
let systemIpcCalls: unknown[][] = [];
let engineIpcCalls: unknown[][] = [];
let nativeServiceCalls: unknown[][] = [];
let startupPreparationCalls = -1;
let applicationMenuCalls = -1;
let userData: string;

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'relay-main-'));
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  h.electron.app.getPath.mockReturnValue(userData);
  process.env.ANTHROPIC_API_KEY = 'host-secret';
  (process as { defaultApp?: boolean }).defaultApp = true;
  process.argv.push('--resume', SID, '--cwd', 'D:\\demos\\x');
  try {
    await import('../../src/main/index');
  } finally {
    process.argv.splice(-4, 4);
    delete (process as { defaultApp?: boolean }).defaultApp;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  protocolCalls = h.electron.app.setAsDefaultProtocolClient.mock.calls.map((c) => [...(c as unknown[])]);
  systemIpcCalls = h.registerSystemIpc.mock.calls.map((c) => [...(c as unknown[])]);
  engineIpcCalls = h.registerEngineIpc.mock.calls.map((c) => [...(c as unknown[])]);
  nativeServiceCalls = h.createNativeServices.mock.calls.map((c) => [...(c as unknown[])]);
  startupPreparationCalls = h.prepareSharedCodeContext.mock.calls.length;
  applicationMenuCalls = h.electron.Menu.setApplicationMenu.mock.calls.length;
});

afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('main process start', () => {
  it('scrubs the inherited host environment before starting', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('registers relaydesk:// with the dev executable and app path', () => {
    expect(protocolCalls).toEqual([['relaydesk', process.execPath, ['D:\\dev\\relay-desk']]]);
  });

  it('passes the launch request parsed from argv to the system IPC', () => {
    expect(systemIpcCalls).toHaveLength(1);
    const deps = systemIpcCalls[0]![1] as { initialLaunch: unknown };
    expect(deps.initialLaunch).toEqual({ action: 'resume', sessionId: SID, cwd: 'D:\\demos\\x', profileId: 'default' });
  });

  it('creates a hardened window coloured for the stored theme', () => {
    expect(h.windows).toHaveLength(1);
    const options = h.windows[0]!.options;
    expect(options).toMatchObject({
      backgroundColor: '#1f1f1f',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1f1f1f', symbolColor: '#d0d0d0', height: 36 },
      minWidth: 960,
      minHeight: 640,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
    });
  });

  it('wires the live account-activity gate into engine creation', () => {
    const deps = engineIpcCalls[0]![1] as { isProfileBusy: (id: string) => boolean };
    h.isAccountBusy.mockReturnValue(true);
    expect(deps.isProfileBusy('work')).toBe(true);
    expect(h.isAccountBusy).toHaveBeenCalledWith('work');
    h.isAccountBusy.mockReturnValue(false);
    expect(deps.isProfileBusy('work')).toBe(false);
  });

  it('lets a session read the CLI model catalog only for an account the system knows as a claude.ai sign-in', () => {
    expect(nativeServiceCalls).toHaveLength(1);
    const hooks = nativeServiceCalls[0]![1] as { effortCatalogAllowed: (profile: unknown) => boolean };
    const profile = { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 1 };
    h.claudeAiSignIn.mockClear();
    expect(hooks.effortCatalogAllowed(profile)).toBe(false);
    expect(h.claudeAiSignIn).toHaveBeenLastCalledWith(profile);
    h.claudeAiSignIn.mockReturnValueOnce(true);
    expect(hooks.effortCatalogAllowed(profile)).toBe(true);
    expect(h.claudeAiSignIn).toHaveBeenCalledTimes(2);
  });

  it('wires shared-context preparation into the production engine without running it at startup', () => {
    const deps = engineIpcCalls[0]![1] as { prepareCodeContext: unknown };
    expect(deps.prepareCodeContext).toBe(h.prepareSharedCodeContext);
    expect(startupPreparationCalls).toBe(0);
    expect(h.prepareSharedCodeContext).not.toHaveBeenCalled();
  });

  it('forwards a second instance URL to the running window and focuses it', () => {
    h.appHandlers.get('second-instance')?.({}, ['Relay Desk.exe', `relaydesk://resume?session=${SID}`]);
    expect(h.pushLaunchRequest).toHaveBeenLastCalledWith({ action: 'resume', sessionId: SID, profileId: 'default' });
    expect(h.windows[0]!.restore).toHaveBeenCalled();
    expect(h.windows[0]!.focus).toHaveBeenCalled();
    h.pushLaunchRequest.mockClear();
    h.appHandlers.get('second-instance')?.({}, ['Relay Desk.exe', 'relaydesk://resume?session=bad']);
    expect(h.pushLaunchRequest).not.toHaveBeenCalled();
  });

  it('denies new windows and navigation; http(s) links go to the browser, other schemes nowhere', () => {
    const win = h.windows[0]!;
    expect(win.openHandler?.({ url: 'https://example.com/a' })).toEqual({ action: 'deny' });
    expect(h.electron.shell.openExternal).toHaveBeenLastCalledWith('https://example.com/a');
    h.electron.shell.openExternal.mockClear();
    expect(win.openHandler?.({ url: 'file:///C:/Windows/System32/calc.exe' })).toEqual({ action: 'deny' });
    expect(win.openHandler?.({ url: 'https://user:pw@example.com' })).toEqual({ action: 'deny' });
    expect(h.electron.shell.openExternal).not.toHaveBeenCalled();

    const event = { url: 'https://evil.example/', preventDefault: vi.fn() };
    win.handlers.get('will-navigate')?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
    const reload = { url: 'file:///app/index.html', preventDefault: vi.fn() };
    win.handlers.get('will-navigate')?.(reload);
    expect(reload.preventDefault).not.toHaveBeenCalled();
  });

  it('grants no permissions except sanitized clipboard writes', () => {
    const decide = (permission: string) => {
      let granted: boolean | undefined;
      h.permissionHandlers.request?.({}, permission, (ok: boolean) => (granted = ok));
      return granted;
    };
    expect(decide('media')).toBe(false);
    expect(decide('openExternal')).toBe(false);
    expect(decide('clipboard-sanitized-write')).toBe(true);
    expect(h.permissionHandlers.check?.({}, 'geolocation')).toBe(false);
  });

  it('registers the durable portable launcher, not its extracted temporary executable', async () => {
    const prior = process.env.PORTABLE_EXECUTABLE_FILE;
    process.env.PORTABLE_EXECUTABLE_FILE = 'D:\\apps\\Relay Desk Portable.exe';
    try {
      const { registerProtocol } = await import('../../src/main/index');
      registerProtocol();
      expect(h.electron.app.setAsDefaultProtocolClient).toHaveBeenLastCalledWith('relaydesk', 'D:\\apps\\Relay Desk Portable.exe', []);
    } finally {
      if (prior === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
      else process.env.PORTABLE_EXECUTABLE_FILE = prior;
    }
  });

  it('leaves the existing protocol association alone on an explicit no-registration launch', async () => {
    process.argv.push('--relay-no-protocol-registration');
    try {
      const { registerProtocol } = await import('../../src/main/index');
      registerProtocol();
      expect(h.electron.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    } finally { process.argv.pop(); }
  });

  it('keeps the default development menu and gives packaged builds one without renderer reload', async () => {
    expect(applicationMenuCalls).toBe(0);
    const { installApplicationMenu } = await import('../../src/main/index');
    installApplicationMenu(true);
    expect(h.electron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    const menu = h.electron.Menu.setApplicationMenu.mock.calls[0]![0] as { template: Array<{ submenu: Array<{ role?: string; accelerator?: string }> }> };
    const items = menu.template.flatMap((entry) => entry.submenu);
    expect(items.map((item) => item.role).filter(Boolean)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut']);
    expect(items.some((item) => /reload/i.test(item.role ?? '') || /R$|F5/.test(item.accelerator ?? ''))).toBe(false);
  });

  it('creates the tray icon from build/icon.ico in development', () => {
    expect(h.trays).toHaveLength(1);
    expect((h.trays[0]!.image as { path: string }).path).toBe(join('D:\\dev\\relay-desk', 'build', 'icon.ico'));
  });

  it('shows and focuses the window on tray click and double click', () => {
    h.windows[0]!.focus.mockClear();
    h.trays[0]!.handlers.get('click')?.();
    h.trays[0]!.handlers.get('double-click')?.();
    expect(h.windows[0]!.show).not.toHaveBeenCalled();
    expect(h.windows[0]!.focus).toHaveBeenCalledTimes(2);
  });

  it('hides the window on close, keeps the app running and tells the user once', async () => {
    h.electron.app.quit.mockClear();
    const close = { preventDefault: vi.fn() };
    h.windows[0]!.handlers.get('window:close')?.(close);
    expect(close.preventDefault).toHaveBeenCalled();
    expect(h.windows[0]!.hide).toHaveBeenCalledTimes(1);
    expect(h.electron.app.quit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.trays[0]!.displayBalloon).toHaveBeenCalledTimes(1));
    h.windows[0]!.handlers.get('window:close')?.({ preventDefault: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.trays[0]!.displayBalloon).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(userData, 'tray-notice.json'), 'utf8'))).toMatchObject({ shown: true });
  });

  it('does not quit when the last window is gone while the tray icon exists', () => {
    h.electron.app.quit.mockClear();
    h.appHandlers.get('window-all-closed')?.();
    expect(h.electron.app.quit).not.toHaveBeenCalled();
  });

  it('pops up Show and Exit on a tray right click; Exit quits through app.quit', async () => {
    h.electron.app.quit.mockClear();
    h.trays[0]!.handlers.get('right-click')?.();
    await vi.waitFor(() => expect(h.trays[0]!.popUpContextMenu).toHaveBeenCalledTimes(1));
    const menu = h.trays[0]!.popUpContextMenu.mock.calls[0]![0] as { template: Array<{ label?: string; click?: () => void }> };
    expect(menu.template.filter((item) => item.label).map((item) => item.label)).toEqual(['Show Relay Desk', 'Exit']);
    menu.template.find((item) => item.label === 'Exit')!.click!();
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it('quits through the normal path when Windows ends the session', () => {
    h.electron.app.quit.mockClear();
    h.windows[0]!.handlers.get('window:session-end')?.();
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1);
    const close = { preventDefault: vi.fn() };
    h.windows[0]!.hide.mockClear();
    h.windows[0]!.handlers.get('window:close')?.(close);
    expect(close.preventDefault).toHaveBeenCalled();
    expect(h.windows[0]!.hide).not.toHaveBeenCalled();
    expect(h.electron.app.quit).toHaveBeenCalledTimes(2);
  });

  it('offers the localised context menu on right click', async () => {
    const handler = h.windows[0]!.handlers.get('context-menu');
    expect(handler).toBeTypeOf('function');
    handler?.({}, {
      x: 1, y: 2, isEditable: true, selectionText: '', mediaType: 'none', linkURL: '',
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    });
    await vi.waitFor(() => expect(h.popups).toHaveLength(1));
    expect(h.popups[0]!.template.map((item) => item.label)).toEqual(['Cut', 'Copy', 'Paste', 'Select All']);
  });

  it('retains the window and ownership when engine shutdown rejects', async () => {
    h.closeAll.mockRejectedValueOnce(new Error('synthetic shutdown failure'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = { preventDefault: vi.fn() };
    h.appHandlers.get('before-quit')?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.electron.app.quit).not.toHaveBeenCalled();
    expect(h.windows[0]!.focus).toHaveBeenCalled();
  });

  it('blocks window destruction and treats shutdown deadline as failure, not permission to exit', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.closeAll.mockImplementationOnce(() => new Promise<void>(() => {}));
    const close = { preventDefault: vi.fn() };
    h.windows[0]!.handlers.get('window:close')?.(close);
    expect(close.preventDefault).toHaveBeenCalled();
    h.electron.app.quit.mockClear();
    const quitting = { preventDefault: vi.fn() };
    h.appHandlers.get('before-quit')?.(quitting);
    h.appHandlers.get('before-quit')?.({ preventDefault: vi.fn() });
    expect(h.closeAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(h.electron.app.quit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('refuses to quit when an owned authentication writer has not been closed', async () => {
    h.shutdownAuth.mockRejectedValueOnce(new Error('synthetic auth writer remains'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = { preventDefault: vi.fn() };
    h.appHandlers.get('before-quit')?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.electron.app.quit).not.toHaveBeenCalled();
    expect(h.windows[0]!.focus).toHaveBeenCalled();
  });

  it('closes every engine and owned authentication before quitting', async () => {
    const event = { preventDefault: vi.fn() };
    h.appHandlers.get('before-quit')?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.closeAll).toHaveBeenCalledTimes(1);
    expect(h.shutdownAuth).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.electron.app.quit).toHaveBeenCalled();
  });
});
