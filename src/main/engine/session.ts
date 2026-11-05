import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID, type UUID } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  query as sdkQuery,
  type AccountInfo,
  type McpServerConfig,
  type McpServerStatus,
  type ModelInfo,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKControlGetContextUsageResponse,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKRateLimitEvent,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type Settings as SDKSettings,
  type SlashCommand,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineState } from '@shared/events';
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type ContextUsage,
  type Effort,
  type EngineHandle,
  type FastModeStatus,
  type ImageRef,
  type McpServerState,
  type ModelOption,
  type OpenSessionRequest,
  type PermissionMode,
  type Profile,
  type PromptAttachment,
  type SlashCommandInfo,
  type TranscriptItem,
  type WorkflowsSetting,
  isWorkflowsSetting,
} from '@shared/types';
import { resolveClaudeBinary } from '../system/claudeBinary';
import { buildChildEnv } from '../system/env';
import type { PermissionBroker } from './broker';
import { redactSecrets, StderrLines } from './redaction';
export { redactSecrets } from './redaction';
import {
  AUTO_CONTINUE_PROMPT,
  applyToolResult,
  asToolUse,
  assistantBlockText,
  isRecord,
  patchCounts,
  summarizeTool,
  toolItemFromUse,
  userContent,
  type ToolItem,
} from './mapTranscript';
import { AutoContinue, isUsageLimitText, systemTimers, type IntervalTimers } from './autoContinue';
import { storeImageBlocks } from './images';
import { promptContent } from './attachments';
import { BackgroundTasks, isTaskMessage } from './tasks';
import { readTaskOutput } from './taskOutput';

export const AUTH_ERROR_MESSAGE =
  'This profile is not logged in to Claude Code. Log in from the Accounts card, then send your message again.';
const AUTH_PATTERN =
  /not logged in|please run \/login|run \/login|invalid api key|authentication_failed|authentication required|oauth token (?:has )?expired|claude auth login/i;

const START_TIMEOUT_MS = 60_000;
/** The SDK ends stdin, waits ~2 s, then kills after 5 s more on Windows; stay inside the app's 10 s quit budget. */
export const CLOSE_TIMEOUT_MS = 8_000;
const KILL_WAIT_MS = 1_500;
const TOKEN_STEP = 20;
/** Fewest ms between two context reads while a turn runs (the CLI answers in milliseconds, also mid-turn). */
export const CONTEXT_REFRESH_MS = 10_000;
const STDERR_TAIL = 4_000;
const STDERR_GRACE_MS = 300;

/** True for the CLI's not-logged-in / bad-credential wording. */
export function isAuthFailure(text: string): boolean {
  return AUTH_PATTERN.test(text);
}

export function toSlashCommand(command: SlashCommand): SlashCommandInfo {
  return {
    name: command.name.replace(/^\//, ''),
    description: command.description,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
  };
}

export function toModelOption(model: ModelInfo): ModelOption {
  return {
    value: model.value,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(model.supportsEffort !== undefined ? { supportsEffort: model.supportsEffort } : {}),
    ...(model.supportedEffortLevels ? { effortLevels: [...model.supportedEffortLevels] } : {}),
    ...(model.supportsAutoMode !== undefined ? { supportsAutoMode: model.supportsAutoMode } : {}),
    ...(model.supportsFastMode !== undefined ? { supportsFastMode: model.supportsFastMode } : {}),
  };
}

/** Tokens a request sent, i.e. what the context held when its reply began (the CLI's summary reading agrees). */
export function promptTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const count = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0);
  return count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens');
}

/** Output tokens that stay in the context: thinking counts in output_tokens, but the CLI's reading leaves it out. */
export function keptOutputTokens(usage: unknown): number {
  if (!isRecord(usage) || typeof usage.output_tokens !== 'number') return 0;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return Math.max(0, usage.output_tokens - (typeof details.thinking_tokens === 'number' ? details.thinking_tokens : 0));
}

export function toContextUsage(usage: SDKControlGetContextUsageResponse): ContextUsage {
  return {
    usedTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percent: usage.percentage,
    model: usage.model,
    memoryFiles: usage.memoryFiles.map(({ path, type, tokens }) => ({ path, type, tokens })),
    categories: usage.categories.map((c) => ({
      name: c.name,
      tokens: c.tokens,
      kind: c.kind,
      ...(c.color ? { color: c.color } : {}),
    })),
  };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** initializationResult().current_permission_mode is undocumented (@internal), so it is read defensively. */
function reportedPermissionMode(init: unknown): PermissionMode | undefined {
  const value = isRecord(init) ? init.current_permission_mode : undefined;
  return isPermissionMode(value) ? value : undefined;
}

type UserItem = Extract<TranscriptItem, { kind: 'user' }>;

export type QueryFunction =(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export type CodeContextSettings = Pick<SDKSettings, 'permissions' | 'autoMemoryDirectory' | 'autoMemoryEnabled'>;

function codeContextSettings(settings: CodeContextSettings): CodeContextSettings {
  return {
    ...(settings.permissions !== undefined ? { permissions: structuredClone(settings.permissions) } : {}),
    ...(settings.autoMemoryDirectory !== undefined ? { autoMemoryDirectory: settings.autoMemoryDirectory } : {}),
    ...(settings.autoMemoryEnabled !== undefined ? { autoMemoryEnabled: settings.autoMemoryEnabled } : {}),
  };
}

/** A spawned CLI process: the SDK's SpawnedProcess plus stderr (a node ChildProcess satisfies it). */
export interface ChildLike extends SpawnedProcess {
  readonly stderr: Readable;
  readonly pid?: number | undefined;
}

export type SpawnChild = (
  command: string,
  args: string[],
  options: { cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal },
) => ChildLike;

export const spawnHidden: SpawnChild = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

export interface EngineSessionOptions {
  handleId: string;
  request: OpenSessionRequest;
  profile: Profile;
  /** Approved Code settings only, prepared without copying account or host configuration. */
  codeContextSettings?: CodeContextSettings;
  /** Enabled servers of Relay's own MCP list (env values included; never logged). */
  mcpServers?: Record<string, McpServerConfig>;
  emit(event: EngineEvent): void;
  broker: PermissionBroker;
  /** Called once after the session ended (closed, or its CLI process went away). */
  onClosed?(): void;
  /** Every rate_limit_event of the session (plan usage windows). */
  onRateLimit?(info: SDKRateLimitEvent['rate_limit_info']): void;
  /** Folder for the CLI stderr log (userData/logs); no log when absent. */
  logDir?: string;
  query?: QueryFunction;
  spawn?: SpawnChild;
  resolveBinary?(): string;
  buildEnv?(profile: Profile): NodeJS.ProcessEnv;
  /** Keeps transcript image bytes in main; default the process-wide image store. */
  storeImages?(content: unknown, keyPrefix: string): ImageRef[];
  newId?(): string;
  now?(): number;
  /** The automatic continue's check interval and jitter; default the system timers and Math.random. */
  autoContinueTimers?: IntervalTimers;
  random?(): number;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** Streaming-input prompt: messages pushed by send() reach the CLI in order. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage, undefined>) => void) | undefined;
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('This session is closed.');
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  end(): void {
    this.ended = true;
    this.items.length = 0;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Appends the CLI's stderr to userData/logs/engine-<date>.log, redacted. */
class StderrLog {
  private stream: WriteStream | undefined;
  private failed = false;
  private closed = false;
  private readonly lines = new StderrLines((line) => this.writeLine(line));

  constructor(
    private readonly dir: string,
    private readonly handleId: string,
    private readonly now: () => number,
  ) {}

  write(text: string): void {
    if (!this.closed) this.lines.write(text);
  }

  private writeLine(text: string): void {
    if (this.failed || this.closed) return;
    const stamp = new Date(this.now()).toISOString();
    if (!this.stream) {
      try {
        mkdirSync(this.dir, { recursive: true });
        this.stream = createWriteStream(join(this.dir, `engine-${stamp.slice(0, 10)}.log`), { flags: 'a' });
        this.stream.on('error', () => {
          this.failed = true;
        });
      } catch {
        this.failed = true;
        return;
      }
    }
    for (const line of redactSecrets(text).split(/\r?\n/)) {
      if (line.trim()) this.stream.write(`${stamp} [${this.handleId}] ${line}\n`);
    }
  }

  close(): Promise<void> {
    this.lines.flush();
    this.closed = true;
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.end(resolve));
  }
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Owns the spawned CLI process so close() can wait for its exit (R4). */
export class ProcessTracker {
  private child: ChildLike | undefined;
  private exited: Promise<void> = Promise.resolve();
  private stderrLines: StderrLines | undefined;
  tail = '';

  constructor(
    private readonly spawnChild: SpawnChild,
    private readonly log: StderrLog | undefined,
  ) {}

  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = this.spawnChild(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      signal: options.signal,
    });
    this.child = child;
    // Exit counts once stderr is drained too (bounded), so start-up errors see the CLI's last words.
    this.exited = new Promise<void>((resolve) => {
      let exitSeen = false;
      let stderrClosed = false;
      child.stderr.once('close', () => {
        stderrClosed = true;
        if (exitSeen) resolve();
      });
      child.once('exit', () => {
        exitSeen = true;
        if (stderrClosed) resolve();
        else setTimeout(resolve, STDERR_GRACE_MS);
      });
      child.once('error', () => {
        if (child.pid === undefined) resolve();
      });
    });
    const stderr = new StderrLines((line) => {
      this.tail = (this.tail + redactSecrets(line) + '\n').slice(-STDERR_TAIL);
    });
    this.stderrLines = stderr;
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr.write(text);
      this.log?.write(text);
    });
    child.stderr.once('end', () => stderr.flush());
    child.stderr.once('close', () => stderr.flush());
    return child;
  };

  async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (await settlesWithin(this.exited, timeoutMs)) {
      this.stderrLines?.flush();
      return;
    }
    child.kill('SIGKILL');
    if (!(await settlesWithin(this.exited, KILL_WAIT_MS))) {
      throw new Error('Claude Code did not exit. Retry closing the session before handing it off.');
    }
    this.stderrLines?.flush();
  }
}

interface StreamBlock {
  id: string;
  msgId: string;
  kind: 'assistant' | 'thinking';
  text: string;
  announced: boolean;
  final: boolean;
}

/** One SDK query() in streaming-input mode per handle. */
export class EngineSession {
  readonly options: EngineSessionOptions;
  private readonly input = new InputQueue();
  private readonly tracker: ProcessTracker;
  private readonly log: StderrLog | undefined;
  private readonly newId: () => string;
  private readonly now: () => number;
  private query: Query | undefined;
  private loop: Promise<void> | undefined;
  private loopError: unknown;
  private closePromise: Promise<void> | undefined;
  private starting = false;
  private closing = false;

  private state: EngineState = 'starting';
  private sessionId: string | undefined;
  private model: string;
  /** Undefined until requested or reported by the CLI: an unset mode follows the native settings (EC-1). */
  private permissionMode: PermissionMode | undefined;
  /** Session-scoped flag setting, remembered so an effort change keeps it on. */
  private ultracode: boolean;
  /** Fast mode as requested (flag setting fastMode) and as the CLI last reported it. */
  private fastMode: boolean;
  private fast: FastModeStatus | undefined;
  /** Dynamic workflows as chosen in Relay's settings at open; undefined leaves the CLI's plan default. */
  private readonly workflows: WorkflowsSetting | undefined;
  private cwd: string;
  private slashCommands: string[] = [];
  private tools: string[] = [];

  private turn = 0;
  private turnStartedAt: number | undefined;
  private tokensDone = 0;
  private tokensCurrent = 0;
  private streamedChars = 0;
  private thinkingEstimate = 0;
  private lastTokens = 0;
  private emittedTokens = 0;
  private authErrorTurn = -1;
  private compactItemId: string | undefined;
  private currentMsgId: string | undefined;
  private readonly streams = new Map<string, StreamBlock>();
  private readonly toolItems = new Map<string, ToolItem>();
  private readonly deniedTools = new Set<string>();
  private readonly queued = new Map<string, UserItem>();
  private readonly tasks = new BackgroundTasks();
  private readonly relayMcpNames: ReadonlySet<string>;
  private readonly mcpCollisions = new Set<string>();
  private lastMcp: string | undefined;
  private contextAskedAt = Number.NEGATIVE_INFINITY;
  /** The last full reading; each reply moves its total in between. */
  private lastContext: ContextUsage | undefined;
  private replyPromptTokens = 0;
  /** Settings → Claude Code: read the context usage during a turn too. */
  private liveContext: boolean;
  private readonly autoContinue: AutoContinue;

  constructor(options: EngineSessionOptions) {
    this.options = options;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.autoContinue = new AutoContinue({
      profileId: options.profile.id,
      // A side chat never continues on its own, as the CLI's side questions do not.
      enabled: options.request.autoContinue !== false && options.request.ephemeral !== true,
      now: this.now,
      random: options.random ?? Math.random,
      timers: options.autoContinueTimers ?? systemTimers,
      newId: this.newId,
      onState: (state) => this.emit({ type: 'autoContinue', handleId: options.handleId, state }),
      onNote: (id, text, level) => this.emitSystem(id, text, level),
      sendPrompt: (uuid) => this.sendResumePrompt(uuid),
      planUsage: () => this.planUsage(),
    });
    this.model = options.request.model || 'default';
    this.permissionMode = options.request.permissionMode;
    this.ultracode = options.request.ultracode === true;
    this.fastMode = options.request.fastMode === true;
    this.workflows = isWorkflowsSetting(options.request.workflows) ? options.request.workflows : undefined;
    this.liveContext = options.request.liveContext === true;
    this.relayMcpNames = new Set(Object.keys(options.mcpServers ?? {}));
    this.cwd = options.request.cwd;
    this.log = options.logDir ? new StderrLog(options.logDir, options.handleId, this.now) : undefined;
    this.tracker = new ProcessTracker(options.spawn ?? spawnHidden, this.log);
  }

  get handle(): EngineHandle {
    return {
      handleId: this.options.handleId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      profileId: this.options.profile.id,
      cwd: this.options.request.cwd,
    };
  }

  get currentState(): EngineState {
    return this.state;
  }

  async start(): Promise<EngineHandle> {
    if (this.query || this.closing) throw new Error('This session was already started.');
    const { request, profile, broker } = this.options;
    const resume = request.resumeSessionId;
    const fork = Boolean(resume && request.forkSession);
    if (request.ephemeral === true && !fork) throw new Error('A side chat must fork a resumed session.');
    this.sessionId =resume && !fork ? resume : this.newId();
    this.starting = true;
    this.emitState();

    try {
      const sdkOptions: Options = {
        cwd: request.cwd,
        ...(resume ? { resume } : {}),
        ...(fork ? { forkSession: true } : {}),
        // Side chat: an unsaved fork, so neither the original nor a new transcript is written.
        ...(fork && request.ephemeral === true ? { persistSession: false } : {}),
        ...(!resume || fork ? { sessionId: this.sessionId } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
        // Makes bypass selectable later from the picker; it never activates the mode by itself.
        allowDangerouslySkipPermissions: true,
        // Background tasks get their own stop buttons, so Stop ends only the turn and spares them (as in the desktop).
        perTaskStopAffordance: true,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...this.flagSettings(),
        ...(this.relayMcpNames.size > 0 ? { mcpServers: { ...this.options.mcpServers } } : {}),
        env: (this.options.buildEnv ?? buildChildEnv)(profile),
        pathToClaudeCodeExecutable: (this.options.resolveBinary ?? resolveClaudeBinary)(),
        canUseTool: broker.canUseTool,
        spawnClaudeCodeProcess: this.tracker.spawn,
      };
      const query = (this.options.query ?? sdkQuery)({ prompt: this.input, options: sdkOptions });
      this.query = query;
      const loop = this.consume(query);
      this.loop = loop;
      const ended = loop.then(() => {
        throw this.loopError ?? new Error('Claude Code exited during start-up.');
      });
      const init = await withTimeout(
        Promise.race([query.initializationResult(), ended]),
        this.options.startTimeoutMs ?? START_TIMEOUT_MS,
        'Claude Code did not start in time.',
      );
      this.slashCommands = init.commands.map((c) => c.name.replace(/^\//, ''));
      const reported = reportedPermissionMode(init);
      if (reported) this.permissionMode = reported;
      this.noteFast(init);
      this.emit({ type: 'commands', handleId: this.options.handleId, commands: init.commands.map(toSlashCommand) });
      await this.applyMcpOverrides(query);
    } catch (error) {
      this.starting = false;
      await this.close();
      throw new Error(this.describeError(error));
    }
    this.starting = false;
    this.emitInit();
    if (this.state === 'starting') this.setState('idle');
    // Known before the first turn ends, which may take long.
    void this.contextUsage('summary');
    void this.query
      .accountInfo()
      .then((info) => this.emitAccount(info))
      .catch(() => undefined);
    void this.refreshMcp().catch(() => undefined);
    return this.handle;
  }

  /** Inline SDK settings: the approved Code settings, plus the session choices requested at open. */
  private flagSettings(): { settings?: SDKSettings } {
    const shared = this.options.codeContextSettings;
    if (shared === undefined && !this.ultracode && !this.fastMode && this.workflows === undefined) return {};
    return {
      settings: {
        ...(shared !== undefined ? codeContextSettings(shared) : {}),
        ...(this.ultracode ? { ultracode: true } : {}),
        ...(this.fastMode ? { fastMode: true } : {}),
        ...(this.workflows !== undefined ? { enableWorkflows: this.workflows === 'on' } : {}),
      },
    };
  }

  /** Live MCP status (also pushed as an`mcp` event when it changed). */
  async mcpStatus(): Promise<McpServerState[]> {
    this.requireQuery();
    return this.refreshMcp();
  }

  async mcpToggle(name: string, enabled: boolean): Promise<McpServerState[]> {
    const query = await this.requireMcpServer(name);
    await this.mcpCall(() => query.toggleMcpServer(name, enabled));
    return this.refreshMcp();
  }

  async mcpReconnect(name: string): Promise<McpServerState[]> {
    const query = await this.requireMcpServer(name);
    await this.mcpCall(() => query.reconnectMcpServer(name));
    return this.refreshMcp();
  }

  /** Re-applies the MCP on/off choices remembered for this conversation (the CLI keeps a toggle only per process). */
  private async applyMcpOverrides(query: Query): Promise<void> {
    for (const [name, enabled] of Object.entries(this.options.request.mcpOverrides ?? {})) {
      try {
        await query.toggleMcpServer(name, enabled);
      } catch {
        // The CLI stores a choice for a name it does not know yet; any other refusal must not block the open.
      }
    }
  }

  private async requireMcpServer(name: string): Promise<Query> {
    const query = this.requireQuery();
    const servers = await this.refreshMcp();
    if (!servers.some((server) => server.name === name)) throw new Error(`No MCP server named "${name}" in this session.`);
    return query;
  }

  private async mcpCall(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  }

  private async refreshMcp(): Promise<McpServerState[]> {
    const query = this.query;
    if (!query || this.closing) return [];
    const servers = (await query.mcpServerStatus()).map((status) => this.toMcpState(status));
    if (this.closing) return servers;
    this.reportMcpCollisions(servers);
    const key = JSON.stringify(servers);
    if (key !== this.lastMcp) {
      this.lastMcp = key;
      this.emit({ type: 'mcp', handleId: this.options.handleId, servers });
    }
    return servers;
  }

  private toMcpState(status: McpServerStatus): McpServerState {
    return {
      name: status.name,
      status: status.status,
      toolCount: status.tools?.length ?? 0,
      ...(status.scope ? { scope: status.scope } : {}),
      ...(status.source ? { source: status.source } : {}),
      ...(status.error ? { error: redactSecrets(status.error) } : {}),
      relay: this.relayMcpNames.has(status.name),
    };
  }

  /** Relay passes its servers as dynamic ones; a configured scope on the same name means Claude Code has its own. */
  private reportMcpCollisions(servers: McpServerState[]): void {
    for (const server of servers) {
      if (!server.relay || this.mcpCollisions.has(server.name)) continue;
      const origin = [server.scope, server.source].find((value) => value !== undefined && value !== 'dynamic');
      if (!origin) continue;
      this.mcpCollisions.add(server.name);
      this.emitSystem(
        `mcp-collision:${server.name}`,
        `The MCP server "${server.name}" from Relay Desk's list has the same name as one Claude Code already configures (${origin}); only one of them runs in this session.`,
        'info',
      );
    }
  }

  /** queue: push while a turn is running (desktop Ctrl+Enter). Attachments arrive validated (attachments.ts). */
  async send(text: string, opts: { queue?: boolean; attachments?: readonly PromptAttachment[] } = {}): Promise<void> {
    if (this.closing || this.input.closed || this.state === 'closed') throw new Error('This session is closed.');
    const attachments = opts.attachments ?? [];
    if (!text.trim() && attachments.length === 0) throw new Error('Nothing to send.');
    this.autoContinue.humanMessage();
    const uuid = this.newId() as UUID;
    const busy = this.state === 'running' || this.state === 'awaiting';
    const content = promptContent(text, attachments);
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
      origin: { kind: 'human' },
      ...(busy ? { priority: opts.queue ? 'later' : 'next' } : {}),
    };
    const item: UserItem = { kind: 'user', id: uuid, text };
    const images = attachments.filter((file) => file.kind === 'image').length;
    if (images > 0) {
      // Same key as the history mapper, so the reopened session finds the same entries.
      const refs = (this.options.storeImages ?? storeImageBlocks)(content, `${this.sessionId ?? this.options.handleId}:${uuid}`);
      item.images = images;
      if (refs.length > 0) item.imageRefs = refs;
    }
    if (busy) {
      this.queued.set(uuid, item);
      this.emitItem({ ...item, queued: true });
    } else {
      this.emitItem(item);
      this.beginTurn();
    }
    this.input.push(message);
  }

  /** The automatic continue's resume prompt: hidden from the transcript, queued behind a running turn. */
  private sendResumePrompt(uuid: string): void {
    if (this.closing || this.input.closed || this.state === 'closed') return;
    const busy = this.state === 'running' || this.state === 'awaiting';
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: AUTO_CONTINUE_PROMPT },
      parent_tool_use_id: null,
      uuid: uuid as UUID,
      origin: { kind: 'auto-continuation' },
      ...(busy ? { priority: 'later' as const } : {}),
    };
    if (!busy) this.beginTurn();
    this.input.push(message);
  }

  async interrupt(): Promise<void> {
    const query = this.requireQuery();
    if (this.state !== 'running' && this.state !== 'awaiting') return;
    // Stop also ends a wait for the usage reset, as Esc does in the CLI.
    this.autoContinue.cancel();
    await query.interrupt();
  }

  async setModel(model: string): Promise<void> {
    if (!model.trim()) throw new Error('No model given.');
    await this.requireQuery().setModel(model === 'default' ? undefined : model);
    this.model = model;
    this.emitInit();
    // Another model may have another context window.
    void this.contextUsage('summary');
  }

  async setEffort(effort: Effort): Promise<void> {
    if (!EFFORT_LEVELS.includes(effort)) throw new Error(`Unknown effort level: ${String(effort)}`);
    // A level change sent without the ultracode key turns ultracode off (SDK applyFlagSettings).
    await this.requireQuery().applyFlagSettings(this.ultracode ? { effortLevel: effort, ultracode: true } : { effortLevel: effort });
  }

  async setUltracode(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid ultracode setting.');
    const query = this.requireQuery();
    const previous = this.ultracode;
    // Set first so an effort change racing this call carries the new value.
    this.ultracode = enabled;
    try {
      await query.applyFlagSettings({ ultracode: enabled });
    } catch (error) {
      if (this.ultracode === enabled) this.ultracode = previous;
      throw error;
    }
  }

  async setFastMode(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid fast mode setting.');
    const query = this.requireQuery();
    const previous = this.fastMode;
    this.fastMode = enabled;
    try {
      await query.applyFlagSettings({ fastMode: enabled });
    } catch (error) {
      if (this.fastMode === enabled) this.fastMode = previous;
      throw error;
    }
  }

  /** null clears the flag-layer key, so the plan default (or the user's own settings file) applies again. */
  async setWorkflows(value: WorkflowsSetting | null): Promise<void> {
    if (value !== null && !isWorkflowsSetting(value)) throw new Error('Invalid workflows setting.');
    await this.requireQuery().applyFlagSettings({ enableWorkflows: value === null ? null : value === 'on' });
  }

  /** Relay's own setting, so a session that is still starting takes it too; off ends a wait. */
  async setAutoContinue(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid auto-continue setting.');
    this.requireOpen();
    this.autoContinue.setEnabled(enabled && this.options.request.ephemeral !== true);
  }

  async setLiveContext(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid context refresh setting.');
    this.requireOpen();
    this.liveContext = enabled;
  }

  async cancelAutoContinue(): Promise<void> {
    this.requireOpen();
    this.autoContinue.cancel();
  }

  /** Sends the resume prompt now; rejects when nothing waits. */
  async continueAfterLimit(): Promise<void> {
    this.requireOpen();
    this.autoContinue.continueNow();
  }

  async stopTask(taskId: string): Promise<void> {
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200) throw new Error('Invalid task id.');
    await this.requireQuery().stopTask(taskId);
  }

  /** End of the output file the CLI reported for a task; null while there is none. */
  async taskOutput(taskId: string): Promise<string | null> {
    const path = typeof taskId === 'string' ? this.tasks.outputFile(taskId) : undefined;
    return path ? readTaskOutput(path) : null;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode: ${String(mode)}`);
    await this.requireQuery().setPermissionMode(mode);
    this.permissionMode = mode;
    this.emitInit();
  }

  async models(): Promise<ModelOption[]> {
    return (await this.requireQuery().supportedModels()).map(toModelOption);
  }

  /** Plan usage data (experimental SDK API) without the local transcript scan. */
  async planUsage(): Promise<SDKControlGetUsageResponse> {
    return this.requireQuery().usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  }

  /** getContextUsage(); also pushed as a `context` event. Null when the CLI cannot answer. */
  async contextUsage(detail: 'summary' | 'full' = 'full'): Promise<ContextUsage | null> {
    const query = this.query;
    if (!query || this.closing) return null;
    this.contextAskedAt = this.now();
    try {
      const usage = toContextUsage(await query.getContextUsage({ detail }));
      this.lastContext = usage;
      if (!this.closing) this.emit({ type: 'context', handleId: this.options.handleId, usage });
      return usage;
    } catch {
      return null;
    }
  }

  /** Permission broker hook: pending request count. */
  onPendingChange(count: number): void {
    if (this.closing || this.state === 'closed') return;
    if (count > 0 && this.state !== 'awaiting') {
      if (this.state !== 'running') this.beginTurn();
      this.setState('awaiting');
    } else if (count === 0 && this.state === 'awaiting') {
      this.setState('running');
    }
  }

  /** Permission broker hook: the user denied a tool call, so its error result shows as denied. */
  onToolDecision(info: { toolUseId?: string; behavior: 'allow' | 'deny' }): void {
    if (info.behavior === 'deny' && info.toolUseId) this.deniedTools.add(info.toolUseId);
  }

  /** Ends the query; resolves after the CLI process has exited (R4). */
  close(): Promise<void> {
    this.closePromise ??= this.shutdown().catch((error: unknown) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.autoContinue.dispose();
    this.options.broker.cancelAll('The session was closed.');
    this.input.end();
    try {
      this.query?.close();
    } catch {
      // already closed
    }
    await this.tracker.waitForExit(this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
    if (this.loop) await settlesWithin(this.loop, KILL_WAIT_MS);
    await this.log?.close();
    this.setState('closed');
    this.options.onClosed?.();
  }

  private requireQuery(): Query {
    if (!this.query || this.closing || this.state === 'closed') throw new Error('This session is closed.');
    return this.query;
  }

  private requireOpen(): void {
    if (this.closing || this.state === 'closed') throw new Error('This session is closed.');
  }

  private async consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.closing) break;
        this.handleMessage(message);
      }
    } catch (error) {
      this.loopError = error;
      if (!this.closing && !this.starting) this.emitError(this.describeError(error), true);
    } finally {
      if (!this.closing && !this.starting) void this.close().catch(() => undefined);
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const tail = this.tracker.tail.trim();
    if (isAuthFailure(message) || isAuthFailure(tail)) return AUTH_ERROR_MESSAGE;
    const lastLines = tail.split(/\r?\n/).slice(-3).join('\n');
    return redactSecrets(lastLines && !message.includes(lastLines) ? `${message}\n${lastLines}` : message);
  }

  private emit(event: EngineEvent): void {
    this.options.emit(event);
  }

  private emitItem(item: TranscriptItem): void {
    this.emit({ type: 'item', handleId: this.options.handleId, item });
  }

  private emitSystem(id: string, text: string, level: 'info' | 'warn' | 'error'): void {
    this.emitItem({ kind: 'system', id, text, level });
  }

  private emitError(message: string, fatal: boolean): void {
    this.emit({ type: 'error', handleId: this.options.handleId, message, fatal });
  }

  private emitAuthError(): void {
    if (this.authErrorTurn === this.turn) return;
    this.authErrorTurn = this.turn;
    this.emitError(AUTH_ERROR_MESSAGE, false);
  }

  private emitAccount(info: AccountInfo): void {
    if (this.closing) return;
    this.emit({
      type: 'account',
      handleId: this.options.handleId,
      ...(info.email ? { email: info.email } : {}),
      ...(info.subscriptionType ? { subscriptionType: info.subscriptionType } : {}),
      ...(info.organization ? { organization: info.organization } : {}),
    });
  }

  private emitInit(): void {
    if (!this.sessionId) return;
    this.emit({
      type: 'init',
      handleId: this.options.handleId,
      sessionId: this.sessionId,
      model: this.model,
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      slashCommands: [...this.slashCommands],
      tools: [...this.tools],
      cwd: this.cwd,
      ...(this.fast ? { fast: { ...this.fast } } : {}),
    });
  }

  /** Takes the fast mode state of an initialize answer, system/init or result; true when it changed. */
  private noteFast(message: { fast_mode_state?: unknown; fast_mode_disabled_reason?: unknown }): boolean {
    const state = message.fast_mode_state;
    if (state !== 'off' && state !== 'cooldown' && state !== 'on') return false;
    const reason = typeof message.fast_mode_disabled_reason === 'string' ? message.fast_mode_disabled_reason : undefined;
    if (this.fast?.state === state && this.fast.reason === reason) return false;
    this.fast = { state, ...(reason ? { reason } : {}) };
    return true;
  }

  private tokens(): number {
    return this.tokensDone + this.tokensCurrent + Math.ceil(this.streamedChars / 4) + this.thinkingEstimate;
  }

  private emitState(): void {
    const event: Extract<EngineEvent, { type: 'state' }> = {
      type: 'state',
      handleId: this.options.handleId,
      state: this.state,
    };
    if (this.state === 'running' || this.state === 'awaiting') {
      event.startedAt = this.turnStartedAt ?? this.now();
      event.tokens = this.tokens();
      this.emittedTokens = event.tokens;
    } else if (this.state === 'idle' && this.turn > 0) {
      event.tokens = this.lastTokens;
    }
    this.emit(event);
  }

  private setState(state: EngineState): void {
    if (state === this.state && state !== 'running') return;
    this.state = state;
    this.emitState();
  }

  private beginTurn(): void {
    this.turn++;
    this.autoContinue.turnStarted();
    this.turnStartedAt = this.now();
    this.tokensDone = 0;
    this.tokensCurrent = 0;
    this.streamedChars = 0;
    this.thinkingEstimate = 0;
    this.state = 'running';
    this.emitState();
  }

  private ensureRunning(): void {
    if (this.state === 'idle' || this.state === 'starting') this.beginTurn();
  }

  private updateTokens(force: boolean): void {
    if (this.state !== 'running' && this.state !== 'awaiting') return;
    const tokens = this.tokens();
    if (force ? tokens !== this.emittedTokens : tokens - this.emittedTokens >= TOKEN_STEP) this.emitState();
  }

  private markConsumed(uuids: readonly string[] | undefined): void {
    for (const uuid of uuids ?? []) {
      const item = this.queued.get(uuid);
      if (item === undefined) continue;
      this.queued.delete(uuid);
      this.emitItem(item);
    }
  }

  private consumedIds(message: { user_message_uuid?: string; user_message_uuids?: string[] }): string[] | undefined {
    return message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : undefined);
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        this.onSystem(message);
        break;
      case 'stream_event':
        this.onStream(message);
        break;
      case 'assistant':
        this.onAssistant(message);
        break;
      case 'user':
        if (!('isReplay' in message && message.isReplay)) this.onToolResults(message);
        break;
      case 'result':
        this.onResult(message);
        break;
      case 'rate_limit_event':
        this.onRateLimit(message);
        break;
      case 'auth_status':
        if (message.error) {
          if (isAuthFailure(message.error)) this.emitAuthError();
          else this.emitError(redactSecrets(message.error), false);
        }
        break;
      case 'conversation_reset':
        this.emitSystem(message.uuid, 'Conversation cleared', 'info');
        break;
      default:
        break;
    }
  }

  private onSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (isTaskMessage(message) && this.tasks.apply(message, this.now())) {
      this.emit({ type: 'tasks', handleId: this.options.handleId, tasks: this.tasks.list() });
    }
    switch (message.subtype) {
      case 'init':
        this.onInit(message);
        break;
      case 'commands_changed':
        this.slashCommands = message.commands.map((c) => c.name.replace(/^\//, ''));
        this.emit({ type: 'commands', handleId: this.options.handleId, commands: message.commands.map(toSlashCommand) });
        break;
      case 'compact_boundary': {
        const { trigger, pre_tokens: before } = message.compact_metadata;
        const text = `Conversation compacted (${trigger === 'auto' ? 'automatic' : 'manual'}, ${before.toLocaleString('en-US')} tokens before)`;
        this.emitSystem(this.compactItemId ?? message.uuid, text, 'info');
        this.compactItemId = undefined;
        void this.contextUsage('summary');
        break;
      }
      case 'status':
        if (isPermissionMode(message.permissionMode) && message.permissionMode !== this.permissionMode) {
          this.permissionMode = message.permissionMode;
          this.emitInit();
        }
        if (message.status === 'compacting') {
          this.compactItemId ??= `compact:${message.uuid}`;
          this.emitSystem(this.compactItemId, 'Compacting the conversation…', 'info');
        } else if (message.compact_result === 'failed') {
          const reason = message.compact_error ? `: ${redactSecrets(message.compact_error)}` : '';
          this.emitSystem(this.compactItemId ?? message.uuid, `Compaction failed${reason}`, 'warn');
          this.compactItemId = undefined;
        }
        break;
      case 'api_retry': {
        if (message.error === 'authentication_failed') {
          this.emitAuthError();
          break;
        }
        const status = message.error_status ? ` ${message.error_status}` : '';
        const seconds = Math.max(1, Math.round(message.retry_delay_ms / 1000));
        this.emitSystem(
          `retry:${this.turn}`,
          `API error${status} (${message.error}); retrying in ${seconds}s (attempt ${message.attempt} of ${message.max_retries})`,
          'warn',
        );
        break;
      }
      case 'informational':
        if (message.level !== 'info' && message.content.trim()) {
          this.emitSystem(message.uuid, message.content.trim(), message.level === 'warning' ? 'warn' : 'info');
        }
        break;
      case 'local_command_output':
        if (message.content.trim()) this.emitItem({ kind: 'assistant', id: message.uuid, text: message.content });
        break;
      case 'permission_denied': {
        const item = this.toolItems.get(message.tool_use_id);
        if (item) {
          this.updateTool({ ...item, status: 'denied', output: message.message });
        } else {
          this.emitSystem(message.uuid, `${message.tool_name} was not allowed: ${message.message}`, 'warn');
        }
        break;
      }
      case 'session_state_changed':
        if (message.state === 'running') this.ensureRunning();
        else if (message.state === 'requires_action') this.onPendingChange(Math.max(1, this.options.broker.pendingCount));
        else if (message.state === 'idle' && (this.state === 'running' || this.state === 'awaiting')) this.endTurn();
        break;
      case 'thinking_tokens':
        this.thinkingEstimate = message.estimated_tokens;
        this.updateTokens(false);
        break;
      case 'task_notification':
        if (!message.skip_transcript && !message.ambient && message.summary.trim()) {
          const summary = message.summary.trim().replace(/\s+/g, ' ');
          this.emitItem({
            kind: 'system',
            id: message.uuid,
            text: `Background task ${message.status}: ${summary}`,
            level: message.status === 'failed' ? 'warn' : 'info',
            tasks: [{ status: message.status, summary }],
          });
        }
        break;
      case 'model_refusal_fallback':
      case 'model_refusal_no_fallback':
        if (message.content.trim()) this.emitSystem(message.uuid, message.content.trim(), 'warn');
        break;
      case 'notification':
        if (message.priority === 'high' || message.priority === 'immediate') {
          this.emitSystem(message.uuid, message.text, 'info');
        }
        break;
      default:
        break;
    }
  }

  private onInit(message: SDKSystemMessage): void {
    this.sessionId = message.session_id;
    this.model = message.model;
    if (isPermissionMode(message.permissionMode)) this.permissionMode = message.permissionMode;
    this.slashCommands = message.slash_commands.map((c) => c.replace(/^\//, ''));
    this.tools = [...message.tools];
    this.cwd = message.cwd;
    this.noteFast(message);
    this.emitInit();
    void this.refreshMcp().catch(() => undefined);
  }

  private onStream(message: SDKPartialAssistantMessage): void {
    if (message.parent_tool_use_id) return;
    this.markConsumed(this.consumedIds(message));
    this.ensureRunning();
    const event = message.event;
    switch (event.type) {
      case 'message_start':
        this.currentMsgId = event.message.id;
        this.tokensCurrent = event.message.usage?.output_tokens ?? 0;
        this.streamedChars = 0;
        this.thinkingEstimate = 0;
        this.replyPromptTokens = promptTokens(event.message.usage);
        this.emitReplyContext(0);
        break;
      case 'content_block_start': {
        const block = assistantBlockText(event.content_block);
        if (!block || !this.currentMsgId) break;
        const id = `${this.currentMsgId}:${event.index}`;
        const stream: StreamBlock = { id, msgId: this.currentMsgId, kind: block.kind, text: '', announced: false, final: false };
        this.streams.set(id, stream);
        if (block.text) this.appendStream(stream, block.text);
        break;
      }
      case 'content_block_delta': {
        const stream = this.currentMsgId ? this.streams.get(`${this.currentMsgId}:${event.index}`) : undefined;
        if (!stream || stream.final) break;
        const delta = event.delta;
        const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : '';
        if (text) this.appendStream(stream, text);
        break;
      }
      case 'message_delta':
        this.tokensCurrent = event.usage.output_tokens;
        this.streamedChars = 0;
        this.thinkingEstimate = 0;
        this.updateTokens(true);
        this.emitReplyContext(keptOutputTokens(event.usage));
        break;
      case 'message_stop':
        this.tokensDone += this.tokensCurrent;
        this.tokensCurrent = 0;
        this.streamedChars = 0;
        break;
      default:
        break;
    }
  }

  private appendStream(stream: StreamBlock, text: string): void {
    stream.text += text;
    this.streamedChars += text.length;
    if (!stream.announced) {
      stream.announced = true;
      this.emitItem({ kind: stream.kind, id: stream.id, text: stream.text, streaming: true });
    } else {
      this.emit({ type: 'delta', handleId: this.options.handleId, itemId: stream.id, text });
    }
    this.updateTokens(false);
  }

  /** First streamed block of `kind` for `msgId` that no final assistant frame has claimed yet. */
  private claimStream(msgId: string, kind: StreamBlock['kind']): StreamBlock | undefined {
    for (const stream of this.streams.values()) {
      if (stream.msgId === msgId && stream.kind === kind && !stream.final) {
        stream.final = true;
        return stream;
      }
    }
    return undefined;
  }

  /** Streamed blocks that never got a final frame (interrupts) stop streaming with the text so far. */
  private finalizeStreams(): void {
    for (const stream of this.streams.values()) {
      if (!stream.final && stream.announced) this.emitItem({ kind: stream.kind, id: stream.id, text: stream.text });
    }
    this.streams.clear();
    this.currentMsgId = undefined;
  }

  private onAssistant(message: SDKAssistantMessage): void {
    const parent = message.parent_tool_use_id ?? undefined;
    if (!parent) {
      this.markConsumed(this.consumedIds(message));
      this.ensureRunning();
    }
    const content: unknown[] = Array.isArray(message.message.content) ? message.message.content : [];
    const synthetic = message.message.model === '<synthetic>';
    if (message.error && !parent) {
      const text = content
        .map((block) => assistantBlockText(block)?.text ?? '')
        .join('\n')
        .trim();
      if (message.error === 'rate_limit' && isUsageLimitText(text)) this.autoContinue.noteLimitStop();
      if (message.error === 'authentication_failed' || isAuthFailure(text)) {
        this.emitAuthError();
        if (synthetic) return;
      } else if (synthetic) {
        this.emitSystem(message.uuid, redactSecrets(text || `API error: ${message.error}`), 'error');
        return;
      } else {
        const note = message.error === 'max_output_tokens' ? 'The reply was cut off at the output limit.' : `API error: ${message.error}`;
        this.emitSystem(`${message.uuid}:error`, note, 'warn');
      }
    }
    content.forEach((block, index) => {
      const use = asToolUse(block);
      if (use) {
        const existing = this.toolItems.get(use.id);
        if (existing && existing.status !== 'running') return;
        this.updateTool(toolItemFromUse(use, { cwd: this.cwd, ...(parent ? { parentToolUseId: parent } : {}) }));
        return;
      }
      if (parent) return;
      const part = assistantBlockText(block);
      if (!part) return;
      const stream = this.claimStream(message.message.id, part.kind);
      const text = part.text || stream?.text || '';
      if (!text.trim()) return;
      const id = stream?.id ?? `${message.uuid}:${index}`;
      if (synthetic) this.emitSystem(id, text.trim(), isAuthFailure(text) ? 'error' : 'info');
      else this.emitItem({ kind: part.kind, id, text });
    });
    if (!parent && !synthetic) this.refreshContextSoon();
  }

  /** Each main-thread reply carries its request's token usage, so the ring follows the turn without asking the CLI. */
  private emitReplyContext(output: number): void {
    const base = this.lastContext;
    if (!base || base.maxTokens <= 0 || this.replyPromptTokens <= 0 || this.closing) return;
    const usedTokens = this.replyPromptTokens + output;
    const usage: ContextUsage = { ...base, usedTokens, percent: Math.round((usedTokens / base.maxTokens) * 100), live: true };
    this.emit({ type: 'context', handleId: this.options.handleId, usage });
  }

  /** With the setting on, the context ring follows the replies of a running turn instead of waiting for its end. */
  private refreshContextSoon(): void {
    if (!this.liveContext || this.now() - this.contextAskedAt < CONTEXT_REFRESH_MS) return;
    void this.contextUsage('summary');
  }

  private updateTool(item: ToolItem): void {
    const startedAt = this.toolItems.get(item.toolUseId)?.startedAt ?? (item.status === 'running' ? this.now() : undefined);
    const next = startedAt === undefined || item.startedAt !== undefined ? item : { ...item, startedAt };
    this.toolItems.set(next.toolUseId, next);
    this.emitItem(next);
  }

  private onToolResults(message: SDKUserMessage): void {
    const { results } = userContent(message.message.content);
    const blocks: unknown[] = Array.isArray(message.message.content) ? message.message.content : [];
    for (const result of results) {
      const item = this.toolItems.get(result.toolUseId);
      if (!item) continue;
      let next = applyToolResult(item, result, { denied: this.deniedTools.has(result.toolUseId) });
      if (result.images > 0) {
        // Same key as the history mapper, so a reopened session finds the same entries.
        const block = blocks.find((b) => isRecord(b) && b.type === 'tool_result' && b.tool_use_id === result.toolUseId);
        const refs = block ? (this.options.storeImages ?? storeImageBlocks)([block], `${this.sessionId ?? this.options.handleId}:${item.id}`) : [];
        if (refs.length > 0) next = { ...next, imageRefs: refs };
      }
      if (results.length === 1 && isRecord(message.tool_use_result)) {
        const counts = patchCounts(message.tool_use_result.structuredPatch);
        if (counts && (counts.added > 0 || counts.removed > 0)) {
          next = { ...next, summary: summarizeTool(next.name, next.input, this.cwd, counts) };
        }
      }
      this.updateTool(next);
    }
  }

  private onResult(message: SDKResultMessage): void {
    if (this.noteFast(message)) this.emitInit();
    this.markConsumed(this.consumedIds(message));
    this.finalizeStreams();
    const usage = message.usage;
    const aborted = message.terminal_reason?.startsWith('aborted') === true;
    let text: string | undefined;
    if (aborted) text = 'Interrupted';
    else if (message.subtype === 'success') text = message.is_error ? message.result : undefined;
    else text = message.errors.join('\n') || RESULT_ERRORS[message.subtype];
    const isError = !aborted && (message.is_error || message.subtype !== 'success');
    if (isError && text && isUsageLimitText(text)) this.autoContinue.noteLimitStop();
    if (isError && text && isAuthFailure(text)) {
      this.emitAuthError();
      text = AUTH_ERROR_MESSAGE;
    }
    const inputTokens =
      usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    this.emitItem({
      kind: 'result',
      id: message.uuid,
      durationMs: message.duration_ms,
      costUsd: message.total_cost_usd,
      inputTokens,
      outputTokens: usage.output_tokens,
      isError,
      ...(text ? { text: redactSecrets(text) } : {}),
    });
    this.lastTokens = usage.output_tokens;
    if ((message.queued_turn_count ?? 0) > 0) {
      this.beginTurn();
    } else {
      this.markConsumed([...this.queued.keys()]);
      this.endTurn();
      this.autoContinue.turnEnded(aborted);
    }
    void this.contextUsage('summary');
  }

  private endTurn(): void {
    this.finalizeStreams();
    this.turnStartedAt = undefined;
    this.setState('idle');
  }

  private onRateLimit(message: SDKRateLimitEvent): void {
    const info = message.rate_limit_info;
    try {
      this.options.onRateLimit?.(info);
    } catch {
      // usage bookkeeping must not break the session
    }
    this.autoContinue.onRateLimit(info);
    if (info.status === 'allowed') return;
    const window = info.rateLimitType ? RATE_LIMIT_WINDOWS[info.rateLimitType] : 'usage';
    const reset = info.resetsAt ? `; resets at ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
    const used = info.utilization !== undefined ? ` (${Math.round(info.utilization * 100)}% used)` : '';
    const id = `ratelimit:${info.rateLimitType ?? 'usage'}`;
    if (info.status === 'rejected') this.emitSystem(id, `The ${window} limit is reached${reset}.`, 'error');
    else this.emitSystem(id, `Approaching the ${window} limit${used}${reset}.`, 'warn');
  }
}

const RESULT_ERRORS: Record<string, string> = {
  error_during_execution: 'The turn stopped because of an error.',
  error_max_turns: 'The turn stopped: maximum number of turns reached.',
  error_max_budget_usd: 'The turn stopped: budget limit reached.',
  error_max_structured_output_retries: 'The turn stopped: structured output retries exhausted.',
};

const RATE_LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
};
