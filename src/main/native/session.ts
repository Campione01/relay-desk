import { randomUUID } from 'node:crypto';
import type { SDKControlGetUsageResponse, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineState } from '@shared/events';
import {
  EFFORT_LEVELS, PERMISSION_MODES, type ContextUsage, type Effort, type EffortGuide, type EngineHandle,
  type BackgroundTask, type McpServerState, type ModelOption, type NativeFastControl, type PermissionMode, type PromptAttachment, type PlanUsage,
  type SlashCommandInfo, type WorkflowsSetting, type TranscriptItem, type NativeStartupInput, type NativeStartupKey, type NativePanelInput,
} from '@shared/types';
import { isSignInScreen, SIGN_IN_COMMANDS, SIGN_IN_REQUIRED, signInCommandRefusal } from '@shared/signIn';
import type { EngineSessionOptions } from '../engine/session';
import { redactSecrets } from '../engine/redaction';
import { readTaskOutput } from '../engine/taskOutput';
import { promptContent } from '../engine/attachments';
import { storeImageBlocks } from '../engine/images';
import type { NativeEvent, NativeExitCause, NativeLaunch, NativeReady, NativeRequestOptions, NativeRuntime } from './contract';
import type { NativeCliBuild } from './cliBuilds';
import { isRecord, nativeAgents, nativeCommandOutput, nativeContext, nativePlanUsage, nativeText, NativeTranscriptMapper } from './mapping';
import { cliCommandName, COMMAND_ANCHOR_SLACK_MS, readCommandResults } from './commandResults';
import { NativeControlGate, NativeMcpDialogControls, NativeSendQueue, NativeTerminalScreen, NativeUiController, nativeComposerIdle } from './controls';
import { detectNativePanel } from './panel';
import { NativePanelHost } from './panelHost';
import { nativeEffortChip, NativeSessionSettings } from './sessionSettings';
import { nativeModelCatalog } from './modelCatalog';
import { EFFORT_GUIDE_TIMEOUT_MS, withEffortGuides } from './effortGuide';
import { NativeSettings, nativePermissionMode } from './nativeSettings';
import { nativeFastControl } from './fastMode';
import { NativeQuotaControls } from './nativeQuotaControls';
import { createNativePersistentMcpControls } from './persistentMcp';
import { NativeWorkflowState } from './workflowParity';
import type { createNativeWorkflowFiles } from './workflowFiles';
import { createNativeAttachmentAdapter, validateNativeAttachmentSubmission,
  type NativeAttachmentOptions, type NativeAttachmentStorage, type NativePdfTools,
  type NativeAttachmentComposer } from './attachments';

export interface NativeSessionAttachmentResources {
  storage: NativeAttachmentStorage;
  pdfTools?: NativePdfTools;
  onAccepted?: NativeAttachmentOptions['onAccepted'];
  verifyRead?(path: string): void;
  close?(): void | Promise<void>;
}

export interface NativeMcpControls {
  status(): Promise<McpServerState[]>;
  setEnabled(name: string, enabled: boolean): Promise<McpServerState[]>;
  reconnect(name: string): Promise<McpServerState[]>;
}

export interface NativeInteractiveSessionOptions extends Omit<EngineSessionOptions, 'query' | 'spawn'> {
  runtime: NativeRuntime;
  launch: NativeLaunch;
  readTaskOutput?(path: string): Promise<string | null>;
  controls?: { cliSha256: string; admittedBuilds?: readonly NativeCliBuild[]; preferenceFingerprint(): Promise<string>; assertPreferenceScope?(): void; assertCycleBinding?(): void };
  attachments?(sessionId: string): NativeSessionAttachmentResources | Promise<NativeSessionAttachmentResources>;
  mcpControls?: NativeMcpControls;
  workflowFiles?: ReturnType<typeof createNativeWorkflowFiles>;
  /** The session's transcript file as the history reader finds it; a user command's printed rows are read back from it. */
  commandTranscript?(sessionId: string, cwd: string): Promise<string | undefined>;
  /** The CLI catalog's effort notes by model id, read each time the model list is. */
  effortGuides?(): Promise<Record<string, EffortGuide>>;
}

export class NativeCapabilityError extends Error {
  constructor(readonly capability: string, detail?: string) {
    super(`Native interactive feature gate [${capability}]: ${detail ?? 'the native bridge has not verified this operation.'}`);
    this.name = 'NativeCapabilityError';
  }
}

const STARTUP_KEYS: Record<NativeStartupKey, string> = {
  enter: '\r', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', escape: '\x1b',
};
const SLASH_COMMAND = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/;
// A second Esc in quick succession opens the CLI's message rewind, so Stop sends at most one per window.
const COMMAND_ESCAPE_WINDOW_MS = 2_000;
const COMPOSER_WAIT_MS = 1_500;
// A startup key is answered by a screen that differs from the one shown when its write was confirmed and then gets no
// terminal data for STARTUP_KEY_SETTLE_MS, so a screen that arrives in pieces is checked whole before input re-arms.
// The CLI paces its frames 4 to 16 ms apart and steps its spinners every 128 ms; both fit within that period. While its
// optional stdout queue (CLAUDE_CODE_NONBLOCKING_STDOUT, a write hook or a server flag) holds more than 16 KiB it holds a
// frame in 250 ms steps, which can outlast that period; the cap below then decides. A key
// that changes nothing is answered after STARTUP_KEY_QUIET_MS, one whose screen never goes quiet after
// STARTUP_KEY_CAP_MS. Until then no other key is written: the CLI may already have left the screen the window shows,
// for example for its sign-in.
const STARTUP_KEY_SETTLE_MS = 150;
const STARTUP_KEY_QUIET_MS = 1_000;
const STARTUP_KEY_CAP_MS = 3_000;

/** A startup key the CLI has not answered yet; its times are performance.now() readings. */
interface PendingStartupKey {
  written: boolean;
  /** The screen once the write was confirmed: output from before it never answers the key. */
  baseline: string;
  writtenAt: number;
  outputAt: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: unknown): void;
}

function startupTimeoutReason(text: string): string {
  const compact = text.replace(/\s/g, '').toLowerCase();
  if (compact.includes('bypasspermissionsmode') && compact.includes('yes,iaccept')) return 'Native startup is waiting for explicit Bypass Permissions consent. Reopen and answer the native startup dialog.';
  if (/trustthisfolder|doyoutrust|quicksafetycheck/.test(compact)) return 'Native startup is waiting for folder trust confirmation. Reopen and answer the native startup dialog.';
  if (/detectedacustomapikey/.test(compact)) return 'Native startup is waiting for an answer to the API key approval dialog. Reopen and answer the native startup dialog.';
  if (/relaynativestartupfailed|hooksmodule(?:didnotload|failed)|plugin.*(?:failed|error)|(?:failed|error).*plugin/.test(compact)) return 'Native Mod initialization failed. Check the installed native bridge before reopening the session.';
  return 'Native transport: interactive hello timed out';
}

/** One real interactive process. Requests are local mod dispatch, never SDK queries. */
export class NativeInteractiveSession {
  readonly options: NativeInteractiveSessionOptions;
  private readonly runtime: NativeRuntime;
  private readonly mapper: NativeTranscriptMapper;
  private readonly lifetime = new AbortController();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly interactions = new Map<string, AbortController>();
  private readonly settledInteractions = new Set<string>();
  private readonly pendingEvents: NativeEvent[] = [];
  private readonly gates = new Set<string>();
  private readonly outputPaths = new Map<string, string>();
  private capabilities = new Set<string>();
  private state: EngineState = 'starting';
  private ready: NativeReady | undefined;
  private sessionId: string | undefined;
  private model: string;
  private permissionMode: PermissionMode | undefined;
  private commands: SlashCommandInfo[] = [];
  private tools: string[] = [];
  private activeTurn: string | undefined;
  private readonly stepOutput = new Map<string, number>();
  private outputTokens: number | undefined;
  private startedAt: number | undefined;
  private lastSequence = 0;
  private started = false;
  private activityEpoch = 0;
  private mainTurnEpoch = 0;
  private workflowRefresh: Promise<void> | undefined;
  private lastWorkflowReadAt = -Infinity;
  private closing = false;
  private didClose = false;
  private closePromise: Promise<void> | undefined;
  private sendTail: Promise<void> = Promise.resolve();
  /** Sends chained on sendTail that have not settled yet. */
  private tailDepth = 0;
  /** The user's slash command from send() until it settles; a second one is refused rather than stacked. */
  private claimedCommand: { name: string } | undefined;
  /** The same command while the native CLI runs it. */
  private pendingCommand: { name: string } | undefined;
  private commandEscapeAt = Number.NEGATIVE_INFINITY;
  /** `<command-name>` transcript rows a command read-back already owns. */
  private readonly commandAnchors = new Set<string>();
  /** Running command read-backs by the command the CLI runs. */
  private readonly commandReads = new Map<string, AbortController>();
  private readonly screen: NativeTerminalScreen;
  private panelHost: NativePanelHost | undefined;
  private effort: Effort | undefined;
  private lastContext: ContextUsage | undefined;
  /** The newest state-like events, re-sent when a reloaded renderer adopts this handle again. */
  private readonly lastEvents = new Map<'mcp' | 'context' | 'autoContinue', EngineEvent>();
  private sendQueue: NativeSendQueue | undefined;
  private ui: NativeUiController | undefined;
  private sessionSettings: NativeSessionSettings | undefined;
  private nativeSettings: NativeSettings | undefined;
  private nativeFast: NativeFastControl | undefined;
  private quotaControls: NativeQuotaControls | undefined;
  private mcpDialogs: NativeMcpDialogControls | undefined;
  private mcpControls: NativeMcpControls | undefined;
  private workflows: NativeWorkflowState | undefined;
  private agentTasks: BackgroundTask[] = [];
  private controlsActive = false;
  private composerBusy = false;
  private attachmentSender: ReturnType<typeof createNativeAttachmentAdapter> | undefined;
  private attachmentResources: NativeSessionAttachmentResources | undefined;
  private preparedSend: { id: string; files: readonly PromptAttachment[] } | undefined;
  private pendingAttachment: Promise<unknown> | undefined;
  private readonly queuedEchoes = new Map<string, Extract<TranscriptItem, { kind: 'user' }>>();
  private startupScreen: NativeTerminalScreen | undefined;
  private startupRevision = 0;
  private startupText = '';
  private startupFinished = false;
  private startupFailureReason = 'Native transport: interactive hello timed out';
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  /** The CLI showed its own sign-in: none of it reaches the window and the session closes. */
  private signInBlocked = false;
  private startupKey: PendingStartupKey | undefined;
  private liveContext: boolean;
  private lastContextAt = Number.NEGATIVE_INFINITY;
  private contextInFlight: { detail: 'summary' | 'full'; promise: Promise<ContextUsage | null> } | undefined;
  /** The running effort-note read; a model list read meanwhile waits for it rather than starting another. */
  private effortRead: Promise<Record<string, EffortGuide>> | undefined;
  private readonly now: () => number;

  constructor(options: NativeInteractiveSessionOptions) {
    this.options = options;
    this.runtime = options.runtime;
    // Written from the first byte: the CLI switches its mouse and paste modes only once, at startup.
    this.screen = new NativeTerminalScreen(options.launch.cols, options.launch.rows);
    this.startupScreen = new NativeTerminalScreen(options.launch.cols, options.launch.rows);
    this.mcpControls = options.mcpControls;
    this.now = options.now ?? Date.now;
    this.model = options.request.model ?? 'default';
    this.permissionMode = options.request.permissionMode;
    this.liveContext = options.request.liveContext === true;
    this.mapper = new NativeTranscriptMapper(
      (item) => this.emit({ type: 'item', handleId: options.handleId, item }),
      (itemId, text) => this.emit({ type: 'delta', handleId: options.handleId, itemId, text }),
      options.request.cwd, this.now,
      { store: options.storeImages ?? storeImageBlocks, prefix: () => this.sessionId ?? options.handleId },
    );
  }

  get handle(): EngineHandle {
    return { handleId: this.options.handleId, profileId: this.options.profile.id,
      cwd: this.ready?.cwd ?? this.options.request.cwd,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }
  get currentState(): EngineState { return this.state; }

  async start(): Promise<EngineHandle> {
    if (this.started || this.closing) throw new Error('This native session was already started.');
    this.started = true;
    this.unsubscribers.push(this.runtime.onEvent((event) => this.receive(event)),
      this.runtime.onExit((code, cause) => this.exited(code, cause)),
      this.runtime.onTerminal((data) => this.receiveTerminal(data)));
    this.setState('starting');
    this.emitStartup('waiting', '');
    try {
      const ready = await this.runtime.start(this.options.launch);
      if (this.closing) throw new Error('The native session was closed during startup.');
      if (ready.protocol !== 1 || !ready.isInteractive || ready.surface !== 'terminal' || !ready.sessionId) {
        throw new Error('Native bridge did not attest a real interactive terminal session.');
      }
      const resumed = this.options.request.resumeSessionId;
      if (resumed) {
        const same = ready.sessionId.toLowerCase() === resumed.toLowerCase();
        if (this.options.request.forkSession ? same : !same) {
          throw new Error('Native session identity does not match the requested resume/fork ownership.');
        }
      }
      this.ready = ready;
      this.finishStartup('ready');
      this.sessionId = ready.sessionId;
      this.workflows = new NativeWorkflowState(ready.sessionId);
      this.capabilities = new Set(ready.capabilities);
      this.model = ready.model ?? this.model;
      this.configureControls();
      this.configurePanel();
      await this.configureAttachments();
      if (this.options.request.ephemeral) this.requireCapability('session.ephemeral');
      // Native saved MCP preferences are authoritative, including the shared Default
      // profile. Legacy SDK conversation overrides must not write them or block resume.
      this.emitInit();
      this.setState('idle');
      for (const event of this.pendingEvents.splice(0)) this.receive(event);
      // Discovery is independent of readiness: a missing optional feature must not freeze the GUI.
      void this.discover().catch((error: unknown) => this.report(error));
      return this.handle;
    } catch (error) {
      const failure = this.signInBlocked ? new Error(SIGN_IN_REQUIRED)
        : error instanceof Error && error.message === 'Native transport: interactive hello timed out'
          ? new Error(this.startupFailureReason) : error;
      await this.close();
      throw failure;
    }
  }

  async startupInput(input: NativeStartupInput): Promise<void> {
    if (this.signInBlocked) throw new Error(SIGN_IN_REQUIRED);
    if (!this.options.request.startupRequestId || !this.started || this.ready || this.closing || this.didClose || this.startupFinished) throw new Error('Native startup input is no longer available.');
    this.publishStartup();
    if (!this.startupText.trim() || this.startupRevision < 1) throw new Error('The native startup screen is not available yet.');
    if (!input || !Number.isSafeInteger(input.revision) || input.revision !== this.startupRevision
      || !Object.prototype.hasOwnProperty.call(STARTUP_KEYS, input.key)) throw new Error('The native startup screen changed. Review the current screen before answering.');
    if (!this.runtime.writeStartup) throw new Error('The native runtime does not support guarded startup input.');
    if (this.startupKey) throw new Error('The native startup screen has not answered the previous key yet.');
    // Consume the revision before the await; duplicate clicks cannot reuse one screen.
    this.startupRevision++;
    this.emitStartup('waiting', this.startupText);
    let key!: PendingStartupKey;
    const answered = new Promise<void>((resolve, reject) => {
      key = { written: false, baseline: '', writtenAt: 0, outputAt: -Infinity, resolve, reject };
    });
    void answered.catch(() => undefined);
    this.startupKey = key;
    try {
      await this.runtime.writeStartup(STARTUP_KEYS[input.key]);
    } catch (error) {
      this.settleStartupKey(error, key);
    }
    if (this.startupKey === key) {
      // What arrived before the write was confirmed is not the answer; a sign-in screen closes the session instead.
      this.publishStartup();
      key.written = true; key.baseline = this.startupText; key.writtenAt = performance.now();
      this.checkStartupKey(key);
    }
    return answered;
  }

  /** Messages wait their turn (also behind a failed control until its dialog is closed); slash commands never stack. */
  send(text: string, opts: { queue?: boolean; attachments?: readonly PromptAttachment[] } = {}): Promise<void> {
    const command = opts.attachments?.length ? null : SLASH_COMMAND.exec(text.trim());
    // Log in and Log out run the official commands in their own console; the CLI's own sign-in never runs in a session.
    // The CLI runs a listed command of exactly the typed name, letter case included, before an alias; so do the window
    // and the plugin.
    if (command && SIGN_IN_COMMANDS.has(this.commands.some((entry) => entry.name === command[1]) ? command[1].toLowerCase()
      : cliCommandName(command[1], []))) {
      return Promise.reject(new Error(signInCommandRefusal(command[1].toLowerCase())));
    }
    let claim: { name: string } | undefined;
    if (command) {
      // Keys meant for a second dialog would reach the first one.
      if (this.claimedCommand) return Promise.reject(new Error(`Finish /${this.claimedCommand.name} before running another command.`));
      claim = this.claimedCommand = { name: command[1] };
    } else if (this.pendingCommand && this.tailDepth === 1) {
      // Only the running command is ahead: queue the message now (shown as queued); it goes out once the command ends.
      return this.sendOne(text, opts);
    }
    this.tailDepth++;
    // Released before the caller resumes, so a command sent right after this one is not refused.
    const run = this.sendTail.then(() => this.sendOne(text, opts, claim))
      .finally(() => { this.tailDepth--; if (claim && this.claimedCommand === claim) this.claimedCommand = undefined; });
    this.sendTail = run.catch(() => undefined);
    return run;
  }

  private async sendOne(text: string, opts: { queue?: boolean; attachments?: readonly PromptAttachment[] }, claim?: { name: string }): Promise<void> {
    this.requireOpen();
    const attachments = opts.attachments ?? [];
    if (!text.trim() && !attachments.length) throw new Error('Nothing to send.');
    const command = attachments.length === 0 ? SLASH_COMMAND.exec(text.trim()) : null;
    this.requireCapability(command ? 'command.run' : 'prompt.submit');
    if (attachments.length && !this.attachmentSender) throw new NativeCapabilityError('prompt.attachments', 'the native attachment bridge/private storage is unavailable.');
    if (!command) {
      const files = attachments.map((file) => ({ ...file }));
      if (files.length) validateNativeAttachmentSubmission({ text, attachments: files }, Boolean(this.attachmentResources?.pdfTools));
      const queue = this.sendQueue;
      if (!queue) throw new Error('Native send queue is not ready.');
      const before = queue.snapshot();
      const queued = this.controlsActive || this.state === 'running' || this.state === 'awaiting' || before.phase !== 'idle';
      const activity = this.activityEpoch;
      const send = queue.submit(text, opts.queue ? 'later' : 'next', files.length ? async (id, signal) => {
        this.composerBusy = true;
        this.preparedSend = { id, files };
        const submitted = this.attachmentSender!.submit({ text, attachments: files, signal });
        this.pendingAttachment = submitted;
        try { return await submitted; }
        finally {
          if (this.pendingAttachment === submitted) this.pendingAttachment = undefined;
          this.preparedSend = undefined; this.composerBusy = false;
        }
      } : undefined);
      const delivered = send.delivered.then(() => {
        this.queuedEchoes.delete(send.id);
        if (this.closing) return;
        this.mapper.acceptSend(send.id, false);
        if (this.state === 'idle' && activity === this.activityEpoch) this.setState('running');
      }, (error: unknown) => {
        this.mapper.rejectSend(send.id);
        throw error;
      });
      if (queued) {
        const imageCount = files.filter((file) => file.kind === 'image').length;
        const imageRefs = imageCount ? (this.options.storeImages ?? storeImageBlocks)(promptContent(text, files), `${this.sessionId}:${send.id}`) : [];
        const item: Extract<TranscriptItem, { kind: 'user' }> = { kind: 'user', id: send.id, text, queued: true,
          ...(imageCount ? { images: imageCount, imageRefs } : {}) };
        this.queuedEchoes.set(send.id, item);
        this.emit({ type: 'item', handleId: this.options.handleId, item });
        void delivered.catch(() => undefined);
        return;
      }
      return delivered;
    }
    if (this.controlsActive || this.composerBusy) throw new NativeCapabilityError('ui.command.busy', 'a native modal or attachment owns terminal input; slash commands cannot interleave.');
    const busy = this.state === 'running' || this.state === 'awaiting';
    if (busy && !opts.queue && !this.activeTurn) throw new NativeCapabilityError('prompt.preempt', 'the first native turn has not reported its identity yet.');
    const uuid = (this.options.newId ?? randomUUID)();
    const owner = claim ?? { name: command[1] };
    this.pendingCommand = owner;
    this.mapper.registerSend(uuid, text);
    this.mapper.beginCommand(uuid);
    // The command shows as running (Stop, elapsed time) until it settles, also when it draws a dialog.
    if (!busy) { this.startedAt = this.now(); this.outputTokens = undefined; this.setState('running'); }
    this.panelHost?.refresh();
    let ended = false;
    try {
      if (busy && !opts.queue) await this.interruptTurn();
      const runs = cliCommandName(command[1], this.commands.map((entry) => entry.name));
      // An older run's read-back could take this run's rows; with it stopped, this one must not take the older run's.
      const superseded = this.stopCommandRead(runs);
      const sentAt = this.now();
      const result = await this.call('command.run', { command: command[1], args: command[2] ?? '' }, { timeoutMs: null });
      this.requireOpen();
      this.mapper.acceptSend(uuid, false);
      ended = true;
      const printed = this.mapper.endCommand();
      const output = isRecord(result) ? nativeText(result.text) : undefined;
      this.showCommandResults({ name: command[1], runs, since: superseded ? sentAt : sentAt - COMMAND_ANCHOR_SLACK_MS }, uuid,
        printed ? undefined : output);
      // A local command can finish without a turn.complete event or any result text.
      const priorContext = this.contextInFlight?.promise;
      if (priorContext) void priorContext.then(() => this.refreshContext(), () => this.refreshContext());
      else this.refreshContext();
    } catch (error) {
      if (!ended) this.mapper.endCommand();
      this.mapper.rejectSend(uuid);
      throw error;
    } finally {
      if (this.pendingCommand === owner) {
        this.pendingCommand = undefined;
        this.panelHost?.refresh();
        if (!this.closing) {
          if (this.state === 'running' && !this.activeTurn) this.setState('idle');
          this.sendQueue?.refresh();
          void this.refreshAfterCommand();
        }
      }
    }
  }

  /**
   * The command's printed rows under their transcript ids, which a later history read replaces in place, each kept right
   * below the command (its echo, else its transcript row); the text command.run answered only when the transcript has none.
   */
  private showCommandResults(query: { name: string; runs: string; since: number }, afterId: string, fallback: string | undefined): void {
    const show = (items: readonly TranscriptItem[], anchorId?: string): void => {
      let after = afterId;
      for (const item of items) {
        this.emit({ type: 'item', handleId: this.options.handleId, item, afterId: after, ...(anchorId ? { anchorId } : {}) });
        after = item.id;
      }
    };
    const fallbackItems = (): TranscriptItem[] => {
      const item = fallback ? nativeCommandOutput(fallback, `native-command:${afterId}`) : undefined;
      return item ? [item] : [];
    };
    const locate = this.options.commandTranscript, sessionId = this.sessionId;
    if (!locate || !sessionId) { show(fallbackItems()); return; }
    const reading = new AbortController();
    this.commandReads.set(query.runs, reading);
    void readCommandResults({ name: query.name, resolved: query.runs, since: query.since, taken: this.commandAnchors,
      onAnchor: (anchor) => this.commandAnchors.add(anchor), signal: AbortSignal.any([this.lifetime.signal, reading.signal]),
      file: () => locate(sessionId, this.handle.cwd) }).then((scan) => {
      if (!this.closing) show(scan.items.length ? scan.items : fallbackItems(), scan.anchor);
    }).catch((error: unknown) => this.report(error))
      .finally(() => { if (this.commandReads.get(query.runs) === reading) this.commandReads.delete(query.runs); });
  }

  /** Stops the read-back of an earlier run of the command; whether one was still running. */
  private stopCommandRead(runs: string): boolean {
    const reading = this.commandReads.get(runs);
    if (!reading) return false;
    this.commandReads.delete(runs);
    reading.abort();
    return true;
  }

  async interrupt(): Promise<void> {
    this.requireOpen();
    if (this.pendingCommand && !this.activeTurn) { await this.stopCommand(); return; }
    await this.interruptTurn();
  }

  private async interruptTurn(): Promise<void> {
    if (this.sendQueue) { await this.sendQueue.interrupt(); return; }
    if (this.state !== 'running' && this.state !== 'awaiting') return;
    if (!this.activeTurn) throw new NativeCapabilityError('turn.abort', 'the native turn ID is not available yet.');
    await this.call('turn.abort', { turnId: this.activeTurn });
  }

  /** Stop for a slash command: close its dialog, or give the CLI one Esc, the key that cancels a running command. */
  private async stopCommand(): Promise<void> {
    if (this.panelHost?.visible) { await this.panelHost.close(); return; }
    const now = Date.now();
    if (now - this.commandEscapeAt < COMMAND_ESCAPE_WINDOW_MS) return;
    this.commandEscapeAt = now;
    await this.runtime.writeTerminal('\x1b');
  }

  /** One key, text or click for the CLI dialog the mirror shows. */
  panelInput(input: NativePanelInput): Promise<void> {
    if (this.signInBlocked) return Promise.reject(new Error(SIGN_IN_REQUIRED));
    this.requireOpen();
    if (!this.panelHost) return Promise.reject(new Error('No CLI panel is open.'));
    return this.panelHost.input(input);
  }

  /** Closes the mirrored CLI dialog the way Esc does; a failed control's quarantine then ends. */
  async panelClose(): Promise<void> {
    this.requireOpen();
    if (!this.panelHost) return;
    try { await this.panelHost.close(); }
    finally { this.ui?.checkRecovery(); }
  }

  async setModel(model: string): Promise<void> {
    if (!model.trim()) throw new Error('No model given.');
    this.requireOpen();
    if (this.sessionSettings) {
      const actual = await this.sessionSettings.setModel(model);
      this.model = actual.model;
      // Effort is kept per model, so the footer chip can change with it.
      await this.composerShown();
      this.readFooter();
      await this.refreshFast().catch((error: unknown) => this.report(error));
      this.emitInit();
      void this.contextUsage('summary').catch((error: unknown) => this.report(error));
      return;
    }
    this.requireCapability('model.session', 'the native /model command persists new-session defaults; a genuine session-only setter is not verified.');
    this.requireCapability('session.model');
    await this.call('model.session', { model });
    const actual = await this.call('session.model', {});
    if (typeof actual !== 'string' || !actual.trim()) throw new Error('Native session.model returned no model.');
    this.model = actual;
    await this.refreshFast().catch((error: unknown) => this.report(error));
    this.emitInit();
    void this.contextUsage('summary').catch((error: unknown) => this.report(error));
  }

  async setEffort(effort: Effort): Promise<void> {
    if (!EFFORT_LEVELS.includes(effort)) throw new Error('Invalid effort level.');
    this.requireOpen();
    if (this.sessionSettings) await this.sessionSettings.setEffort(effort);
    else await this.setSessionConfig('effortLevel', effort);
    this.effort = effort;
  }
  async setUltracode(enabled: boolean): Promise<void> {
    if (this.nativeSettings) { await this.nativeSettings.setUltracode(this.boolean(enabled)); await this.refreshTools(); return; }
    await this.setSessionConfig('ultracode', this.boolean(enabled));
  }
  async setFastMode(enabled: boolean): Promise<void> {
    if (this.nativeSettings) {
      await this.nativeSettings.setFastMode(this.boolean(enabled));
      if (this.capabilities.has('session.model')) {
        const actual = nativeText(await this.call('session.model', {}));
        if (!actual) throw new Error('Native Fast mode returned no current model.');
        this.model = actual;
      }
      await this.refreshFast();
      await this.refreshTools(); return;
    }
    await this.setSessionConfig('fastMode', this.boolean(enabled));
  }
  async setWorkflows(value: WorkflowsSetting | null): Promise<void> {
    if (value !== null && value !== 'on' && value !== 'off') throw new Error('Invalid workflows setting.');
    if (this.options.controls?.assertPreferenceScope) {
      this.requireOpen();
      this.options.controls.assertPreferenceScope();
      // No flag layer is installed in this mode: Default already follows the native saved choice.
      if (value === null) return;
      const result = await this.call('workflow.set', { enabled: value === 'on' });
      if (isRecord(result) && typeof result.deny === 'string') throw new Error(result.deny);
      if (!isRecord(result) || result.enabled !== (value === 'on') || result.scope !== 'native-user') {
        throw new Error('Native workflow settings did not confirm the saved value.');
      }
      this.options.controls.assertPreferenceScope();
      await this.refreshTools();
      return;
    }
    await this.setSessionConfig('enableWorkflows', value === null ? null : value === 'on');
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw new Error('Invalid permission mode.');
    if (this.nativeSettings) {
      const actual = await this.nativeSettings.setPermissionMode(mode);
      this.permissionMode = actual.mode;
      this.emitInit();
      return;
    }
    await this.setSessionConfig('permissionMode', mode);
    this.permissionMode = mode;
    this.emitInit();
  }
  async setAutoContinue(enabled: boolean): Promise<void> {
    if (this.options.request.ephemeral && enabled) throw new Error('A side chat cannot continue automatically.');
    if (this.nativeSettings && !this.options.request.ephemeral) { await this.nativeSettings.setAutoContinue(this.boolean(enabled)); return; }
    if (this.options.request.ephemeral && enabled === false) { this.requireOpen(); return; }
    await this.setSessionConfig('autoContinueAtUsageLimit', this.boolean(enabled));
  }
  async cancelAutoContinue(): Promise<void> {
    this.requireOpen();
    if (!this.quotaControls) throw new NativeCapabilityError('autoContinue.cancel', 'the native quota view is not available.');
    await this.quotaControls.cancel();
  }
  async continueAfterLimit(): Promise<void> {
    this.requireOpen();
    if (!this.quotaControls) throw new NativeCapabilityError('autoContinue.continue', 'the native quota view is not available.');
    await this.quotaControls.continue();
  }
  async setLiveContext(enabled: boolean): Promise<void> { this.requireOpen(); this.liveContext = this.boolean(enabled); }

  /** Native menu writes are not silently substituted for session-only flag settings. */
  private async setSessionConfig(key: string, value: unknown): Promise<void> {
    const list = await this.call('config.list', {});
    if (!Array.isArray(list)) throw new Error('Native config.list returned no list.');
    const row = list.find((entry) => isRecord(entry) && entry.key === key);
    if (!isRecord(row)) throw new NativeCapabilityError(`config.session:${key}`, 'no native configuration row has this key.');
    if (row.isLocked === true) throw new Error(`Native configuration is managed: ${key}.`);
    if (row.scope !== 'session' && !this.capabilities.has(`config.session:${key}`)) {
      throw new NativeCapabilityError(`config.session:${key}`, 'native menu persistence is not verified equivalent to a session-only flag.');
    }
    await this.call('config.set', { key, value });
  }

  async models(): Promise<ModelOption[]> {
    const guides = this.effortGuides();
    if (this.capabilities.has('model.list')) {
      const value = await this.call('model.list', {});
      if (!Array.isArray(value)) throw new Error('Native model.list returned no list.');
      // Effort notes come only from Relay's own validated catalog read, never from bridge rows.
      const rows = value.filter((row): row is ModelOption => isRecord(row) && typeof row.value === 'string' && typeof row.label === 'string')
        .map(({ effortGuide: _bridge, ...row }) => row);
      return withEffortGuides(rows, await guides);
    }
    const list = await this.call('config.list', {});
    this.nativeFast = nativeFastControl(list); this.emitInit();
    const row = Array.isArray(list) ? list.find((entry) => isRecord(entry) && entry.key === 'model') : undefined;
    if (!isRecord(row) || !Array.isArray(row.options)) throw new NativeCapabilityError('model.list', 'native model catalog is unavailable.');
    return withEffortGuides(nativeModelCatalog(row.options), await guides);
  }
  /** Effort notes are optional: without them, or while they are slow to read, the menu still lists the models. */
  private async effortGuides(): Promise<Record<string, EffortGuide>> {
    if (!this.options.effortGuides) return {};
    if (!this.effortRead) {
      const read: Promise<Record<string, EffortGuide>> = (async () => await this.options.effortGuides?.() ?? {})()
        .catch(() => ({}))
        .finally(() => { if (this.effortRead === read) this.effortRead = undefined; });
      this.effortRead = read;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.effortRead,
        new Promise<Record<string, EffortGuide>>((resolve) => { timer = setTimeout(() => resolve({}), EFFORT_GUIDE_TIMEOUT_MS); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async contextUsage(detail: 'summary' | 'full' = 'full'): Promise<ContextUsage | null> {
    this.requireOpen();
    const active = this.contextInFlight;
    if (active) {
      if (detail === 'summary' || active.detail === 'full') return active.promise;
      await active.promise.catch(() => undefined);
      return this.contextUsage(detail);
    }
    this.lastContextAt = this.now();
    const run = this.call('session.usage', { breakdown: detail }).then((value) => {
      let context = nativeContext(value);
      // A summary reading carries no memory files; keep the ones the last full reading reported.
      if (context && !context.memoryFiles && this.lastContext?.memoryFiles) context = { ...context, memoryFiles: this.lastContext.memoryFiles };
      if (context?.categories.length) this.lastContext = context;
      if (context) this.emit({ type: 'context', handleId: this.options.handleId, usage: context });
      const usage = nativePlanUsage(value, this.options.profile.id, this.now());
      if (usage) this.emit({ type: 'usage', usage });
      return context;
    }).finally(() => { if (this.contextInFlight?.promise === run) this.contextInFlight = undefined; });
    this.contextInFlight = { detail, promise: run };
    return run;
  }

  async nativePlanUsage(): Promise<PlanUsage | null> {
    const value = await this.call('session.usage', {});
    const usage = nativePlanUsage(value, this.options.profile.id, this.now());
    if (usage) this.emit({ type: 'usage', usage });
    return usage;
  }
  async planUsage(): Promise<SDKControlGetUsageResponse> {
    throw new NativeCapabilityError('SDK quota ledger', 'Native GUI usage is read through nativePlanUsage; no SDK ledger request or shadow engine is available.');
  }

  async mcpStatus(): Promise<McpServerState[]> {
    this.requireOpen();
    if (this.mcpControls) return this.publishMcp(await this.mcpControls.status());
    if (!this.capabilities.has('mcp.status') && this.mcpDialogs) {
      const names = Object.keys(this.options.mcpServers ?? {});
      const actual = await this.mcpDialogs.inspectCatalog(names);
      return this.publishMcp(actual.map((row) => ({ name: row.name, status: row.status, toolCount: row.toolCount ?? 0,
        relay: names.includes(row.name), source: row.source })));
    }
    const value = await this.call('mcp.status', {});
    if (!Array.isArray(value)) throw new Error('Native mcp.status returned no list.');
    const servers = value.filter((row): row is McpServerState => isRecord(row) && typeof row.name === 'string' &&
      ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(String(row.status)) &&
      typeof row.toolCount === 'number' && typeof row.relay === 'boolean');
    this.emit({ type: 'mcp', handleId: this.options.handleId, servers });
    return servers;
  }
  async mcpToggle(name: string, enabled: boolean): Promise<McpServerState[]> {
    this.requireOpen();
    if (this.mcpControls) {
      const servers = await this.mcpControls.setEnabled(name, this.boolean(enabled));
      await this.refreshTools();
      return this.publishMcp(servers);
    }
    this.requireCapability('mcp.status');
    await this.call('mcp.toggle', { name, enabled: this.boolean(enabled) });
    return this.mcpStatus();
  }
  async mcpReconnect(name: string): Promise<McpServerState[]> {
    this.requireOpen();
    if (this.mcpControls) {
      const servers = await this.mcpControls.reconnect(name);
      await this.refreshTools();
      return this.publishMcp(servers);
    }
    if (!this.capabilities.has('mcp.reconnect') && this.mcpDialogs) {
      if (this.dialogMcpName() !== name) throw new NativeCapabilityError('mcp.reconnect.dialog', 'the requested server is not the known literal session configuration.');
      const actual = await this.mcpDialogs.reconnect(name);
      const servers: McpServerState[] = [{ name, status: actual.status, toolCount: actual.toolCount ?? 0, relay: true, source: actual.source }];
      this.emit({ type: 'mcp', handleId: this.options.handleId, servers });
      return servers;
    }
    this.requireCapability('mcp.status');
    await this.call('mcp.reconnect', { name });
    return this.mcpStatus();
  }

  private publishMcp(servers: McpServerState[]): McpServerState[] {
    this.requireOpen();
    this.emit({ type: 'mcp', handleId: this.options.handleId, servers });
    return servers;
  }

  async stopTask(taskId: string): Promise<void> {
    if (!taskId.trim() || taskId.length > 200) throw new Error('Invalid task id.');
    const value = await this.call('tool.call', { tool: 'TaskStop', task_id: taskId });
    if (isRecord(value) && value.isError === true) throw new Error(redactSecrets(nativeText(value.text) ?? 'Native TaskStop failed.'));
    if (this.capabilities.has('agent.list')) {
      await this.refreshTasks().catch((error: unknown) => this.report(error));
    }
  }
  async taskOutput(taskId: string): Promise<string | null> {
    this.requireOpen();
    const path = this.outputPaths.get(taskId) ?? this.workflows?.outputPath(taskId);
    if (path) return (this.options.readTaskOutput ?? readTaskOutput)(path);
    if (!this.capabilities.has('task.output')) throw new NativeCapabilityError('task.output', 'no native output-file binding is available for this task.');
    const output = await this.call('task.output', { taskId });
    if (output === null) return null;
    if (typeof output !== 'string') throw new Error('Native task.output returned invalid data.');
    return redactSecrets(output);
  }
  async nativeSubagent(agentId: string): Promise<TranscriptItem[] | null> {
    this.requireOpen();
    if (!this.workflows || !this.options.workflowFiles) return null;
    await this.refreshWorkflowFiles();
    return this.options.workflowFiles.readAgent(this.workflows, agentId);
  }

  onPendingChange(count: number): void {
    if (this.closing || this.didClose) return;
    if (count > 0) this.setState('awaiting');
    else if (this.state === 'awaiting') this.setState(this.activeTurn || this.pendingCommand ? 'running' : 'idle');
  }
  onToolDecision(info: { toolUseId?: string; behavior: 'allow' | 'deny' }): void {
    if (info.toolUseId && info.behavior === 'deny') this.mapper.markDenied(info.toolUseId);
  }

  close(): Promise<void> {
    this.closing = true;
    this.finishStartup('closed');
    this.closePromise ??= Promise.resolve().then(() => this.shutdown()).catch((error: unknown) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
  private async shutdown(): Promise<void> {
    this.closing = true;
    this.sendQueue?.close();
    this.ui?.close();
    this.panelHost?.dispose();
    this.options.workflowFiles?.dispose();
    await this.workflowRefresh?.catch(() => undefined);
    this.lifetime.abort();
    for (const controller of this.interactions.values()) controller.abort();
    this.interactions.clear();
    this.options.broker.cancelAll('The native session was closed.');
    // Keep writer ownership when process termination could not be verified.
    if (this.attachmentSender) await this.attachmentSender.close();
    else await this.runtime.close();
    // The process is gone; a resource that fails to close must not keep the session half open.
    try { await this.attachmentResources?.close?.(); }
    catch (error) { this.options.emit({ type: 'error', handleId: this.options.handleId, fatal: false, message: redactSecrets(error instanceof Error ? error.message : String(error)) }); }
    this.finishClose();
  }
  private finishClose(): void {
    if (this.didClose) return;
    this.didClose = true;
    this.mapper.finalize();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.pendingEvents.length = 0;
    this.queuedEchoes.clear();
    this.setState('closed');
    this.options.onClosed?.();
  }
  private exited(code: number | null, cause?: NativeExitCause): void {
    if (this.didClose) return;
    if (!this.closing) {
      const exit = `Native interactive process exited (${code ?? 'unknown'}).`;
      this.report(new Error(cause?.kind === 'transport' ? `${cause.message}. ${exit}` : exit), true);
    }
    this.closing = true;
    this.finishStartup('closed');
    this.sendQueue?.close();
    this.ui?.close();
    this.panelHost?.dispose();
    this.lifetime.abort();
    for (const controller of this.interactions.values()) controller.abort();
    this.interactions.clear();
    this.options.broker.cancelAll('The native process exited.');
    void this.close().catch((error: unknown) => {
      this.options.emit({ type: 'error', handleId: this.options.handleId, fatal: true,
        message: redactSecrets(error instanceof Error ? error.message : String(error)) });
    });
  }

  private receive(event: NativeEvent): void {
    if (this.closing || this.didClose) return;
    if (!this.ready) {
      if (this.pendingEvents.length >= 512) { this.report(new Error('Native startup event buffer overflowed.'), true); void this.close(); }
      else this.pendingEvents.push(event);
      return;
    }
    if (event.sessionId !== this.sessionId || !Number.isSafeInteger(event.sequence) || event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    this.sendQueue?.observe(event);
    if (this.workflows?.observe(event)) {
      this.publishTasks();
      void this.refreshWorkflowFiles().catch((error: unknown) => this.report(error));
    }
    const data = isRecord(event.data) ? event.data : {};
    switch (event.event) {
      case 'turn.start':
        if (data.agentId || typeof data.turnId !== 'string') break;
        this.mainTurnEpoch++;
        this.activityEpoch++;
        this.activeTurn = data.turnId;
        this.stepOutput.clear();
        this.outputTokens = undefined;
        this.mapper.beginTurn(data.turnId);
        this.startedAt = this.now();
        this.setState('running');
        break;
      case 'turn.step':
        if (!data.agentId && typeof data.turnId === 'string') {
          this.activityEpoch++;
          this.activeTurn ??= data.turnId;
          this.mapper.beginTurn(data.turnId);
          if (this.state !== 'awaiting') this.setState('running');
        }
        this.mapper.step(data);
        if (!data.agentId && isRecord(data.chunk) && data.chunk.kind === 'stop' && isRecord(data.chunk.usage)) {
          const count = data.chunk.usage.output_tokens;
          if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
            this.stepOutput.set(String(data.stepId ?? data.index ?? 0), count);
            this.outputTokens = [...this.stepOutput.values()].reduce((sum, value) => sum + value, 0);
            this.setState(this.state);
          }
        }
        if (this.liveContext && this.now() - this.lastContextAt >= 10_000) this.refreshContext();
        break;
      case 'session.append': this.mapper.append(data); break;
      case 'session.measure': {
        // A measure carries no breakdown: it updates the last one's totals instead of replacing it.
        const live = nativeContext(data);
        const context = live && this.lastContext ? { ...this.lastContext, usedTokens: live.usedTokens, percent: live.percent, live: true } : live;
        if (context) this.emit({ type: 'context', handleId: this.options.handleId, usage: context });
        const usage = nativePlanUsage(data, this.options.profile.id, this.now());
        if (usage) this.emit({ type: 'usage', usage });
        break;
      }
      case 'turn.complete':
        this.mapper.complete(data);
        if (!data.agentId && (!this.activeTurn || data.turnId === this.activeTurn)) {
          this.activityEpoch++;
          this.activeTurn = undefined;
          if (isRecord(data.usage) && typeof data.usage.output_tokens === 'number' &&
            Number.isFinite(data.usage.output_tokens) && data.usage.output_tokens >= 0) this.outputTokens = data.usage.output_tokens;
          // A slash command that waited for this turn (or started it) is still running.
          if (this.pendingCommand) { this.startedAt = this.now(); this.outputTokens = undefined; this.setState('running'); }
          else this.setState('idle');
          this.refreshContext();
        }
        void this.refreshTasks().catch((error: unknown) => this.report(error));
        break;
      case 'interaction.request': void this.interaction(data); break;
      case 'interaction.cancel': {
        const id = nativeText(data.id);
        if (id) { const controller = this.interactions.get(id); this.interactions.delete(id); this.settledInteractions.add(id); controller?.abort(); }
        break;
      }
      case 'session.compact':
        this.emit({ type: 'item', handleId: this.options.handleId,
          item: { kind: 'system', id: `native-compact:${event.sequence}`, text: 'Conversation compacted', level: 'info' } });
        this.refreshContext();
        break;
      case 'task.output':
        if (typeof data.taskId === 'string' && typeof data.path === 'string') this.outputPaths.set(data.taskId, data.path);
        break;
      case 'autoContinue':
        if (data.state && isRecord(data.state) && ['idle', 'waiting', 'stale'].includes(String(data.state.phase))) {
          this.emit({ type: 'autoContinue', handleId: this.options.handleId, state: data.state as unknown as import('@shared/types').AutoContinueState });
        }
        break;
      case 'error':
        this.report(new Error(nativeText(data.message) ?? 'Native bridge error.'), data.fatal === true);
        if (data.fatal === true) void this.close().catch(() => undefined);
        break;
      default: break;
    }
  }

  private async interaction(data: Record<string, unknown>): Promise<void> {
    const id = nativeText(data.id), toolName = nativeText(data.toolName);
    if (!id || this.interactions.has(id) || this.settledInteractions.has(id)) return;
    if (!toolName || !isRecord(data.input)) {
      this.settledInteractions.add(id);
      try { await this.call('interaction.reply', { id, result: { behavior: 'deny', message: 'Malformed native interaction request.' } }); }
      catch (error) { if (!this.closing) this.report(error); }
      return;
    }
    const controller = new AbortController();
    this.interactions.set(id, controller);
    try {
      if (toolName === 'Read' && typeof data.input.file_path === 'string') {
        await this.pendingAttachment;
        if (controller.signal.aborted || this.closing) return;
        this.attachmentSender?.verifyPdfRead(data.input.file_path);
        this.attachmentResources?.verifyRead?.(data.input.file_path);
      }
      const result = await this.options.broker.canUseTool(toolName, data.input, {
        signal: controller.signal,
        requestId: id,
        toolUseID: nativeText(data.toolUseId) ?? id,
        ...(Array.isArray(data.suggestions) ? { suggestions: data.suggestions as PermissionUpdate[] } : {}),
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        ...(typeof data.description === 'string' ? { description: data.description } : {}),
        ...(data.defaultToNo === true ? { defaultToNo: true } : {}),
        ...(data.suppressAlwaysAllowRule === true ? { suppressAlwaysAllowRule: true } : {}),
      });
      if (!this.closing && !controller.signal.aborted) await this.call('interaction.reply', { id, result });
    } catch (error) {
      if (!this.closing && !controller.signal.aborted) {
        this.report(error);
        await this.call('interaction.reply', { id, result: { behavior: 'deny', message: 'The native tool request could not be verified.' } }).catch(() => undefined);
      }
    }
    finally {
      this.settledInteractions.add(id);
      if (this.interactions.get(id) === controller) this.interactions.delete(id);
      this.sendQueue?.refresh();
    }
  }

  private async discover(): Promise<void> {
    await this.refreshFast().catch((error: unknown) => this.report(error));
    if (this.capabilities.has('command.list')) await this.refreshCommands();
    if (this.capabilities.has('session.taskHistory')) {
      this.workflows?.rehydrate(await this.call('session.taskHistory', {}));
      this.publishTasks();
    }
    await this.refreshTools();
    if (this.capabilities.has('session.usage')) this.refreshContext();
    if (this.capabilities.has('agent.list')) await this.refreshTasks();
    // Only a typed status read here: the dialog readers would hold the user's first message and commands.
    // Connectors reads the dialog when the user opens it.
    if (this.capabilities.has('mcp.status') && !this.mcpControls) await this.mcpStatus();
  }
  private async refreshCommands(): Promise<void> {
    const value = await this.call('command.list', {});
    if (!Array.isArray(value)) throw new Error('Native command.list returned no list.');
    this.commands = value.flatMap((row) => isRecord(row) && typeof row.name === 'string' && typeof row.description === 'string'
      ? [{ name: row.name.replace(/^\//, ''), description: row.description,
        ...(typeof row.argumentHint === 'string' ? { argumentHint: row.argumentHint } : {}) }] : []);
    this.emit({ type: 'commands', handleId: this.options.handleId, commands: this.commands });
  }
  /** A slash command or a dialog the user operated may have changed what the footer shows; read it back. */
  private async refreshAfterCommand(): Promise<void> {
    if (this.closing) return;
    try {
      await this.composerShown();
      if (this.closing) return;
      this.readFooter();
      if (this.capabilities.has('session.model')) {
        const model = nativeText(await this.call('session.model', {}));
        if (model?.trim()) this.model = model;
      }
      if (this.capabilities.has('command.list')) await this.refreshCommands();
      await this.refreshFast();
      await this.refreshTools();
    } catch (error) { this.report(error); }
  }
  /** Effort chip and permission mode as the CLI's idle footer draws them; left alone when not recognizable. */
  private readFooter(): void {
    if (!nativeComposerIdle(this.screen)) return;
    this.effort = nativeEffortChip(this.screen.lineTexts()) ?? this.effort;
    const mode = nativePermissionMode({ sessionId: this.sessionId ?? '', cliSha256: '', revision: this.screen.revision, text: this.screen.text() });
    if (mode) this.permissionMode = mode;
  }
  private async composerShown(): Promise<void> {
    const deadline = Date.now() + COMPOSER_WAIT_MS;
    while (!this.closing && !nativeComposerIdle(this.screen) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  private async refreshTools(): Promise<void> {
    if (this.capabilities.has('tool.list')) {
      const value = await this.call('tool.list', {});
      this.tools = Array.isArray(value) ? value.flatMap((row) => isRecord(row) && typeof row.name === 'string' ? [row.name] : []) : [];
    }
    this.emitInit();
  }
  private async refreshFast(): Promise<void> {
    if (!this.capabilities.has('config.list')) return;
    this.nativeFast = nativeFastControl(await this.call('config.list', {}));
    this.emitInit();
  }
  private async refreshTasks(): Promise<void> {
    this.agentTasks = nativeAgents(await this.call('agent.list', {}));
    await this.refreshWorkflowFiles();
    this.publishTasks();
  }
  private async refreshWorkflowFiles(activeOnly = false): Promise<void> {
    if (this.closing || !this.workflows || !this.options.workflowFiles) return;
    this.lastWorkflowReadAt = this.now();
    const active = activeOnly ? new Set(this.workflows.snapshot().tasks.filter(task => task.kind === 'workflow' &&
      ['pending', 'running', 'paused', 'unknown'].includes(task.status)).map(task => task.taskId)) : undefined;
    if (active?.size === 0) return;
    this.workflowRefresh ??= this.options.workflowFiles.refresh(this.workflows, active).then((changed) => {
      if (changed && !this.closing) this.publishTasks();
    }).finally(() => { this.workflowRefresh = undefined; });
    return this.workflowRefresh;
  }
  private publishTasks(): void {
    this.emit({ type: 'tasks', handleId: this.options.handleId,
      tasks: this.workflows?.mergeTasks(this.agentTasks) ?? this.agentTasks });
  }
  private refreshContext(): void {
    if (this.closing) return;
    void this.contextUsage('summary').catch((error: unknown) => this.report(error));
  }
  private receiveTerminal(data: string): void {
    if (this.closing) return;
    this.screen.write(data);
    if (!this.ready && this.startupScreen && !this.startupFinished) {
      this.startupScreen.write(data.slice(-512 * 1024));
      if (isSignInScreen(this.startupScreen.lineTexts(), this.startupScreen.columns)) { this.blockSignIn(); return; }
      const key = this.startupKey;
      if (key?.written) { key.outputAt = performance.now(); this.checkStartupKey(key); }
      this.startupFailureReason = startupTimeoutReason(this.startupScreen.text());
      if (this.options.request.startupRequestId && !this.startupTimer) this.startupTimer = setTimeout(() => {
        this.startupTimer = undefined; this.publishStartup();
      }, 30);
    }
    this.panelHost?.observe();
    if (!this.ui) return;
    this.ui.observeTerminal(); this.quotaControls?.observe();
    if (this.workflows?.workflowSources().length && this.now() - this.lastWorkflowReadAt >= 100) {
      void this.refreshWorkflowFiles(true).catch((error: unknown) => this.report(error));
    }
  }
  private publishStartup(): void {
    if (this.startupFinished || !this.startupScreen || !this.options.request.startupRequestId) return;
    const text = redactSecrets(this.startupScreen.text()).slice(0, 32 * 1024);
    if (text === this.startupText) return;
    this.startupText = text; this.startupRevision++;
    this.emitStartup('waiting', text);
  }
  private emitStartup(phase: 'waiting' | 'ready' | 'closed', text: string): void {
    const requestId = this.options.request.startupRequestId;
    if (requestId) this.emit({ type: 'startup', handleId: this.options.handleId, requestId,
      revision: this.startupRevision, text, phase });
  }
  private finishStartup(phase: 'ready' | 'closed'): void {
    if (this.startupFinished) return;
    this.startupFinished = true;
    this.settleStartupKey(phase === 'ready' ? undefined
      : new Error(this.signInBlocked ? SIGN_IN_REQUIRED : 'Native startup input is no longer available.'));
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.startupScreen = undefined; this.startupText = '';
    this.startupRevision++;
    this.emitStartup(phase, '');
  }
  /** Ends the wait for the CLI's answer to a startup key; with an error, the key's call fails with it. */
  private settleStartupKey(error?: unknown, key = this.startupKey): void {
    if (!key || this.startupKey !== key) return;
    this.startupKey = undefined;
    clearTimeout(key.timer);
    if (error === undefined) key.resolve(); else key.reject(error);
  }
  /** Settles a written startup key once the CLI has answered it (STARTUP_KEY_SETTLE_MS), else looks again when it may have. */
  private checkStartupKey(key: PendingStartupKey): void {
    if (this.startupKey !== key) return;
    clearTimeout(key.timer);
    const now = performance.now();
    const quiet = now - key.outputAt >= STARTUP_KEY_SETTLE_MS, capped = now - key.writtenAt >= STARTUP_KEY_CAP_MS;
    if (quiet || capped) {
      // The window gets the screen that answered the key before its keys re-arm.
      this.publishStartup();
      if (capped || this.startupText !== key.baseline || now - key.writtenAt >= STARTUP_KEY_QUIET_MS) {
        this.settleStartupKey(undefined, key);
        return;
      }
    }
    const next = quiet ? key.writtenAt + STARTUP_KEY_QUIET_MS : key.outputAt + STARTUP_KEY_SETTLE_MS;
    key.timer = setTimeout(() => this.checkStartupKey(key), Math.min(next, key.writtenAt + STARTUP_KEY_CAP_MS) - now);
  }
  /**
   * Nothing more of the CLI's own sign-in is shown or answered: the session closes (which also takes a mirrored panel
   * down) and reports SIGN_IN_REQUIRED. Every write to the startup screen and every panel the mirror publishes is checked.
   */
  private blockSignIn(): void {
    if (this.signInBlocked) return;
    this.signInBlocked = true;
    if (this.ready) this.report(new Error(SIGN_IN_REQUIRED), true);
    void this.close().catch((error: unknown) => {
      this.options.emit({ type: 'error', handleId: this.options.handleId, fatal: true,
        message: redactSecrets(error instanceof Error ? error.message : String(error)) });
    });
  }
  /** The docked dialog on screen is the CLI's sign-in. */
  private signInPanelShown(): boolean {
    const region = detectNativePanel(this.screen);
    return region !== undefined && isSignInScreen(this.screen.lineTexts().slice(region.firstRow, region.lastRow + 1), this.screen.columns);
  }
  private configureControls(): void {
    this.sendQueue = new NativeSendQueue({ sessionId: this.sessionId!, capabilities: [...this.capabilities],
      newId: this.options.newId ?? randomUUID,
      port: { request: (method, args, options) => this.call(method, args, options) },
      isBlocked: () => Boolean(this.pendingCommand) || this.controlsActive || this.composerBusy || this.interactions.size > 0 && !this.activeTurn,
      onDispatch: (id, text) => this.mapper.registerSend(id, text),
      onDeliveryError: (id, error) => {
        const queued = this.queuedEchoes.get(id);
        this.queuedEchoes.delete(id);
        if (queued && !this.closing) {
          this.emit({ type: 'item', handleId: this.options.handleId,
            item: { ...queued, queued: undefined, deliveryUnconfirmed: true } });
          this.report(new Error(`Queued native send ${id} was not delivered: ${error.message}`));
        }
      },
    });
    if (this.options.controls && ['ui.command', 'session.model', 'env.effort'].every((capability) => this.capabilities.has(capability))) {
      this.ui = new NativeUiController({ sessionId: this.sessionId!, cliSha256: this.options.controls.cliSha256,
        admittedBuilds: this.options.controls.admittedBuilds,
        port: { request: (method, args, options) => {
          if (method !== 'command.run') throw new NativeCapabilityError(method, 'the native UI port only dispatches bounded native commands.');
          if (isRecord(args) && args.command === 'config') return this.call('config.open', {}, options);
          return this.call('ui.command', args, options);
        } }, writeTerminal: (data) => this.runtime.writeTerminal(data),
        isIdle: () => !this.pendingCommand && this.state === 'idle' && !this.composerBusy && !this.activeTurn && !this.interactions.size && !this.options.broker.pendingCount && this.sendQueue?.snapshot().phase !== 'awaiting-start',
        columns: this.options.launch.cols, rows: this.options.launch.rows, screen: this.screen,
        ...(this.capabilities.has('bridge.diagnostics') ? { readDiagnostics: () => this.call('bridge.diagnostics', {}, { timeoutMs: 450 }) } : {}),
        // Queued messages stay queued: the queue holds while the quarantine lasts and sends them once it ends.
        onControlFailure: (error) => {
          if (!this.closing && this.ui?.recoveryError()?.operation === 'mcp.status.dialog') {
            const diagnostic = error instanceof NativeControlGate && ['mcp.status.dialog', 'mcp.dialog'].includes(error.operation)
              ? error : new NativeControlGate('mcp.status.dialog', 'Native MCP status command failed; safe diagnostic metadata is unavailable.');
            this.report(diagnostic);
          }
        },
        // A dialog the failed control left is mirrored as soon as Relay stops driving it.
        onSettled: () => this.panelHost?.refresh(),
        onRecovered: () => { this.panelHost?.refresh(); void this.refreshAfterCommand(); },
        onActiveChange: (active) => { this.controlsActive = active; if (!active) this.sendQueue?.refresh(); },
      });
      this.quotaControls = new NativeQuotaControls({ ui: this.ui, turnEpoch: () => this.mainTurnEpoch,
        admittedBuilds: this.options.controls.admittedBuilds,
        onState: (state) => this.emit({ type: 'autoContinue', handleId: this.options.handleId, state }) });
      this.quotaControls.observe();
      this.sessionSettings = new NativeSessionSettings({ ui: this.ui,
        preferenceFingerprint: () => this.options.controls!.preferenceFingerprint(),
        readModel: async () => {
          const actual = await this.call('session.model', {});
          if (typeof actual !== 'string' || !actual.trim()) throw new Error('Native session.model returned no model.');
          return actual;
        }, readEffortEnvironment: async () => {
          const actual = await this.call('env.effort', {});
          if (actual !== null && actual !== undefined && typeof actual !== 'string') throw new Error('Native effort environment returned invalid data.');
          return actual ?? undefined;
        },
      });
      this.mcpDialogs = new NativeMcpDialogControls(this.ui);
      if (this.options.controls.assertPreferenceScope) {
        this.nativeSettings = new NativeSettings({ port: { request: (method, args, options) => this.call(method, args, options, true) },
          hasCapability: (capability) => this.capabilities.has(capability), assertPreferenceScope: this.options.controls.assertPreferenceScope,
          ui: this.ui,
          permission: { ui: this.ui, preferenceFingerprint: this.options.controls.preferenceFingerprint,
            assertCycleBinding: this.options.controls.assertCycleBinding },
          ultracode: { ui: this.ui, readModel: async () => {
            const value = await this.call('session.model', {});
            if (typeof value !== 'string') throw new Error('Native model is unavailable.');
            return value;
          }, preferenceFingerprint: this.options.controls.preferenceFingerprint },
        });
      }
      if (!this.mcpControls && this.options.controls.assertPreferenceScope && this.capabilities.has('mcp.nativeAction')) {
        this.mcpControls = createNativePersistentMcpControls({
          runtime: { request: (method, args, options) => this.call(method, args, options) },
          serverNames: () => Object.keys(this.options.mcpServers ?? {}),
          assertPreferenceScope: this.options.controls.assertPreferenceScope, ui: this.ui,
        });
      }
    }
  }
  /** Mirrors the dialog of the user's slash command, or one a failed control left, for the user to operate. */
  private configurePanel(): void {
    this.panelHost = new NativePanelHost({ screen: this.screen,
      publish: (panel) => {
        if (panel && isSignInScreen(panel.rows.map((row) => row.runs.map((run) => run.text).join('')), panel.columns)) {
          this.blockSignIn();
          return;
        }
        this.emit({ type: 'panel', handleId: this.options.handleId, panel });
      },
      // Also a screen that turned into the sign-in after the mirror last showed it takes no input.
      writeTerminal: (data) => {
        if (this.signInBlocked || this.signInPanelShown()) {
          this.blockSignIn();
          return Promise.reject(new Error(SIGN_IN_REQUIRED));
        }
        return this.runtime.writeTerminal(data);
      },
      pendingCommand: () => this.pendingCommand?.name,
      recovering: () => Boolean(this.ui?.recoveryError()),
      driving: () => this.ui?.driving() ?? false,
    });
  }
  private async configureAttachments(): Promise<void> {
    if (!this.options.attachments) return;
    for (const method of ['prompt.read', 'prompt.fill', 'attachment.arm', 'attachment.status', 'attachment.disarm']) this.requireCapability(method);
    const resources = await this.options.attachments(this.sessionId!);
    this.attachmentResources = resources;
    const composer: NativeAttachmentComposer = {
      read: (signal) => this.call('prompt.read', {}, { signal }) as ReturnType<NativeAttachmentComposer['read']>,
      replace: (text, signal) => this.call('prompt.fill', { text }, { signal }) as ReturnType<NativeAttachmentComposer['replace']>,
      arm: (input, signal) => this.call('attachment.arm', input, { signal }) as ReturnType<NativeAttachmentComposer['arm']>,
      status: (id, signal) => this.call('attachment.status', { id }, { signal }) as ReturnType<NativeAttachmentComposer['status']>,
      disarm: async (id) => { await this.call('attachment.disarm', { id }); },
    };
    let sequence = 0;
    this.attachmentSender = createNativeAttachmentAdapter({ storage: resources.storage, pdfTools: resources.pdfTools,
      runtime: { writeTerminal: (data) => this.runtime.writeTerminal(data), close: () => this.runtime.close(),
        onEvent: (listener) => this.runtime.onEvent((event) => {
          if (event.sessionId !== this.sessionId || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence) return;
          sequence = event.sequence; listener(event);
        }) }, composer,
      isBusy: () => Boolean(this.activeTurn) || this.state === 'running' || this.state === 'awaiting',
      // The shared queue dispatches only after the previous main turn has completed.
      waitForIdle: async () => { throw new Error('Native attachment delivery must be owned by the shared send queue.'); },
      onPrepared: ({ nativeText }) => {
        const send = this.preparedSend;
        if (!send) throw new Error('Native attachment send ownership is unavailable.');
        const images = send.files.filter((file) => file.kind === 'image').length;
        const refs = images ? (this.options.storeImages ?? storeImageBlocks)(promptContent('', send.files), `${this.sessionId}:${send.id}`) : [];
        this.mapper.prepareAttachments(send.id, nativeText, images, refs);
      }, onAccepted: resources.onAccepted,
      // The CLI already has the message; keeping a copy of its files failed, which the user should know.
      onWarning: (error) => this.report(error),
    });
  }
  private dialogMcpName(): string {
    this.requireOpen();
    const names = Object.keys(this.options.mcpServers ?? {});
    if (names.length !== 1 || !/^[A-Za-z0-9_.:-]{1,120}$/.test(names[0])) throw new NativeCapabilityError('mcp.status.dialog', 'the dialog adapter requires one known literal configured server and a verified selected row.');
    return names[0];
  }
  private emitInit(): void {
    if (!this.sessionId || this.closing) return;
    this.emit({ type: 'init', handleId: this.options.handleId, sessionId: this.sessionId, model: this.model,
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.nativeFast ? { nativeFast: this.nativeFast } : {}),
      slashCommands: this.commands.map((command) => command.name), tools: this.tools, cwd: this.handle.cwd });
  }
  /** A renderer that lost this live handle (a reload) adopts it again: send what it would otherwise never see. */
  republish(): void {
    if (!this.ready || this.closing || this.didClose) return;
    this.emitInit();
    if (this.commands.length) this.emit({ type: 'commands', handleId: this.options.handleId, commands: this.commands });
    this.publishTasks();
    for (const event of this.lastEvents.values()) this.emit(event);
    const panel = this.panelHost?.panel;
    if (panel) this.emit({ type: 'panel', handleId: this.options.handleId, panel });
    this.setState(this.state);
    this.options.broker.republish?.();
  }
  private setState(state: EngineState): void {
    this.state = state;
    this.options.emit({ type: 'state', handleId: this.options.handleId, state,
      ...(this.outputTokens !== undefined ? { tokens: this.outputTokens } : {}),
      ...(state === 'running' || state === 'awaiting' ? { startedAt: this.startedAt } : {}) });
  }
  private emit(event: EngineEvent): void {
    if (this.didClose) return;
    if (event.type === 'mcp' || event.type === 'context' || event.type === 'autoContinue') this.lastEvents.set(event.type, event);
    this.options.emit(event);
  }
  private report(error: unknown, fatal = false): void {
    if (this.closing || this.didClose) return;
    if (error instanceof NativeCapabilityError) {
      if (this.gates.has(error.capability)) return;
      this.gates.add(error.capability);
    }
    this.emit({ type: 'error', handleId: this.options.handleId,
      message: redactSecrets(error instanceof Error ? error.message : String(error)), fatal });
  }
  private requireOpen(): void {
    if (!this.ready || this.closing || this.didClose) throw new Error('This native session is closed or not ready.');
  }
  private requireCapability(capability: string, detail?: string): void {
    this.requireOpen();
    if (!this.capabilities.has(capability)) throw new NativeCapabilityError(capability, detail);
  }
  private async call(method: string, args: unknown, options?: NativeRequestOptions, preserveDenial = false): Promise<unknown> {
    this.requireCapability(method);
    const signal = options?.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    const result = await this.runtime.request(method, args, { ...options, signal });
    if (!preserveDenial && isRecord(result)) {
      const denial = nativeText(result.deny) ?? nativeText(result.drop) ?? nativeText(result.skip);
      if (denial) throw new Error(redactSecrets(denial));
    }
    return result;
  }
  private boolean(value: boolean): boolean {
    if (typeof value !== 'boolean') throw new Error('Invalid boolean setting.');
    return value;
  }
}
