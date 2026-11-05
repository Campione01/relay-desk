import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { app, type IpcMain } from 'electron';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '@shared/events';
import { registerHandlers } from '@shared/ipc';
import {
  EFFORT_LEVELS,
  MAX_HISTORY_CURSOR,
  MAX_MCP_OVERRIDES,
  PERMISSION_MODES,
  SHARED_CONTEXT_ERROR_PREFIX,
  type Effort,
  type EngineHandle,
  type NativeStartupInput,
  type NativePanelInput,
  type OpenSessionRequest,
  type PermissionDecision,
  type PermissionMode,
  type Profile,
  type ProfileId,
  type QuestionAnswer,
  type SharedCodeContextReport,
  type WorkflowsSetting,
  type TranscriptItem,
  isWorkflowsSetting,
} from '@shared/types';
import { toLocalAbsolutePath } from '../system/paths';
import { parseAttachments } from './attachments';
import { PermissionBroker } from './broker';
import { createListingClient, type ListingClient } from './listing';
import { MAX_TITLE_LENGTH } from './listingOps';
import { imageStore } from './images';
import { isRecord } from './mapTranscript';
import { EngineSession, type CodeContextSettings, type EngineSessionOptions } from './session';
import { createUsageService, type UsageService, type UsageServiceDeps } from './usage';
import { createUsageMemory } from './usageMemory';

/** What the IPC layer needs from a session; EngineSession implements it. */
export type EngineSessionLike = Pick<
  EngineSession,
  | 'handle'
  | 'start'
  | 'send'
  | 'interrupt'
  | 'setModel'
  | 'setEffort'
  | 'setUltracode'
  | 'setFastMode'
  | 'setWorkflows'
  | 'setAutoContinue'
  | 'cancelAutoContinue'
  | 'setLiveContext'
  | 'continueAfterLimit'
  | 'stopTask'
  | 'taskOutput'
  | 'setPermissionMode'
  | 'models'
  | 'contextUsage'
  | 'mcpStatus'
  | 'mcpToggle'
  | 'mcpReconnect'
  | 'planUsage'
  | 'close'
  | 'onPendingChange'
  | 'onToolDecision'
> & {
  nativeSubagent?(agentId: string): Promise<TranscriptItem[] | null>;
  startupInput?(input: NativeStartupInput): Promise<void>;
  panelInput?(input: NativePanelInput): Promise<void>;
  panelClose?(): Promise<void>;
  /** Re-sends the live state for a renderer that adopts an already open handle. */
  republish?(): void;
};

export interface EngineIpcDeps {
  /** Delivers an engine event to the renderer. */
  emit(event: EngineEvent): void;
  /** Rejects for unknown ids. */
  getProfile(id: ProfileId): Promise<Profile>;
  /** Absolute path of the built utilityProcess entry (out/main/listingWorker.js). */
  listingWorkerPath: string;
  /** Folder for CLI stderr logs; default userData/logs. */
  logDir?: string;
  /** File that keeps the last good plan usage across restarts (userData/usage-cache.json in the app). */
  usageMemoryPath?: string;
  createSession?(options: EngineSessionOptions): EngineSessionLike;
  listing?: ListingClient;
  newHandleId?(): string;
  isDirectory?(path: string): Promise<boolean>;
  /** Sign-in or account-directory mutation is in progress; no new writer may start. */
  isProfileBusy?(profileId: ProfileId): boolean;
  /** Prepare shared Code files/settings before constructing a writer. No default filesystem helper. */
  prepareCodeContext?(profile: Profile, cwd: string): Promise<{ settings?: CodeContextSettings; report: SharedCodeContextReport }>;
  /** Enabled servers of Relay's own MCP list as SDK configs (env values included; main only). */
  getMcpServers?(): Promise<Record<string, McpServerConfig>>;
  /** Plan usage service; default one built on the open sessions and short probes. */
  createUsage?(base: Pick<UsageServiceDeps, 'emit' | 'getProfile' | 'liveSession' | 'isProfileBusy'>): UsageService;
}

/** What the rest of main (hand-off, app quit) may do with the engine. */
export interface EngineControl {
  /** Closes a handle; resolves after its CLI process exited (R4). No-op for unknown ids. */
  close(handleId: string): Promise<void>;
  /** Handle currently writing `sessionId`, if any (R4 single writer). */
  findBySession(sessionId: string, profileId?: ProfileId): EngineHandle | undefined;
  /** All writers in a profile and normalized, case-insensitive Windows folder. */
  findByCwd(cwd: string, profileId: ProfileId): EngineHandle[];
  /** Every live writer for an account, including handles that are still starting. */
  findByProfile(profileId: ProfileId): EngineHandle[];
  /** Closes every handle and listing worker (app quit). */
  closeAll(): Promise<void>;
  /** Auth-source changes cannot reuse readings from the previous credential source. */
  invalidateProfileUsage?(profileId: ProfileId): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]/@-]{0,99}$/;

function normalizedCwd(cwd: string): string {
  return win32.normalize(cwd).replace(/\\+$/, '').toLowerCase();
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${what}.`);
  return value;
}

function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('Invalid session id.');
  return value.toLowerCase();
}

function startupRequestIdOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('Invalid startup request id.');
  return value;
}

function startupInputOf(value: unknown): NativeStartupInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      typeof value.key !== 'string' || !['enter', 'up', 'down', 'left', 'right', 'tab', 'escape'].includes(value.key)) {
    throw new Error('Invalid startup input.');
  }
  return { revision: value.revision as number, key: value.key as NativeStartupInput['key'] };
}

function modelOf(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value)) throw new Error('Invalid model name.');
  return value;
}

/** Task ids (b1a2c3d4e, a0201cf8574775420) and subagent ids. */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function taskIdOf(value: unknown, what: 'task' | 'agent' = 'task'): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw new Error(`Invalid ${what} id.`);
  return value;
}

function mcpNameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid MCP server name.');
  return value;
}

function effortOf(value: unknown): Effort {
  if (!EFFORT_LEVELS.includes(value as Effort)) throw new Error('Invalid effort level.');
  return value as Effort;
}

function modeOf(value: unknown): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('Invalid permission mode.');
  return value as PermissionMode;
}

/** Unset optional fields may arrive as undefined, null or ''. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function mcpOverridesOf(value: unknown): Record<string, boolean> | undefined {
  if (!present(value)) return undefined;
  const entries = isRecord(value) ? Object.entries(value) : null;
  if (!entries || entries.length > MAX_MCP_OVERRIDES || entries.some(([, enabled]) => typeof enabled !== 'boolean')) {
    throw new Error('Invalid MCP server choices.');
  }
  // fromEntries defines own properties, so a "__proto__" name stays a plain key.
  return entries.length ? Object.fromEntries(entries.map(([name, enabled]) => [mcpNameOf(name), enabled === true])) : undefined;
}

/** Copies only the known fields of a renderer-supplied request, validated. */
export function parseOpenRequest(value: unknown): OpenSessionRequest {
  if (!isRecord(value)) throw new Error('Invalid session request.');
  const cwd = folderOf(text(value.cwd, 'folder'));
  const resume = present(value.resumeSessionId) ? sessionIdOf(value.resumeSessionId) : undefined;
  const fork = value.forkSession === true;
  if (value.ephemeral === true && (!resume || !fork)) throw new Error('A side chat must fork a resumed session.');
  if (value.ephemeral !== true && value.ephemeral !== false && value.ephemeral !== undefined && value.ephemeral !== null) {
    throw new Error('Invalid side chat request.');
  }
  if (value.autoContinue !== undefined && value.autoContinue !== null && typeof value.autoContinue !== 'boolean') {
    throw new Error('Invalid auto-continue setting.');
  }
  if (value.liveContext !== undefined && value.liveContext !== null && typeof value.liveContext !== 'boolean') {
    throw new Error('Invalid context refresh setting.');
  }
  const mcpOverrides = mcpOverridesOf(value.mcpOverrides);
  return {
    profileId: text(value.profileId, 'profile'),
    cwd,
    ...(present(value.startupRequestId) ? { startupRequestId: startupRequestIdOf(value.startupRequestId) } : {}),
    ...(resume ? { resumeSessionId: resume } : {}),
    ...(fork ? { forkSession: true } : {}),
    ...(value.ephemeral === true ? { ephemeral: true } : {}),
    ...(present(value.model) ? { model: modelOf(value.model) } : {}),
    ...(present(value.effort) ? { effort: effortOf(value.effort) } : {}),
    ...(present(value.permissionMode) ? { permissionMode: modeOf(value.permissionMode) } : {}),
    ...(value.skipSharedContext === true ? { skipSharedContext: true } : {}),
    ...(value.ultracode === true ? { ultracode: true } : {}),
    ...(typeof value.fastMode === 'boolean' ? { fastMode: value.fastMode } : {}),
    ...(present(value.workflows) ? { workflows: workflowsOf(value.workflows) } : {}),
    ...(typeof value.autoContinue === 'boolean' ? { autoContinue: value.autoContinue } : {}),
    ...(value.liveContext === true ? { liveContext: true } : {}),
    ...(mcpOverrides ? { mcpOverrides } : {}),
  };
}

function workflowsOf(value: unknown): WorkflowsSetting {
  if (!isWorkflowsSetting(value)) throw new Error('Invalid workflows setting.');
  return value;
}

/** A local drive path (no UNC, device or root-relative paths), normalised. */
function folderOf(value: string): string {
  const folder = toLocalAbsolutePath(value);
  if (!folder) throw new Error('The folder must be an absolute local path.');
  return folder;
}

/** Optional `older` cursor of a history page: absent stays absent, anything else must be a string the worker issued. */
function historyCursorOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_HISTORY_CURSOR) throw new Error('Invalid history cursor.');
  return value;
}

/** Optional history folder: absent stays absent, anything else must be a valid local folder. */
function optionalFolderOf(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string') throw new Error('The folder must be an absolute local path.');
  return folderOf(value);
}

export function parseDecision(value: unknown): PermissionDecision {
  if (isRecord(value) && value.behavior === 'allow' && (value.scope === 'once' || value.scope === 'session')) {
    return { behavior: 'allow', scope: value.scope, ...(isRecord(value.updatedInput) ? { updatedInput: value.updatedInput } : {}) };
  }
  if (isRecord(value) && value.behavior === 'deny') {
    return { behavior: 'deny', ...(typeof value.message === 'string' && value.message.trim() ? { message: value.message } : {}) };
  }
  throw new Error('Invalid permission decision.');
}

export function parseAnswer(value: unknown): QuestionAnswer | null {
  if (value === null) return null;
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'string')) throw new Error('Invalid answer.');
  return { ...(value as QuestionAnswer) };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Prefixes preparation failures so the renderer can offer a one-time open without the shared context (EC-2). */
async function prepareShared(
  prepare: NonNullable<EngineIpcDeps['prepareCodeContext']>,
  profile: Profile,
  cwd: string,
): Promise<{ settings?: CodeContextSettings; report: SharedCodeContextReport }> {
  try {
    return await prepare(profile, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(SHARED_CONTEXT_ERROR_PREFIX) ? message : `${SHARED_CONTEXT_ERROR_PREFIX}${message}`);
  }
}

interface StartupState {
  revision: number;
  phase: 'waiting' | 'ready' | 'closed';
}

interface Entry {
  session: EngineSessionLike;
  broker: PermissionBroker;
  request: OpenSessionRequest;
  ready: Promise<EngineHandle>;
  /** Started: its query can answer control requests. */
  live: boolean;
  failed: boolean;
  cancelled: boolean;
  startup: StartupState;
  closing?: Promise<void>;
}

interface Opening {
  handle: EngineHandle;
  request: OpenSessionRequest;
  ready: Promise<EngineHandle>;
  cancelled: boolean;
  startup: StartupState;
}

/** Wires the engine.* and sessions.* channels. */
export function registerEngineIpc(ipcMain: IpcMain, deps: EngineIpcDeps): EngineControl {
  const entries = new Map<string, Entry>();
  const opening = new Map<string, Opening>();
  // A window that goes away mid-send must not break a running session or a pending permission.
  const emit = (event: EngineEvent): void => {
    try {
      deps.emit(event);
    } catch (error) {
      console.error('[relay:engine] could not deliver an event', error);
    }
  };
  let listing: ListingClient | undefined;
  let shuttingDown = false;
  const getListing = (): ListingClient => (listing ??= deps.listing ?? createListingClient(deps.listingWorkerPath));
  const createSession = deps.createSession ?? ((options: EngineSessionOptions) => new EngineSession(options));
  const isDirectory = deps.isDirectory ?? directoryExists;
  const usageBase: Pick<UsageServiceDeps, 'emit' | 'getProfile' | 'liveSession' | 'isProfileBusy'> = {
    emit,
    getProfile: (id) => deps.getProfile(id),
    liveSession: (profileId) => [...entries.values()].find((entry) => entry.live && entry.request.profileId === profileId)?.session,
    ...(deps.isProfileBusy ? { isProfileBusy: (id: ProfileId) => deps.isProfileBusy?.(id) ?? false } : {}),
  };
  const usage =
    deps.createUsage?.(usageBase) ??
    createUsageService({ ...usageBase, ...(deps.usageMemoryPath ? { memory: createUsageMemory(deps.usageMemoryPath) } : {}) });

  // A side chat (ephemeral fork) saves nothing, so it writes no session: not the original, not its own fork id.
  const writerOf = (entry: Entry): string | undefined =>
    entry.request.ephemeral
      ? undefined
      : (entry.session.handle.sessionId ?? (entry.request.forkSession ? undefined : entry.request.resumeSessionId));

  const entryForSession = (sessionId: string, profileId?: ProfileId): Entry | undefined =>
    [...entries.values()].find(
      (entry) => writerOf(entry)?.toLowerCase() === sessionId.toLowerCase() && (profileId === undefined || entry.request.profileId === profileId),
    );

  const openingForSession = (sessionId: string, profileId?: ProfileId): Opening | undefined =>
    [...opening.values()].find(
      (entry) => entry.handle.sessionId?.toLowerCase() === sessionId.toLowerCase() && (profileId === undefined || entry.request.profileId === profileId),
    );

  const handles = (options: { writersOnly?: boolean } = {}): EngineHandle[] =>
    [...entries.values(), ...opening.values()]
      .filter((entry) => !(options.writersOnly && entry.request.ephemeral))
      .map((entry) => ('session' in entry ? entry.session.handle : entry.handle));

  const entryFor = (handleId: unknown): Entry => {
    const entry = typeof handleId === 'string' ? entries.get(handleId) : undefined;
    if (!entry) throw new Error('This session is not open in Relay Desk.');
    return entry;
  };

  const closeStartup = (handleId: string, attempt: Pick<Opening, 'request' | 'startup'>): void => {
    if (!attempt.request.startupRequestId || attempt.startup.phase === 'closed') return;
    attempt.startup.phase = 'closed';
    emit({ type: 'startup', handleId, requestId: attempt.request.startupRequestId,
      revision: attempt.startup.revision, text: '', phase: 'closed' });
  };

  const closeHandle = async (handleId: string): Promise<void> => {
    const reservation = opening.get(handleId);
    if (reservation) {
      reservation.cancelled = true;
      closeStartup(handleId, reservation);
      opening.delete(handleId);
      return;
    }
    const entry = entries.get(handleId);
    if (!entry) return;
    if (!entry.live) entry.cancelled = true;
    closeStartup(handleId, entry);
    // Concurrent cancel/retry calls share cleanup, but a failed close remains retryable.
    entry.closing ??= Promise.resolve().then(() => entry.session.close()).then(() => {
      if (entries.get(handleId) === entry) entries.delete(handleId);
    }).finally(() => { entry.closing = undefined; });
    await entry.closing;
  };

  // A broken MCP list must not block a session; the configs carry env values, so nothing of them is logged.
  const relayMcpServers = async (): Promise<Record<string, McpServerConfig>> => {
    if (!deps.getMcpServers) return {};
    try {
      return { ...(await deps.getMcpServers()) };
    } catch {
      console.error('[relay:engine] could not read the MCP server list; starting without it');
      return {};
    }
  };

  // The renderer asking for a live writer may have lost its events (a reload); the handle answer follows the re-sent state.
  const adopt = (entry: Entry): Promise<EngineHandle> => {
    if (entry.live) entry.session.republish?.();
    return entry.ready;
  };

  const assertOpening = (reservation: Opening): void => {
    if (reservation.cancelled) throw new Error('This session was closed before it started.');
    if (shuttingDown) throw new Error('Relay Desk is shutting down.');
  };

  const initialize = async (reservation: Opening): Promise<EngineHandle> => {
    const { request, handle: { handleId } } = reservation;
    const writes = reservation.handle.sessionId;
    assertOpening(reservation);
    const profile = await deps.getProfile(request.profileId);
    assertOpening(reservation);
    const exists = await isDirectory(request.cwd);
    assertOpening(reservation);
    if (!exists) throw new Error(`Folder not found: ${request.cwd}`);
    const raced = writes ? entryForSession(writes, request.profileId) : undefined;
    if (raced) {
      if (!raced.failed) return adopt(raced);
      await closeHandle(raced.session.handle.handleId);
      assertOpening(reservation);
    }
    if (shuttingDown) throw new Error('Relay Desk is shutting down.');
    const shareContext = profile.sharedCodeContext !== false && request.skipSharedContext !== true;
    const codeContext = deps.prepareCodeContext && shareContext ? await prepareShared(deps.prepareCodeContext, profile, request.cwd) : undefined;
    assertOpening(reservation);
    const mcpServers = await relayMcpServers();
    assertOpening(reservation);

    let session: EngineSessionLike | undefined;
    const broker = new PermissionBroker(handleId, emit, {
      onPendingChange: (count) => session?.onPendingChange(count),
      onDecision: (info) => session?.onToolDecision(info),
    });
    session = createSession({
      handleId,
      request,
      profile,
      ...(codeContext?.settings !== undefined ? { codeContextSettings: codeContext.settings } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      emit: (event) => {
        if (event.type === 'startup' && event.handleId === handleId && event.requestId === request.startupRequestId) {
          if (reservation.startup.phase === 'closed' || event.revision < reservation.startup.revision ||
              (reservation.startup.phase !== 'waiting' && event.phase === 'waiting')) return;
          reservation.startup.revision = event.revision;
          reservation.startup.phase = event.phase;
        }
        emit(event);
      },
      broker,
      logDir: deps.logDir ?? join(app.getPath('userData'), 'logs'),
      onClosed: () => {
        closeStartup(handleId, reservation);
        if (entries.get(handleId)?.session === session) entries.delete(handleId);
      },
      onRateLimit: (info) => usage.onRateLimit(profile.id, info),
    });
    const ownedSession = session;
    const entry: Entry = {
      session, broker, request, live: false, failed: false, cancelled: false, startup: reservation.startup,
      ready: Promise.resolve().then(async () => {
        try {
          if (entry.cancelled || entries.get(handleId) !== entry || shuttingDown) {
            throw new Error('This session was closed before it started.');
          }
          const handle = await ownedSession.start();
          if (entry.cancelled || entries.get(handleId) !== entry || shuttingDown) {
            throw new Error('This session was closed before it started.');
          }
          entry.live = true;
          return handle;
        } catch (error) {
          entry.failed = true;
          await closeHandle(handleId);
          throw error;
        }
      }),
    };
    entries.set(handleId, entry);
    opening.delete(handleId);
    return entry.ready;
  };

  const open = async (raw: unknown): Promise<EngineHandle> => {
    const request = parseOpenRequest(raw);
    if (deps.isProfileBusy?.(request.profileId)) {
      throw new Error('This account is busy with sign-in or account changes. Wait for it to finish before opening a session.');
    }
    if (request.startupRequestId && [...entries.values(), ...opening.values()].some(
      (entry) => entry.request.startupRequestId === request.startupRequestId,
    )) throw new Error('This startup request id is already in use.');
    // R4: reserve before the first await, including profile and directory validation.
    const writes = request.resumeSessionId && !request.forkSession ? request.resumeSessionId : undefined;
    const current = writes ? entryForSession(writes, request.profileId) : undefined;
    if (current && !current.failed) return adopt(current);
    const pending = writes ? openingForSession(writes, request.profileId) : undefined;
    if (pending) return pending.ready;
    if (shuttingDown) throw new Error('Relay Desk is shutting down.');
    const handleId = deps.newHandleId?.() ?? randomUUID();
    const reservation: Opening = {
      handle: { handleId, profileId: request.profileId, cwd: request.cwd, ...(writes ? { sessionId: writes } : {}) },
      request,
      cancelled: false,
      startup: { revision: 0, phase: 'waiting' },
      ready: Promise.resolve().then(() => initialize(reservation)).catch((error: unknown) => {
        closeStartup(handleId, reservation);
        throw error;
      }).finally(() => {
        if (opening.get(handleId) === reservation) opening.delete(handleId);
      }),
    };
    opening.set(handleId, reservation);
    return reservation.ready;
  };

  registerHandlers(ipcMain, 'engine', {
    open: (req) => open(req),
    startupInput: (handleId, requestId, input) => {
      const id = startupRequestIdOf(requestId), parsed = startupInputOf(input);
      const entry = entryFor(handleId);
      if (entry.request.startupRequestId !== id || entry.live || entry.failed || entry.cancelled ||
          entry.startup.phase !== 'waiting' || entry.startup.revision !== parsed.revision || !entry.session.startupInput) {
        throw new Error('This startup prompt is no longer active.');
      }
      return entry.session.startupInput(parsed);
    },
    cancelStartup: async (requestId) => {
      const id = startupRequestIdOf(requestId);
      const reservation = [...opening.values()].find((entry) => entry.request.startupRequestId === id);
      if (reservation) return closeHandle(reservation.handle.handleId);
      const entry = [...entries.values()].find((candidate) => !candidate.live && candidate.request.startupRequestId === id);
      if (entry) await closeHandle(entry.session.handle.handleId);
    },
    send: (handleId, message, opts) => {
      const entry = entryFor(handleId);
      const attachments = parseAttachments(isRecord(opts) ? opts.attachments : undefined);
      // Files alone make a message; the text may then be empty.
      const prompt = attachments.length > 0 && typeof message === 'string' ? message : text(message, 'message');
      return entry.session.send(prompt, { queue: isRecord(opts) && opts.queue === true, ...(attachments.length > 0 ? { attachments } : {}) });
    },
    interrupt: (handleId) => entryFor(handleId).session.interrupt(),
    // The session validates the input against the panel it shows; nothing here forwards raw bytes.
    panelInput: (handleId, input) => {
      const session = entryFor(handleId).session;
      if (!session.panelInput) throw new Error('This session has no CLI panel.');
      return session.panelInput(input as NativePanelInput);
    },
    panelClose: async (handleId) => { await entryFor(handleId).session.panelClose?.(); },
    close: (handleId) => closeHandle(text(handleId, 'handle')),
    setModel: (handleId, model) => entryFor(handleId).session.setModel(modelOf(model)),
    setEffort: (handleId, effort) => entryFor(handleId).session.setEffort(effortOf(effort)),
    setUltracode: (handleId, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid ultracode setting.');
      return entryFor(handleId).session.setUltracode(enabled);
    },
    setFastMode: (handleId, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid fast mode setting.');
      return entryFor(handleId).session.setFastMode(enabled);
    },
    setWorkflows: (handleId, value) => entryFor(handleId).session.setWorkflows(value === null ? null : workflowsOf(value)),
    setAutoContinue: (handleId, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid auto-continue setting.');
      return entryFor(handleId).session.setAutoContinue(enabled);
    },
    cancelAutoContinue: (handleId) => entryFor(handleId).session.cancelAutoContinue(),
    setLiveContext: (handleId, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid context refresh setting.');
      return entryFor(handleId).session.setLiveContext(enabled);
    },
    continueAfterLimit: (handleId) => entryFor(handleId).session.continueAfterLimit(),
    stopTask: (handleId, taskId) => entryFor(handleId).session.stopTask(taskIdOf(taskId)),
    taskOutput: (handleId, taskId) => entryFor(handleId).session.taskOutput(taskIdOf(taskId)),
    setPermissionMode: (handleId, mode) => entryFor(handleId).session.setPermissionMode(modeOf(mode)),
    respondPermission: (requestId, decision) => {
      const parsed = parseDecision(decision);
      for (const entry of entries.values()) if (entry.broker.respondPermission(String(requestId), parsed)) return;
    },
    respondQuestion: (requestId, answer) => {
      const parsed = parseAnswer(answer);
      for (const entry of entries.values()) if (entry.broker.respondQuestion(String(requestId), parsed)) return;
    },
    models: (handleId) => entryFor(handleId).session.models(),
    refreshContext: (handleId) => entryFor(handleId).session.contextUsage(),
    mcpStatus: (handleId) => entryFor(handleId).session.mcpStatus(),
    mcpToggle: (handleId, name, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid MCP toggle.');
      return entryFor(handleId).session.mcpToggle(mcpNameOf(name), enabled);
    },
    mcpReconnect: (handleId, name) => entryFor(handleId).session.mcpReconnect(mcpNameOf(name)),
  });

  registerHandlers(ipcMain, 'sessions', {
    list: async (profileId) => getListing().list(await deps.getProfile(text(profileId, 'profile'))),
    history: async (profileId, sessionId, cwd, before) => {
      const folder = optionalFolderOf(cwd);
      const cursor = historyCursorOf(before);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      return getListing().history(profile, sessionIdOf(sessionId), folder, cursor);
    },
    rename: async (profileId, sessionId, title) => {
      const name = text(title, 'title').trim();
      if (name.length > MAX_TITLE_LENGTH) throw new Error(`A title needs 1 to ${MAX_TITLE_LENGTH} characters.`);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      await getListing().rename(profile, sessionIdOf(sessionId), name);
    },
    fork: async (profileId, sessionId, cwd) => {
      const folder = optionalFolderOf(cwd);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      return getListing().fork(profile, sessionIdOf(sessionId), folder);
    },
    delete: async (profileId, sessionId, cwd) => {
      const folder = optionalFolderOf(cwd);
      const id = sessionIdOf(sessionId);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      // Relay's own writer would recreate the file with its next message.
      if (entryForSession(id, profile.id) || openingForSession(id, profile.id)) throw new Error('Close this session in Relay Desk before deleting it.');
      await getListing().delete(profile, id, folder);
    },
    tasks: async (profileId, sessionId, cwd) => {
      const folder = optionalFolderOf(cwd);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      return getListing().tasks(profile, sessionIdOf(sessionId), folder);
    },
    image: (key) => (typeof key === 'string' && key.length <= 300 ? imageStore.get(key) : null),
    subagent: async (profileId, sessionId, agentId, cwd) => {
      const folder = optionalFolderOf(cwd);
      const profile = await deps.getProfile(text(profileId, 'profile'));
      const id = sessionIdOf(sessionId), agent = taskIdOf(agentId, 'agent');
      const live = entryForSession(id, profile.id);
      if (live?.live && live.session.nativeSubagent) {
        const native = await live.session.nativeSubagent(agent);
        if (native !== null) return native;
      }
      return getListing().subagent(profile, id, agent, folder);
    },
  });

  registerHandlers(ipcMain, 'usage', {
    get: (profileId, force) => usage.get(text(profileId, 'profile'), force === true),
  });

  return {
    close: closeHandle,
    findBySession: (sessionId, profileId) =>
      entryForSession(sessionId, profileId)?.session.handle ?? openingForSession(sessionId, profileId)?.handle,
    findByCwd: (cwd, profileId) => {
      const directory = normalizedCwd(cwd);
      return handles({ writersOnly: true })
        .filter((handle) => handle.profileId === profileId && normalizedCwd(handle.cwd) === directory);
    },
    findByProfile: (profileId) => handles().filter((handle) => handle.profileId === profileId),
    async invalidateProfileUsage(profileId) {
      if (handles().some((handle) => handle.profileId === profileId)) throw new Error('Close active account sessions before changing authentication.');
      await usage.invalidate?.(profileId);
    },
    async closeAll() {
      shuttingDown = true;
      const results = await Promise.allSettled([
        ...[...entries.keys(), ...opening.keys()].map((handleId) => closeHandle(handleId)),
        usage.dispose(),
      ]);
      listing?.dispose();
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        throw new AggregateError(failed.map((result) => result.reason), 'Could not close all engine sessions. Retry before quitting.');
      }
    },
  };
}
