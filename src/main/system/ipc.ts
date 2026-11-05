import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { app, dialog, nativeTheme, shell, type BrowserWindow, type IpcMain } from 'electron';
import { registerHandlers, sendEvent } from '@shared/ipc';
import type { AuthStatus, HandoffResult, LaunchRequest, Profile, SharedCodeContextReport } from '@shared/types';
import type { EngineControl } from '../engine/ipc';
import { AUTH_STATUS_THROTTLE_MS, createAuthService, type AuthService, type LoginMethod } from './auth';
import { getAuthenticationEnvironmentMetadata } from './authenticationEnvironment';
import { cliVersion as defaultCliVersion } from './claudeBinary';
import { createHandoffService, type HandoffDeps, type HandoffService } from './handoff';
import { errorText } from './messages';
import { createMcpStore, type McpStore } from './mcp';
import { toLocalAbsolutePath } from './paths';
import type { ProfileStore } from './profiles';
import { inspectSharedCodeContext, unshareSharedCodeContext } from './sharedCodeContext';
import { createSettingsStore, createShortcutStore, type SettingsStore, type ShortcutStore } from './stores';
import { applyTheme, syncWindowTheme } from './theme';

export interface SystemIpcDeps {
  engine: EngineControl;
  profiles: ProfileStore;
  getWindow(): BrowserWindow | null;
  /** Parsed from this process's argv; served by app.getLaunchRequest. */
  initialLaunch: LaunchRequest | null;
  /** Injectable for tests; default stores under app userData and the real services. */
  settings?: SettingsStore;
  shortcuts?: ShortcutStore;
  auth?: AuthService;
  handoff?: HandoffService;
  prepareCodeContext?: HandoffDeps['prepareCodeContext'];
  cliVersion?: () => Promise<string>;
  sdkVersion?: () => string;
  inspectCodeContext?(profile: Profile, cwd?: string): Promise<SharedCodeContextReport>;
  mcp?: McpStore;
}

// For a handler whose service is not implemented yet.
function notYet(item: string): never {
  throw new Error(`Not implemented yet (${item}).`);
}

export interface SystemControl {
  /** Forwards a launch request from a second instance or a relaydesk:// URL to the renderer. */
  pushLaunchRequest(request: LaunchRequest): void;
  /** Engine-open gate, including an interactive login that has not exited yet. */
  isAccountBusy(id: string): boolean;
  /**
   * Whether a status checked within AUTH_GATE_MAX_AGE_MS is a claude.ai sign-in from the profile's CLI config, without
   * checking again. Only then may the CLI's global config be read: with a Console sign-in it holds the API key (R2).
   */
  claudeAiSignIn(profile: Profile): boolean;
  /** Stop owned login writers and drain account mutations before application exit. */
  shutdown(): Promise<void>;
}

const LOGIN_METHODS: readonly LoginMethod[] = ['claudeai', 'sso', 'console'];

/** The oldest status a gate decides on: the renderer re-checks on focus at most this often. */
export const AUTH_GATE_MAX_AGE_MS = AUTH_STATUS_THROTTLE_MS;

/** Only https links leave the app, without embedded credentials. */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !!parsed.hostname;
  } catch {
    return false;
  }
}

export function readSdkVersion(): string {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Wires the app.*, handoff.*, accounts.*, shortcuts.* and mcp.* channels. */
export function registerSystemIpc(ipcMain: IpcMain, deps: SystemIpcDeps): SystemControl {
  const userData = (): string => app.getPath('userData');
  const settings = deps.settings ?? createSettingsStore(userData());
  const shortcuts = deps.shortcuts ?? createShortcutStore(userData());
  const auth = deps.auth ?? createAuthService({
    terminalHelperPath: () => app.isPackaged
      ? join(process.resourcesPath, 'auth', 'RelayAuthHost.exe')
      : join(app.getAppPath(), 'tools', 'auth', 'bin', 'RelayAuthHost.exe'),
  });
  const handoff = deps.handoff ?? createHandoffService({ engine: deps.engine, getProfile: (id) => deps.profiles.get(id), prepareCodeContext: deps.prepareCodeContext });
  const cliVersion = deps.cliVersion ?? defaultCliVersion;
  const sdkVersion = deps.sdkVersion ?? readSdkVersion;
  const inspectCodeContext = deps.inspectCodeContext ?? inspectSharedCodeContext;
  const mcp = deps.mcp ?? createMcpStore(userData());
  const themeTarget = { nativeTheme, getWindow: deps.getWindow };
  const busyAccounts = new Set<string>();
  const accountOperations = new Set<Promise<unknown>>();
  let shuttingDown = false;
  const isAccountBusy = (id: string): boolean => shuttingDown || busyAccounts.has(id) || auth.isLoginInProgress(id);

  let pendingLaunch: LaunchRequest | null = deps.initialLaunch;
  const liveWindow = (): BrowserWindow | null => {
    const win = deps.getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  registerHandlers(ipcMain, 'app', {
    // Served once: a renderer reload must not replay a resume request.
    getLaunchRequest: () => {
      const request = pendingLaunch;
      pendingLaunch = null;
      return request;
    },
    getSettings: () => settings.get(),
    setSettings: async (patch) => {
      const next = await settings.set(patch);
      applyTheme(next.theme, themeTarget);
      return next;
    },
    pickFolder: async () => {
      const win = liveWindow();
      const options = { properties: ['openDirectory' as const, 'createDirectory' as const] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const picked = result.canceled ? undefined : result.filePaths[0];
      if (!picked) return null;
      const local = toLocalAbsolutePath(picked);
      if (!local) throw new Error('Network folders are not supported; pick a folder on a local drive.');
      return local;
    },
    pickFiles: async () => {
      const win = liveWindow();
      const options = { properties: ['openFile' as const, 'multiSelections' as const] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      return result.filePaths.map((picked) => {
        const local = toLocalAbsolutePath(picked);
        if (!local) throw new Error('Only files on a local drive are supported.');
        return local;
      });
    },
    revealPath: async (path) => {
      const local = toLocalAbsolutePath(path);
      if (!local) throw new Error('Folder path must be an absolute path on a local drive.');
      const resolved = toLocalAbsolutePath(await realpath(local));
      if (!resolved || !(await stat(resolved)).isDirectory()) {
        throw new Error('Select an existing local folder.');
      }
      const error = await shell.openPath(resolved);
      if (error) throw new Error('The folder could not be opened.');
    },
    // Selects the file in Explorer; a script Claude wrote is never opened or run from here.
    revealFile: async (path) => {
      const local = toLocalAbsolutePath(path);
      if (!local) throw new Error('File path must be an absolute path on a local drive.');
      const resolved = toLocalAbsolutePath(await realpath(local).catch(() => local));
      if (!resolved || !(await stat(resolved).catch(() => null))?.isFile()) throw new Error('The file no longer exists.');
      shell.showItemInFolder(resolved);
    },
    openExternal: async (url) => {
      if (!isAllowedExternalUrl(url)) throw new Error('Only https links can be opened.');
      await shell.openExternal(url);
    },
    versions: async () => {
      let cli = 'unknown';
      try {
        cli = await cliVersion();
      } catch (error) {
        console.error('[relay] claude --version failed:', errorText(error));
      }
      return { app: app.getVersion(), cli, sdk: sdkVersion() };
    },
    inspectCodeContext: async (id, cwd) => {
      const folder = cwd === undefined ? undefined : toLocalAbsolutePath(cwd);
      if (cwd !== undefined && !folder) throw new Error('Select a folder on a local drive.');
      return inspectCodeContext(await deps.profiles.get(String(id)), folder ?? undefined);
    },
  });

  registerHandlers(ipcMain, 'handoff', handoff);

  const accountAction = async (id: unknown, run: (profile: Awaited<ReturnType<ProfileStore['get']>>) => Promise<HandoffResult>) => {
    try {
      const key = String(id);
      return await withIdleAccount(key, async () => run(await deps.profiles.get(key)));
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
  };

  const ensureAccountIdle = (id: string): void => {
    if (isAccountBusy(id)) {
      throw new Error('Finish or close this account\'s login console before changing its login or removing it.');
    }
    if (deps.engine.findByProfile(id).length) {
      throw new Error('Close this account\'s active sessions before changing its login or removing it.');
    }
  };

  const withIdleAccount = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    ensureAccountIdle(id);
    busyAccounts.add(id);
    const pending = Promise.resolve().then(run);
    accountOperations.add(pending);
    try {
      return await pending;
    } finally {
      accountOperations.delete(pending);
      busyAccounts.delete(id);
    }
  };

  registerHandlers(ipcMain, 'accounts', {
    list: () => deps.profiles.list(),
    add: (name, configDir) => deps.profiles.add(name, configDir === null ? undefined : configDir),
    rename: (id, name) => deps.profiles.rename(id, name),
    remove: async (id, options) => {
      if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some((key) => key !== 'deleteDirectory') ||
        (options.deleteDirectory !== undefined && typeof options.deleteDirectory !== 'boolean'))) {
        throw new Error('Invalid account removal options.');
      }
      await withIdleAccount(id, () => deps.profiles.remove(id, { deleteDirectory: options?.deleteDirectory === true }));
    },
    status: async (id, force) => auth.status(await deps.profiles.get(id), force === true),
    login: (id, method, email) => {
      if (method !== undefined && method !== null && !LOGIN_METHODS.includes(method)) {
        return Promise.resolve({ ok: false, message: 'Unknown login method' });
      }
      return accountAction(id, (profile) => auth.login(profile, method ?? undefined, typeof email === 'string' ? email : undefined));
    },
    cancelLogin: async (id) => {
      if (typeof id !== 'string' || !id) return { ok: false, message: 'Invalid login account.' };
      try {
        const profile = await deps.profiles.get(id);
        if (profile.id !== id) return { ok: false, message: 'Unknown login account.' };
        if (!auth.cancelLogin) return { ok: false, message: 'This authentication service cannot cancel a login.' };
        return await auth.cancelLogin(profile.id);
      } catch { return { ok: false, message: 'The pending login could not be closed safely.' }; }
    },
    authenticationEnvironment: () => getAuthenticationEnvironmentMetadata(),
    setAuthenticationSource: async (id, source) => {
      if (typeof id !== 'string' || !id || (source !== 'cli-config' && source !== 'launch-environment')) {
        throw new Error('Invalid authentication source.');
      }
      if (source === 'launch-environment' && !getAuthenticationEnvironmentMetadata().available) {
        throw new Error('No usable authentication inputs were provided when Relay started. Configure the official CLI or relaunch Relay with the intended token, API key or provider environment.');
      }
      return withIdleAccount(id, async () => {
        const current = await deps.profiles.get(id);
        if ((current.authenticationSource ?? 'cli-config') === source) return current;
        await deps.engine.invalidateProfileUsage?.(id);
        const profile = await deps.profiles.setAuthenticationSource(id, source);
        auth.invalidate?.(id);
        return profile;
      });
    },
    logout: (id) => accountAction(id, (profile) => auth.logout(profile)),
    setSharedCodeContext: async (id, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid shared code context setting.');
      const key = String(id);
      return withIdleAccount(key, () => deps.profiles.setSharedCodeContext(key, enabled));
    },
    // The switch goes off first, so no new session prepares the files while they are removed.
    unshareCodeContext: async (id) => {
      const key = String(id);
      return withIdleAccount(key, async () => unshareSharedCodeContext(await deps.profiles.setSharedCodeContext(key, false)));
    },
  });

  auth.onStatus((status) => {
    const win = liveWindow();
    if (win) sendEvent(win.webContents, 'accounts', 'onStatus', status);
  });

  registerHandlers(ipcMain, 'shortcuts', {
    get: () => shortcuts.get(),
    set: (list) => shortcuts.set(list),
    reset: () => shortcuts.reset(),
  });

  registerHandlers(ipcMain, 'mcp', {
    list: () => mcp.list(),
    previewDesktopImport: () => mcp.previewDesktopImport(),
    importFromDesktop: (names) => mcp.importFromDesktop(names),
    setEnabled: (name, enabled) => mcp.setEnabled(name, enabled),
    remove: (name) => mcp.remove(name),
  });

  nativeTheme.on('updated', () => syncWindowTheme(themeTarget));

  // An older status decides nothing; it is refreshed in the background, so the next decision has a current one.
  const gateStatus = (profile: Profile): AuthStatus | undefined => {
    const status = auth.cachedStatus?.(profile);
    if (!status || Date.now() - status.checkedAt <= AUTH_GATE_MAX_AGE_MS) return status;
    void auth.status(profile).catch(() => undefined);
    return undefined;
  };

  return {
    isAccountBusy,
    claudeAiSignIn(profile) {
      if ((profile.authenticationSource ?? 'cli-config') !== 'cli-config') return false;
      const status = gateStatus(profile);
      return status?.loggedIn === true && status.authMethod === 'claude.ai';
    },
    async shutdown() {
      shuttingDown = true;
      await auth.shutdown?.();
      await Promise.allSettled([...accountOperations]);
    },
    pushLaunchRequest(request) {
      const win = liveWindow();
      // While the renderer is (re)loading nobody listens yet: keep it for app.getLaunchRequest.
      if (win && !win.webContents.isLoading()) sendEvent(win.webContents, 'app', 'onLaunchRequest', request);
      else pendingLaunch = request;
    },
  };
}
