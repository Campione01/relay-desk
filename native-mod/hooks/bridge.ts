import type { EngineInterface, HookStream, PermissionRequestDecision, ProcessSpawnChunk, ProcessSpawnResult, PromptSubmitInput, PromptSubmitResult, Timer } from 'claude-code';
import { ATTACHMENT_TIMEOUT_MS, createAttachmentGuard } from './attachmentGuard';
import { PROTOCOL_VERSION, type BridgeOutput, type BridgeReply, type BridgeRequest } from './protocol';
import type { BridgeTransport } from './transport';

export const MAX_PENDING_INTERACTIONS = 32;
export const MAX_ACTIVE_REQUESTS = 128;
export const MAX_REMEMBERED_REQUESTS = 256;
export const MAX_REMEMBERED_BYTES = 4 * 1024 * 1024;
export const MAX_DIAGNOSTIC_ENTRIES = 16;

export const CAPABILITIES = [
  'prompt.submit', 'turn.abort', 'session.usage', 'session.messages', 'session.compact',
  'session.model', 'config.list', 'command.list', 'command.run', 'tool.list', 'tool.call',
  'agent.list', 'interaction.reply', 'turn.step', 'turn.complete', 'session.append',
  'interaction.request',
  'ui.command', 'env.effort',
  'prompt.read', 'prompt.fill', 'attachment.arm', 'attachment.status', 'attachment.disarm',
  'agent.spawn', 'task.notification', 'classic.Stop', 'session.measure',
  'session.taskHistory', 'task.append', 'bridge.diagnostics',
] as const;
export const PERSISTENT_CAPABILITIES = ['config.persist:workflows', 'workflow.set', 'mcp.nativeAction',
  'ultracode.set', 'fast.set', 'autoContinue.set', 'config.open'] as const;
type Capability = typeof CAPABILITIES[number] | typeof PERSISTENT_CAPABILITIES[number];

/** Reads start at once instead of waiting on commandTail, but still count toward MAX_ACTIVE_REQUESTS. */
export const CONCURRENT_METHODS = new Set<string>(['session.usage', 'session.messages', 'session.taskHistory', 'session.model',
  'config.list', 'env.effort', 'command.list', 'tool.list', 'agent.list'] satisfies Capability[]);
const PRIORITY_METHODS = new Set<string>(['bridge.diagnostics', 'interaction.reply', 'turn.abort', 'attachment.status',
  'attachment.disarm'] satisfies Capability[]);
function concurrentRequest(request: BridgeRequest): boolean {
  if (CONCURRENT_METHODS.has(request.method)) return true;
  const args = request.args && typeof request.args === 'object' ? request.args as Record<string, unknown> : undefined;
  return request.method === 'tool.call' && args?.tool === 'TaskStop';
}

const DIAGNOSTIC_METHODS = new Set<string>([
  'bridge.diagnostics', 'interaction.reply', 'prompt.submit', 'prompt.read', 'prompt.fill',
  'attachment.arm', 'attachment.status', 'attachment.disarm', 'turn.abort', 'session.usage',
  'session.messages', 'session.taskHistory', 'session.compact', 'session.model', 'config.list',
  'env.effort', 'ui.command', 'workflow.set', 'config.open', 'fast.set', 'autoContinue.set',
  'ultracode.set', 'mcp.nativeAction', 'command.list', 'command.run', 'tool.list', 'tool.call', 'agent.list',
] satisfies ReadonlyArray<typeof CAPABILITIES[number] | typeof PERSISTENT_CAPABILITIES[number]>);
const DIAGNOSTIC_COMMANDS = ['effort', 'model', 'mcp', 'plan', 'rate-limit-options'] as const;
type DiagnosticCommand = typeof DIAGNOSTIC_COMMANDS[number];

export interface NativeBridgeDiagnosticEntry {
  method: string;
  command?: DiagnosticCommand;
  state: 'queued' | 'running';
  queuedMs: number;
  runMs?: number;
}
export interface NativeBridgeDiagnostics {
  version: 1;
  modalActive: boolean;
  runningTurn: boolean;
  activeCount: number;
  queuedCount: number;
  entries: NativeBridgeDiagnosticEntry[];
  truncated: boolean;
}
interface ActiveDiagnostic {
  method: string;
  command?: DiagnosticCommand;
  state: 'queued' | 'running';
  queuedAt: number;
  runAt?: number;
}
interface ActiveRequest { promise: Promise<BridgeReply>; diagnostic?: ActiveDiagnostic }

function diagnosticMetadata(request: BridgeRequest): ActiveDiagnostic {
  const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args)
    ? request.args as Record<string, unknown> : undefined;
  const value = request.method === 'ui.command' ? args?.command : undefined;
  const command = typeof value === 'string' && DIAGNOSTIC_COMMANDS.some((label) => label === value)
    ? value as DiagnosticCommand : undefined;
  return { method: DIAGNOSTIC_METHODS.has(request.method) ? request.method : 'other',
    ...(command ? { command } : {}), state: 'queued', queuedAt: Date.now() };
}

/** CLI 2.1.308 aliases of the guarded commands; src/renderer/lib/slash.ts keeps its own copy. */
export const COMMAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  clear: ['reset', 'new'],
  resume: ['continue'],
  exit: ['quit'],
  background: ['bg'],
  'remote-control': ['rc'],
  teleport: ['tp'],
};
/** A copy of SIGN_IN_COMMANDS and ACCOUNT_COMMANDS in src/shared/signIn.ts, which the plugin ships without. */
export const SIGN_IN_COMMANDS: readonly string[] = ['login', 'logout', 'design-login', 'upgrade', 'remote-control', 'teleport',
  'usage-credits', 'extra-usage', 'rate-limit-options', 'pro-trial-expired', 'install-github-app', 'setup-bedrock'];
export const ACCOUNT_COMMANDS: readonly string[] = ['login', 'logout', 'design-login'];
/** Commands that break Relay's session model, with their aliases: Relay handles them itself or treats them as terminal-only. */
export const GUARDED_COMMANDS = new Set([
  'login', 'logout', 'clear', 'resume', 'fork', 'branch', 'exit', 'upgrade',
  'migrate-installer', 'tui', 'focus', 'background', 'cd', 'terminal-setup', 'remote-control', ...SIGN_IN_COMMANDS,
].flatMap((name) => [name, ...(COMMAND_ALIASES[name] ?? [])]));
/** The CLI runs a command of the exact typed name before an alias, so a user's own /continue is not /resume. */
const GUARDED_ALIASES = new Set(Object.values(COMMAND_ALIASES).flat());
const SIGN_IN_NAMES = new Set(SIGN_IN_COMMANDS.flatMap((name) => [name, ...(COMMAND_ALIASES[name] ?? [])]));
/** Why command.run refuses a guarded command; the sign-in wording is signInCommandRefusal's in src/shared/signIn.ts. */
export function commandRefusal(name: string): string {
  return SIGN_IN_NAMES.has(name) && !ACCOUNT_COMMANDS.includes(name)
    ? `Relay Desk does not run Claude Code's own sign-in inside a session. Run /${name} in a terminal.`
    : `/${name} is handled by Relay, not the native CLI.`;
}
export const COMMAND_BUSY_MESSAGE = 'Another slash command is still running in the native CLI.';

type HoldStream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
interface PendingInteraction {
  resolve(result: PermissionRequestDecision): void;
  signal?: AbortSignal;
  abort(): void;
  hold?: HoldStream;
}

export interface InteractionInput {
  kind: 'permission' | 'question';
  toolName: string;
  input: unknown;
  toolUseId?: string;
  suggestions?: unknown;
}

export interface NativeBridge {
  start(isInteractive: boolean, surface: string | null): Promise<void>;
  receive(request: BridgeRequest): Promise<void>;
  emit(event: string, data: unknown): void;
  interact(input: InteractionInput, signal?: AbortSignal): Promise<PermissionRequestDecision>;
  cancelInteractions(reason: string): void;
  setTurn(turnId?: string): void;
  close(reason: string): void;
  rebind(): Promise<void>;
  promptBlockReason(): Promise<string | undefined>;
  checkAttachmentPrompt(event: PromptSubmitInput, blockedReason?: string): { reason?: string; transactionId?: string };
  completeAttachmentPrompt(id: string, result: PromptSubmitResult): void;
  rejectAttachmentPrompt(id: string): void;
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an argument object');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Expected ${name}`);
  return value;
}

function denial(message: string): PermissionRequestDecision {
  return { behavior: 'deny', message };
}

const TASK_TOOLS = new Set(['Workflow', 'Bash', 'Monitor', 'Agent', 'TaskStop']);
const TASK_INPUT_FIELDS = new Set(['description', 'command', 'subagent_type', 'task_id']);
const TASK_RESULT_FIELDS = new Set(['status', 'taskId', 'taskType', 'runId', 'workflowName', 'summary', 'transcriptDir', 'scriptPath', 'error', 'backgroundTaskId', 'rawOutputPath', 'persistedOutputPath', 'timeoutMs', 'agentId', 'description', 'outputFile', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'task_id', 'task_type', 'message', 'command']);
function taskFields(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => fields.has(key) && (item === null || ['string', 'number', 'boolean'].includes(typeof item))));
}
/** Native summary projection, not a full conversation or tool-output export. */
export function nativeTaskHistory(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  type TaskUse = { tool: string; tool_use_id: string; input?: unknown; result?: unknown; isError?: boolean; agentId?: string; durationMs?: number };
  type TaskResult = { tool_use_id: string; result?: unknown; isError?: boolean };
  const rows = value as Array<{ role: unknown; toolUses?: TaskUse[]; toolResults?: TaskResult[] }>;
  const ids = new Set<string>();
  for (const row of rows) for (const use of row?.toolUses ?? []) if (TASK_TOOLS.has(use.tool) && typeof use.tool_use_id === 'string') ids.add(use.tool_use_id);
  return rows.map(row => ({ role: row.role,
    ...(Array.isArray(row.toolUses) ? { toolUses: row.toolUses.filter(use => TASK_TOOLS.has(use.tool)).map(use => ({ tool: use.tool, tool_use_id: use.tool_use_id,
      input: taskFields(use.input, TASK_INPUT_FIELDS), result: taskFields(use.result, TASK_RESULT_FIELDS), ...(typeof use.isError === 'boolean' ? { isError: use.isError } : {}),
      ...(typeof use.agentId === 'string' ? { agentId: use.agentId } : {}), ...(typeof use.durationMs === 'number' ? { durationMs: use.durationMs } : {}),
    })) } : {}),
    ...(Array.isArray(row.toolResults) ? { toolResults: row.toolResults.filter(result => ids.has(result.tool_use_id)).map(result => ({ tool_use_id: result.tool_use_id,
      result: taskFields(result.result, TASK_RESULT_FIELDS), ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
    })) } : {}),
  }));
}

function replyDecision(value: unknown): PermissionRequestDecision {
  const result = object(value);
  if (result.behavior === 'deny') return denial(typeof result.message === 'string' ? result.message : 'Denied by user');
  if (result.behavior !== 'allow') throw new Error('Invalid permission behavior');
  if (result.updatedPermissions !== undefined) {
    // Persisted permission updates are outside this isolated prototype's write boundary.
    const updates = result.updatedPermissions;
    if (!Array.isArray(updates) || updates.some((entry) => object(entry).destination !== 'session')) {
      throw new Error('Only session-scoped permission updates are supported');
    }
  }
  const decision: PermissionRequestDecision = { behavior: 'allow' };
  if (result.updatedInput !== undefined) decision.updatedInput = object(result.updatedInput);
  if (result.updatedPermissions !== undefined) {
    decision.updatedPermissions = result.updatedPermissions as NonNullable<Extract<PermissionRequestDecision, { behavior: 'allow' }>['updatedPermissions']>;
  }
  return decision;
}

export function createNativeBridge($: EngineInterface, transport: BridgeTransport): NativeBridge {
  const pending = new Map<string, PendingInteraction>();
  const active = new Map<string, ActiveRequest>();
  const remembered = new Map<string, BridgeReply>();
  const rememberedSizes = new Map<string, number>();
  let rememberedBytes = 0;
  let sessionId = '';
  let sequence = 0;
  let interactionNumber = 0;
  let runningTurn: string | undefined;
  let closed = false;
  let epoch = 0;
  let commandTail: Promise<unknown> = Promise.resolve();
  let ephemeral = false;
  let modalActive = false;
  let commandRun: string | undefined;
  let advertised = new Set<string>();
  let holdArgv: readonly string[] | undefined;
  const attachments = createAttachmentGuard();
  let attachmentTimer: Timer | undefined;

  function diagnostics(): NativeBridgeDiagnostics {
    const now = Date.now();
    // The inspector itself has no metadata: snapshots describe outstanding work only.
    const tracked = [...active.values()].flatMap((entry) => entry.diagnostic ? [entry.diagnostic] : []);
    return { version: 1, modalActive, runningTurn: runningTurn !== undefined,
      activeCount: tracked.length, queuedCount: tracked.filter((entry) => entry.state === 'queued').length,
      entries: tracked.slice(0, MAX_DIAGNOSTIC_ENTRIES).map((entry) => ({ method: entry.method,
        ...(entry.command ? { command: entry.command } : {}), state: entry.state,
        queuedMs: Math.max(0, (entry.runAt ?? now) - entry.queuedAt),
        ...(entry.runAt !== undefined ? { runMs: Math.max(0, now - entry.runAt) } : {}) })),
      truncated: tracked.length > MAX_DIAGNOSTIC_ENTRIES };
  }

  function persistentIdle(allowRunning = false): void {
    if (closed || modalActive || (!allowRunning && runningTurn) || pending.size || attachments.isArmed()) {
      throw new Error('Native persistent control requires an idle session without a modal, pending approval or attachments');
    }
  }
  async function persistentControl<T>(action: (checkIdle: () => void) => Promise<T>, allowRunning = false): Promise<T> {
    persistentIdle(allowRunning);
    if (await $.env.get('RELAY_NATIVE_PERSISTENT_CONTROLS') !== '1') throw new Error('Native persistent controls were not explicitly enabled for this process');
    persistentIdle(allowRunning);
    modalActive = true;
    const currentEpoch = epoch;
    const checkIdle = () => {
      if (closed || currentEpoch !== epoch || (!allowRunning && runningTurn) || pending.size || attachments.isArmed()) throw new Error('Native persistent control lost session ownership');
    };
    try { return await action(checkIdle); }
    finally { modalActive = false; }
  }
  async function writeNativeBoolean(key: 'workflows' | 'fast' | 'autoContinueAtUsageLimit', enabled: boolean) {
    const label = key === 'workflows' ? 'Workflows' : key === 'fast' ? 'Fast mode' : 'Automatic continuation';
    return persistentControl(async (checkIdle) => {
      const row = (await $.config.list()).find((entry) => entry.key === key);
      if (!row || row.kind !== 'boolean' || typeof row.value !== 'boolean' || row.provider.plugin !== 'engine' || row.provider.tier !== 'core') throw new Error(`The native ${label} preference is not available in this session`);
      if (row.isLocked) throw new Error(`The native ${label} preference is locked by policy`);
      checkIdle();
      const result = await $.config.set({ key, value: enabled });
      if (result.deny !== undefined) return { deny: result.deny };
      checkIdle();
      let observed = (await $.config.list()).find((entry) => entry.key === key);
      for (let attempt = 0; observed?.value !== enabled && attempt < 20; attempt++) {
        await new Promise<void>((resolve) => { $.clock.after(100, resolve); });
        checkIdle(); observed = (await $.config.list()).find((entry) => entry.key === key);
      }
      if (typeof result.value !== 'boolean' || !observed || observed.kind !== 'boolean' || observed.value !== enabled || observed.provider.plugin !== 'engine' || observed.provider.tier !== 'core') {
        throw new Error(`Native ${label} preference write was not confirmed by the native row (native=${String(result.value)}, observed=${String(observed?.value)}, kind=${String(observed?.kind)})`);
      }
      return { key, enabled, scope: 'native-user', nativeValue: result.value };
    }, true);
  }

  /** A command the CLI lists under exactly this name, as its exact-name lookup compares; none when the list cannot be read. */
  async function listedExactly(name: string): Promise<boolean> {
    try { return (await $.command.list()).some((entry) => entry.name === name); }
    catch { return false; }
  }

  /** Refuses a guarded command as the CLI resolves the typed name: a listed command of exactly that name runs first. */
  async function refuseGuarded(typed: string): Promise<void> {
    const name = typed.toLowerCase();
    if (GUARDED_COMMANDS.has(name) && !(GUARDED_ALIASES.has(name) && await listedExactly(typed))) throw new Error(commandRefusal(name));
  }

  function clearAttachmentTimer(): void { attachmentTimer?.cancel(); attachmentTimer = undefined; }
  function cancelAttachment(reason: string): void {
    clearAttachmentTimer();
    const status = attachments.cancelActive(reason);
    if (status) emit('attachment.checked', status);
  }
  async function composerBlockReason(): Promise<string | undefined> {
    if (modalActive) return 'A native control dialog owns the composer';
    return ephemeral && await $.env.get('CLAUDE_CODE_SKIP_PROMPT_HISTORY') !== '1'
      ? 'Native no-history protection is no longer active' : undefined;
  }

  function send(output: BridgeOutput): void {
    if (closed) return;
    try { transport.send(output); } catch { close('Relay native transport is unavailable'); }
  }

  function emit(event: string, data: unknown): void {
    send({ type: 'event', event, sessionId, sequence: ++sequence, data });
  }

  // A hook's budget stands still only while one of its own `$` calls is in flight (HookBudget), so the
  // waiting hook keeps an idle child open until the person decides; return() kills it.
  function holdOpen(): HoldStream | undefined {
    if (!holdArgv) return undefined;
    try {
      const hold = $.process.spawn({ argv: [...holdArgv, `RelayHold${interactionNumber}x${Math.random().toString(36).slice(2, 12)}`] });
      void hold.next().catch(() => undefined);
      return hold;
    } catch { return undefined; }
  }

  function settle(id: string, result: PermissionRequestDecision, canceled = false): void {
    const interaction = pending.get(id);
    if (!interaction) return;
    pending.delete(id);
    const hold = interaction.hold;
    if (hold) void Promise.resolve().then(() => hold.return({ code: null, signal: 'relay-settled' })).catch(() => undefined);
    interaction.signal?.removeEventListener('abort', interaction.abort);
    if (canceled) emit('interaction.cancel', { id });
    interaction.resolve(result);
  }

  function cancelInteractions(reason: string): void {
    for (const id of pending.keys()) settle(id, denial(reason), true);
  }

  function close(reason: string): void {
    if (closed) return;
    closed = true;
    active.clear();
    cancelAttachment(reason);
    cancelInteractions(reason);
    transport.close();
    if (runningTurn && advertised.has('turn.abort')) void $.turn.abort({ turnId: runningTurn }).catch(() => undefined);
  }

  async function rebind(): Promise<void> {
    const nextId = await $.session.id();
    if (nextId !== sessionId) {
      cancelInteractions('The native session changed');
      clearAttachmentTimer(); attachments.clear();
      epoch++;
      sessionId = nextId;
      sequence = 0;
      runningTurn = undefined;
      remembered.clear();
      rememberedSizes.clear();
      rememberedBytes = 0;
      active.clear();
    }
  }

  async function dispatch(request: BridgeRequest): Promise<unknown> {
    if (!advertised.has(request.method)) throw new Error('Unsupported native bridge method');
    const args = object(request.args);
    switch (request.method) {
      case 'bridge.diagnostics':
        if (Object.keys(args).length) throw new Error('Native bridge diagnostics takes no arguments');
        return diagnostics();
      case 'interaction.reply': {
        const id = text(args.id, 'interaction id');
        if (!pending.has(id)) throw new Error('Interaction is no longer pending');
        let decision: PermissionRequestDecision;
        try { decision = replyDecision(args.result); }
        catch (error) { settle(id, denial('Invalid interaction response')); throw error; }
        settle(id, decision);
        return { accepted: true };
      }
      case 'prompt.submit': {
        if (modalActive) throw new Error('A native control dialog owns the composer');
        if (attachments.isArmed()) throw new Error('A native attachment transaction owns the composer');
        if (ephemeral && await $.env.get('CLAUDE_CODE_SKIP_PROMPT_HISTORY') !== '1') throw new Error('Native no-history protection is no longer active');
        if (Object.keys(args).some((key) => key !== 'text' && key !== 'asUser')) {
          throw new Error('Prompt attachments and injected context are not supported by this prototype');
        }
        const prompt = text(args.text, 'prompt text');
        if (prompt.trim().startsWith('/')) await refuseGuarded(prompt.trim().slice(1).split(/\s+/, 1)[0]);
        return $.prompt.submit({ text: prompt, asUser: true });
      }
      case 'prompt.read': {
        if (Object.keys(args).length) throw new Error('Native prompt.read takes no arguments');
        const reason = await composerBlockReason(); if (reason) throw new Error(reason);
        return $.prompt.read();
      }
      case 'prompt.fill': {
        if (Object.keys(args).some((key) => key !== 'text')) throw new Error('Native prompt.fill takes only text');
        const reason = await composerBlockReason(); if (reason) throw new Error(reason);
        if (runningTurn || pending.size) throw new Error('Native attachment fill requires an idle session without pending approval');
        const id = attachments.activeId();
        const value = attachments.validateFill(args.text);
        const result = await $.prompt.fill({ text: value, mode: 'replace' });
        if (!id || attachments.activeId() !== id) throw new Error('Native attachment transaction was cancelled during fill');
        return result;
      }
      case 'attachment.arm': {
        const reason = await composerBlockReason(); if (reason) throw new Error(reason);
        if (runningTurn || pending.size) throw new Error('Native attachments require an idle session without pending approval');
        const receipt = attachments.arm(args);
        clearAttachmentTimer();
        attachmentTimer = $.clock.after(ATTACHMENT_TIMEOUT_MS, () => cancelAttachment('Native attachment transaction expired'));
        try {
          const draft = await $.prompt.read();
          if (draft.text || draft.cursor) throw new Error('Native composer contains a draft; it was not overwritten');
          if (attachments.activeId() !== receipt.id) throw new Error('Native attachment transaction was cancelled while arming');
          return receipt;
        } catch (error) {
          if (attachments.activeId() === receipt.id) cancelAttachment('Native attachment arm was refused');
          throw error;
        }
      }
      case 'attachment.status':
        if (Object.keys(args).some((key) => key !== 'id')) throw new Error('Native attachment.status takes only an id');
        return attachments.status(args.id);
      case 'attachment.disarm': {
        if (Object.keys(args).some((key) => key !== 'id')) throw new Error('Native attachment.disarm takes only an id');
        const previous = attachments.activeId();
        const status = attachments.disarm(args.id);
        if (previous === status.id) { clearAttachmentTimer(); emit('attachment.checked', status); }
        return status;
      }
      case 'turn.abort': {
        const turnId = args.turnId === undefined ? runningTurn : text(args.turnId, 'turn id');
        if (!turnId || turnId !== runningTurn) return { interrupted: false, reason: 'not-running' };
        cancelInteractions('The native turn was interrupted');
        cancelAttachment('The native turn was interrupted');
        // runningTurn clears only after turn.complete's next() returns, so the turn may already have ended.
        try { await $.turn.abort({ turnId }); }
        catch { return { interrupted: false, reason: 'not-running' }; }
        return { interrupted: true };
      }
      case 'session.usage':
        if (args.breakdown !== undefined && args.breakdown !== 'summary' && args.breakdown !== 'full') throw new Error('Invalid context breakdown');
        return $.session.usage({ breakdown: args.breakdown as 'summary' | 'full' | undefined });
      case 'session.messages':
        if (args.as !== undefined && args.as !== 'api') throw new Error('Only API-shaped session messages are supported');
        return $.session.messages({ as: 'api', ...(typeof args.agentId === 'string' ? { agentId: args.agentId } : {}) });
      case 'session.taskHistory':
        if (Object.keys(args).length) throw new Error('Native session.taskHistory takes no arguments');
        return nativeTaskHistory(await $.session.messages());
      case 'session.compact':
        if (attachments.isArmed()) throw new Error('A native attachment transaction owns the composer');
        return $.session.compact(typeof args.instructions === 'string' ? { instructions: args.instructions } : {});
      case 'session.model':
        if (Object.keys(args).length) throw new Error('Session-only model setting is not verified');
        return $.session.model();
      case 'config.list': return $.config.list();
      case 'env.effort': {
        if (Object.keys(args).length) throw new Error('The effort environment reader takes no arguments');
        const value = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL');
        if (value && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('The native effort environment override is invalid');
        return value || undefined;
      }
      case 'ui.command': {
        const command = text(args.command, 'native dialog');
        if (!['model', 'effort', 'mcp', 'plan'].includes(command) || (args.args !== undefined && args.args !== '') ||
          Object.keys(args).some((key) => key !== 'command' && key !== 'args')) throw new Error('Only named native control dialogs are allowed');
        if (modalActive || runningTurn || pending.size || attachments.isArmed()) throw new Error('Native control requires an idle session without pending approval or attachments');
        modalActive = true;
        try { return await $.command.run({ command, args: '' }); }
        finally { modalActive = false; }
      }
      case 'workflow.set': {
        if (Object.keys(args).some((key) => key !== 'enabled') || typeof args.enabled !== 'boolean') throw new Error('Native workflow.set takes only an enabled boolean');
        const enabled = args.enabled;
        return writeNativeBoolean('workflows', enabled);
      }
      case 'config.open': {
        if (Object.keys(args).length) throw new Error('Native config.open takes no arguments');
        return persistentControl(async (checkIdle) => {
          checkIdle();
          return $.command.run({ command: 'config', args: '' });
        });
      }
      case 'fast.set':
      case 'autoContinue.set': {
        if (Object.keys(args).some((key) => key !== 'enabled') || typeof args.enabled !== 'boolean') throw new Error('Native preference setter takes only an enabled boolean');
        if (request.method === 'autoContinue.set' && ephemeral && args.enabled) throw new Error('Native automatic continuation cannot be enabled in a no-history side chat');
        return writeNativeBoolean(request.method === 'fast.set' ? 'fast' : 'autoContinueAtUsageLimit', args.enabled);
      }
      case 'ultracode.set': {
        if (Object.keys(args).some((key) => key !== 'enabled') || typeof args.enabled !== 'boolean') throw new Error('Native ultracode.set takes only an enabled boolean');
        return persistentControl(async (checkIdle) => {
          checkIdle();
          return $.command.run({ command: 'effort', args: args.enabled ? 'ultracode on' : 'ultracode off' });
        }, true);
      }
      case 'mcp.nativeAction': {
        if (Object.keys(args).some((key) => key !== 'operation' && key !== 'name') || !['enable', 'disable', 'reconnect'].includes(String(args.operation))) throw new Error('Native MCP action must be enable, disable or reconnect');
        const name = text(args.name, 'MCP server name');
        if (name.length > 256 || name.trim() !== name || /^all$/i.test(name) || /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(name)) throw new Error('Native MCP action requires one bounded literal server name, not all or control text');
        return persistentControl(async (checkIdle) => {
          checkIdle();
          return $.command.run({ command: 'mcp', args: `${args.operation} ${name}` });
        });
      }
      case 'command.list': return $.command.list();
      case 'command.run': {
        if (attachments.isArmed()) throw new Error('A native attachment transaction owns the composer');
        const command = text(args.command, 'command').trim().replace(/^\//, '');
        const typed = command.split(/\s+/, 1)[0];
        await refuseGuarded(typed);
        return $.command.run({ command, args: typeof args.args === 'string' ? args.args : '' });
      }
      case 'tool.list': return $.tool.list();
      case 'tool.call':
        if (args.tool !== 'TaskStop') throw new Error('Only explicit TaskStop calls are supported by the prototype tool dispatcher');
        return $.tool.call({ tool: 'TaskStop', task_id: text(args.task_id, 'task id') });
      case 'agent.list': return $.agent.list();
      default: throw new Error('Unsupported native bridge method');
    }
  }

  async function receive(request: BridgeRequest): Promise<void> {
    if (closed) return;
    const prior = remembered.get(request.id);
    if (prior) { send(prior); return; }
    const inFlight = active.get(request.id);
    if (inFlight) { send(await inFlight.promise); return; }
    const inspector = request.method === 'bridge.diagnostics';
    const priority = PRIORITY_METHODS.has(request.method);
    // Inspectors must not consume the existing capacity reserved for ordinary work.
    if (!priority && [...active.values()].filter((entry) => entry.diagnostic !== undefined).length >= MAX_ACTIVE_REQUESTS) {
      send({ type: 'response', id: request.id, ok: false, error: { code: 'CAPACITY', message: 'Too many pending native requests' } });
      return;
    }
    const requestEpoch = epoch;
    const diagnostic = inspector ? undefined : diagnosticMetadata(request);
    const rejected = (message: string): BridgeReply => ({ type: 'response', id: request.id, ok: false, error: { code: 'NATIVE_REQUEST_REJECTED', message } });
    // Decided before commandTail: a command.run waits there until its native dialog or command ends.
    const busy = request.method === 'command.run' && commandRun !== undefined;
    if (request.method === 'command.run' && !busy) commandRun = request.id;
    const run = async (): Promise<BridgeReply> => {
      if (closed || requestEpoch !== epoch) return { type: 'response', id: request.id, ok: false,
        error: { code: 'SESSION_CHANGED', message: 'The native session changed before this request ran' } };
      if (diagnostic) { diagnostic.state = 'running'; diagnostic.runAt = Date.now(); }
      try { return { type: 'response', id: request.id, ok: true, value: await dispatch(request) }; }
      catch (error) { return rejected(error instanceof Error ? error.message : 'Native request failed'); }
    };
    const serialized = !busy && !priority && !concurrentRequest(request);
    const result = busy ? Promise.resolve(rejected(COMMAND_BUSY_MESSAGE)) : serialized ? commandTail.then(run) : Promise.resolve().then(run);
    if (serialized) commandTail = result.then(() => undefined);
    const entry: ActiveRequest = { promise: result, ...(diagnostic ? { diagnostic } : {}) };
    active.set(request.id, entry);
    const reply = await result;
    if (!busy && commandRun === request.id) commandRun = undefined;
    if (active.get(request.id) === entry) active.delete(request.id);
    if (closed) return;
    // A rebind cleared this id's records: answer once, unless the new session already reused the id.
    if (requestEpoch !== epoch) { if (!active.has(request.id) && !remembered.has(request.id)) send(reply); return; }
    remembered.set(request.id, reply);
    const replyBytes = new TextEncoder().encode(JSON.stringify(reply)).length;
    rememberedSizes.set(request.id, replyBytes);
    rememberedBytes += replyBytes;
    while (remembered.size > MAX_REMEMBERED_REQUESTS || rememberedBytes > MAX_REMEMBERED_BYTES) {
      const oldest = remembered.keys().next().value!;
      rememberedBytes -= rememberedSizes.get(oldest) ?? 0;
      remembered.delete(oldest);
      rememberedSizes.delete(oldest);
    }
    send(reply);
  }

  return {
    async start(isInteractive, surface) {
      if (!isInteractive || surface !== 'terminal') throw new Error('Relay native bridge requires a genuine interactive terminal session');
      await rebind();
      ephemeral = await $.env.get('CLAUDE_CODE_SKIP_PROMPT_HISTORY') === '1';
      const persistent = await $.env.get('RELAY_NATIVE_PERSISTENT_CONTROLS') === '1';
      const systemRoot = await $.env.get('SystemRoot');
      holdArgv = systemRoot && /^[A-Za-z]:\\[^\u0000-\u001f"*?<>|]*$/.test(systemRoot)
        ? [`${systemRoot.replace(/\\+$/, '')}\\System32\\waitfor.exe`, '/t', '99999'] : undefined;
      const model = await $.session.model();
      const cwd = await $.session.cwd();
      if (closed) throw new Error('Relay native startup was canceled');
      advertised = new Set<string>([...CAPABILITIES, ...(persistent ? PERSISTENT_CAPABILITIES : [])]);
      transport.start((request) => { void receive(request); }, close);
      if (closed) throw new Error('Relay native startup transport closed');
      transport.send({ type: 'hello', protocol: PROTOCOL_VERSION, sessionId, isInteractive, surface,
        capabilities: [...CAPABILITIES, ...(ephemeral ? ['session.ephemeral'] : []), ...(persistent ? PERSISTENT_CAPABILITIES : [])], model, cwd });
      await transport.flush();
    },
    receive, emit, close, rebind, cancelInteractions,
    promptBlockReason: composerBlockReason,
    checkAttachmentPrompt(event, blockedReason) {
      const result = attachments.checkPrompt(event, blockedReason);
      if (result.checked) { if (result.checked.state !== 'armed') clearAttachmentTimer(); emit('attachment.checked', result.checked); }
      return closed ? { reason: 'Relay native attachment transport is unavailable' } : { reason: result.reason, transactionId: result.transactionId };
    },
    completeAttachmentPrompt(id, result) {
      const status = attachments.complete(id, result);
      if (status) { clearAttachmentTimer(); emit('attachment.checked', status); }
    },
    rejectAttachmentPrompt(id) {
      const status = attachments.reject(id, 'Native prompt entry failed downstream');
      if (status) { clearAttachmentTimer(); emit('attachment.checked', status); }
    },
    setTurn(turnId) { runningTurn = turnId; },
    interact(input, signal) {
      if (closed || signal?.aborted) return Promise.resolve(denial('Relay interaction is unavailable or canceled'));
      if (pending.size >= MAX_PENDING_INTERACTIONS) return Promise.resolve(denial('Too many pending Relay interactions'));
      const id = sessionId + ':interaction:' + (++interactionNumber);
      return new Promise<PermissionRequestDecision>((resolve) => {
        const abort = () => settle(id, denial('The native request was canceled'), true);
        pending.set(id, { resolve, signal, abort, hold: holdOpen() });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        emit('interaction.request', { id, ...input });
      });
    },
  };
}
