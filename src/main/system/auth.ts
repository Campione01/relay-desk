import { homedir } from 'node:os';
import { AUTH_METHODS, type AuthMethod, type AuthStatus, type CliProfilePlan, type HandoffResult, type Profile, type ProfileId } from '@shared/types';
import { readCliProfilePlan } from './cliProfile';
import { resolveClaudeBinary } from './claudeBinary';
import { buildChildEnv } from './env';
import { MSG, errorText } from './messages';
import { runHidden, type CommandRunner } from './run';
import type { TerminalHandle, TerminalOpener } from './terminal';
import { createOfficialLoginOpener, LoginLaunchError } from './officialLogin';
import type { OwnedAuthTerminalOptions } from './ownedAuthTerminal';

export type LoginMethod = 'claudeai' | 'sso' | 'console';

export const AUTH_STATUS_TIMEOUT_MS = 15_000;
export const AUTH_STATUS_THROTTLE_MS = 60_000;
/** The profile plan never holds up a status check; a slower read means no profile plan this time. */
export const PROFILE_PLAN_TIMEOUT_MS = 2_000;

const MAX_FIELD = 256;
interface StatusFlight {
  promise: Promise<AuthStatus>;
  /** This check has not started yet, so newer refresh requests can safely join it. */
  waiting: boolean;
  generation: number;
  source: string;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return clean ? clean.slice(0, MAX_FIELD) : undefined;
}

/**
 * Pure: `claude auth status --json` stdout + exit code (0 = logged in) -> AuthStatus.
 * Only authMethod, configDirectory, email, orgName/organization and subscriptionType are read; nothing else is kept.
 */
export function parseAuthStatus(
  profileId: ProfileId,
  stdout: string,
  exitCode: number | null,
  checkedAt: number,
): AuthStatus {
  const status: AuthStatus = { profileId, loggedIn: exitCode === 0, authMethod: 'unknown', checkedAt };
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (!data) {
    status.error =
      exitCode === null ? 'claude auth status did not finish' : `claude auth status output could not be read (exit ${exitCode})`;
    if (exitCode !== 0) status.loggedIn = false;
    return status;
  }
  const method = data.authMethod;
  status.authMethod = AUTH_METHODS.includes(method as AuthMethod) ? (method as AuthMethod) : 'unknown';
  const configDirectory = cleanString(data.configDirectory);
  if (configDirectory) status.configDirectory = configDirectory;
  const email = cleanString(data.email);
  if (email) status.email = email;
  const organization = cleanString(data.orgName) ?? cleanString(data.organization);
  if (organization) status.organization = organization;
  const subscriptionType = cleanString(data.subscriptionType);
  if (subscriptionType) status.subscriptionType = subscriptionType;
  return status;
}

const EMAIL = /^[^\s@"'<>;&|^%!`\\-][^\s@"'<>;&|^%!`\\]*@[^\s@"'<>;&|^%!`\\]+\.[^\s@"'<>;&|^%!`\\]+$/;

/** Pure: argv after the binary for `auth login` ([--sso | --console] [--email x]). Throws on an invalid email. */
export function authLoginArgs(method?: LoginMethod, email?: string): string[] {
  const args = ['auth', 'login'];
  if (method === 'sso') args.push('--sso');
  else if (method === 'console') args.push('--console');
  const trimmed = email?.trim();
  if (trimmed) {
    if (trimmed.length > 254 || !EMAIL.test(trimmed)) throw new Error(MSG.invalidEmail);
    args.push('--email', trimmed);
  }
  return args;
}

export function authStatusArgs(): string[] {
  return ['auth', 'status', '--json'];
}

export function authLogoutArgs(): string[] {
  return ['auth', 'logout'];
}

export interface AuthService {
  /** Prevent account removal/logout while its visible login console can still save credentials. */
  isLoginInProgress(profileId: ProfileId): boolean;
  /** Throttled to one CLI call per profile per 60 s unless `force`. */
  status(profile: Profile, force?: boolean): Promise<AuthStatus>;
  /** The last checked status of the profile's current authentication source, if any; never runs the CLI. */
  cachedStatus?(profile: Profile): AuthStatus | undefined;
  /** Visible terminal; status is refreshed and emitted when that process exits, also after a cancel. */
  login(profile: Profile, method?: LoginMethod, email?: string): Promise<HandoffResult & { cancelled?: boolean }>;
  cancelLogin?(profileId: ProfileId): Promise<HandoffResult & { noPending?: boolean }>;
  shutdown?(): Promise<void>;
  invalidate?(profileId: ProfileId): void;
  logout(profile: Profile): Promise<HandoffResult>;
  onStatus(cb: (s: AuthStatus) => void): () => void;
}

export interface AuthDeps {
  runner?: CommandRunner;
  openTerminal?: TerminalOpener;
  resolveBinary?: () => string;
  buildEnv?: (profile: Profile) => NodeJS.ProcessEnv;
  now?: () => number;
  /** Working folder for the auth commands (default: the user's home). */
  workDir?: () => string;
  /** Owned console host of the official login; it terminates only its job when Relay exits or cancels. */
  terminalHelperPath?: () => string;
  /** The plan of the profile Claude Code last fetched (default: its global config for the profile). */
  readProfilePlan?: (profile: Profile) => Promise<CliProfilePlan | undefined>;
  profilePlanTimeoutMs?: number;
}

export interface InteractiveAuthService extends AuthService {
  cachedStatus(profile: Profile): AuthStatus | undefined;
}

export function createAuthService(deps: AuthDeps = {}): InteractiveAuthService {
  const runner = deps.runner ?? runHidden;
  const openTerminal = deps.openTerminal ?? ((launch, options) => {
    if (!deps.terminalHelperPath) throw new LoginLaunchError('The owned login host is not configured.');
    return createOfficialLoginOpener({ helperPath: deps.terminalHelperPath() })(launch, options);
  });
  const resolveBinary = deps.resolveBinary ?? (() => resolveClaudeBinary());
  const buildEnv = deps.buildEnv ?? ((profile: Profile) => buildChildEnv(profile));
  const now = deps.now ?? Date.now;
  const workDir = deps.workDir ?? homedir;
  const readProfilePlan = deps.readProfilePlan ?? ((profile: Profile) => readCliProfilePlan(profile.configDir));
  const profilePlanTimeoutMs = deps.profilePlanTimeoutMs ?? PROFILE_PLAN_TIMEOUT_MS;
  const listeners = new Set<(s: AuthStatus) => void>();
  const cache = new Map<ProfileId, AuthStatus>();
  const cacheSources = new Map<ProfileId, string>();
  const inFlight = new Map<ProfileId, StatusFlight>();
  const pendingChecks = new Set<Promise<AuthStatus>>();
  const loginInFlight = new Set<ProfileId>();
  const statusGenerations = new Map<ProfileId, number>();
  let shuttingDown = false;
  interface LoginAttempt {
    profile: Profile;
    abort: AbortController;
    startup: Promise<void>;
    started(): void;
    handle?: TerminalHandle & { close?(): Promise<void> };
    cancelled: boolean;
    finished?: Promise<void>;
  }
  const attempts = new Map<ProfileId, LoginAttempt>();

  const emit = (status: AuthStatus): void => {
    for (const cb of [...listeners]) {
      try {
        cb(structuredClone(status));
      } catch (error) {
        console.error('[auth] status listener failed', error);
      }
    }
  };

  /**
   * Same email only: another Claude Code process may have written another account's profile into the shared config.
   * Only for a claude.ai sign-in: with a Console sign-in the CLI keeps the API key in that same file (R2).
   */
  const addProfilePlan = async (profile: Profile, status: AuthStatus): Promise<void> => {
    if (!status.loggedIn || status.authMethod !== 'claude.ai' || !status.email) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = await Promise.race([
      readProfilePlan(profile).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), profilePlanTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!plan || plan.email.toLowerCase() !== status.email.toLowerCase()) return;
    status.profilePlan = { subscriptionType: plan.subscriptionType, ...(plan.rateLimitTier ? { rateLimitTier: plan.rateLimitTier } : {}) };
  };

  const sourceOf = (profile: Profile): string => profile.authenticationSource ?? 'cli-config';
  const staleStatus = (profile: Profile): AuthStatus => ({ profileId: profile.id, loggedIn: false,
    authMethod: 'unknown', checkedAt: now(), error: 'Authentication source changed; refresh account status.' });
  const check = async (profile: Profile, generation: number): Promise<AuthStatus> => {
    if (shuttingDown || generation !== (statusGenerations.get(profile.id) ?? 0)) return staleStatus(profile);
    let status: AuthStatus;
    try {
      const result = await runner(resolveBinary(), authStatusArgs(), {
        env: buildEnv(profile),
        cwd: workDir(),
        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
      });
      status = parseAuthStatus(profile.id, result.stdout, result.exitCode, now());
      if (result.timedOut) status.error = 'claude auth status timed out';
      else if (result.error) status.error = `claude auth status could not run: ${result.error}`;
      await addProfilePlan(profile, status);
    } catch (error) {
      status = { profileId: profile.id, loggedIn: false, authMethod: 'unknown', checkedAt: now(), error: errorText(error) };
    }
    if (!shuttingDown && generation === (statusGenerations.get(profile.id) ?? 0)) {
      cache.set(profile.id, status);
      cacheSources.set(profile.id, sourceOf(profile));
      emit(status);
    } else {
      return staleStatus(profile);
    }
    return status;
  };

  const startStatusCheck = (profile: Profile, after?: StatusFlight): Promise<AuthStatus> => {
    const captured = { ...profile };
    const generation = statusGenerations.get(profile.id) ?? 0;
    let flight: StatusFlight;
    const checked = after
      ? after.promise.catch(() => undefined).then(() => { flight.waiting = false; return check(captured, generation); })
      : check(captured, generation);
    const pending = checked.finally(() => {
      pendingChecks.delete(pending);
      if (inFlight.get(profile.id)?.promise === pending) inFlight.delete(profile.id);
    });
    pendingChecks.add(pending);
    flight = { promise: pending, waiting: after !== undefined, generation, source: sourceOf(captured) };
    inFlight.set(profile.id, flight);
    return pending;
  };

  const status = (profile: Profile, force = false): Promise<AuthStatus> => {
    if (shuttingDown) return Promise.resolve(cache.get(profile.id) ?? {
      profileId: profile.id, loggedIn: false, authMethod: 'unknown', checkedAt: now(), error: 'Relay is shutting down.',
    });
    const running = inFlight.get(profile.id);
    if (running && running.generation === (statusGenerations.get(profile.id) ?? 0) && running.source === sourceOf(profile)) {
      const pending = force && !running.waiting ? startStatusCheck(profile, running) : running.promise;
      return pending.then((s) => structuredClone(s));
    }
    const cached = cache.get(profile.id);
    if (!force && cached && cacheSources.get(profile.id) === sourceOf(profile) && now() - cached.checkedAt < AUTH_STATUS_THROTTLE_MS) return Promise.resolve(structuredClone(cached));
    return startStatusCheck(profile).then((s) => structuredClone(s));
  };

  const finishAttempt = (attempt: LoginAttempt): Promise<void> => {
    if (attempt.finished) return attempt.finished;
    attempt.finished = (async () => {
      const id = attempt.profile.id;
      if (attempts.get(id) !== attempt) return;
      attempts.delete(id);
      loginInFlight.delete(id);
      cache.delete(id);
      cacheSources.delete(id);
      // Also after a cancel of a running login: the CLI can have saved the sign-in just before it was stopped.
      if (!shuttingDown && (!attempt.cancelled || attempt.handle)) await status(attempt.profile, true);
    })();
    return attempt.finished;
  };

  const stopAttempt = async (attempt: LoginAttempt): Promise<void> => {
    attempt.cancelled = true;
    attempt.abort.abort();
    await attempt.startup;
    if (attempt.handle && !attempt.finished) {
      if (!attempt.handle.close) throw new LoginLaunchError('The pending login has no owned cancellation handle; close its console before exiting.');
      await attempt.handle.close();
      await attempt.handle.exited;
    }
    await finishAttempt(attempt);
  };

  return {
    isLoginInProgress: (profileId) => loginInFlight.has(profileId),
    invalidate(profileId) {
      cache.delete(profileId);
      cacheSources.delete(profileId);
      inFlight.delete(profileId);
      statusGenerations.set(profileId, (statusGenerations.get(profileId) ?? 0) + 1);
    },
    async cancelLogin(profileId) {
      const attempt = attempts.get(profileId);
      if (!attempt) return { ok: true, noPending: true, message: 'There is no pending login for this account.' };
      try {
        await stopAttempt(attempt);
        return { ok: true, noPending: false, message: 'The pending login and its owned processes have been closed.' };
      } catch { return { ok: false, message: 'The pending login has not been confirmed closed. The account remains protected.' }; }
    },
    async shutdown() {
      shuttingDown = true;
      await Promise.all([...attempts.values()].map(stopAttempt));
      await Promise.allSettled([...pendingChecks]);
    },
    status,
    cachedStatus(profile) {
      const cached = cache.get(profile.id);
      return cached && cacheSources.get(profile.id) === sourceOf(profile) ? structuredClone(cached) : undefined;
    },
    async login(profile, method, email) {
      if (shuttingDown) return { ok: false, message: 'Relay is shutting down; no new login was started.' };
      let args: string[];
      try {
        args = authLoginArgs(method, email);
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      if (loginInFlight.has(profile.id)) {
        return { ok: false, message: 'A login console for this account is already open. Finish or close it before trying again.' };
      }
      loginInFlight.add(profile.id);
      let started!: () => void;
      const attempt: LoginAttempt = { profile, abort: new AbortController(), cancelled: false,
        startup: new Promise<void>((resolve) => { started = resolve; }), started: () => started() };
      attempts.set(profile.id, attempt);
      try {
        // The official command as is, in the profile's own environment, with nothing that reads its output.
        const terminalOptions: OwnedAuthTerminalOptions = { signal: attempt.abort.signal };
        const handle = await openTerminal(
          { exe: resolveBinary(), args, cwd: workDir(), env: buildEnv(profile), title: 'Relay Desk login' },
          terminalOptions,
        );
        attempt.handle = handle;
        if (!handle.exited) throw new LoginLaunchError('The login console could not be observed.');
        const finished = (): Promise<void> => finishAttempt(attempt);
        void handle.exited.then(finished, finished).catch(() => undefined);
        attempt.started();
        if (attempt.cancelled || shuttingDown) {
          await stopAttempt(attempt);
          return { ok: false, cancelled: true, message: 'Login canceled.' };
        }
        return { ok: true, message: MSG.loginConsoleOpened };
      } catch (error) {
        attempt.started();
        // A cancel (or shutdown) during the start ends it; that is no failure to report.
        const cancelled = attempt.cancelled || shuttingDown;
        attempt.cancelled = true;
        try { await stopAttempt(attempt); } catch { /* Keep the account locked if a writer cannot be confirmed closed. */ }
        if (cancelled) return { ok: false, cancelled: true, message: 'Login canceled.' };
        const reason = error instanceof LoginLaunchError ? error.message : 'Could not start the login console.';
        return { ok: false, message: MSG.loginFailed(reason) };
      } finally {
        attempt.started();
      }
    },
    async logout(profile) {
      if (shuttingDown || loginInFlight.has(profile.id)) return { ok: false, message: 'Finish or cancel the pending login before signing out.' };
      let exitCode: number | null = null;
      try {
        const result = await runner(resolveBinary(), authLogoutArgs(), {
          env: buildEnv(profile),
          cwd: workDir(),
          timeoutMs: AUTH_STATUS_TIMEOUT_MS,
        });
        exitCode = result.exitCode;
      } catch {
        exitCode = null;
      }
      await status(profile, true);
      return exitCode === 0
        ? { ok: true, message: MSG.loggedOut, exitCode }
        : { ok: false, message: MSG.logoutFailed(exitCode), ...(exitCode === null ? {} : { exitCode }) };
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
