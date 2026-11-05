// Scrub before constructing services; pinned SDK reads auth when its APIs are called.
import './system/scrubOnLoad';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { sendEvent } from '@shared/ipc';
import type { AppSettings } from '@shared/types';
import { installContextMenu } from './contextMenu';
import { registerEngineIpc } from './engine/ipc';
import { registerSystemIpc, type SystemControl } from './system/ipc';
import { PROTOCOL_SCHEME, parseArgv, parseProtocolUrl } from './system/launchArgs';
import { createMcpStore } from './system/mcp';
import { createProfileStore } from './system/profiles';
import { inspectSharedCodeContext, prepareSharedCodeContext } from './system/sharedCodeContext';
import { createSettingsStore, type SettingsStore } from './system/stores';
import { isNativePrototype, PROTOTYPE_APP_ID, PROTOTYPE_NAME } from './native/isolation';
import { createNativeServices } from './native/prototypeServices';
import { assertPrototypePath, assertPrototypeProfile, scopedPrototypeProfiles } from './native/scope';
import { themeColors, titleBarOverlay } from './system/theme';
import {
  createTrayController,
  createTrayNoticeStore,
  decideWindowClose,
  quitWhenAllWindowsClosed,
  trayIconPath,
  type TrayController,
  type TrayHost,
} from './tray';

const outDir = import.meta.dirname;
const QUIT_TIMEOUT_MS = 10_000;
let mainWindow: BrowserWindow | null = null;
let shutdownApproved = false;
let sessionEnding = false;
let tray: TrayController | null = null;

if (app.requestSingleInstanceLock()) {
  start();
} else {
  app.quit();
}

export function registerProtocol(): void {
  if (isNativePrototype() || process.argv.includes('--relay-no-protocol-registration')) return;
  // Dev runs electron.exe <app path>: the protocol command needs that path too, or Windows would start a bare Electron.
  const ok = process.defaultApp
    ? app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [app.getAppPath()])
    : app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, []);
  if (!ok) console.warn(`[relay] could not register the ${PROTOCOL_SCHEME}:// protocol`);
}

/** Electron's default menu binds Reload/Force Reload, and a renderer reload orphans the live sessions it owned. */
export function installApplicationMenu(packaged: boolean): void {
  if (!packaged) return;
  const template: MenuItemConstructorOptions[] = [
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function focusWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function start(): void {
  app.setAppUserModelId(isNativePrototype() ? PROTOTYPE_APP_ID : 'com.relaydesk.app');
  registerProtocol();

  const userData = app.getPath('userData');
  const prototypeRoot = isNativePrototype() ? process.env.RELAY_NATIVE_SANDBOX_ROOT! : undefined;
  const originalProfiles = createProfileStore(userData);
  const profiles = prototypeRoot ? scopedPrototypeProfiles(originalProfiles, prototypeRoot) : originalProfiles;
  const settings = createSettingsStore(userData);
  const mcp = createMcpStore(userData);
  let system: SystemControl | undefined;
  const native = createNativeServices({
    ...(prototypeRoot ? { root: prototypeRoot } : {}), userData,
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged,
  }, { effortCatalogAllowed: (profile) => system?.claudeAiSignIn(profile) ?? false });
  const prepareCodeContext: typeof prepareSharedCodeContext = prototypeRoot ? async (profile, cwd) => {
    assertPrototypeProfile(profile, prototypeRoot);
    assertPrototypePath(join(prototypeRoot, 'home', '.claude'), prototypeRoot);
    assertPrototypePath(cwd, prototypeRoot);
    return prepareSharedCodeContext(profile, cwd);
  } : prepareSharedCodeContext;
  const engine = registerEngineIpc(ipcMain, {
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) sendEvent(mainWindow.webContents, 'engine', 'onEvent', event);
    },
    getProfile: (id) => profiles.get(id),
    isProfileBusy: (id) => system?.isAccountBusy(id) ?? true,
    prepareCodeContext,
    getMcpServers: () => mcp.enabledConfigs(),
    listingWorkerPath: join(outDir, 'listingWorker.js'),
    usageMemoryPath: join(userData, 'usage-cache.json'),
    ...native.engine,
  });
  system = registerSystemIpc(ipcMain, {
    engine,
    prepareCodeContext,
    profiles,
    settings,
    mcp,
    getWindow: () => mainWindow,
    initialLaunch: parseArgv(process.argv),
    ...(prototypeRoot ? { auth: native.auth, handoff: native.handoff, cliVersion: native.cliVersion,
      inspectCodeContext: async (profile, cwd) => {
        assertPrototypeProfile(profile, prototypeRoot!);
        assertPrototypePath(join(prototypeRoot!, 'home', '.claude'), prototypeRoot!);
        if (cwd) assertPrototypePath(cwd, prototypeRoot!);
        return inspectSharedCodeContext(profile, cwd);
      },
    } : {}),
  });

  // Windows and Linux: a relaydesk:// link or `--resume ...` start while running arrives here.
  app.on('second-instance', (_event, argv) => {
    const request = parseArgv(argv);
    if (request) system?.pushLaunchRequest(request);
    focusWindow();
  });
  // macOS delivers protocol links as open-url; kept for completeness.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const request = parseProtocolUrl(url);
    if (request) system?.pushLaunchRequest(request);
    focusWindow();
  });

  const getLanguage = async (): Promise<AppSettings['language']> => {
    try {
      return (await settings.get()).language;
    } catch {
      return 'en';
    }
  };

  let quitting = false;
  app.on('before-quit', (event) => {
    if (shutdownApproved) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Neither conversation writers nor an unfinished login may outlive normal exit.
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Engine shutdown timed out; writers may still be active.')), QUIT_TIMEOUT_MS);
    });
    void Promise.race([Promise.all([engine.closeAll(), system?.shutdown()]), timeout])
      .then(() => {
        shutdownApproved = true;
        app.quit();
      })
      .catch(() => {
        quitting = false;
        console.error('[relay] engine shutdown incomplete; application kept open to retain writer ownership');
        focusWindow();
      })
      .finally(() => clearTimeout(timer));
  });

  // The tray icon keeps the app alive while the window is hidden.
  app.on('window-all-closed', () => {
    if (quitWhenAllWindowsClosed(tray?.available() ?? false)) app.quit();
  });
  app.on('will-quit', () => tray?.destroy());

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  void app.whenReady().then(async () => {
    hardenSession();
    installApplicationMenu(app.isPackaged);
    await applyStoredTheme(settings);
    tray = createTrayController({
      host: electronTrayHost(),
      iconPath: trayIconPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
      getLanguage,
      notices: createTrayNoticeStore(userData),
      onShow: focusWindow,
      onExit: () => app.quit(),
    });
    createWindow(getLanguage);
  });
}

function electronTrayHost(): TrayHost {
  return {
    createTray: (iconPath) => {
      const image = nativeImage.createFromPath(iconPath);
      if (image.isEmpty()) throw new Error(`tray icon not found: ${iconPath}`);
      return new Tray(image);
    },
    buildMenu: (template) => Menu.buildFromTemplate(template),
  };
}

/** Sets nativeTheme from the saved setting before the window exists, so its first frame has the right colour. */
async function applyStoredTheme(settings: SettingsStore): Promise<void> {
  try {
    nativeTheme.themeSource = (await settings.get()).theme;
  } catch (error) {
    console.error('[relay] could not read settings', error);
  }
}

function hardenSession(): void {
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/** Links the user clicks may open in the browser: http(s) only, no embedded credentials. */
function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function createWindow(getLanguage: () => Promise<AppSettings['language']>): void {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: isNativePrototype() ? PROTOTYPE_NAME : 'Relay Desk',
    backgroundColor: themeColors(dark).background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(dark),
    // Packaged builds take the icon from the executable; build/ is not shipped.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.ico') }),
    webPreferences: {
      preload: join(outDir, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    const action = decideWindowClose({ shutdownApproved, sessionEnding, trayAvailable: tray?.available() ?? false });
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'hide') {
      win.hide();
      void tray?.noteHidden();
    } else {
      app.quit();
    }
  });
  // Windows log-off/shutdown: leave through the normal quit path, which closes the engines first.
  win.on('session-end', () => {
    sessionEnding = true;
    app.quit();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    if (event.url === win.webContents.getURL()) return;
    event.preventDefault();
    if (isExternalUrl(event.url)) void shell.openExternal(event.url);
  });

  installContextMenu(win.webContents, {
    getLanguage,
    copyText: (text) => clipboard.writeText(text),
    popup: (template) => {
      if (!win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: win });
    },
  });

  win.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] ${preloadPath}: ${error.message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] gone: ${details.reason}`);
  });
  if (!app.isPackaged) {
    win.webContents.on('did-finish-load', () => console.log(`[relay] renderer loaded ${win.webContents.getURL()}`));
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(outDir, '../renderer/index.html'));
  }
}
