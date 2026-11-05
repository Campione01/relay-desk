import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { win32 } from 'node:path';
import type { EngineSessionOptions } from '../../src/main/engine/session';
import type { NativeInteractiveSessionOptions } from '../../src/main/native/session';
import type { NativeServicePaths } from '../../src/main/native/prototypeServices';
import { createNativeServices } from '../../src/main/native/prototypeServices';

const mocks = vi.hoisted(() => ({
  receipts: new Set<string>(), exists: vi.fn(), constructed: vi.fn(), pdfSource: vi.fn(), pdfPackaged: vi.fn(),
}));

// Every side-effect dependency is replaced; the real pdfSelection decides from the mocked file checks.
vi.mock('node:child_process', () => ({ spawn: () => { throw new Error('Unexpected real process'); }, spawnSync: () => { throw new Error('Unexpected real process'); } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('Normal native services must never load SDK query runtime'); });
vi.mock('node:fs', () => ({ existsSync: mocks.exists, mkdirSync: vi.fn(), lstatSync: () => ({ isDirectory: () => true }), realpathSync: (file: string) => win32.normalize(file) }));
vi.mock('node:os', () => ({ homedir: () => 'C:\\Synthetic\\Home' }));
vi.mock('../../src/main/system/env', async (original) => {
  const actual = await original<typeof import('../../src/main/system/env')>();
  return { ...actual, buildChildEnv: (profile: Parameters<typeof actual.buildChildEnv>[0]) => actual.buildChildEnv(profile, { PATH: 'C:\\Synthetic\\Tools' }) };
});
vi.mock('../../src/main/system/claudeBinary', () => ({ resolveClaudeBinary: () => 'C:\\Synthetic\\NativeBin\\claude.exe' }));
vi.mock('../../src/main/engine/usageMemory', () => ({ createUsageMemory: () => ({}) }));
vi.mock('../../src/main/engine/taskOutput', () => ({ readTaskOutput: vi.fn() }));
vi.mock('../../src/main/native/usage', () => ({ createNativeUsageCache: () => ({ observe: vi.fn(), createService: vi.fn(), generation: () => 0 }) }));
vi.mock('../../src/main/native/privateStorage', () => ({ createPrivateStorage: () => ({ createLaunch: () => ({ path: 'C:\\RelayDeskNativePrototype\\owned', identity: 'id' }),
  writeJson: vi.fn(), verify: vi.fn(), dispose: vi.fn() }) }));
vi.mock('../../src/main/native/transport', () => ({ createNativeRuntime: () => ({ start: vi.fn(), close: vi.fn() }) }));
vi.mock('../../src/main/native/guardedRuntime', () => ({ guardNativeRuntime: (runtime: unknown) => runtime }));
vi.mock('../../src/main/native/pdfResources', () => ({ createNativePdfToolsFromReceipt: mocks.pdfSource, createPackagedNativePdfTools: mocks.pdfPackaged }));
vi.mock('../../src/main/native/controlsState', () => ({ verifiedNativeHash: () => 'a'.repeat(64), nativePreferenceFingerprint: vi.fn() }));
vi.mock('../../src/main/native/durableAssets', () => ({ createNativeDurableAssets: () => ({ openSession: () => ({ storage: {}, retain: vi.fn(), verifyPath: vi.fn(), close: vi.fn() }) }) }));
vi.mock('../../src/main/native/persistentPreferences', () => ({ createNativePreferenceScope: () => ({ prepareNativeSettings: vi.fn(), verify: vi.fn() }) }));
vi.mock('../../src/main/native/effortGuide', () => ({ readServedEffortGuides: vi.fn() }));
vi.mock('../../src/main/native/session', () => ({ NativeInteractiveSession: class {
  constructor(options: NativeInteractiveSessionOptions) { mocks.constructed(options); }
} }));

const PATHS: NativeServicePaths = { userData: 'C:\\Synthetic\\RelayData', appPath: 'C:\\Synthetic\\RelayApp', resourcesPath: 'C:\\Synthetic\\RelayResources', packaged: false };
const options = (): EngineSessionOptions => ({ handleId: 'h', request: { cwd: 'C:\\Synthetic\\Project', profileId: 'independent', model: 'claude-opus-5-5', effort: 'xhigh', workflows: 'on' },
  profile: { id: 'independent', name: 'Synthetic', configDir: 'C:\\Synthetic\\Profiles\\independent', createdAt: 0 },
  broker: {} as EngineSessionOptions['broker'], emit: vi.fn() });
const current = () => mocks.constructed.mock.calls.at(-1)![0] as NativeInteractiveSessionOptions;
// The advice must be true for a development run (a source checkout) and a packaged build, which has no tools/pdf/receipt.mjs.
const advice = 'Other attachments still work. Put the folder back as its receipt.json lists it, then quit and restart Relay Desk. '
  + 'If you changed the folder on purpose, a source checkout can write its receipt again first with node tools/pdf/receipt.mjs. '
  + 'Sessions that are already open keep using the folder until you close them.';
const pdf = { withEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env, PATH: `C:\\PdfTools\\Library\\bin;${env.PATH}` }), verify: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks(); mocks.receipts.clear();
  vi.stubEnv('RELAY_NATIVE_FIXTURE_URL', undefined); vi.stubEnv('RELAY_NATIVE_DENY_PROXY', undefined); vi.stubEnv('RELAY_DESK_PDF_TOOLS_DIR', undefined);
  mocks.exists.mockImplementation((file: string) => !file.endsWith('receipt.json') || mocks.receipts.has(file));
  mocks.pdfSource.mockReturnValue(pdf); mocks.pdfPackaged.mockReturnValue(pdf);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('native services without PDF tools', () => {
  it('start sessions with an unchanged PATH and give attachments no PDF tools', async () => {
    for (const packaged of [false, true]) {
      createNativeServices({ ...PATHS, packaged }).engine.createSession(options());
      expect(current().launch.env.PATH).toBe('C:\\Synthetic\\Tools');
      expect((await current().attachments!('s')).pdfTools).toBeUndefined();
    }
    expect(mocks.pdfSource).not.toHaveBeenCalled(); expect(mocks.pdfPackaged).not.toHaveBeenCalled();
    expect(mocks.exists).toHaveBeenCalledWith(win32.join(PATHS.appPath, 'resources', 'pdf-tools', 'receipt.json'));
    expect(mocks.exists).toHaveBeenCalledWith(win32.join(PATHS.resourcesPath, 'pdf-tools', 'receipt.json'));
  });

  it('use the builder-supplied tools once a receipt exists, from the project or RELAY_DESK_PDF_TOOLS_DIR', async () => {
    mocks.receipts.add(win32.join(PATHS.appPath, 'resources', 'pdf-tools', 'receipt.json'));
    createNativeServices(PATHS).engine.createSession(options());
    expect(mocks.pdfSource).toHaveBeenCalledExactlyOnceWith({ sourceRoot: win32.join(PATHS.appPath, 'resources', 'pdf-tools') });
    expect(current().launch.env.PATH).toBe('C:\\PdfTools\\Library\\bin;C:\\Synthetic\\Tools');
    expect((await current().attachments!('s')).pdfTools).toBe(pdf);
    vi.stubEnv('RELAY_DESK_PDF_TOOLS_DIR', 'C:\\Users\\me\\poppler');
    mocks.receipts.add('C:\\Users\\me\\poppler\\receipt.json');
    createNativeServices(PATHS).engine.createSession(options());
    expect(mocks.pdfSource).toHaveBeenLastCalledWith({ sourceRoot: 'C:\\Users\\me\\poppler' });
    mocks.receipts.add(win32.join(PATHS.resourcesPath, 'pdf-tools', 'receipt.json'));
    createNativeServices({ ...PATHS, packaged: true }).engine.createSession(options());
    expect(mocks.pdfPackaged).toHaveBeenCalledExactlyOnceWith({ resourcesPath: PATHS.resourcesPath });
  });

  it('turn PDFs off with a warning when the opted-in folder fails its check, and still start every session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.receipts.add(win32.join(PATHS.appPath, 'resources', 'pdf-tools', 'receipt.json'));
    mocks.pdfSource.mockImplementation(() => { throw new Error('PDF resource hash mismatch: Library/bin/poppler.dll'); });
    const services = createNativeServices(PATHS);
    const problem = `PDF attachments are off: the PDF tools folder failed its check (PDF resource hash mismatch: Library/bin/poppler.dll). ${advice}`;
    for (const handleId of ['first', 'second']) {
      const opened = { ...options(), handleId };
      expect(() => services.engine.createSession(opened)).not.toThrow();
      expect(current().launch.env.PATH).toBe('C:\\Synthetic\\Tools');
      expect((await current().attachments!('s')).pdfTools).toBeUndefined();
      expect(opened.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', handleId, fatal: false, message: problem });
    }
    expect(mocks.pdfSource).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[relay:pdf] ${problem}`);
    warn.mockRestore();
  });

  it('turn PDFs off in a packaged build too, with advice that does not need a source checkout first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.receipts.add(win32.join(PATHS.resourcesPath, 'pdf-tools', 'receipt.json'));
    mocks.pdfPackaged.mockImplementation(() => { throw new Error('PDF resource hash mismatch: manifest.json'); });
    const opened = options();
    expect(() => createNativeServices({ ...PATHS, packaged: true }).engine.createSession(opened)).not.toThrow();
    expect(current().launch.env.PATH).toBe('C:\\Synthetic\\Tools');
    const message = `PDF attachments are off: the PDF tools folder failed its check (PDF resource hash mismatch: manifest.json). ${advice}`;
    expect(opened.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', handleId: 'h', fatal: false, message });
    expect(message).toContain('Put the folder back as its receipt.json lists it');
    expect(message.indexOf('node tools/pdf/receipt.mjs')).toBeGreaterThan(message.indexOf('a source checkout'));
    expect(mocks.pdfSource).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('turn PDFs off for the rest of the start when the tools fail their check for a later session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.receipts.add(win32.join(PATHS.appPath, 'resources', 'pdf-tools', 'receipt.json'));
    const changed = { ...pdf, withEnvironment: vi.fn(pdf.withEnvironment) };
    mocks.pdfSource.mockReturnValue(changed);
    const services = createNativeServices(PATHS);
    services.engine.createSession(options());
    expect(current().launch.env.PATH).toBe('C:\\PdfTools\\Library\\bin;C:\\Synthetic\\Tools');
    changed.withEnvironment.mockImplementation(() => { throw new Error('PDF resource hash mismatch: Library/bin/pdfinfo.exe'); });
    const problem = `PDF attachments are off: the PDF tools folder failed its check (PDF resource hash mismatch: Library/bin/pdfinfo.exe). ${advice}`;
    for (const handleId of ['second', 'third']) {
      const opened = { ...options(), handleId };
      expect(() => services.engine.createSession(opened)).not.toThrow();
      expect(current().launch.env.PATH).toBe('C:\\Synthetic\\Tools');
      expect((await current().attachments!('s')).pdfTools).toBeUndefined();
      expect(opened.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', handleId, fatal: false, message: problem });
    }
    expect(changed.withEnvironment).toHaveBeenCalledTimes(2);
    expect(mocks.pdfSource).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(`[relay:pdf] ${problem}`);
    warn.mockRestore();
  });

  it('warn about nothing when PDF tools resolve or are simply absent', () => {
    const absent = options();
    createNativeServices(PATHS).engine.createSession(absent);
    expect(absent.emit).not.toHaveBeenCalled();
    mocks.receipts.add(win32.join(PATHS.appPath, 'resources', 'pdf-tools', 'receipt.json'));
    const present = options();
    createNativeServices(PATHS).engine.createSession(present);
    expect(present.emit).not.toHaveBeenCalled();
  });
});
