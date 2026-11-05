import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';
import type { EngineSessionOptions } from '../../src/main/engine/session';
import type { NativeInteractiveSessionOptions } from '../../src/main/native/session';
import type { NativeRuntime } from '../../src/main/native/contract';
import type { NativeServiceHooks, NativeServicePaths } from '../../src/main/native/prototypeServices';
import { createNativeServices, createPrototypeServices, nativePrivateRoot } from '../../src/main/native/prototypeServices';

const mocks = vi.hoisted(() => ({
  baseEnv: {} as NodeJS.ProcessEnv,
  exists: vi.fn(), mkdir: vi.fn(), lstat: vi.fn(), realpath: vi.fn(), home: vi.fn(),
  storage: vi.fn(), runtime: vi.fn(), guard: vi.fn(), pdfReceipt: vi.fn(), pdfPackaged: vi.fn(),
  binary: vi.fn(), hash: vi.fn(), fingerprint: vi.fn(), assets: vi.fn(), preferences: vi.fn(),
  usageMemory: vi.fn(), usageCache: vi.fn(), constructed: vi.fn(), taskOutput: vi.fn(), childEnv: vi.fn(), effortGuides: vi.fn(),
}));

// Every potential side-effect dependency is replaced before importing the factory.
vi.mock('node:child_process', () => ({ spawn: () => { throw new Error('Unexpected real process'); }, spawnSync: () => { throw new Error('Unexpected real process'); } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('Normal native services must never load SDK query runtime'); });
vi.mock('node:fs', () => ({ existsSync: mocks.exists, mkdirSync: mocks.mkdir, lstatSync: mocks.lstat, realpathSync: mocks.realpath }));
vi.mock('node:os', () => ({ homedir: mocks.home }));
vi.mock('../../src/main/system/env', async (original) => {
  const actual = await original<typeof import('../../src/main/system/env')>();
  return { ...actual, buildChildEnv: (profile: Parameters<typeof actual.buildChildEnv>[0]) => {
    mocks.childEnv(profile);
    return actual.buildChildEnv(profile, mocks.baseEnv);
  } };
});
vi.mock('../../src/main/system/claudeBinary', () => ({ resolveClaudeBinary: mocks.binary }));
vi.mock('../../src/main/engine/usageMemory', () => ({ createUsageMemory: mocks.usageMemory }));
vi.mock('../../src/main/engine/taskOutput', () => ({ readTaskOutput: mocks.taskOutput }));
vi.mock('../../src/main/native/usage', () => ({ createNativeUsageCache: mocks.usageCache }));
vi.mock('../../src/main/native/privateStorage', () => ({ createPrivateStorage: mocks.storage }));
vi.mock('../../src/main/native/transport', () => ({ createNativeRuntime: mocks.runtime }));
vi.mock('../../src/main/native/guardedRuntime', () => ({ guardNativeRuntime: mocks.guard }));
vi.mock('../../src/main/native/pdfResources', () => ({ createNativePdfToolsFromReceipt: mocks.pdfReceipt, createPackagedNativePdfTools: mocks.pdfPackaged }));
vi.mock('../../src/main/native/controlsState', () => ({ verifiedNativeHash: mocks.hash, nativePreferenceFingerprint: mocks.fingerprint }));
vi.mock('../../src/main/native/durableAssets', () => ({ createNativeDurableAssets: mocks.assets }));
vi.mock('../../src/main/native/persistentPreferences', () => ({ createNativePreferenceScope: mocks.preferences }));
vi.mock('../../src/main/native/effortGuide', () => ({ readServedEffortGuides: mocks.effortGuides }));
vi.mock('../../src/main/native/session', () => ({ NativeInteractiveSession: class {
  readonly options: NativeInteractiveSessionOptions;
  constructor(options: NativeInteractiveSessionOptions) { this.options = options; mocks.constructed(options); }
  start() { return this.options.runtime.start(this.options.launch); }
  close() { return this.options.runtime.close(); }
} }));

const PATHS: NativeServicePaths = { userData: 'C:\\Synthetic\\RelayData', appPath: 'C:\\Synthetic\\RelayApp',
  resourcesPath: 'C:\\Synthetic\\RelayResources', packaged: false };
const BINARY = 'C:\\Synthetic\\NativeBin\\claude.exe';
const HASH = '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae';
const FIXTURE_ROOT = 'C:\\RelayDeskNativePrototype\\fixture';

function options(defaultProfile = false): EngineSessionOptions {
  return { handleId: 'h', request: { cwd: 'C:\\Synthetic\\Project', profileId: defaultProfile ? 'default' : 'independent',
    model: 'claude-opus-5-5', effort: 'xhigh', workflows: 'on' },
  profile: { id: defaultProfile ? 'default' : 'independent', name: 'Synthetic', configDir: defaultProfile ? null : 'C:\\Synthetic\\Profiles\\independent', createdAt: 0 },
  broker: {} as EngineSessionOptions['broker'], emit: vi.fn() };
}

function current(): NativeInteractiveSessionOptions { return mocks.constructed.mock.calls.at(-1)![0] as NativeInteractiveSessionOptions; }
function createService(args: NativeServicePaths = PATHS, hooks?: NativeServiceHooks) { return createNativeServices(args, hooks); }

let runtime: NativeRuntime;
let storage: { createLaunch: ReturnType<typeof vi.fn>; writeJson: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
let preference: { prepareNativeSettings: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
let pdfWarnings: { mock: { calls: unknown[][] }; mockRestore: () => void };
let lease: { storage: object; retain: ReturnType<typeof vi.fn>; verifyPath: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', undefined); vi.stubEnv('RELAY_NATIVE_DENY_PROXY', undefined);
  mocks.baseEnv = { PATH: 'C:\\Synthetic\\Tools', HTTP_PROXY: 'http://127.0.0.1:11001', HTTPS_PROXY: 'http://127.0.0.1:11002',
    ALL_PROXY: 'socks5://127.0.0.1:11003', NO_PROXY: 'example.invalid,localhost', NODE_EXTRA_CA_CERTS: 'C:\\Synthetic\\cert.pem',
    SSL_CERT_FILE: 'C:\\Synthetic\\ssl.pem', SSL_CERT_DIR: 'C:\\Synthetic\\certs', CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
    ANTHROPIC_API_KEY: 'synthetic-inherited-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-inherited-token', ANTHROPIC_BASE_URL: 'http://untrusted.invalid',
    CLAUDE_CONFIG_DIR: 'C:\\Synthetic\\WrongProfile', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.302' };
  mocks.exists.mockReturnValue(true); mocks.mkdir.mockReturnValue(undefined);
  mocks.lstat.mockReturnValue({ isDirectory: () => true }); mocks.realpath.mockImplementation((file: string) => win32.normalize(file));
  mocks.home.mockReturnValue('C:\\Synthetic\\Home'); mocks.binary.mockReturnValue(BINARY); mocks.hash.mockReturnValue(HASH);
  mocks.fingerprint.mockResolvedValue('a'.repeat(64)); mocks.usageMemory.mockReturnValue({});
  mocks.usageCache.mockReturnValue({ observe: vi.fn(), createService: vi.fn(), generation: vi.fn(() => 0) });
  runtime = { start: vi.fn(async () => ({ protocol: 1 as const, isInteractive: true, surface: 'terminal', sessionId: 's', capabilities: [] })),
    request: vi.fn(async () => ({})), onEvent: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined),
    onTerminal: vi.fn(() => () => undefined), writeTerminal: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  mocks.runtime.mockReturnValue(runtime); mocks.guard.mockImplementation((value: NativeRuntime) => value);
  const privateLaunch = { path: 'C:\\RelayDeskNativePrototype\\owned\\launch', identity: 'owned-launch' };
  storage = { createLaunch: vi.fn(() => privateLaunch), writeJson: vi.fn(() => ({ path: `${privateLaunch.path}\\mcp.json` })),
    verify: vi.fn(), dispose: vi.fn() };
  mocks.storage.mockReturnValue(storage);
  const pdf = { withEnvironment: vi.fn((env: NodeJS.ProcessEnv) => ({ ...env, RELAY_PDF_FIXTURE: 'synthetic' })), verify: vi.fn() };
  mocks.pdfReceipt.mockReturnValue(pdf); mocks.pdfPackaged.mockReturnValue(pdf);
  pdfWarnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  preference = { prepareNativeSettings: vi.fn(), verify: vi.fn() }; mocks.preferences.mockReturnValue(preference);
  lease = { storage: {}, retain: vi.fn(), verifyPath: vi.fn(), close: vi.fn() };
  mocks.assets.mockReturnValue({ openSession: vi.fn(() => lease) }); mocks.taskOutput.mockResolvedValue('synthetic output');
});
afterEach(() => {
  // turnPdfOff only logs; without this check a case whose PDF tools failed would pass with PDFs off.
  const off = pdfWarnings.mock.calls.filter((call) => String(call[0]).startsWith('[relay:pdf]'));
  pdfWarnings.mockRestore(); vi.unstubAllEnvs();
  expect(off).toEqual([]);
});

describe('normal native service composition without real side effects', () => {
  it('keeps ordinary Relay proxy/cert settings and profile, removes inherited SDK/auth identity, and uses no fixture networking', () => {
    const input = options(); const before = { ...mocks.baseEnv };
    const services = createService(); services.engine.createSession(input);
    const captured = current(), env = captured.launch.env;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS']) expect(env[key]).toBe(before[key]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(input.profile.configDir);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER']) expect(env[key]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('native-acceptance-fake-key');
    expect(mocks.baseEnv).toEqual(before); expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.childEnv).toHaveBeenCalledExactlyOnceWith(input.profile);
    expect(captured.launch).toMatchObject({ exe: BINARY, cwd: input.request.cwd });
    expect(captured.launch.args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'xhigh', '--setting-sources', 'user,project,local']));
    expect(captured.launch.args.some((arg) => ['-p', '--print', '--sdk-url', '--input-format', '--output-format'].includes(arg))).toBe(false);
    expect(mocks.hash).toHaveBeenCalledExactlyOnceWith(BINARY);
    expect(captured.controls?.cliSha256).toBe(HASH); expect(mocks.constructed).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(services).not.toHaveProperty('auth'); expect(services).not.toHaveProperty('handoff'); expect(services).not.toHaveProperty('cliVersion');
  });

  it('preserves user-selected ordinary telemetry env rather than adding acceptance overrides', () => {
    Object.assign(mocks.baseEnv, { DISABLE_TELEMETRY: '0', DISABLE_ERROR_REPORTING: '0', DISABLE_AUTOUPDATER: '0' });
    createService().engine.createSession(options());
    expect(current().launch.env).toMatchObject({ DISABLE_TELEMETRY: '0', DISABLE_ERROR_REPORTING: '0', DISABLE_AUTOUPDATER: '0' });
  });

  it('uses the existing Default profile without rebinding it to the private asset namespace', async () => {
    const input = options(true); createService().engine.createSession(input);
    expect(current().launch.env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(mocks.preferences).not.toHaveBeenCalled();
    await current().controls!.preferenceFingerprint();
    expect(mocks.fingerprint).toHaveBeenCalledWith(input.profile, input.request.cwd, nativePrivateRoot(PATHS.userData),
      { home: 'C:\\Synthetic\\Home', enforcePrototypeBoundary: false });
  });

  it('reads effort notes from the profile\'s own CLI config: the home folder for Default, the account folder otherwise', async () => {
    const notes = { 'claude-opus-5-5': { levels: {} } };
    mocks.effortGuides.mockResolvedValue(notes);
    const allowed = vi.fn(() => true);
    const defaultInput = options(true);
    createService(PATHS, { effortCatalogAllowed: allowed }).engine.createSession(defaultInput);
    await expect(current().effortGuides!()).resolves.toBe(notes);
    expect(allowed).toHaveBeenLastCalledWith(defaultInput.profile);
    expect(mocks.effortGuides).toHaveBeenLastCalledWith({ configDir: null, configRoot: win32.join('C:\\Synthetic\\Home', '.claude'), home: 'C:\\Synthetic\\Home' });
    createService(PATHS, { effortCatalogAllowed: allowed }).engine.createSession(options());
    await current().effortGuides!();
    expect(mocks.effortGuides).toHaveBeenLastCalledWith({ configDir: 'C:\\Synthetic\\Profiles\\independent',
      configRoot: 'C:\\Synthetic\\Profiles\\independent', home: 'C:\\Synthetic\\Home' });
  });

  it('never opens the CLI config for effort notes unless the account is asked about on each read and is a claude.ai sign-in', async () => {
    mocks.effortGuides.mockResolvedValue({ 'claude-opus-5-5': { levels: {} } });
    createService().engine.createSession(options());
    await expect(current().effortGuides!()).resolves.toEqual({});
    expect(mocks.effortGuides).not.toHaveBeenCalled();

    const allowed = vi.fn((_profile: EngineSessionOptions['profile']) => false);
    const input = options();
    createService(PATHS, { effortCatalogAllowed: allowed }).engine.createSession(input);
    const read = current().effortGuides!;
    expect(allowed).not.toHaveBeenCalled();
    await expect(read()).resolves.toEqual({});
    expect(allowed).toHaveBeenCalledExactlyOnceWith(input.profile);
    expect(mocks.effortGuides).not.toHaveBeenCalled();
    allowed.mockReturnValue(true);
    await expect(read()).resolves.toEqual({ 'claude-opus-5-5': { levels: {} } });
    expect(mocks.effortGuides).toHaveBeenCalledTimes(1);
    allowed.mockReturnValue(false);
    await expect(read()).resolves.toEqual({});
    expect(mocks.effortGuides).toHaveBeenCalledTimes(1);
    expect(allowed).toHaveBeenCalledTimes(3);
  });

  it('reads no effort notes in the isolated entry once the account folder leads outside the prototype root', async () => {
    vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', 'http://127.0.0.1:12001'); vi.stubEnv('RELAY_NATIVE_DENY_PROXY', 'http://127.0.0.1:12002');
    mocks.effortGuides.mockResolvedValue({ 'claude-opus-5-5': { levels: {} } });
    const configDir = `${FIXTURE_ROOT}\\profiles\\independent`;
    const input = options(); input.profile.configDir = configDir; input.request.cwd = `${FIXTURE_ROOT}\\workspace`;
    createNativeServices({ ...PATHS, root: FIXTURE_ROOT }, { effortCatalogAllowed: () => true }).engine.createSession(input);
    const read = current().effortGuides!;
    await expect(read()).resolves.toEqual({ 'claude-opus-5-5': { levels: {} } });
    expect(mocks.effortGuides).toHaveBeenLastCalledWith({ configDir, configRoot: configDir, home: win32.join(FIXTURE_ROOT, 'home') });
    mocks.realpath.mockImplementation((file: string) => file.toLowerCase().startsWith(configDir.toLowerCase())
      ? 'C:\\Synthetic\\Elsewhere' : win32.normalize(file));
    await expect(read()).resolves.toEqual({});
    expect(mocks.effortGuides).toHaveBeenCalledTimes(1);
  });

  it('keeps private files in the application hash namespace and checks their identity before runtime start', async () => {
    const input = options(); input.mcpServers = { fixture: { command: 'synthetic-command', env: { SYNTHETIC: 'only' } } };
    const service = createService(); const session = service.engine.createSession(input);
    const root = nativePrivateRoot(PATHS.userData);
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(root, { recursive: true });
    expect(mocks.storage).toHaveBeenCalledWith({ helperPath: win32.join(PATHS.appPath, 'tools', 'private-storage', 'bin', 'RelayPrivateStorage.exe'), prototypeRoot: root });
    expect(storage.writeJson).toHaveBeenCalledWith(expect.anything(), { mcpServers: input.mcpServers });
    expect(current().launch.args).toEqual(expect.arrayContaining(['--mcp-config', 'C:\\RelayDeskNativePrototype\\owned\\launch\\mcp.json']));
    await session.start(); expect(storage.verify).toHaveBeenCalledTimes(1); expect(runtime.start).toHaveBeenCalledWith(current().launch);
    expect(storage.verify.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runtime.start).mock.invocationCallOrder[0]);
    await session.close(); expect(runtime.close).toHaveBeenCalledTimes(1); expect(storage.dispose).toHaveBeenCalledTimes(1);
  });

  it('passes independent profile preference ownership and durable attachment lifetime callbacks', async () => {
    const input = options(); createService().engine.createSession(input);
    expect(mocks.preferences).toHaveBeenCalledWith(input.profile, win32.dirname(input.profile.configDir!));
    expect(preference.prepareNativeSettings).toHaveBeenCalledWith({ workflows: 'on', fastMode: undefined, autoContinue: true });
    expect(current().controls?.assertPreferenceScope).toBe(preference.verify);
    expect(current().launch.env.RELAY_NATIVE_PERSISTENT_CONTROLS).toBe('1');
    const resources = await current().attachments!('s');
    resources.onAccepted?.({ launch: { path: 'owned', identity: 'id' } } as Parameters<NonNullable<typeof resources.onAccepted>>[0]);
    resources.verifyRead?.('owned'); await resources.close?.();
    expect(lease.retain).toHaveBeenCalled(); expect(lease.verifyPath).toHaveBeenCalledWith('owned'); expect(lease.close).toHaveBeenCalledTimes(1);
  });

  it('puts the PDF tools folder on the launch environment in development, after its receipt check, and never reaches for it when packaged', () => {
    const input = options();
    createService().engine.createSession(input);
    expect(mocks.pdfReceipt).toHaveBeenCalledExactlyOnceWith({ sourceRoot: win32.join(PATHS.appPath, 'resources', 'pdf-tools') });
    expect(mocks.pdfPackaged).not.toHaveBeenCalled();
    expect(current().launch.env.RELAY_PDF_FIXTURE).toBe('synthetic');
    expect(input.emit).not.toHaveBeenCalled();
    vi.clearAllMocks();
    const packaged = options();
    createService({ ...PATHS, packaged: true }).engine.createSession(packaged);
    expect(mocks.pdfPackaged).toHaveBeenCalledExactlyOnceWith({ resourcesPath: PATHS.resourcesPath }); expect(mocks.pdfReceipt).not.toHaveBeenCalled();
    expect(current().launch.env.RELAY_PDF_FIXTURE).toBe('synthetic');
    expect(packaged.emit).not.toHaveBeenCalled();
  });

  it('selects packaged helper/plugin/PDF paths without a PATH or SDK fallback', () => {
    createService({ ...PATHS, packaged: true }).engine.createSession(options());
    expect(mocks.runtime).toHaveBeenCalledWith({ helperPath: win32.join(PATHS.resourcesPath, 'native', 'RelayNativeHost.exe') });
    expect(mocks.pdfPackaged).toHaveBeenCalledExactlyOnceWith({ resourcesPath: PATHS.resourcesPath }); expect(mocks.pdfReceipt).not.toHaveBeenCalled();
    expect(current().launch.args.slice(0, 2)).toEqual(['--plugin-dir', win32.join(PATHS.resourcesPath, 'native-mod')]);
  });

  it('fails closed before constructors on redirected private storage or missing helpers', () => {
    mocks.realpath.mockImplementation((file: string) => file.includes('app-assets') ? 'C:\\Synthetic\\Redirected' : file);
    expect(() => createService().engine.createSession(options())).toThrow('redirect');
    expect(mocks.mkdir).not.toHaveBeenCalled(); expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
    mocks.realpath.mockImplementation((file: string) => file); mocks.exists.mockReturnValue(false);
    expect(() => createService().engine.createSession(options())).toThrow('helpers');
    expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it('cleans owned storage on native hash or startup failure without any fallback constructor', async () => {
    mocks.hash.mockImplementationOnce(() => { throw new Error('Synthetic hash refusal'); });
    expect(() => createService().engine.createSession(options())).toThrow('hash refusal');
    expect(storage.dispose).toHaveBeenCalledTimes(1); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.constructed).not.toHaveBeenCalled();
    storage.dispose.mockClear(); const input = options();
    input.query = vi.fn(() => { throw new Error('SDK query fallback is forbidden'); });
    input.spawn = vi.fn(() => { throw new Error('SDK spawn fallback is forbidden'); });
    const session = createService().engine.createSession(input);
    vi.mocked(runtime.start).mockRejectedValueOnce(new Error('Synthetic startup refusal'));
    await expect(session.start()).rejects.toThrow('startup refusal');
    expect(runtime.close).toHaveBeenCalledTimes(1); expect(storage.dispose).toHaveBeenCalledTimes(1); expect(mocks.constructed).toHaveBeenCalledTimes(1);
    expect(input.query).not.toHaveBeenCalled(); expect(input.spawn).not.toHaveBeenCalled();
  });

  it('does not start a native child when the owned private launch cannot be verified', async () => {
    const session = createService().engine.createSession(options());
    storage.verify.mockImplementationOnce(() => { throw new Error('Synthetic private launch changed'); });
    await expect(session.start()).rejects.toThrow('private launch changed');
    expect(runtime.start).not.toHaveBeenCalled(); expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(storage.dispose).toHaveBeenCalledTimes(1); expect(mocks.constructed).toHaveBeenCalledTimes(1);
  });

  it('retains private ownership when native close fails, instead of deleting files still in use', async () => {
    const session = createService().engine.createSession(options());
    vi.mocked(runtime.close).mockRejectedValueOnce(new Error('Synthetic exit unverified'));
    await expect(session.close()).rejects.toThrow('unverified'); expect(storage.dispose).not.toHaveBeenCalled();
    await session.close(); expect(storage.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects fixture variables on the normal entry before storage/runtime construction', () => {
    vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', 'http://127.0.0.1:12001');
    expect(() => createService()).toThrow('configured together');
    vi.stubEnv('RELAY_NATIVE_DENY_PROXY', 'http://127.0.0.1:12002');
    expect(() => createService()).toThrow('isolated prototype entry');
    expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it('keeps the isolated entry fixture-only and rejects an external account before native construction', async () => {
    const isolated = { ...PATHS, root: FIXTURE_ROOT };
    expect(() => createPrototypeServices(isolated).engine.createSession(options())).toThrow('local acceptance fixture');
    vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', 'http://127.0.0.1:12001'); vi.stubEnv('RELAY_NATIVE_DENY_PROXY', 'http://127.0.0.1:12002');
    const fixture = createPrototypeServices(isolated);
    expect(() => fixture.engine.createSession(options())).toThrow('inside the isolated');
    await expect(fixture.auth.status(options().profile)).rejects.toThrow('inside the isolated');
    await expect(fixture.auth.login(options().profile)).resolves.toMatchObject({ ok: false });
    await expect(fixture.handoff.openInTerminal({} as never)).resolves.toMatchObject({ ok: false });
    expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.constructed).not.toHaveBeenCalled();
  });

  it('applies fake credentials/deny proxy only for an owned isolated fixture profile', () => {
    vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', 'http://127.0.0.1:12001'); vi.stubEnv('RELAY_NATIVE_DENY_PROXY', 'http://127.0.0.1:12002');
    const input = options(); input.profile.configDir = `${FIXTURE_ROOT}\\profiles\\independent`; input.request.cwd = `${FIXTURE_ROOT}\\workspace`;
    createPrototypeServices({ ...PATHS, root: FIXTURE_ROOT }).engine.createSession(input);
    expect(current().launch.env).toMatchObject({ ANTHROPIC_API_KEY: 'native-acceptance-fake-key-not-a-real-credential',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:12001', HTTP_PROXY: 'http://127.0.0.1:12002', HTTPS_PROXY: 'http://127.0.0.1:12002', DISABLE_TELEMETRY: '1' });
    expect(mocks.guard).toHaveBeenCalledWith(runtime, { kind: 'local-fixture', origin: 'http://127.0.0.1:12001', denyProxy: 'http://127.0.0.1:12002' });
  });
});
