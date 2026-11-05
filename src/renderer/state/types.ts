import type { EngineState } from '@shared/events';
import type { Shortcut, ShortcutAction, ShortcutGroup } from '@shared/shortcuts';
import type {
  AppSettings,
  AuthStatus,
  AutoContinueState,
  BackgroundAgent,
  BackgroundTask,
  ContextUsage,
  Effort,
  FastModeStatus,
  NativeFastControl,
  McpServerState,
  ModelOption,
  NativePanel,
  PermissionMode,
  PermissionRequest,
  PlanUsage,
  Profile,
  ProfileId,
  QuestionRequest,
  SessionSummary,
  SharedCodeContextReport,
  SlashCommandInfo,
  TranscriptItem,
} from '@shared/types';
import type { AccountLabelDrift } from './accountLabel';
import type { SessionPrefs } from './sessionPrefs';
import type { SidebarMarks } from './sidebarMarks';

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

/** What the retry button of an inline error re-runs. */
export type ViewErrorRetry =
  | { kind: 'history' }
  /** skipSharedContext: open this once without the account's shared Code context (EC-2). */
  | { kind: 'open'; skipSharedContext?: boolean }
  | { kind: 'send'; text: string; queue: boolean }
  | { kind: 'action'; action: ShortcutAction }
  | { kind: 'none' };

export interface ViewError {
  id: string;
  message: string;
  fatal?: boolean;
  retry: ViewErrorRetry;
  /** Translated label of the retry button when it differs from the default for its kind. */
  retryLabel?: string;
}

/** Saved history before the oldest item a view shows ("Load earlier messages"). */
export interface OlderHistory {
  /** HistoryPage.older of the oldest page shown; sent back as `before`. */
  cursor: string;
  state: 'idle' | 'loading' | 'error';
  /** Why the last load failed; the cursor stays, so a retry asks for the same page. */
  error?: string;
}

/** Renderer-only request ownership, never persisted or used as native execution evidence. */
export interface Submission {
  id: string;
  handleId?: string;
  echoId: string;
  nativeItemId?: string;
  /** Command name used to distinguish command completion from message acceptance. */
  command?: string;
  phase: 'preparing' | 'queued' | 'sending' | 'waiting' | 'accepted' | 'ended' | 'failed' | 'unconfirmed';
  createdAt: number;
  settledAt?: number;
}

/** One session shown in the transcript area: a read-only history view, an open engine handle, or a new session. */
export interface SessionView {
  key: string;
  profileId: ProfileId;
  sessionId?: string;
  cwd: string;
  title: string;
  /** Created with "new session" in Relay (never needs a take-over confirmation). */
  isNew: boolean;
  /** The user confirmed the take-over (or the session is Relay's own). */
  confirmed: boolean;
  /** Taken over from outside Relay (desktop, terminal): show the take-over banner while the handle is open. */
  takeover: boolean;
  handleId?: string;
  /** 'none' = no engine handle (history only). */
  engineState: EngineState | 'none';
  opening: boolean;
  /** In-memory correlation only: never included in history or session preferences. */
  openingRequestId?: string;
  startup?: {
    handleId: string;
    requestId: string;
    revision: number;
    text: string;
    inputPending: boolean;
    error?: string;
  };
  startedAt?: number;
  tokens?: number;
  items: TranscriptItem[];
  /** Ids of local user echoes that the engine has not confirmed yet. */
  localEchoes: string[];
  submissions: Submission[];
  history: LoadState;
  /** Absent once the view reaches the start of the saved session. */
  olderHistory?: OlderHistory;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  slashCommands: string[];
  commands: SlashCommandInfo[];
  models: ModelOption[];
  context?: ContextUsage;
  account?: { email?: string; subscriptionType?: string; organization?: string };
  /** Background tasks of the live session (engine `tasks` events). */
  tasks?: BackgroundTask[];
  /** Live MCP status of the session (engine `mcp` events). */
  mcp?: McpServerState[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  errors: ViewError[];
  /** Created by a relaydesk:// link: the engine waits for the first send; `account` = the link switched to it (AS-2). */
  launch?: { cwd: string; account?: string };
  /** Permission mode the user chose (picker or settings default for a new session); the only mode sent on open (EC-1). */
  permissionOverride?: PermissionMode;
  /** Ultracode requested for this view (session-scoped; sent on open and through engine.setUltracode). */
  ultracode?: boolean;
  /** Fast mode requested for this view (sent on open and through engine.setFastMode; remembered per conversation). */
  fastMode?: boolean;
  /** Fast mode as the CLI last reported it (engine `init`). */
  fast?: FastModeStatus;
  nativeFast?: NativeFastControl;
  /** Choices the user made for this conversation (picker, MCP switches); stored per saved session (sessionPrefs.ts). */
  prefs?: SessionPrefs;
  /** Side chat: key of the view it was started from; the engine runs an unsaved fork (OpenSessionRequest.ephemeral). */
  sideChatOf?: string;
  /** Side chat: the session it forks. A reopen forks it again; the earlier fork was never saved. */
  sideChatSource?: string;
  /** Result of the last hand-off that closed this view's handle. */
  handedOff?: { ok: boolean; message: string; at: number };
  /** Wait for the usage reset or a missed-reset offer (engine `autoContinue`); absent = idle. */
  autoContinue?: AutoContinueState;
  /** The native CLI dialog the open handle shows (engine `panel`); absent once it closed. */
  panel?: NativePanel;
}

export interface PlanEvidence {
  /** When the stored auth status first reported its current plan; re-checks of the CLI's cached plan do not move it. */
  authSince?: number;
  /** Newest plan a live session of the account reported (engine `account` event). */
  session?: { subscriptionType: string; at: number };
}

/** The account label of the shared Claude Code settings and a detected drift of it (accountLabel.ts). */
export interface AccountLabelState {
  /** Email the shared settings show now (auth status or a live session's account info); other apps may rewrite it. */
  email?: string;
  drift?: AccountLabelDrift;
  /** The label changed and usage could not tell yet whether it is still the same account. */
  undecided?: boolean;
}

export type PanelCardId = 'environment' | 'handoff' | 'context' | 'accounts' | 'connectors' | 'outputs' | 'background';
/** 'usage' = the plan/context usage popover on the bottom-right ring (U1). */
export type FooterMenu = 'model' | 'effort' | 'permission' | 'usage' | null;

export interface Toast {
  id: string;
  kind: 'info' | 'error';
  text: string;
  retry?: () => void;
}

export interface ConfirmRequest {
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  checkboxLabel?: string;
}

export interface TextRequest {
  id: string;
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  confirmLabel: string;
  multiline?: boolean;
  /** Allow an empty answer (optional values such as a cloud session id). */
  optional?: boolean;
}

export interface TakeoverPrompt {
  key: string;
  source: 'launch' | 'send' | 'menu';
  pendingText?: string;
  pendingQueue?: boolean;
}

export interface UiState {
  sidebar: boolean;
  rightPanel: boolean;
  /** The Background tasks side pane (title bar ⋮ menu), as in the desktop. */
  tasksPane: boolean;
  /** Task whose detail the pane shows; null shows the list. */
  tasksPaneTask: string | null;
  cards: Record<PanelCardId, boolean>;
  settings: boolean;
  shortcutEditor: boolean;
  keyboardHelp: boolean;
  footerMenu: FooterMenu;
  /** The sidebar's session search should take the focus (/resume); the sidebar clears it once it has. */
  sessionSearch: boolean;
}

export interface AppState {
  ready: boolean;
  settings: AppSettings;
  versions: { app: string; cli: string; sdk: string } | null;
  profiles: Profile[];
  auth: Record<ProfileId, AuthStatus>;
  /** Plan usage per account (usage.get and `usage` engine events). */
  usage: Record<ProfileId, PlanUsage>;
  /** Evidence for the plan badge per account; merged with auth and usage by currentPlan (plan.ts). */
  plans: Record<ProfileId, PlanEvidence>;
  /** Shared-settings label per account and its drift check against the weekly usage reset (accountLabel.ts). */
  labels: Record<ProfileId, AccountLabelState>;
  /** Last model list an open session of the account reported; the model menu of a closed view uses it. */
  modelCatalog: Record<ProfileId, ModelOption[]>;
  activeProfileId: ProfileId;
  sessions: SessionSummary[];
  sessionsState: LoadState;
  sessionsError?: string;
  views: Record<string, SessionView>;
  handleToKey: Record<string, string>;
  currentKey: string | null;
  navBack: Array<string | null>;
  navForward: Array<string | null>;
  shortcuts: Shortcut[];
  shortcutGroup: ShortcutGroup;
  drafts: Record<string, string>;
  promptFocus: number;
  ui: UiState;
  takeover: TakeoverPrompt | null;
  confirm: ConfirmRequest | null;
  textRequest: TextRequest | null;
  toasts: Toast[];
  background: { list: BackgroundAgent[]; state: LoadState; error?: string };
  /** Pins, unread marks, archived sessions and own groups of the sidebar, per account (sidebarMarks.ts). */
  marks: Record<ProfileId, SidebarMarks>;
  codeContext: {
    profileId: ProfileId;
    cwd?: string;
    state: 'loading' | 'loaded' | 'error';
    report?: SharedCodeContextReport;
    error?: string;
    /** Result of "stop sharing": what Relay left in place, one line each (EC-2). */
    unshared?: { kept: string[] };
    /** Sharing switch or unshare is running. */
    busy?: boolean;
  } | null;
}
