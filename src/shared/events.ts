import type {
  AutoContinueState,
  BackgroundTask,
  ContextUsage,
  Effort,
  FastModeStatus,
  NativeFastControl,
  McpServerState,
  NativePanel,
  PermissionMode,
  PermissionRequest,
  PlanUsage,
  QuestionRequest,
  SlashCommandInfo,
  TranscriptItem,
} from './types';

export type EngineState = 'starting' | 'idle' | 'running' | 'awaiting' | 'closed';

/** main -> renderer, per handle. */
export type EngineEvent =
  | { type: 'startup'; handleId: string; requestId: string; revision: number; text: string; phase: 'waiting' | 'ready' | 'closed' }
  | {
      type: 'init';
      handleId: string;
      sessionId: string;
      model: string;
      /** Absent until the CLI reports it (an unset mode follows the native settings; EC-1). */
      permissionMode?: PermissionMode;
      /** Names only (SDK system/init `slash_commands`); descriptions arrive in `commands`. */
      slashCommands: string[];
      tools: string[];
      cwd: string;
      /** Fast mode as last reported by the CLI; absent until it reports. */
      fast?: FastModeStatus;
      /** Genuine interactive native Fast row; never inferred from SDK model metadata. */
      nativeFast?: NativeFastControl;
      /** Effort the native CLI shows after a native panel changed it; absent = unchanged. */
      effort?: Effort;
    }
  /**
   * New or replaced item (same id = replace). A new item goes right after `afterId` while that item is shown, else right
   * after `anchorId` (a command's transcript row) while that one is shown, else at the end.
   */
  | { type: 'item'; handleId: string; item: TranscriptItem; afterId?: string; anchorId?: string }
  /** Streaming append to an assistant or thinking item. */
  | { type: 'delta'; handleId: string; itemId: string; text: string }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'question'; request: QuestionRequest }
  /** A pending permission or question request was settled or cancelled (answered, aborted, handle closed). */
  | { type: 'requestClosed'; handleId: string; requestId: string }
  | { type: 'state'; handleId: string; state: EngineState; startedAt?: number; tokens?: number }
  | { type: 'context'; handleId: string; usage: ContextUsage }
  /** Full slash-command list; replaces the previous one (SDK supportedCommands() and commands_changed). */
  | { type: 'commands'; handleId: string; commands: SlashCommandInfo[] }
  | { type: 'account'; handleId: string; email?: string; subscriptionType?: string; organization?: string }
  /** Full background-task list of the session; replaces the previous one. */
  | { type: 'tasks'; handleId: string; tasks: BackgroundTask[] }
  /** Live MCP status of the session; replaces the previous one. */
  | { type: 'mcp'; handleId: string; servers: McpServerState[] }
  /** Automatic continue after a usage limit: waiting for the reset, a missed reset, or nothing (idle). */
  | { type: 'autoContinue'; handleId: string; state: AutoContinueState }
  /** The native panel shown for this handle, replaced on every change; null once it closed. */
  | { type: 'panel'; handleId: string; panel: NativePanel | null }
  /** Plan usage of an account changed (fetch or rate_limit_event); not tied to one handle. */
  | { type: 'usage'; usage: PlanUsage }
  | { type: 'error'; handleId: string; message: string; fatal: boolean };

export type EngineEventType = EngineEvent['type'];
