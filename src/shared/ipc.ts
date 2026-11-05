import { IPC, isEventMethod } from './channels';
import type { EngineEvent } from './events';
import type { Shortcut } from './shortcuts';
import type {
  AppSettings,
  AuthStatus,
  AuthenticationSource,
  AuthenticationEnvironmentMetadata,
  BackgroundAgent,
  BackgroundTask,
  ContextUsage,
  Effort,
  EngineHandle,
  HandoffResult,
  HistoryPage,
  LaunchRequest,
  McpImportPreview,
  McpServerEntry,
  McpServerState,
  ModelOption,
  NativePanelInput,
  NativeStartupInput,
  OpenSessionRequest,
  PermissionDecision,
  PermissionMode,
  PlanUsage,
  Profile,
  PromptAttachment,
  ProfileId,
  QuestionAnswer,
  SessionSummary,
  SharedCodeContextReport,
  TranscriptItem,
  WorkflowsSetting,
} from './types';

export { IPC, ALL_CHANNELS, isEventMethod } from './channels';

export interface LoginHandoffResult extends HandoffResult {
  /** The login was cancelled (or Relay Desk is shutting down) before it started: no failure to show. */
  cancelled?: boolean;
  /** Cancel is idempotent; true means there was no pending login to close. */
  noPending?: boolean;
}

/** window.relay (preload). All methods return Promises; on* return an unsubscribe fn. */
export interface RelayApi {
  app: {
    getLaunchRequest(): Promise<LaunchRequest | null>;
    onLaunchRequest(cb: (r: LaunchRequest) => void): () => void;
    getSettings(): Promise<AppSettings>;
    setSettings(p: Partial<AppSettings>): Promise<AppSettings>;
    pickFolder(): Promise<string | null>;
    pickFiles(): Promise<string[]>;
    revealPath(path: string): Promise<void>;
    /** Shows an existing local file selected in Explorer; never opens or runs it. */
    revealFile(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    versions(): Promise<{ app: string; cli: string; sdk: string }>;
    inspectCodeContext(profileId: ProfileId, cwd?: string): Promise<SharedCodeContextReport>;
  };
  sessions: {
    list(profileId: ProfileId): Promise<SessionSummary[]>;
    /**
     * One page of a saved session's history across compactions, newest page first: without `before` the latest page,
     * with a page's `older` cursor the page before it.
     */
    history(profileId: ProfileId, sessionId: string, cwd?: string, before?: string): Promise<HistoryPage>;
    rename(profileId: ProfileId, sessionId: string, title: string): Promise<void>;
    /** Copies a saved session into a new one (SDK forkSession); answers the new session id. */
    fork(profileId: ProfileId, sessionId: string, cwd?: string): Promise<string>;
    /** Removes a saved session and its subagent transcripts (SDK deleteSession); refused while Relay has it open. */
    delete(profileId: ProfileId, sessionId: string, cwd?: string): Promise<void>;
    /** Background tasks derived from the saved history (read-only views). */
    tasks(profileId: ProfileId, sessionId: string, cwd?: string): Promise<BackgroundTask[]>;
    /** data: URL of a transcript image, or null when main no longer holds it. */
    image(key: string): Promise<string | null>;
    /** Transcript of one subagent of a saved or live session (SDK getSubagentMessages), mapped like history. */
    subagent(profileId: ProfileId, sessionId: string, agentId: string, cwd?: string): Promise<TranscriptItem[]>;
  };
  engine: {
    open(req: OpenSessionRequest): Promise<EngineHandle>;
    /** Explicit menu keys for this pending native startup only; never a model prompt. */
    startupInput(handleId: string, requestId: string, input: NativeStartupInput): Promise<void>;
    /** Cancels an opening attempt even before a native handle has been returned. */
    cancelStartup(requestId: string): Promise<void>;
    /** One key, text or click for the native panel this handle shows; rejects when it shows none. */
    panelInput(handleId: string, input: NativePanelInput): Promise<void>;
    /** Closes the native panel this handle shows the way Esc does, as often as it takes; resolves once it is gone. */
    panelClose(handleId: string): Promise<void>;
    /** text may be empty when attachments are given. */
    send(handleId: string, text: string, opts?: { queue?: boolean; attachments?: PromptAttachment[] }): Promise<void>;
    interrupt(handleId: string): Promise<void>;
    close(handleId: string): Promise<void>;
    setModel(handleId: string, model: string): Promise<void>;
    setEffort(handleId: string, effort: Effort): Promise<void>;
    /** Turns ultracode on or off for the session (SDK applyFlagSettings({ ultracode })); the effort level stays. */
    setUltracode(handleId: string, enabled: boolean): Promise<void>;
    /** Turns fast mode on or off for the session (SDK applyFlagSettings({ fastMode })); the CLI reports the result in `init`. */
    setFastMode(handleId: string, enabled: boolean): Promise<void>;
    /** Dynamic workflows for the session (SDK applyFlagSettings({ enableWorkflows })); null = back to the plan default. */
    setWorkflows(handleId: string, value: WorkflowsSetting | null): Promise<void>;
    /** Continue automatically at usage limit for the session; turning it off ends a wait. */
    setAutoContinue(handleId: string, enabled: boolean): Promise<void>;
    /** Reads the context usage during a turn too (at most every 10 s), or only at open, model change, turn end and compaction. */
    setLiveContext(handleId: string, enabled: boolean): Promise<void>;
    /** Ends a wait for the usage reset or a missed-reset offer; the next limit starts a new run of automatic continues. */
    cancelAutoContinue(handleId: string): Promise<void>;
    /** Sends the resume prompt now (the missed-reset offer's Continue); rejects when nothing waits. */
    continueAfterLimit(handleId: string): Promise<void>;
    /** Stops one background task (SDK stopTask); a task_notification with status stopped follows. */
    stopTask(handleId: string, taskId: string): Promise<void>;
    /** End of the output file the CLI reported for a task (redacted, ANSI stripped); null while it has none. */
    taskOutput(handleId: string, taskId: string): Promise<string | null>;
    setPermissionMode(handleId: string, mode: PermissionMode): Promise<void>;
    respondPermission(requestId: string, d: PermissionDecision): Promise<void>;
    respondQuestion(requestId: string, a: QuestionAnswer | null): Promise<void>;
    models(handleId: string): Promise<ModelOption[]>;
    refreshContext(handleId: string): Promise<ContextUsage | null>;
    mcpStatus(handleId: string): Promise<McpServerState[]>;
    mcpToggle(handleId: string, name: string, enabled: boolean): Promise<McpServerState[]>;
    mcpReconnect(handleId: string, name: string): Promise<McpServerState[]>;
    onEvent(cb: (e: EngineEvent) => void): () => void;
  };
  handoff: {
    toDesktop(a: { profileId: ProfileId; sessionId: string; cwd: string; handleId?: string }): Promise<HandoffResult>;
    openFolderInDesktop(a: { profileId: ProfileId; cwd: string }): Promise<HandoffResult>;
    openInTerminal(a: {
      profileId: ProfileId;
      cwd: string;
      sessionId?: string;
      fork?: boolean;
      continueLatest?: boolean;
      handleId?: string;
    }): Promise<HandoffResult>;
    toCloud(a: { profileId: ProfileId; cwd: string; task: string }): Promise<HandoffResult>;
    teleport(a: { profileId: ProfileId; cwd: string; cloudSessionId?: string }): Promise<HandoffResult>;
    remoteControl(a: { profileId: ProfileId; cwd: string; sessionId?: string; handleId?: string }): Promise<HandoffResult>;
    backgroundAgents(profileId: ProfileId): Promise<BackgroundAgent[]>;
    attachBackground(a: { profileId: ProfileId; id: string }): Promise<HandoffResult>;
  };
  accounts: {
    list(): Promise<Profile[]>;
    add(name: string, configDir?: string): Promise<Profile>;
    rename(id: ProfileId, name: string): Promise<Profile>;
    remove(id: ProfileId, options?: { deleteDirectory?: boolean }): Promise<void>;
    status(id: ProfileId, force?: boolean): Promise<AuthStatus>;
    login(id: ProfileId, method?: 'claudeai' | 'sso' | 'console', email?: string): Promise<LoginHandoffResult>;
    cancelLogin(id: ProfileId): Promise<LoginHandoffResult>;
    authenticationEnvironment(): Promise<AuthenticationEnvironmentMetadata>;
    setAuthenticationSource(id: ProfileId, source: AuthenticationSource): Promise<Profile>;
    logout(id: ProfileId): Promise<HandoffResult>;
    /** Independent accounts: turn the shared code context on or off for later sessions. */
    setSharedCodeContext(id: ProfileId, enabled: boolean): Promise<Profile>;
    /** Removes only what Relay created (marker, unchanged bridge, its own junctions); reports what was kept. */
    unshareCodeContext(id: ProfileId): Promise<SharedCodeContextReport>;
    onStatus(cb: (s: AuthStatus) => void): () => void;
  };
  shortcuts: {
    get(): Promise<Shortcut[]>;
    set(list: Shortcut[]): Promise<Shortcut[]>;
    reset(): Promise<Shortcut[]>;
  };
  usage: {
    /** Plan usage of an account: the live session's query when one is open, else a short non-persisted probe. Cached 60 s unless force. Updates also arrive as `usage` engine events. */
    get(profileId: ProfileId, force?: boolean): Promise<PlanUsage>;
  };
  mcp: {
    /** Relay's own MCP list, shared by all accounts. */
    list(): Promise<McpServerEntry[]>;
    /** Reads only the mcpServers object of the desktop's claude_desktop_config.json, on this call (the R1 exception in docs/ARCHITECTURE.md). */
    previewDesktopImport(): Promise<McpImportPreview>;
    importFromDesktop(names: string[]): Promise<McpServerEntry[]>;
    setEnabled(name: string, enabled: boolean): Promise<McpServerEntry[]>;
    remove(name: string): Promise<McpServerEntry[]>;
  };
}

export type RelayNamespace = keyof RelayApi;
export type RelayMethod<N extends RelayNamespace> = keyof RelayApi[N] & string;
/** Subscription methods (`on*`): main pushes on their channel with webContents.send. */
export type EventMethod<N extends RelayNamespace> = Extract<RelayMethod<N>, `on${string}`>;
/** Request/response methods: main answers on their channel with ipcMain.handle. */
export type InvokeMethod<N extends RelayNamespace> = Exclude<RelayMethod<N>, `on${string}`>;

export type InvokeArgs<N extends RelayNamespace, M extends InvokeMethod<N>> = RelayApi[N][M] extends (
  ...args: infer A
) => unknown
  ? A
  : never;
export type InvokeResult<N extends RelayNamespace, M extends InvokeMethod<N>> = RelayApi[N][M] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never;
export type EventPayload<N extends RelayNamespace, M extends EventMethod<N>> = RelayApi[N][M] extends (
  cb: (payload: infer P) => void,
) => () => void
  ? P
  : never;

export type InvokeHandler<N extends RelayNamespace, M extends InvokeMethod<N>> = (
  ...args: InvokeArgs<N, M>
) => InvokeResult<N, M> | Promise<InvokeResult<N, M>>;

/** Every request/response method of one namespace, as main-process handlers. */
export type NamespaceHandlers<N extends RelayNamespace> = { [M in InvokeMethod<N>]: InvokeHandler<N, M> };

/** Structural subset of Electron's ipcMain used by registerHandlers. */
export interface HandleTarget {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** Registers one ipcMain.handle per method of `ns`; the handlers receive the renderer arguments only. */
export function registerHandlers<N extends RelayNamespace>(
  target: HandleTarget,
  ns: N,
  handlers: NamespaceHandlers<N>,
): void {
  const channels = IPC[ns] as Readonly<Record<string, string>>;
  for (const [method, handler] of Object.entries(handlers) as Array<[string, (...args: unknown[]) => unknown]>) {
    const channel = channels[method];
    if (!channel || isEventMethod(method)) throw new Error(`No invoke channel for ${ns}.${method}`);
    target.handle(channel, (_event, ...args) => handler(...args));
  }
}

/** Structural subset of Electron's WebContents used by sendEvent. */
export interface SendTarget {
  send(channel: string, ...args: unknown[]): void;
}

/** Pushes one event to a renderer on the channel of the matching on* method. */
export function sendEvent<N extends RelayNamespace, M extends EventMethod<N>>(
  target: SendTarget,
  ns: N,
  method: M,
  payload: EventPayload<N, M>,
): void {
  const channel = (IPC[ns] as Readonly<Record<string, string>>)[method];
  if (!channel) throw new Error(`No event channel for ${ns}.${method}`);
  target.send(channel, payload);
}

/** What the preload needs from ipcRenderer to build the api. */
export interface RendererTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribes to pushes on `channel`; the listener gets the payload only. Returns an unsubscribe fn. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** Builds window.relay from the channel table: on* methods subscribe, all others invoke. */
export function createRelayApi(transport: RendererTransport): RelayApi {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [ns, methods] of Object.entries(IPC)) {
    const target: Record<string, unknown> = {};
    for (const [method, channel] of Object.entries(methods)) {
      target[method] = isEventMethod(method)
        ? (cb: (payload: unknown) => void) => transport.on(channel, (payload) => cb(payload))
        : (...args: unknown[]) => transport.invoke(channel, ...args);
    }
    api[ns] = target;
  }
  return api as unknown as RelayApi;
}
