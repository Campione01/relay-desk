// Domain types shared by main, preload and renderer. Keep this file free of Node and DOM APIs.

export type ProfileId = string;

export type AuthenticationSource = 'cli-config' | 'launch-environment';

/** Recognized launch inputs only; availability requires an auth/provider selection, not verified credentials. */
export interface AuthenticationEnvironmentMetadata {
  available: boolean;
  variableNames: string[];
}

/** The profile that uses the default config dir (~/.claude), shared with the desktop app. */
export const DEFAULT_PROFILE_ID: ProfileId = 'default';

export interface Profile {
  id: ProfileId;
  name: string;
  /** null = default (~/.claude); otherwise the CLAUDE_CONFIG_DIR used for this profile. */
  configDir: string | null;
  createdAt: number;
  /** Independent accounts only: share global instructions/rules/skills (sharedCodeContext). Absent = on. */
  sharedCodeContext?: boolean;
  /** Absent = cli-config. Launch environment explicitly shares the original process's authentication inputs. */
  authenticationSource?: AuthenticationSource;
}

export const AUTH_METHODS = ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party', 'unknown'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Plan fields of the account profile Claude Code last fetched from the server (its global config's oauthAccount). */
export interface CliProfilePlan {
  /** The profile's email, to match it with the signed-in account. */
  email: string;
  /** max, pro, team or enterprise. */
  subscriptionType: string;
  /** e.g. default_claude_max_20x. */
  rateLimitTier?: string;
}

export interface AuthStatus {
  profileId: ProfileId;
  loggedIn: boolean;
  authMethod: AuthMethod;
  configDirectory?: string;
  email?: string;
  organization?: string;
  /** The plan Claude Code recorded at sign-in; it keeps it after an upgrade until the next sign-in. */
  subscriptionType?: string;
  /** The plan of the profile Claude Code fetched later, when it belongs to the same email. */
  profilePlan?: Omit<CliProfilePlan, 'email'>;
  checkedAt: number;
  error?: string;
}

/** One page of a saved session's history (items oldest first). */
export interface HistoryPage {
  items: TranscriptItem[];
  /** Opaque cursor for the page before this one; absent once the page reaches the start of the session. */
  older?: string;
}

/** Main-chain messages per history page (user, assistant and system entries before mapping). */
export const HISTORY_PAGE_MESSAGES = 2000;
/** Longest `older` cursor main accepts back. */
export const MAX_HISTORY_CURSOR = 512;

export interface SessionSummary {
  sessionId: string;
  /** SDK customTitle, else SDK summary (auto summary or first prompt). */
  title: string;
  /** '' when the SDK does not report a cwd for the session. */
  cwd: string;
  lastModified: number;
  createdAt?: number;
  gitBranch?: string;
  firstPrompt?: string;
  fileSize?: number;
  tag?: string;
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** The "Dynamic workflows" choice (the CLI's /config row); unset follows the plan. */
export const WORKFLOWS_SETTINGS = ['on', 'off'] as const;
export type WorkflowsSetting = (typeof WORKFLOWS_SETTINGS)[number];

export function isWorkflowsSetting(value: unknown): value is WorkflowsSetting {
  return (WORKFLOWS_SETTINGS as readonly unknown[]).includes(value);
}

/** Most automatic continues in a row: a message sent by hand or a turn that ends without hitting the limit starts a new run. */
export const AUTO_CONTINUE_MAX = 3;

/** Continue automatically at usage limit (the CLI's autoContinueAtUsageLimit, which never runs for an SDK host). */
export type AutoContinueState =
  | { phase: 'idle' }
  /** Native CLI owns scheduling; its banner exposes no exact fireAt or retry count. */
  | { phase: 'native-waiting'; message: string; canContinue: boolean; schedule: 'unreported' }
  /** A usage limit stopped the turn; the resume prompt goes out at `fireAt`, shortly after `resetsAt` (both epoch ms). */
  | { phase: 'waiting'; resetsAt: number; fireAt: number; attempt: number }
  /** The computer slept through the reset, so nothing was sent; the user may continue now or dismiss. */
  | { phase: 'stale'; resetsAt: number };

export interface OpenSessionRequest {
  profileId: ProfileId;
  cwd: string;
  /** Correlates in-memory native startup interaction before open resolves. */
  startupRequestId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** One-time open without the shared code context (no settings passed, nothing written). */
  skipSharedContext?: boolean;
  /** Session-scoped dynamic-workflow orchestration (SDK settings.ultracode); never persisted by the CLI. */
  ultracode?: boolean;
  /** Fast mode for this session (SDK flag setting fastMode, the opt-in the CLI requires from an SDK host). */
  fastMode?: boolean;
  /** Dynamic workflows (SDK flag setting enableWorkflows); absent = the CLI's plan default (off on Pro). */
  workflows?: WorkflowsSetting;
  /** false = no automatic continue after a usage limit in this session; absent or true = on (the CLI default). */
  autoContinue?: boolean;
  /** true = also read the context usage during a turn, at most every 10 s; absent = at open, model change, turn end and compaction. */
  liveContext?: boolean;
  /** Side chat: with resumeSessionId + forkSession, the fork is not saved (SDK persistSession: false) and never writes the original. */
  ephemeral?: boolean;
  /** MCP on/off choices remembered for this conversation; the CLI keeps a toggle only per process, so main re-applies them at start. */
  mcpOverrides?: Record<string, boolean>;
}

export const MAX_MCP_OVERRIDES = 64;

export type NativeStartupKey = 'enter' | 'up' | 'down' | 'left' | 'right' | 'tab' | 'escape';
export interface NativeStartupInput { revision: number; key: NativeStartupKey }

/** Text attributes of a native panel run; colors are CSS hex (#rrggbb). Absent fields are the terminal defaults. */
export interface NativePanelStyle {
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
  strike?: true;
}
/** Consecutive cells of one row that share a style; `s` indexes NativePanel.styles. Wide glyphs count two columns. */
export interface NativePanelRun { text: string; s: number }
export interface NativePanelRow { runs: NativePanelRun[] }
/** A dialog the native CLI shows (a slash command's panel), mirrored so it can be read and operated in Relay. */
export interface NativePanel {
  /** Grows with every published change of this handle's panel. */
  revision: number;
  /** The slash command that opened it, without the slash, when Relay started it. */
  command?: string;
  /** Terminal width in cells; every row fits it. */
  columns: number;
  /** Rows below the panel's top border, its own footer hints included. */
  rows: NativePanelRow[];
  styles: NativePanelStyle[];
  /** The CLI reads mouse clicks and the wheel; without it only keys and text reach the panel. */
  mouse: boolean;
}
export type NativePanelKey =
  | 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'tab' | 'shift-tab'
  | 'backspace' | 'delete' | 'home' | 'end' | 'pageup' | 'pagedown' | 'space';
/** Ctrl letters the native panels use (Ctrl+A all projects, Ctrl+B branch, line editing); never C, D or Z. */
export const NATIVE_PANEL_CTRL_LETTERS = ['a', 'b', 'e', 'f', 'k', 'n', 'p', 'r', 'u', 'w', 'y'] as const;
export type NativePanelCtrlLetter = typeof NATIVE_PANEL_CTRL_LETTERS[number];
/** One input for the shown native panel. Mouse rows and columns are 0-based cells of NativePanel.rows. */
export type NativePanelInput =
  | { kind: 'key'; key: NativePanelKey }
  | { kind: 'ctrl'; letter: NativePanelCtrlLetter }
  | { kind: 'text'; text: string; paste?: boolean }
  | { kind: 'mouse'; action: 'click' | 'wheel-up' | 'wheel-down'; row: number; column: number };
/** Longest text one input may carry (a paste included). */
export const MAX_NATIVE_PANEL_TEXT = 4000;

export type FastModeState = 'off' | 'cooldown' | 'on';

/** Fast mode as the CLI reports it (initialize, system/init and result messages). */
export interface FastModeStatus {
  state: FastModeState;
  /** SDK fast_mode_disabled_reason: why fast mode cannot serve now (extra_usage_disabled, model_not_allowed, ...). */
  reason?: string;
}

/** The genuine interactive CLI's session-wide Fast control, independent of SDK model/credit metadata. */
export interface NativeFastControl {
  source: 'native-config';
  available: boolean;
  /** Native core fast row value. This is the requested preference, not proof of serving speed. */
  requested?: boolean;
  locked?: boolean;
  label?: string;
  /** Only an observed state, or off when the native requested preference is false. */
  state?: FastModeState;
}

/** One background-task notification (SDK task_notification / a saved <task-notification>). */
export interface TaskNote {
  /** completed, failed, stopped or what the CLI wrote. */
  status: string;
  summary: string;
}

/** A file attached to a prompt (pasted or dropped). The base64 bytes cross IPC once, on send. */
export interface PromptAttachment {
  kind: 'image' | 'pdf';
  /** image/png, image/jpeg, image/gif, image/webp or application/pdf. */
  mediaType: string;
  /** Base64 without a data: prefix. */
  data: string;
  name?: string;
}

export const MAX_PROMPT_ATTACHMENTS = 10;
/** Decoded size limits; main enforces them again. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** All files of one message together, decoded: base64 adds a third and the API caps a request at about 32 MB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface EngineHandle {
  handleId: string;
  sessionId?: string;
  profileId: ProfileId;
  cwd: string;
}

export type TranscriptItem =
  | {
      kind: 'user'; id: string; text: string; images?: number; imageRefs?: ImageRef[]; queued?: boolean;
      /** In-app retained intent after a queued handle closes; delivery is unknown, never automatically retried. */
      deliveryUnconfirmed?: boolean;
    }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      toolUseId: string;
      name: string;
      input: unknown;
      summary: string;
      status: 'running' | 'done' | 'error' | 'denied';
      output?: string;
      parentToolUseId?: string;
      images?: number;
      imageRefs?: ImageRef[];
      /** Live sessions: when the call started (epoch ms), for the elapsed time while it runs. */
      startedAt?: number;
    }
  | {
      kind: 'system';
      id: string;
      /** English text (copy, fallback); task rows render from `tasks` in the UI language. */
      text: string;
      level: 'info' | 'warn' | 'error';
      /** Background-task notifications: one line each in the transcript (status + the CLI's summary). */
      tasks?: TaskNote[];
      /** A slash command's result row: how long the command ran, from the transcript timestamps of its rows. */
      durationMs?: number;
    }
  | {
      kind: 'result';
      id: string;
      durationMs?: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      isError?: boolean;
      text?: string;
    };

export type TranscriptItemKind = TranscriptItem['kind'];

export interface PermissionRequest {
  requestId: string;
  handleId: string;
  toolName: string;
  input: unknown;
  /** SDK `title`: full prompt sentence; prefer it over text rebuilt from toolName + input. */
  title?: string;
  /** SDK `displayName`: short noun phrase for the action, e.g. "Read file". */
  displayName?: string;
  /** SDK `description`: human-readable subtitle. */
  description?: string;
  /** SDK `decisionReason`: why the prompt was triggered. */
  decisionReason?: string;
  /** SDK `blockedPath`: path that triggered the request, if any. */
  blockedPath?: string;
  toolUseId?: string;
  /** Sub-agent id when the request comes from a sub-agent. */
  agentId?: string;
  /** Open the prompt on its deny option; offer no one-key approve. */
  defaultToNo?: boolean;
  /** Hide the "allow for this session" option. */
  suppressAlwaysAllowRule?: boolean;
  /** SDK permission-update suggestions; kept opaque for the renderer. Empty or absent = no session-scope option. */
  suggestions?: unknown[];
}

export type PermissionDecision =
  | { behavior: 'allow'; scope: 'once' | 'session'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string };

export interface QuestionOption {
  label: string;
  description?: string;
  /** Optional preview content (markdown by default) shown when the option is focused. */
  preview?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionRequest {
  requestId: string;
  handleId: string;
  questions: Question[];
  toolUseId?: string;
}

/**
 * Question text -> answer. Single select: the chosen label. Multi select: chosen labels joined with ", ".
 * Free text ("other") replaces the label. Same shape as the SDK AskUserQuestion `answers` field.
 */
export type QuestionAnswer = Record<string, string>;

export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  /** 0-100+, as reported by the SDK (`percentage`). */
  percent: number;
  /** Classify rows on `kind`, never on the English `name`. */
  categories: Array<{ name: string; tokens: number; kind: ContextCategoryKind; color?: string }>;
  model?: string;
  /** Actual metadata returned by the native context query, not inferred from file existence. */
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
  /** usedTokens and percent follow the latest reply's token usage; the categories are from the last full reading. */
  live?: boolean;
}

/** One observed model-picker entry; `value` is always the exact value sent to its engine. */
export interface ModelOption {
  value: string;
  /** Upstream display name, or a native adapter's version-bound readable fallback. */
  label: string;
  description?: string;
  catalogSource?: 'native-config';
  /** Display/selection equivalence only; never replace `value` when dispatching a choice. */
  equivalentValues?: string[];
  supportsEffort?: boolean;
  /** SDK supportedEffortLevels. */
  effortLevels?: Effort[];
  supportsAutoMode?: boolean;
  supportsFastMode?: boolean;
  /** What the CLI's model catalog says about this model's effort levels (native engine only). */
  effortGuide?: EffortGuide;
  /** For a native alias that stands for several models: each one's notes by model id; the session's model picks one. */
  effortGuideByModel?: Record<string, EffortGuide>;
}

/**
 * The effort picker's notes for one model, from the model catalog the CLI fetches for its own surface ("cc") and keeps
 * under <config>/cache/model-catalog; the desktop's model picker shows the same catalog. Texts are the catalog's own.
 */
export interface EffortGuide {
  /** The line above the levels ("Higher effort means more thorough responses, …"). */
  description?: string;
  levels: Partial<Record<Effort, EffortLevelGuide>>;
}

export interface EffortLevelGuide {
  /** "Recommended" (neutral) or "3.5× or more usage" (warning); an unknown catalog variant counts as neutral. */
  badge?: { message: string; tone: 'neutral' | 'warning' };
  /** Hover text, for example what Max costs. */
  tooltip?: string;
}

/** One slash command with its description (from SDK supportedCommands() / commands_changed). */
export interface SlashCommandInfo {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface HandoffResult {
  ok: boolean;
  message: string;
  exitCode?: number;
}

export interface LaunchRequest {
  action: 'resume' | 'new' | 'open';
  sessionId?: string;
  cwd?: string;
  profileId?: ProfileId;
}

export interface BackgroundAgent {
  id: string;
  sessionId?: string;
  name?: string;
  cwd?: string;
  state?: string;
  status?: string;
  startedAt?: string;
}

/** Prefix of an engine.open error caused by the shared code context; the renderer then offers a one-time open without it (EC-2). */
export const SHARED_CONTEXT_ERROR_PREFIX = 'Shared code context: ';

export type SharedCodeContextEntryState = 'native' | 'ready' | 'pending' | 'missing' | 'conflict';

/** Local paths/status only; never includes file contents, settings env, or account secrets. */
export interface SharedCodeContextReport {
  profileId: ProfileId;
  mode: 'default' | 'shared';
  configDirectory: string;
  globalRoot: string;
  entries: Array<{
    kind: 'instructions' | 'rules' | 'skills';
    sourcePath: string;
    targetPath: string;
    state: SharedCodeContextEntryState;
  }>;
  memory: {
    directory?: string;
    shared: boolean;
    enabled?: boolean;
    indexExists?: boolean;
  };
  permissions?: { allow: number; deny: number; ask: number; defaultMode?: PermissionMode };
  warnings: string[];
}

/** A transcript image; the bytes stay in main until sessions.image(key) asks for them. */
export interface ImageRef {
  key: string;
  mediaType: string;
}

/** One plan rate-limit window (SDK usage_EXPERIMENTAL_... rate_limits and rate_limit_event). */
export interface PlanUsageWindow {
  /** SDK key: five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_oauth_apps, ... */
  id: string;
  /** 0-100; null when the SDK reports none. */
  percent: number | null;
  /** Epoch ms; null when not started, or when resetUnknown marks an unreported native reset. */
  resetsAt: number | null;
  /** Native reading has no reset time; do not interpret null as "Starts when a message is sent". */
  resetUnknown?: true;
  /** Latest rate_limit_event status for this window, when one arrived. */
  status?: 'allowed' | 'allowed_warning' | 'rejected';
}

export interface PlanUsage {
  profileId: ProfileId;
  /** False for API-key / third-party auth: no plan limits. */
  available: boolean;
  subscriptionType?: string;
  /** five_hour first, then seven_day, then the per-model weekly windows; windows the SDK reports as null are dropped. */
  windows: PlanUsageWindow[];
  extraUsage?: {
    enabled: boolean;
    percent: number | null;
    usedCredits: number | null;
    monthlyLimit: number | null;
    currency: string | null;
  };
  fetchedAt: number;
  error?: string;
}

export const BACKGROUND_TASK_KINDS = ['shell', 'agent', 'workflow', 'monitor', 'other'] as const;
export type BackgroundTaskKind = (typeof BACKGROUND_TASK_KINDS)[number];

/** A background task of one session (SDK task_* messages while live; derived from history otherwise). */
export interface BackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  /** SDK task_type as reported (local_bash, local_agent, local_workflow, ...). */
  taskType?: string;
  description: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';
  /** Epoch ms, when known. */
  startedAt?: number;
  endedAt?: number;
  /** SDK usage.duration_ms from task_progress / task_notification. */
  durationMs?: number;
  totalTokens?: number;
  toolUses?: number;
  lastTool?: string;
  summary?: string;
  toolUseId?: string;
  parentTaskId?: string;
  subagentType?: string;
  /** meta.name of a workflow script (task_started workflow_name). */
  workflowName?: string;
  /** Phases and agents of a running or finished workflow (the CLI's task_progress workflow_progress). */
  workflow?: WorkflowProgress;
  /** True once the CLI reported an output file for the task (engine.taskOutput can read it). */
  hasOutput?: boolean;
}

export interface WorkflowPhase {
  index: number;
  title: string;
  agents: number;
  done: number;
  failed: number;
  running: number;
}

export interface WorkflowAgent {
  index: number;
  label: string;
  phaseIndex?: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  /** Subagent id, for sessions.subagent(). */
  agentId?: string;
  tokens?: number;
  toolCalls?: number;
  lastTool?: string;
}

export interface WorkflowProgress {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
}

export type McpTransport = 'stdio' | 'sse' | 'http';

/** A server in Relay's own MCP list (userData mcp.json). Env values never leave main: names only. */
export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  enabled: boolean;
  source: 'desktop';
  importedAt: number;
}

export interface McpImportPreview {
  sourcePath: string;
  servers: Array<{
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    envKeys: string[];
    /** Already in Relay's list (a re-import replaces it). */
    exists: boolean;
  }>;
  warnings: string[];
}

/** Live status of one MCP server in an open session (SDK mcpServerStatus()). */
export interface McpServerState {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  toolCount: number;
  scope?: string;
  source?: string;
  error?: string;
  /** Passed by Relay from its own list. */
  relay: boolean;
}

export interface AppSettings {
  activeProfileId?: ProfileId;
  theme: 'system' | 'light' | 'dark';
  language: 'zh-TW' | 'en';
  fontScale: number;
  defaultModel?: string;
  defaultEffort?: Effort;
  defaultPermissionMode?: PermissionMode;
  /** Dynamic workflows for every session; unset follows each account's plan. */
  workflows?: WorkflowsSetting;
  /** Continue automatically at usage limit; unset = on. */
  autoContinue?: boolean;
  /** Refresh context usage during a turn (at most every 10 s); unset = off. */
  liveContext?: boolean;
  recentFolders: string[];
}

/** Fresh default settings object (seed for the settings store and the mock api). */
export function defaultSettings(): AppSettings {
  return { theme: 'system', language: 'en', fontScale: 1, recentFolders: [] };
}
