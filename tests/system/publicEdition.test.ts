import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Public edition: sign-in is the official CLI login in its own console. These checks pin the account surface to exact
// lists, so anything added to it is a deliberate change of this file.
const NAMESPACES = ['app', 'sessions', 'engine', 'handoff', 'accounts', 'shortcuts', 'usage', 'mcp'];
const ACCOUNT_METHODS = ['list', 'add', 'rename', 'remove', 'status', 'login', 'cancelLogin', 'authenticationEnvironment',
  'setAuthenticationSource', 'logout', 'setSharedCodeContext', 'unshareCodeContext', 'onStatus'];
const ACCOUNT_EVENTS = ['onStatus'];
const MESSAGES = ['loginConsoleOpened', 'loginFailed', 'loggedOut', 'logoutFailed', 'invalidEmail', 'desktopDefaultOnly',
  'desktopOpened', 'desktopFolderOpened', 'desktopFailed', 'closeFailed', 'terminalOpened', 'terminalFailed', 'cloudOpened',
  'teleportOpened', 'remoteControlOpened', 'attachOpened', 'emptyTask', 'invalidSessionId', 'invalidBackgroundId',
  'invalidCloudSessionId', 'invalidFolder', 'unknownProfile'];
const ACCOUNT_STRINGS = ['title', 'count', 'chipLabel', 'switchFor', 'manage', 'active', 'useForNew', 'loggedIn', 'loggedOut',
  'statusError', 'statusUnknown', 'authenticationSource', 'authenticationTitle', 'authenticationCliConfig', 'authenticationCliHint',
  'authenticationEnvironment', 'authenticationEnvironmentHint', 'authenticationScope', 'authenticationWarning',
  'authenticationConfirmTitle', 'authenticationUseEnvironment', 'authenticationVariableNames', 'authenticationNoSecrets',
  'authenticationEnvironmentEmpty', 'authenticationEnvironmentFailed', 'authenticationSourceChanged', 'authenticationSourceFailed',
  'cancelLogin', 'noPendingLogin', 'loginCancelled', 'cancelLoginFailed', 'login', 'loginStarted', 'method.claudeai', 'method.sso',
  'method.console', 'logout', 'logoutTitle', 'logoutBody', 'refresh', 'refreshAll', 'planHint', 'planStale', 'planStalePro',
  'labelCaption', 'labelDrift', 'rename', 'renameTitle', 'nameLabel', 'add', 'addTitle', 'addHint', 'added', 'removeTitle',
  'removeBody', 'removeBodyCustom', 'deleteDirectory', 'defaultCannotRemove', 'actionsFor', 'note'].map((key) => `accounts.${key}`);
const LOGIN_STARTED = {
  en: 'The official Claude Code sign-in opened in its own console window. Complete it there; this account refreshes when that window closes.',
  'zh-TW': '已在獨立的主控台視窗開啟官方 Claude Code 登入。請在該視窗完成；視窗關閉後會更新此帳號。',
};
// Where the values go: the Claude Code processes Relay Desk starts, through its own helpers, and what those start.
const LAUNCH_ENVIRONMENT = {
  en: ['Launch environment (token, API key or cloud)',
    'Use the authentication variables Relay Desk was started with, such as CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or cloud provider settings. Relay Desk passes their values to the Claude Code processes it starts and does not store or log them.',
    'Only variable names are shown. Relay Desk keeps the values only in memory and does not log them. Through its own helper processes (the session host, the login host, terminal handoff) it passes them to the Claude Code processes it starts for this account, and so to everything those start: tools, hooks and MCP servers. Cloud provider variables (AWS, Google Cloud, Azure) also stay in Relay Desk\'s own environment, so every process it starts receives them. Do not paste keys or tokens here. Availability is not a credential-validity check.'],
  'zh-TW': ['啟動環境（權杖、API 金鑰或雲端）',
    '使用 Relay Desk 啟動時已有的驗證環境變數，例如 CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_API_KEY 或雲端供應商設定。Relay Desk 會把這些值交給它啟動的 Claude Code 程序，不會儲存或記錄。',
    '只顯示變數名稱。Relay Desk 只將這些值保留在記憶體中，也不會記錄。它會透過自己的輔助程序（工作階段主機、登入主機、終端機交接）把這些值交給它為此帳號啟動的 Claude Code 程序，因此也會傳到這些程序啟動的一切：工具、hook 與 MCP 伺服器。雲端供應商變數（AWS、Google Cloud、Azure）也保留在 Relay Desk 自己的環境中，因此它啟動的每個程序都會收到。請勿在此貼上金鑰或權杖。偵測到變數不代表憑證有效。'],
};

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\synthetic-relay', getPath: () => 'C:\\synthetic-relay\\user-data', getVersion: () => '0.0.0' },
  nativeTheme: { on: () => undefined, themeSource: 'system', shouldUseDarkColors: false },
  dialog: {}, shell: {},
}));
vi.mock('electron', () => electron);
const authServices = vi.hoisted(() => [] as unknown[]);
vi.mock('../../src/main/system/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/system/auth')>();
  return { ...actual, createAuthService: (deps: Parameters<typeof actual.createAuthService>[0]) => {
    authServices.push(deps);
    return actual.createAuthService(deps);
  } };
});

const { IPC, createRelayApi } = await import('@shared/ipc');
const { registerSystemIpc } = await import('../../src/main/system/ipc');
const { MSG } = await import('../../src/main/system/messages');
const { en } = await import('../../src/renderer/i18n/en');
const { zhTW } = await import('../../src/renderer/i18n/zh-TW');

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('public edition: the account surface', () => {
  it('has exactly the core IPC namespaces and account methods', () => {
    expect(Object.keys(IPC)).toEqual(NAMESPACES);
    expect(Object.keys(IPC.accounts)).toEqual(ACCOUNT_METHODS);
    expect(Object.values(IPC.accounts)).toEqual(ACCOUNT_METHODS.map((method) => `relay:accounts:${method}`));
    const api = createRelayApi({ invoke: async () => undefined, on: () => () => undefined });
    expect(sorted(Object.keys(api.accounts))).toEqual(sorted(ACCOUNT_METHODS));
  });

  it('registers exactly the account handlers and wires only the owned login host into the default auth service', () => {
    const handlers: string[] = [];
    const stub = {} as never;
    const created = authServices.length;
    registerSystemIpc({ handle: (channel: string) => { handlers.push(channel); } } as never, {
      engine: { findByProfile: () => [] } as never, profiles: stub, getWindow: () => null, initialLaunch: null,
      settings: stub, shortcuts: stub, handoff: stub, mcp: stub,
    });
    expect(handlers.filter((channel) => channel.startsWith('relay:accounts:'))).toEqual(ACCOUNT_METHODS
      .filter((method) => !ACCOUNT_EVENTS.includes(method)).map((method) => `relay:accounts:${method}`));
    expect(authServices).toHaveLength(created + 1);
    const deps = authServices.at(-1) as { terminalHelperPath?: () => string };
    expect(Object.keys(deps)).toEqual(['terminalHelperPath']);
    expect(deps.terminalHelperPath!()).toBe(join('C:\\synthetic-relay', 'tools', 'auth', 'bin', 'RelayAuthHost.exe'));
  });

  it('keeps exactly these main-process messages, all English', () => {
    expect(Object.keys(MSG)).toEqual(MESSAGES);
    const texts = Object.values(MSG).map((value) => typeof value === 'function' ? (value as (arg: never) => string)('x' as never) : value);
    expect(texts.filter((text) => /[\u3000-\u9fff\uff00-\uffef]/.test(text))).toEqual([]);
  });

  it('keeps exactly these account strings, in both languages', () => {
    for (const strings of [en, zhTW] as Array<Record<string, string>>) {
      expect(Object.keys(strings).filter((key) => key.startsWith('accounts.'))).toEqual(ACCOUNT_STRINGS);
    }
  });

  it('says the sign-in runs in its own console', () => {
    expect(en['accounts.loginStarted']).toBe(LOGIN_STARTED.en);
    expect(zhTW['accounts.loginStarted']).toBe(LOGIN_STARTED['zh-TW']);
    expect(MSG.loginConsoleOpened).toBe(LOGIN_STARTED.en);
  });

  it('describes the launch environment as passing a token, an API key or cloud settings to the CLI, and where they go', () => {
    const keys = ['accounts.authenticationEnvironment', 'accounts.authenticationEnvironmentHint', 'accounts.authenticationNoSecrets'] as const;
    expect(keys.map((key) => en[key])).toEqual(LAUNCH_ENVIRONMENT.en);
    expect(keys.map((key) => zhTW[key])).toEqual(LAUNCH_ENVIRONMENT['zh-TW']);
  });

  it('ships only the console login host and its build script in tools/auth', () => {
    const files = readdirSync(join('tools', 'auth'), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(sorted(files)).toEqual(['RelayAuthHost.cs', 'build-host.ps1']);
  });
});
