import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { EngineIpcDeps } from '../engine/ipc';
import type { AuthService } from '../system/auth';
import type { HandoffService } from '../system/handoff';
import { buildChildEnv } from '../system/env';
import { resolveClaudeBinary } from '../system/claudeBinary';
import { createUsageMemory } from '../engine/usageMemory';
import { buildNativeLaunch } from './launch';
import { NativeInteractiveSession } from './session';
import { createNativeRuntime, NATIVE_UI_STARTUP_TIMEOUT_MS } from './transport';
import { createNativeUsageCache } from './usage';
import type { NativeRuntime } from './contract';
import { assertPrototypePath, assertPrototypeProfile, physicalFuturePath } from './scope';
import { createPrivateStorage } from './privateStorage';
import { guardNativeRuntime } from './guardedRuntime';
import { nativePreferenceFingerprint, verifiedNativeHash } from './controlsState';
import { resolveNativePdfTools } from './pdfSelection';
import type { NativePdfTools } from './attachments';
import { createNativeDurableAssets } from './durableAssets';
import { createNativePreferenceScope } from './persistentPreferences';
import { DEFAULT_PROFILE_ID, type Profile } from '@shared/types';
import { readTaskOutput } from '../engine/taskOutput';
import { createNativeWorkflowFiles } from './workflowFiles';
import { nativeTranscriptFile } from './commandResults';
import { readServedEffortGuides } from './effortGuide';
export { assertPrototypeProfile } from './scope';

const FAKE_KEY = 'native-acceptance-fake-key-not-a-real-credential';
const FIXTURE_REQUIRED = 'This isolated prototype requires its local acceptance fixture. Production accounts remain disabled until all promotion gates pass.';

export function validatedFixtureUrl(input: string | undefined): string | undefined {
  if (!input) return;
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('The prototype fixture must be a numeric loopback HTTP origin.');
  return url.origin;
}

function scopedRuntime(runtime: NativeRuntime, cleanup: () => void, verify: () => void): NativeRuntime {
  return {
    ...runtime,
    async start(launch) {
      try { verify(); return await runtime.start(launch); }
      catch (error) { await runtime.close(); cleanup(); throw error; }
    },
    async close() { await runtime.close(); cleanup(); },
  };
}

export interface NativeServicePaths { root?: string; userData: string; appPath: string; resourcesPath: string; packaged: boolean }

export interface NativeServiceHooks {
  /** Asked before each read of the CLI's cached model catalog; without it the catalog is never read. */
  effortCatalogAllowed?(profile: Profile): boolean;
}

/** Reuses the verified helper's bounded namespace without weakening it or rebuilding the helper. */
export function nativePrivateRoot(userData: string): string {
  if (!win32.isAbsolute(userData) || userData.startsWith('\\\\')) throw new Error('Native application data must be a local absolute path.');
  const key = createHash('sha256').update(win32.normalize(userData).toLowerCase()).digest('hex');
  return win32.join('C:\\RelayDeskNativePrototype', 'app-assets', key);
}

/** Normal execution inherits the existing Relay child environment; fixture overrides never escape the isolated entry. */
export function createNativeServices(args: NativeServicePaths, hooks: NativeServiceHooks = {}) {
  const fixtureUrl = validatedFixtureUrl(process.env.RELAY_NATIVE_FIXTURE_URL);
  const denyProxy = validatedFixtureUrl(process.env.RELAY_NATIVE_DENY_PROXY);
  if (Boolean(fixtureUrl) !== Boolean(denyProxy)) throw new Error('The local fixture and deny proxy must be configured together.');
  if (fixtureUrl && !args.root) throw new Error('Fixture networking requires the isolated prototype entry.');
  const storageRoot = args.root ?? nativePrivateRoot(args.userData);
  const helperPath = args.packaged ? join(args.resourcesPath, 'native', 'RelayNativeHost.exe') : join(args.appPath, 'tools', 'native', 'bin', 'RelayNativeHost.exe');
  const privateHelperPath = args.packaged ? join(args.resourcesPath, 'private-storage', 'RelayPrivateStorage.exe') : join(args.appPath, 'tools', 'private-storage', 'bin', 'RelayPrivateStorage.exe');
  const pluginDirectory = args.packaged ? join(args.resourcesPath, 'native-mod') : join(args.appPath, 'native-mod');
  const usage = createNativeUsageCache(createUsageMemory(join(args.userData, 'usage-cache.json')));
  let pdfTools: NativePdfTools | undefined;
  let pdfResolved = false;
  let pdfProblem: string | undefined;
  // A failed check turns PDF attachments off for the rest of this start; sessions still start.
  const turnPdfOff = (error: unknown): void => {
    pdfTools = undefined;
    pdfProblem = `PDF attachments are off: the PDF tools folder failed its check (${error instanceof Error ? error.message : String(error)}). `
      + 'Other attachments still work. Put the folder back as its receipt.json lists it, then quit and restart Relay Desk. '
      + 'If you changed the folder on purpose, a source checkout can write its receipt again first with node tools/pdf/receipt.mjs. '
      + 'Sessions that are already open keep using the folder until you close them.';
    console.warn(`[relay:pdf] ${pdfProblem}`);
  };
  const createSession: NonNullable<EngineIpcDeps['createSession']> = (options) => {
    const usageGeneration = usage.generation(options.profile.id);
    if (args.root) {
      if (!fixtureUrl || !denyProxy) throw new Error(FIXTURE_REQUIRED);
      assertPrototypeProfile(options.profile, args.root);
      assertPrototypePath(options.request.cwd, args.root);
    } else {
      if (physicalFuturePath(storageRoot).toLowerCase() !== storageRoot.toLowerCase()) throw new Error('Native private storage must not redirect outside its owned namespace.');
      mkdirSync(storageRoot, { recursive: true });
    }
    const preferenceScope = options.profile.id !== DEFAULT_PROFILE_ID && options.profile.configDir
      ? createNativePreferenceScope(options.profile, args.root ?? dirname(options.profile.configDir)) : undefined;
    if (!existsSync(helperPath) || !existsSync(privateHelperPath)) throw new Error('Build the prototype native and private-storage helpers first.');
    const storage = createPrivateStorage({ helperPath: privateHelperPath, prototypeRoot: storageRoot });
    const cleanup = () => storage.dispose();
    try {
      const privateLaunch = storage.createLaunch();
      const mcpConfigPath = options.mcpServers && Object.keys(options.mcpServers).length
        ? storage.writeJson(privateLaunch, { mcpServers: options.mcpServers }).path : undefined;
      const env = buildChildEnv(options.profile);
      if (fixtureUrl && denyProxy) {
        for (const key of Object.keys(env)) if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(key.toUpperCase())) delete env[key];
        Object.assign(env, {
        ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: fixtureUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
        HTTP_PROXY: denyProxy, HTTPS_PROXY: denyProxy, ALL_PROXY: denyProxy,
        NO_PROXY: '127.0.0.1,localhost,[::1]',
        });
      }
      // Resolved once per start and checked again for every session, because the folder can change while Relay Desk
      // runs. Without PDF tools the child gets no PDF PATH entry and attachments refuse only PDFs.
      if (!pdfResolved) {
        pdfResolved = true;
        try { pdfTools = resolveNativePdfTools(args); } catch (error) { turnPdfOff(error); }
      }
      let childEnv: NodeJS.ProcessEnv = { ...env };
      if (pdfTools) {
        try { childEnv = pdfTools.withEnvironment(env); } catch (error) { turnPdfOff(error); }
      }
      const binary = resolveClaudeBinary();
      const cliSha256 = verifiedNativeHash(binary);
      preferenceScope?.prepareNativeSettings({ workflows: options.request.workflows, fastMode: options.request.fastMode,
        ...(options.request.ephemeral ? {} : { autoContinue: options.request.autoContinue !== false }) });
      if (preferenceScope) childEnv.RELAY_NATIVE_PERSISTENT_CONTROLS = '1';
      const launch = buildNativeLaunch({ ...options, buildEnv: () => ({ ...childEnv }) }, { binary, pluginDirectory, mcpConfigPath,
        persistentPreferences: Boolean(preferenceScope) });
      const nativeRuntime = createNativeRuntime({ helperPath,
        ...(options.request.startupRequestId ? { startupTimeoutMs: NATIVE_UI_STARTUP_TIMEOUT_MS } : {}) });
      const guarded = fixtureUrl && denyProxy
        ? guardNativeRuntime(nativeRuntime, { kind: 'local-fixture', origin: fixtureUrl, denyProxy }) : nativeRuntime;
      const runtime = scopedRuntime(guarded, cleanup, () => { storage.verify(privateLaunch); });
      const assets = createNativeDurableAssets({ helperPath: privateHelperPath, prototypeRoot: storageRoot, profileId: options.profile.id });
      const home = args.root ? join(args.root, 'home') : homedir();
      const configRoot = options.profile.configDir ?? join(home, '.claude');
      const workflowFiles = createNativeWorkflowFiles({ cwd: options.request.cwd, assertPath: (path) => {
        if (args.root) assertPrototypePath(path, args.root);
        const relative = win32.relative(physicalFuturePath(configRoot), physicalFuturePath(path));
        if (!relative || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) {
          throw new Error('Native workflow files must belong to the current CLI account.');
        }
      } });
      const session = new NativeInteractiveSession({ ...options, launch, runtime,
        workflowFiles,
        // Asked on every read: the account may have signed in another way since the session opened.
        effortGuides: async () => {
          if (hooks.effortCatalogAllowed?.(options.profile) !== true) return {};
          if (args.root) {
            try { assertPrototypePath(configRoot, args.root); } catch { return {}; }
          }
          return readServedEffortGuides({ configDir: options.profile.configDir, configRoot, home });
        },
        readTaskOutput: async (path) => { if (args.root) assertPrototypePath(path, args.root); return readTaskOutput(path); },
        commandTranscript: async (sessionId, cwd) => {
          const path = await nativeTranscriptFile(launch.env, sessionId, cwd);
          if (path && args.root) assertPrototypePath(path, args.root);
          return path;
        },
        controls: { cliSha256, preferenceFingerprint: () => nativePreferenceFingerprint(options.profile, options.request.cwd, storageRoot,
          args.root ? undefined : { home: homedir(), enforcePrototypeBoundary: false }),
          ...(preferenceScope ? { assertPreferenceScope: preferenceScope.verify, assertCycleBinding: preferenceScope.assertCycleBinding } : {}) },
        attachments: (sessionId) => {
          const lease = assets.openSession({ sessionId, resumeSessionId: options.request.resumeSessionId,
            fork: options.request.forkSession, ephemeral: options.request.ephemeral });
          return { storage: lease.storage, pdfTools, onAccepted: ({ launch: assetLaunch }) => lease.retain(assetLaunch),
            verifyRead: (path) => { lease.verifyPath(path); }, close: () => lease.close() };
        },
        emit: (event) => {
          if (event.type === 'usage' && usageGeneration !== usage.generation(options.profile.id)) return;
          const observed = usage.observe(event, usageGeneration);
          options.emit(event.type === 'usage' && observed ? { ...event, usage: observed } : event);
        } });
      if (pdfProblem) options.emit({ type: 'error', handleId: options.handleId, fatal: false, message: pdfProblem });
      return session;
    } catch (error) { cleanup(); throw error; }
  };
  const auth: AuthService = {
    isLoginInProgress: () => false,
    async status(profile) {
      assertPrototypeProfile(profile, storageRoot);
      return { profileId: profile.id, loggedIn: Boolean(fixtureUrl), authMethod: fixtureUrl ? 'api_key' : 'none', ...(fixtureUrl ? { email: 'offline-fixture@example.invalid', subscriptionType: 'fixture' } : {}), checkedAt: Date.now(), ...(fixtureUrl ? {} : { error: FIXTURE_REQUIRED }) };
    },
    async login() { return { ok: false, message: FIXTURE_REQUIRED }; },
    async logout() { return { ok: false, message: FIXTURE_REQUIRED }; },
    onStatus: () => () => {},
  };
  const blocked = async () => ({ ok: false, message: 'External handoff stays gated in the isolated prototype; no other application was started.' });
  const handoff: HandoffService = {
    toDesktop: blocked, openFolderInDesktop: blocked, openInTerminal: blocked,
    toCloud: blocked, teleport: blocked, remoteControl: blocked,
    backgroundAgents: async () => [], attachBackground: blocked,
  };
  return { engine: { createSession, createUsage: usage.createService },
    ...(args.root ? { auth, handoff, cliVersion: async () => '2.1.308 (isolated native prototype)' } : {}) };
}

export function createPrototypeServices(args: NativeServicePaths & { root: string }) {
  const services = createNativeServices(args);
  return { ...services, auth: services.auth!, handoff: services.handoff!, cliVersion: services.cliVersion! };
}
