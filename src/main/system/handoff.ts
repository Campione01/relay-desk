import { homedir } from 'node:os';
import type { RelayApi } from '@shared/ipc';
import { DEFAULT_PROFILE_ID, type BackgroundAgent, type HandoffResult, type Profile, type ProfileId } from '@shared/types';
import type { EngineControl } from '../engine/ipc';
import { resolveClaudeBinary } from './claudeBinary';
import { buildChildEnv } from './env';
import { isSessionId } from './launchArgs';
import { MSG, errorText } from './messages';
import { toLocalAbsolutePath } from './paths';
import { runHidden, type CommandRunner } from './run';
import type { SharedCodeContextSettings } from './sharedCodeContext';
import { openTerminal as defaultOpenTerminal, type TerminalOpener } from './terminal';

// Pure argv builders (arguments after the bundled claude.exe) for the official hand-off commands.
// Builders throw on invalid ids; the runners turn that into a HandoffResult.

const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BACKGROUND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_TASK_CHARS = 6000;

function requireSessionId(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(MSG.invalidSessionId);
  return sessionId;
}

export function desktopResumeArgs(sessionId: string): string[] {
  return ['--desktop', '--resume', requireSessionId(sessionId)];
}

export function desktopOpenArgs(): string[] {
  return ['--desktop'];
}

/** `--continue` wins over a session id; with neither, a new interactive session in the folder. */
export function terminalResumeArgs(o: { sessionId?: string; fork?: boolean; continueLatest?: boolean }): string[] {
  const fork = o.fork ? ['--fork-session'] : [];
  if (o.continueLatest) return ['--continue', ...fork];
  if (o.sessionId) return ['--resume', requireSessionId(o.sessionId), ...fork];
  return [];
}

/** Pure: task text without NUL/control characters (newlines and tabs kept), trimmed. */
export function cleanTask(task: string): string {
  return task
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
}

/** A task starting with "-" uses the `--cloud=<task>` form so it is never parsed as a flag. */
export function cloudArgs(task: string): string[] {
  const clean = cleanTask(typeof task === 'string' ? task : '');
  if (!clean) throw new Error(MSG.emptyTask);
  if (clean.length > MAX_TASK_CHARS) throw new Error(`The task is too long (at most ${MAX_TASK_CHARS} characters).`);
  return clean.startsWith('-') ? [`--cloud=${clean}`] : ['--cloud', clean];
}

export function teleportArgs(cloudSessionId?: string): string[] {
  if (cloudSessionId === undefined || cloudSessionId === '') return ['--teleport'];
  if (!CLOUD_ID.test(cloudSessionId)) throw new Error(MSG.invalidCloudSessionId);
  return ['--teleport', cloudSessionId];
}

export function remoteControlArgs(sessionId?: string): string[] {
  return sessionId ? ['--remote-control', '--resume', requireSessionId(sessionId)] : ['--remote-control'];
}

export function agentsListArgs(): string[] {
  return ['agents', '--json'];
}

export function attachArgs(id: string): string[] {
  if (typeof id !== 'string' || !BACKGROUND_ID.test(id)) throw new Error(MSG.invalidBackgroundId);
  return ['attach', id];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return clean ? clean.slice(0, 256) : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return text(value);
}

/** Pure, defensive: `claude agents --json` stdout -> BackgroundAgent[] (unknown shapes are skipped). */
export function parseBackgroundAgents(stdout: string): BackgroundAgent[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    data = record.sessions ?? record.agents ?? record.items;
  }
  if (!Array.isArray(data)) return [];
  const agents: BackgroundAgent[] = [];
  for (const raw of data.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : undefined;
    if (r.kind !== 'background' || !id || !BACKGROUND_ID.test(id)) continue;
    const agent: BackgroundAgent = { id };
    const sessionId = text(r.sessionId) ?? text(r.session_id);
    if (sessionId) agent.sessionId = sessionId;
    const name = text(r.name) ?? text(r.title) ?? text(r.label);
    if (name) agent.name = name;
    const cwd = text(r.cwd) ?? text(r.directory);
    if (cwd) agent.cwd = cwd;
    const state = text(r.state);
    if (state) agent.state = state;
    const status = text(r.status);
    if (status) agent.status = status;
    const startedAt = timestamp(r.startedAt ?? r.started_at ?? r.createdAt);
    if (startedAt) agent.startedAt = startedAt;
    agents.push(agent);
  }
  return agents;
}

export type HandoffService = RelayApi['handoff'];

export interface HandoffDeps {
  engine: Pick<EngineControl, 'close' | 'findBySession' | 'findByCwd'>;
  getProfile(id: ProfileId): Promise<Profile>;
  runner?: CommandRunner;
  openTerminal?: TerminalOpener;
  resolveBinary?: () => string;
  buildEnv?: (profile: Profile) => NodeJS.ProcessEnv;
  /** Reuse scoped shared-context preparation; no account settings or credentials are copied. */
  prepareCodeContext?(profile: Profile, cwd: string): Promise<{ settings?: SharedCodeContextSettings }>;
  /** Folder for commands without a project folder (agents, attach); default: the user's home. */
  homeDir?: () => string;
}

/** `claude --desktop` hands the session to the app and exits; allow for a slow app start. */
export const DESKTOP_TIMEOUT_MS = 60_000;
export const AGENTS_TIMEOUT_MS = 15_000;

class HandoffError extends Error {}

export function createHandoffService(deps: HandoffDeps): HandoffService {
  const runner = deps.runner ?? runHidden;
  const openTerminal = deps.openTerminal ?? defaultOpenTerminal;
  const resolveBinary = deps.resolveBinary ?? (() => resolveClaudeBinary());
  const buildEnv = deps.buildEnv ?? ((profile: Profile) => buildChildEnv(profile));
  const home = deps.homeDir ?? homedir;

  const profileOf = async (id: unknown): Promise<Profile> => {
    if (typeof id !== 'string') throw new HandoffError(MSG.unknownProfile(String(id)));
    try {
      return await deps.getProfile(id);
    } catch {
      throw new HandoffError(MSG.unknownProfile(id));
    }
  };

  const folder = (cwd: unknown): string => {
    const checked = toLocalAbsolutePath(cwd);
    if (!checked) throw new HandoffError(MSG.invalidFolder);
    return checked;
  };

  const withSharedContext = async (profile: Profile, cwd: string, args: string[]): Promise<string[]> => {
    if (!deps.prepareCodeContext || profile.id === DEFAULT_PROFILE_ID || profile.sharedCodeContext === false) return args;
    const { settings } = await deps.prepareCodeContext(profile, cwd);
    if (!settings) return args;
    const shared: SharedCodeContextSettings = {
      ...(settings.permissions !== undefined ? { permissions: structuredClone(settings.permissions) } : {}),
      ...(settings.autoMemoryDirectory !== undefined ? { autoMemoryDirectory: settings.autoMemoryDirectory } : {}),
      ...(settings.autoMemoryEnabled !== undefined ? { autoMemoryEnabled: settings.autoMemoryEnabled } : {}),
    };
    return Object.keys(shared).length ? ['--settings', JSON.stringify(shared), ...args] : args;
  };

  /** R4: the Relay writer of `sessionId` (and the caller's handle) exits before another client opens the session. */
  const closeWriters = async (
    sessionId: string | undefined,
    handleId: string | undefined,
    profileId: ProfileId,
    otherIds: readonly string[] = [],
  ): Promise<void> => {
    const ids = new Set<string>();
    if (handleId) ids.add(handleId);
    for (const id of otherIds) ids.add(id);
    const writer = sessionId ? deps.engine.findBySession(sessionId, profileId) : undefined;
    if (writer) ids.add(writer.handleId);
    for (const id of ids) {
      try {
        await deps.engine.close(id);
      } catch (error) {
        throw new HandoffError(MSG.closeFailed(errorText(error)));
      }
    }
  };

  const inTerminal = async (profile: Profile, cwd: string, args: string[], okMessage: string): Promise<HandoffResult> => {
    try {
      await openTerminal({ exe: resolveBinary(), args, cwd, env: buildEnv(profile), title: 'Relay Desk' });
      return { ok: true, message: okMessage };
    } catch (error) {
      return { ok: false, message: MSG.terminalFailed(errorText(error)) };
    }
  };

  const runDesktop = async (cwd: string, args: string[], okMessage: string): Promise<HandoffResult> => {
    const profile = await profileOf(DEFAULT_PROFILE_ID);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // --desktop requires a real console; redirecting stdin/stdout makes the CLI refuse it.
      // On failure the console stays open so the CLI's own reason stays readable.
      const exited = openTerminal(
        { exe: resolveBinary(), args, cwd, env: buildEnv(profile), title: 'Relay Desk' },
        { waitForExit: true, keepOpenOnError: true },
      ).then((handle) => handle.exited);
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DESKTOP_TIMEOUT_MS);
      });
      const exitCode = await Promise.race([exited, timeout]);
      if (exitCode === 0) return { ok: true, message: okMessage, exitCode: 0 };
      return {
        ok: false,
        message: MSG.desktopFailed(exitCode),
        ...(exitCode === null ? {} : { exitCode }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** Runs `body`, turning thrown validation errors into ok:false results. */
  const guard = async (body: () => Promise<HandoffResult>): Promise<HandoffResult> => {
    try {
      return await body();
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
  };

  const input = (a: unknown): Record<string, unknown> => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {});
  const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  return {
    toDesktop: (raw) =>
      guard(async () => {
        const a = input(raw);
        if (a.profileId !== DEFAULT_PROFILE_ID) return { ok: false, message: MSG.desktopDefaultOnly };
        const sessionId = String(a.sessionId ?? '');
        const args = desktopResumeArgs(sessionId);
        const cwd = folder(a.cwd);
        await closeWriters(sessionId, optionalString(a.handleId), DEFAULT_PROFILE_ID);
        return runDesktop(cwd, args, MSG.desktopOpened);
      }),
    openFolderInDesktop: (raw) =>
      guard(async () => {
        const a = input(raw);
        if (a.profileId !== DEFAULT_PROFILE_ID) return { ok: false, message: MSG.desktopDefaultOnly };
        return runDesktop(folder(a.cwd), desktopOpenArgs(), MSG.desktopFolderOpened);
      }),
    openInTerminal: (raw) =>
      guard(async () => {
        const a = input(raw);
        const profile = await profileOf(a.profileId);
        const sessionId = optionalString(a.sessionId);
        const fork = a.fork === true;
        const continueLatest = a.continueLatest === true;
        const resumeArgs = terminalResumeArgs({ sessionId, fork, continueLatest });
        const cwd = folder(a.cwd);
        const args = await withSharedContext(profile, cwd, resumeArgs);
        // A fork writes a new session; resuming (or continuing the latest one in this folder) writes this one.
        if (!fork && continueLatest) {
          const writers = deps.engine.findByCwd(cwd, profile.id);
          await closeWriters(undefined, optionalString(a.handleId), profile.id, writers.map((writer) => writer.handleId));
        } else if (!fork && sessionId) await closeWriters(sessionId, optionalString(a.handleId), profile.id);
        return inTerminal(profile, cwd, args, MSG.terminalOpened);
      }),
    toCloud: (raw) =>
      guard(async () => {
        const a = input(raw);
        const profile = await profileOf(a.profileId);
        const taskArgs = cloudArgs(typeof a.task === 'string' ? a.task : '');
        const cwd = folder(a.cwd);
        const args = await withSharedContext(profile, cwd, taskArgs);
        return inTerminal(profile, cwd, args, MSG.cloudOpened);
      }),
    teleport: (raw) =>
      guard(async () => {
        const a = input(raw);
        const profile = await profileOf(a.profileId);
        const resumeArgs = teleportArgs(optionalString(a.cloudSessionId));
        const cwd = folder(a.cwd);
        const args = await withSharedContext(profile, cwd, resumeArgs);
        return inTerminal(profile, cwd, args, MSG.teleportOpened);
      }),
    remoteControl: (raw) =>
      guard(async () => {
        const a = input(raw);
        const profile = await profileOf(a.profileId);
        const sessionId = optionalString(a.sessionId);
        const resumeArgs = remoteControlArgs(sessionId);
        const cwd = folder(a.cwd);
        const args = await withSharedContext(profile, cwd, resumeArgs);
        if (sessionId) await closeWriters(sessionId, optionalString(a.handleId), profile.id);
        return inTerminal(profile, cwd, args, MSG.remoteControlOpened);
      }),
    backgroundAgents: async (profileId) => {
      const profile = await profileOf(profileId);
      const result = await runner(resolveBinary(), agentsListArgs(), {
        env: buildEnv(profile),
        cwd: home(),
        timeoutMs: AGENTS_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Could not list the background sessions (${result.timedOut ? 'timed out' : `exit code ${result.exitCode ?? 'none'}`}).`);
      }
      return parseBackgroundAgents(result.stdout);
    },
    attachBackground: (raw) =>
      guard(async () => {
        const a = input(raw);
        const profile = await profileOf(a.profileId);
        const args = attachArgs(typeof a.id === 'string' ? a.id : '');
        return inTerminal(profile, home(), args, MSG.attachOpened);
      }),
  };
}
