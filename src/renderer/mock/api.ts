// In-memory RelayApi for `npm run dev:web` and component tests. No IPC, no file system.
import type { EngineEvent, EngineState } from '@shared/events';
import type { RelayApi } from '@shared/ipc';
import { seedShortcuts, type Shortcut } from '@shared/shortcuts';
import {
  DEFAULT_PROFILE_ID,
  defaultSettings,
  type AppSettings,
  type AuthStatus,
  type AutoContinueState,
  type BackgroundAgent,
  type ContextUsage,
  type EngineHandle,
  type FastModeStatus,
  type HandoffResult,
  type HistoryPage,
  type LaunchRequest,
  type McpServerEntry,
  type McpServerState,
  type NativePanel,
  type NativePanelInput,
  type PermissionMode,
  type PlanUsage,
  type Profile,
  type SessionSummary,
  type SharedCodeContextReport,
  type TranscriptItem,
} from '@shared/types';
import { runDemoTurn, type DemoHooks } from './demo';
import { mockCodeContext } from './context';
import {
  MAIN_SESSION_ID,
  MOCK_AUTH,
  MOCK_BACKGROUND,
  MOCK_COMMANDS,
  MOCK_CONTEXT,
  MOCK_HISTORY,
  MOCK_IMAGES,
  MOCK_MCP_ENTRIES,
  MOCK_MCP_STATES,
  MOCK_MODELS,
  MOCK_OLDER_HISTORY,
  MOCK_PROFILES,
  MOCK_SESSIONS,
  MOCK_TASKS,
  MOCK_SUBAGENT_ITEMS,
  MOCK_TASK_OUTPUT,
  MOCK_USAGE,
  MOCK_WORK_SESSIONS,
  NOW,
  WORK_PROFILE_ID,
} from './fixtures';

export {
  MAIN_SESSION_ID,
  MOCK_BACKGROUND,
  MOCK_COMMANDS,
  MOCK_CONTEXT,
  MOCK_HISTORY,
  MOCK_MODELS,
  MOCK_OLDER_HISTORY,
  MOCK_PROFILES,
  MOCK_SESSIONS,
  MOCK_WORK_SESSIONS,
} from './fixtures';

export interface MockApiOptions {
  /** Sessions of the default profile. */
  sessions?: SessionSummary[];
  /** Sessions per non-default profile id. */
  profileSessions?: Record<string, SessionSummary[]>;
  /** Latest history page per session id. */
  history?: Record<string, TranscriptItem[]>;
  /** Pages before the `history` page per session id, oldest first; MOCK_OLDER_HISTORY when neither option is given. */
  olderHistory?: Record<string, TranscriptItem[][]>;
  launchRequest?: LaunchRequest | null;
  profiles?: Profile[];
  auth?: Record<string, Omit<AuthStatus, 'checkedAt'>>;
  background?: BackgroundAgent[];
  settings?: Partial<AppSettings>;
  codeContexts?: Record<string, SharedCodeContextReport>;
  contextUsage?: ContextUsage;
  /** Plan usage returned for every profile (profileId and fetchedAt are filled in). */
  usage?: Omit<PlanUsage, 'profileId' | 'fetchedAt'>;
  /** Relay's own MCP list at start (empty by default, as on a fresh install). */
  mcpEntries?: McpServerEntry[];
  /** Delay between mock engine events in ms (0 = next macrotask). */
  latencyMs?: number;
  /** dev:web: resuming the main fixture session plays a scripted turn (streaming, permission, question). */
  demo?: boolean;
  /** Requested fast mode is reported off with this reason (as extra_usage_disabled would); on otherwise. */
  fastBlockedReason?: string;
  /** sessions.subagent answers per agent id (MOCK_SUBAGENT_ITEMS otherwise). */
  subagents?: Record<string, TranscriptItem[]>;
  /** engine.taskOutput answers per task id (MOCK_TASK_OUTPUT otherwise). */
  taskOutputs?: Record<string, string | null>;
}

export type MockPanelCall =
  | { method: 'panelInput'; handleId: string; input: NativePanelInput }
  | { method: 'panelClose'; handleId: string };

/** Pushes what the main process would send; for tests and dev:web. */
export interface MockControls {
  /** A `panel` event shows or closes a handle's native panel; panelInput rejects while the handle shows none. */
  emitEngine(event: EngineEvent): void;
  pushLaunchRequest(request: LaunchRequest): void;
  pushAuthStatus(status: AuthStatus): void;
  /** engine.panelInput and engine.panelClose calls, oldest first. */
  readonly panelCalls: readonly MockPanelCall[];
}

export type MockRelayApi = RelayApi & { readonly mock: MockControls };

const clone = <T>(value: T): T => structuredClone(value);

function listeners<T>() {
  const set = new Set<(value: T) => void>();
  return {
    add(cb: (value: T) => void): () => void {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    emit(value: T): void {
      for (const cb of [...set]) cb(clone(value));
    },
  };
}

type MockHandle = EngineHandle & {
  state: EngineState;
  mode?: PermissionMode;
  model: string;
  ephemeral?: boolean;
  fastMode?: boolean;
  autoContinue: boolean;
  /** Last autoContinue phase emitted for the handle (tests and dev:web inject waits with mock.emitEngine). */
  autoPhase: AutoContinueState['phase'];
};

const sameId = (a: string | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

/** Like main's normalizedCwd: one separator style, no trailing separators, case-insensitive. */
const normalizeCwd = (cwd: string): string => cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function createMockApi(options: MockApiOptions = {}): MockRelayApi {
  const latency = options.latencyMs ?? 0;
  // Like the CLI: without the fastMode flag an SDK host is told to opt in.
  const fastStatus = (requested: boolean): FastModeStatus =>
    !requested
      ? { state: 'off', reason: 'sdk_opt_in_required' }
      : options.fastBlockedReason
        ? { state: 'off', reason: options.fastBlockedReason }
        : { state: 'on' };
  const contextUsage = clone(options.contextUsage ?? MOCK_CONTEXT);
  const engineEvents = listeners<EngineEvent>();
  const launchEvents = listeners<LaunchRequest>();
  const statusEvents = listeners<AuthStatus>();

  let settings: AppSettings = { ...defaultSettings(), ...clone(options.settings ?? {}) };
  let shortcuts: Shortcut[] = seedShortcuts();
  const sessionsByProfile: Record<string, SessionSummary[]> = {
    [DEFAULT_PROFILE_ID]: clone([...(options.sessions ?? MOCK_SESSIONS)]),
    [WORK_PROFILE_ID]: clone([...MOCK_WORK_SESSIONS]),
    ...clone(options.profileSessions ?? {}),
  };
  /** Saved history per session id in pages, oldest first; the last page is the latest. */
  const history: Record<string, TranscriptItem[][]> = {};
  for (const [sessionId, items] of Object.entries(options.history ?? MOCK_HISTORY)) history[sessionId] = [clone([...items])];
  for (const [sessionId, pages] of Object.entries(options.olderHistory ?? (options.history ? {} : MOCK_OLDER_HISTORY))) {
    history[sessionId] = [...pages.map((page) => clone([...page])), ...(history[sessionId] ?? [])];
  }
  const historyCursor = (sessionId: string, index: number): string => `mock-page:${sessionId}:${index}`;
  const historyPage = (sessionId: string, index: number): HistoryPage => ({
    items: clone(history[sessionId]?.[index] ?? []),
    ...(index > 0 ? { older: historyCursor(sessionId, index - 1) } : {}),
  });
  const profiles: Profile[] = clone([...(options.profiles ?? MOCK_PROFILES)]);
  const auth: Record<string, Omit<AuthStatus, 'checkedAt'>> = clone({ ...(options.auth ?? MOCK_AUTH) });
  const background: BackgroundAgent[] = clone([...(options.background ?? MOCK_BACKGROUND)]);
  const handles = new Map<string, MockHandle>();
  /** data: URLs of images pasted into the prompt, by image ref key. */
  const pastedImages = new Map<string, string>();
  let mcpEntries: McpServerEntry[] = clone([...(options.mcpEntries ?? [])]);
  let mcpStates: McpServerState[] = clone([...MOCK_MCP_STATES]);
  /** requestId -> handleId of permission / question requests that are still open. */
  const pending = new Map<string, { handleId: string; kind: 'permission' | 'question' }>();
  /** The native panel each handle shows (last `panel` event). */
  const panels = new Map<string, NativePanel>();
  const panelCalls: MockPanelCall[] = [];
  const demoWaiters = new Map<string, (answer: unknown) => void>();
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  const emit = (event: EngineEvent): void => {
    if (event.type === 'permission' || event.type === 'question') {
      pending.set(event.request.requestId, { handleId: event.request.handleId, kind: event.type });
    }
    if (event.type === 'requestClosed') pending.delete(event.requestId);
    if (event.type === 'state') {
      const handle = handles.get(event.handleId);
      if (handle) handle.state = event.state;
    }
    if (event.type === 'autoContinue') {
      const handle = handles.get(event.handleId);
      if (handle) handle.autoPhase = event.state.phase;
    }
    if (event.type === 'panel') {
      if (event.panel) panels.set(event.handleId, clone(event.panel));
      else panels.delete(event.handleId);
    }
    engineEvents.emit(event);
  };

  /** Emits events one latency step apart, in order. */
  const sequence = (events: EngineEvent[]): void => {
    events.forEach((event, index) => {
      setTimeout(() => emit(event), latency * (index + 1));
    });
  };

  const ok = (message: string): Promise<HandoffResult> => Promise.resolve({ ok: true, message: `mock: ${message}` });

  const authStatus = (profileId: string): AuthStatus => {
    const base = auth[profileId] ?? { profileId, loggedIn: false, authMethod: 'none' as const };
    return { ...clone(base), checkedAt: Date.now() };
  };

  const findProfile = (id: string): Profile => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Unknown profile ${id}`);
    return profile;
  };

  const requireHandle = (handleId: string): MockHandle => {
    const handle = handles.get(handleId);
    if (!handle) throw new Error(`Unknown handle ${handleId}`);
    return handle;
  };

  const closeHandle = (handleId: string | undefined): void => {
    if (!handleId || !handles.delete(handleId)) return;
    panels.delete(handleId);
    for (const [requestId, entry] of pending) {
      if (entry.handleId === handleId) sequence([{ type: 'requestClosed', handleId, requestId }]);
    }
    sequence([{ type: 'state', handleId, state: 'closed' }]);
  };

  /** Like main (handoff.ts closeWriters): the writer of a session id closes even when the caller has no handle id. */
  const closeWriter = (sessionId: string | undefined, profileId: string): void => {
    if (!sessionId) return;
    for (const handle of [...handles.values()]) {
      if (handle.profileId === profileId && sameId(handle.sessionId, sessionId)) closeHandle(handle.handleId);
    }
  };

  const settle = (requestId: string, answer: unknown): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    emit({ type: 'requestClosed', handleId: entry.handleId, requestId });
    const waiter = demoWaiters.get(requestId);
    demoWaiters.delete(requestId);
    waiter?.(answer);
  };

  const demoHooks = (handleId: string): DemoHooks => ({
    emit: (event) => emit(event.type === 'context' && contextUsage.memoryFiles !== undefined
      ? { ...event, usage: { ...event.usage, memoryFiles: clone(contextUsage.memoryFiles) } }
      : event),
    later: (ms, fn) => setTimeout(() => {
      if (handles.has(handleId)) fn();
    }, ms),
    waitFor: (requestId) => new Promise((resolve) => demoWaiters.set(requestId, resolve)),
    nextId,
  });

  const api: MockRelayApi = {
    app: {
      getLaunchRequest: async () => clone(options.launchRequest ?? null),
      onLaunchRequest: (cb) => launchEvents.add(cb),
      getSettings: async () => clone(settings),
      setSettings: async (patch) => {
        settings = { ...settings, ...clone(patch) };
        return clone(settings);
      },
      pickFolder: async () => 'D:\\demos\\demo-app',
      pickFiles: async () => ['D:\\demos\\demo-app\\README.md'],
      revealPath: async () => {},
      revealFile: async () => {},
      openExternal: async () => {},
      versions: async () => ({ app: '0.2.5', cli: '2.1.302', sdk: '0.3.302' }),
      inspectCodeContext: async (profileId, cwd) => clone(options.codeContexts?.[profileId] ?? mockCodeContext(findProfile(profileId), cwd)),
    },
    sessions: {
      list: async (profileId) => clone(sessionsByProfile[profileId] ?? []),
      // Like main: the latest page without `before`, else the page the cursor names; a cursor of another session fails.
      history: async (_profileId, sessionId, _cwd, before) => {
        const latest = Math.max((history[sessionId]?.length ?? 0) - 1, 0);
        if (before === undefined) return historyPage(sessionId, latest);
        const match = /^mock-page:(.+):(\d+)$/.exec(before);
        const index = match?.[1] === sessionId ? Number(match[2]) : -1;
        if (index < 0 || index >= latest) throw new Error('Unknown history cursor.');
        return historyPage(sessionId, index);
      },
      rename: async (profileId, sessionId, title) => {
        const session = sessionsByProfile[profileId]?.find((s) => s.sessionId === sessionId);
        if (session) session.title = title;
      },
      // Like the SDK: a fork is a saved copy under a new id titled "<title> (fork)"; a delete removes it from the list.
      fork: async (profileId, sessionId) => {
        const list = sessionsByProfile[profileId] ?? [];
        const source = list.find((s) => sameId(s.sessionId, sessionId));
        if (!source) throw new Error(`Session ${sessionId} not found`);
        const forked = crypto.randomUUID();
        list.unshift({ ...clone(source), sessionId: forked, title: `${source.title} (fork)`, lastModified: Date.now() });
        sessionsByProfile[profileId] = list;
        history[forked] = clone(history[source.sessionId] ?? []);
        return forked;
      },
      delete: async (profileId, sessionId) => {
        if ([...handles.values()].some((h) => h.profileId === profileId && sameId(h.sessionId, sessionId))) {
          throw new Error('Close this session in Relay Desk before deleting it.');
        }
        const list = sessionsByProfile[profileId] ?? [];
        if (!list.some((s) => sameId(s.sessionId, sessionId))) throw new Error(`Session ${sessionId} not found`);
        sessionsByProfile[profileId] = list.filter((s) => !sameId(s.sessionId, sessionId));
      },
      tasks: async (_profileId, sessionId) => clone(MOCK_TASKS[sessionId] ?? []),
      image: async (key) => MOCK_IMAGES[key] ?? pastedImages.get(key) ?? null,
      subagent: async (_profileId, _sessionId, agentId) => clone(options.subagents?.[agentId] ?? [...MOCK_SUBAGENT_ITEMS]),
    },
    engine: {
      startupInput: async () => { /* Synthetic startup screens are supplied by renderer tests only. */ },
      cancelStartup: async () => {},
      // Like main: input reaches only a panel the handle shows.
      panelInput: async (handleId, input) => {
        requireHandle(handleId);
        panelCalls.push({ method: 'panelInput', handleId, input: clone(input) });
        if (!panels.has(handleId)) throw new Error('No CLI panel is open.');
      },
      // Like main: the closed panel is published before the call resolves.
      panelClose: async (handleId) => {
        requireHandle(handleId);
        panelCalls.push({ method: 'panelClose', handleId });
        if (panels.has(handleId)) emit({ type: 'panel', handleId, panel: null });
      },
      open: async (req) => {
        findProfile(req.profileId);
        // R4 like main: a session that already has a writer in this account gets that writer back.
        // Like main: a side chat is an unsaved fork, never the original's writer.
        if (req.ephemeral && !(req.resumeSessionId && req.forkSession)) throw new Error('A side chat must fork a resumed session.');
        const writes = req.resumeSessionId && !req.forkSession ? req.resumeSessionId : undefined;
        const live = writes ? [...handles.values()].find((h) => h.profileId === req.profileId && sameId(h.sessionId, writes)) : undefined;
        if (live) return { handleId: live.handleId, sessionId: live.sessionId, profileId: live.profileId, cwd: live.cwd };
        const handleId = nextId('mock-handle');
        const sessionId = writes ?? crypto.randomUUID();
        // Like a new CLI process: MCP servers start from their configuration, then main re-applies the remembered choices.
        mcpStates = clone([...MOCK_MCP_STATES]).map((s) =>
          req.mcpOverrides && typeof req.mcpOverrides[s.name] === 'boolean'
            ? { ...s, status: req.mcpOverrides[s.name] ? (s.status === 'disabled' ? 'connected' : s.status) : 'disabled' }
            : s,
        );
        // Only a requested mode is reported; without one the native settings decide (EC-1).
        const mode = req.permissionMode;
        const model = req.model ?? 'opus';
        handles.set(handleId, {
          handleId,
          sessionId,
          profileId: req.profileId,
          cwd: req.cwd,
          state: 'starting',
          ...(mode ? { mode } : {}),
          model,
          ...(req.ephemeral ? { ephemeral: true } : {}),
          ...(req.fastMode ? { fastMode: true } : {}),
          autoContinue: req.autoContinue !== false,
          autoPhase: 'idle',
        });
        sequence([
          { type: 'state', handleId, state: 'starting', startedAt: Date.now() },
          {
            type: 'init',
            handleId,
            sessionId,
            model,
            ...(mode ? { permissionMode: mode } : {}),
            slashCommands: ['compact', 'context', 'goal'],
            tools: ['Bash', 'Read', 'Edit', 'Write', 'AskUserQuestion'],
            cwd: req.cwd,
            fast: fastStatus(req.fastMode === true),
          },
          { type: 'commands', handleId, commands: clone([...MOCK_COMMANDS]) },
          { type: 'state', handleId, state: 'idle' },
          { type: 'context', handleId, usage: clone(contextUsage) },
          { type: 'account', handleId, email: auth[req.profileId]?.email, subscriptionType: auth[req.profileId]?.subscriptionType },
        ]);
        if (options.demo && req.resumeSessionId === MAIN_SESSION_ID) {
          setTimeout(() => void runDemoTurn(handleId, demoHooks(handleId)), latency * 8 + 400);
        }
        return { handleId, sessionId, profileId: req.profileId, cwd: req.cwd };
      },
      send: async (handleId, text, opts) => {
        const handle = requireHandle(handleId);
        // Like main: files alone make a message; nothing at all is rejected.
        if (!text.trim() && !opts?.attachments?.length) throw new Error('Missing message.');
        const queued = Boolean(opts?.queue) && (handle.state === 'running' || handle.state === 'awaiting');
        const userId = nextId('user');
        // Like main: the echo carries the image count and refs that sessions.image() serves.
        const imageRefs = (opts?.attachments ?? [])
          .filter((a) => a.kind === 'image')
          .map((a, index) => {
            const key = `${handle.sessionId ?? handleId}:${userId}:${index}`;
            pastedImages.set(key, `data:${a.mediaType};base64,${a.data}`);
            return { key, mediaType: a.mediaType };
          });
        const images = imageRefs.length > 0 ? { images: imageRefs.length, imageRefs } : {};
        if (queued) {
          sequence([{ type: 'item', handleId, item: { kind: 'user', id: userId, text, queued: true, ...images } }]);
          return;
        }
        handle.state = 'running';
        const replyId = nextId('assistant');
        const reply = `Mock reply to: ${text}`;
        sequence([
          { type: 'item', handleId, item: { kind: 'user', id: userId, text, ...images } },
          { type: 'state', handleId, state: 'running', startedAt: Date.now(), tokens: 0 },
          { type: 'item', handleId, item: { kind: 'assistant', id: replyId, text: '', streaming: true } },
          { type: 'delta', handleId, itemId: replyId, text: reply },
          { type: 'item', handleId, item: { kind: 'assistant', id: replyId, text: reply } },
          { type: 'item', handleId, item: { kind: 'result', id: nextId('result'), durationMs: 1_200, outputTokens: 12 } },
          { type: 'state', handleId, state: 'idle', tokens: 12 },
        ]);
      },
      interrupt: async (handleId) => {
        requireHandle(handleId);
        sequence([
          { type: 'item', handleId, item: { kind: 'system', id: nextId('system'), text: 'Interrupted', level: 'info' } },
          { type: 'state', handleId, state: 'idle' },
        ]);
      },
      close: async (handleId) => {
        closeHandle(handleId);
      },
      setModel: async (handleId, model) => {
        requireHandle(handleId).model = model;
      },
      setEffort: async (handleId) => {
        requireHandle(handleId);
      },
      setUltracode: async (handleId) => {
        requireHandle(handleId);
      },
      setWorkflows: async (handleId) => {
        requireHandle(handleId);
      },
      // Like main: turning it off ends a wait; Cancel ends a wait or the missed-reset offer.
      setAutoContinue: async (handleId, enabled) => {
        const handle = requireHandle(handleId);
        handle.autoContinue = enabled;
        if (!enabled && handle.autoPhase !== 'idle') emit({ type: 'autoContinue', handleId, state: { phase: 'idle' } });
      },
      setLiveContext: async (handleId) => {
        requireHandle(handleId);
      },
      cancelAutoContinue: async (handleId) => {
        const handle = requireHandle(handleId);
        if (handle.autoPhase !== 'idle') emit({ type: 'autoContinue', handleId, state: { phase: 'idle' } });
      },
      continueAfterLimit: async (handleId) => {
        const handle = requireHandle(handleId);
        if (handle.autoPhase === 'idle') throw new Error('Nothing is waiting for the usage limit to reset.');
        emit({ type: 'autoContinue', handleId, state: { phase: 'idle' } });
      },
      setFastMode: async (handleId, enabled) => {
        const handle = requireHandle(handleId);
        handle.fastMode = enabled;
        emit({
          type: 'init',
          handleId,
          sessionId: handle.sessionId ?? '',
          model: handle.model,
          ...(handle.mode ? { permissionMode: handle.mode } : {}),
          slashCommands: ['compact', 'context', 'goal'],
          tools: ['Bash', 'Read', 'Edit', 'Write', 'AskUserQuestion'],
          cwd: handle.cwd,
          fast: fastStatus(enabled),
        });
      },
      stopTask: async (handleId) => {
        requireHandle(handleId);
      },
      taskOutput: async (handleId, taskId) => {
        requireHandle(handleId);
        const output = options.taskOutputs?.[taskId];
        return output === undefined ? MOCK_TASK_OUTPUT : output;
      },
      setPermissionMode: async (handleId, mode) => {
        requireHandle(handleId).mode = mode;
      },
      respondPermission: async (requestId, decision) => {
        settle(requestId, decision);
      },
      respondQuestion: async (requestId, answer) => {
        settle(requestId, answer);
      },
      models: async (handleId) => {
        requireHandle(handleId);
        return clone([...MOCK_MODELS]);
      },
      refreshContext: async (handleId) => {
        requireHandle(handleId);
        return clone(contextUsage);
      },
      mcpStatus: async (handleId) => {
        requireHandle(handleId);
        return clone(mcpStates);
      },
      mcpToggle: async (handleId, name, enabled) => {
        requireHandle(handleId);
        mcpStates = mcpStates.map((s) => (s.name === name ? { ...s, status: enabled ? 'connected' : 'disabled' } : s));
        emit({ type: 'mcp', handleId, servers: clone(mcpStates) });
        return clone(mcpStates);
      },
      mcpReconnect: async (handleId, name) => {
        requireHandle(handleId);
        mcpStates = mcpStates.map((s) => (s.name === name ? { ...s, status: 'connected', error: undefined } : s));
        emit({ type: 'mcp', handleId, servers: clone(mcpStates) });
        return clone(mcpStates);
      },
      onEvent: (cb) => engineEvents.add(cb),
    },
    handoff: {
      toDesktop: async (a) => {
        closeHandle(a.handleId);
        closeWriter(a.sessionId, a.profileId);
        return ok('handed back to the desktop');
      },
      openFolderInDesktop: async () => ok('opened folder in the desktop'),
      openInTerminal: async (a) => {
        if (!a.fork) {
          closeHandle(a.handleId);
          if (a.continueLatest) {
            for (const handle of [...handles.values()]) {
              if (!handle.ephemeral && handle.profileId === a.profileId && normalizeCwd(handle.cwd) === normalizeCwd(a.cwd)) closeHandle(handle.handleId);
            }
          } else closeWriter(a.sessionId, a.profileId);
        }
        return ok('opened in terminal');
      },
      toCloud: async () => ok('sent to cloud'),
      teleport: async () => ok('teleported'),
      remoteControl: async (a) => {
        closeHandle(a.handleId);
        closeWriter(a.sessionId, a.profileId);
        return ok('remote control started');
      },
      backgroundAgents: async (profileId) => (profileId === DEFAULT_PROFILE_ID ? clone(background) : []),
      attachBackground: async () => ok('attached'),
    },
    accounts: {
      list: async () => clone(profiles),
      add: async (name, configDir) => {
        const id = nextId('profile');
        const profile: Profile = {
          id,
          name,
          configDir: configDir ?? `C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\profiles\\${id}`,
          createdAt: Date.now(),
        };
        profiles.push(profile);
        return clone(profile);
      },
      rename: async (id, name) => {
        const profile = findProfile(id);
        profile.name = name;
        return clone(profile);
      },
      remove: async (id) => {
        if (id === DEFAULT_PROFILE_ID) throw new Error('The default profile cannot be removed');
        const index = profiles.findIndex((p) => p.id === id);
        if (index >= 0) profiles.splice(index, 1);
      },
      status: async (id) => {
        findProfile(id);
        return authStatus(id);
      },
      login: async (id) => {
        findProfile(id);
        if (options.demo) {
          setTimeout(() => {
            auth[id] = { profileId: id, loggedIn: true, authMethod: 'claude.ai', email: 'work@example.com', subscriptionType: 'pro' };
            statusEvents.emit(authStatus(id));
          }, 1500);
        }
        return ok('login terminal opened');
      },
      cancelLogin: async (id) => {
        findProfile(id);
        return { ok: true, noPending: true, message: 'No login is running in the preview.' };
      },
      authenticationEnvironment: async () => ({ available: false, variableNames: [] }),
      setAuthenticationSource: async (id, source) => {
        if (source !== 'cli-config' && source !== 'launch-environment') throw new Error('Invalid authentication source');
        const profile = findProfile(id);
        profile.authenticationSource = source;
        return clone(profile);
      },
      logout: async (id) => {
        findProfile(id);
        auth[id] = { profileId: id, loggedIn: false, authMethod: 'none' };
        statusEvents.emit(authStatus(id));
        return ok('logged out');
      },
      setSharedCodeContext: async (id, enabled) => {
        const profile = findProfile(id);
        profile.sharedCodeContext = enabled;
        return clone(profile);
      },
      unshareCodeContext: async (id) => {
        const profile = findProfile(id);
        profile.sharedCodeContext = false;
        return clone(options.codeContexts?.[id] ?? mockCodeContext(profile));
      },
      onStatus: (cb) => statusEvents.add(cb),
    },
    shortcuts: {
      get: async () => clone(shortcuts),
      set: async (list) => {
        shortcuts = clone(list);
        return clone(shortcuts);
      },
      reset: async () => {
        shortcuts = seedShortcuts();
        return clone(shortcuts);
      },
    },
    usage: {
      get: async (profileId) => {
        findProfile(profileId);
        const usage = { ...clone(options.usage ?? MOCK_USAGE), profileId, fetchedAt: Date.now() };
        emit({ type: 'usage', usage });
        return clone(usage);
      },
    },
    mcp: {
      list: async () => clone(mcpEntries),
      previewDesktopImport: async () => ({
        sourcePath: 'C:\Users\me\AppData\Roaming\Claude\claude_desktop_config.json',
        servers: MOCK_MCP_ENTRIES.map(({ name, transport, command, args, envKeys }) => ({
          name,
          transport,
          ...(command ? { command } : {}),
          ...(args ? { args: [...args] } : {}),
          envKeys: [...envKeys],
          exists: mcpEntries.some((e) => e.name === name),
        })),
        warnings: [],
      }),
      importFromDesktop: async (names) => {
        const now = Date.now();
        for (const entry of MOCK_MCP_ENTRIES.filter((e) => names.includes(e.name))) {
          mcpEntries = [...mcpEntries.filter((e) => e.name !== entry.name), { ...clone(entry), importedAt: now }];
        }
        return clone(mcpEntries);
      },
      setEnabled: async (name, enabled) => {
        mcpEntries = mcpEntries.map((e) => (e.name === name ? { ...e, enabled } : e));
        return clone(mcpEntries);
      },
      remove: async (name) => {
        mcpEntries = mcpEntries.filter((e) => e.name !== name);
        return clone(mcpEntries);
      },
    },
    mock: {
      emitEngine: (event) => emit(event),
      pushLaunchRequest: (request) => launchEvents.emit(request),
      pushAuthStatus: (status) => statusEvents.emit(status),
      panelCalls,
    },
  };
  return api;
}

export { NOW as MOCK_NOW };
