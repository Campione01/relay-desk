import { randomUUID } from 'node:crypto';
import type { BackgroundTask, WorkflowAgent } from '@shared/types';
import type { NativeEvent, NativeRequestOptions } from './contract';
import { NATIVE_CLI_BUILDS, nativeCliBuild, type NativeCliBuild } from './cliBuilds';
import { detectNativePanel } from './panel';
import { NativeTerminalScreen } from './terminalScreen';
export { NativeTerminalScreen } from './terminalScreen';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class NativeControlGate extends Error {
  readonly operation: string;
  constructor(operation: string, reason: string) {
    super(`Native control gate [${operation}]: ${reason}`);
    this.name = 'NativeControlGate';
    this.operation = operation;
  }
}

export class NativeUiWaitTimeout extends NativeControlGate {}

export interface NativeControlPort {
  request(method: string, args?: unknown, options?: NativeRequestOptions): Promise<unknown>;
}

/** The newest accepted build; the full list lives in cliBuilds.ts. */
export const NATIVE_UI_PINNED_SHA256 = NATIVE_CLI_BUILDS[0].sha256;
export interface NativeUiSnapshot { sessionId: string; cliSha256: string; revision: number; text: string; source?: 'terminal' | 'command-result' }
export type NativeUiPredicate = (snapshot: NativeUiSnapshot) => boolean;
export interface NativeUiWaitOptions {
  afterRevision?: number; timeoutMs?: number; stableMs?: number;
  completedText?(result: unknown): string | undefined;
}
export interface NativeUiRunOptions { cancelPanel?: NativeUiPredicate }
export interface NativeUiTransaction {
  snapshot(): NativeUiSnapshot;
  wait(predicate: NativeUiPredicate, options?: NativeUiWaitOptions): Promise<NativeUiSnapshot>;
  open(command: 'mcp' | 'model' | 'effort' | 'plan' | 'config' | 'rate-limit-options', args: string, predicate: NativeUiPredicate, options?: NativeUiWaitOptions): Promise<NativeUiSnapshot>;
  key(bytes: string, guard: NativeUiPredicate, settled: NativeUiPredicate, options?: NativeUiWaitOptions): Promise<NativeUiSnapshot>;
  cyclePermissionMode?(guard: NativeUiPredicate, settled: NativeUiPredicate, options?: NativeUiWaitOptions): Promise<NativeUiSnapshot>;
  quotaKey?(bytes: '\x1b' | '\r', guard: NativeUiPredicate, settled: NativeUiPredicate, options?: NativeUiWaitOptions): Promise<NativeUiSnapshot>;
}
export interface NativeUiControllerOptions {
  sessionId: string;
  cliSha256: string;
  /**
   * Fixture-only: replaces NATIVE_CLI_BUILDS for an acceptance run of a staged, unlisted build (exactly its stage
   * receipt's version and sha256). Production wiring never passes it.
   */
  admittedBuilds?: readonly NativeCliBuild[];
  port: NativeControlPort;
  writeTerminal(data: string): void | Promise<void>;
  isIdle(): boolean;
  columns?: number;
  rows?: number;
  /** A screen the owner writes; observeTerminal() then only reports that it changed. */
  screen?: NativeTerminalScreen;
  onActiveChange?(active: boolean): void;
  onControlFailure?(error: Error): void;
  /** A failed control's quarantine ended: its dialog closed and the idle composer is back. */
  onRecovered?(): void;
  /** A transaction ended, however it ended: Relay no longer drives the screen. */
  onSettled?(): void;
  readDiagnostics?(): Promise<unknown>;
}

// Bridge refusals raised before any native dialog could open (bridge.ts idle and allow-list guards).
const PRE_DISPATCH_REFUSAL = /Native control requires an idle session|Native persistent control requires an idle session|Native persistent controls were not explicitly enabled|Only named native control dialogs are allowed|Unsupported native bridge method|The native session changed before this request ran/;
const RECOVERY_CHECK_MS = 100;
/**
 * The CLI's prompt and selection pointer: '>' unless the environment marks a Unicode console (TERM or WT_SESSION, as
 * when Relay is started from a shell), then '❯' or '›'.
 */
export const NATIVE_POINTER = '[>❯›]';
/** The empty composer line. */
export const NATIVE_PROMPT_LINE = new RegExp(`^${NATIVE_POINTER}$`);

/** The idle composer is drawn only after every docked dialog closed; a typed draft is not idle. */
export function nativeComposerIdle(screen: NativeTerminalScreen): boolean {
  if (detectNativePanel(screen)) return false;
  const lines = screen.lineTexts();
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(Math.max(0, end - 8), end).some((line) => NATIVE_PROMPT_LINE.test(line.trim()));
}

const DIAGNOSTIC_METHODS = new Set([
  'bridge.diagnostics', 'interaction.reply', 'prompt.submit', 'prompt.read', 'prompt.fill',
  'attachment.arm', 'attachment.status', 'attachment.disarm', 'turn.abort', 'session.usage',
  'session.messages', 'session.taskHistory', 'session.compact', 'session.model', 'config.list',
  'env.effort', 'ui.command', 'workflow.set', 'config.open', 'fast.set', 'autoContinue.set',
  'ultracode.set', 'mcp.nativeAction', 'command.list', 'command.run', 'tool.list', 'tool.call', 'agent.list',
]);
const DIAGNOSTIC_COMMANDS = new Set(['effort', 'model', 'mcp', 'plan', 'rate-limit-options']);
const DIAGNOSTIC_KEYS = { '\r': 'enter', '\x1b': 'escape', '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', s: 'session-only', '\x1b[Z': 'shift-tab' } as const;
type DiagnosticPhase = 'wait' | `open:${Parameters<NativeUiTransaction['open']>[0]}` | `key:${typeof DIAGNOSTIC_KEYS[keyof typeof DIAGNOSTIC_KEYS]}`;
const DIAGNOSTICS_UNAVAILABLE = 'bridge=unavailable';

function bridgeDiagnosticText(value: unknown): string {
  if (!record(value) || value.version !== 1 || typeof value.modalActive !== 'boolean' || typeof value.runningTurn !== 'boolean' ||
    !integer(value.activeCount) || !integer(value.queuedCount) || typeof value.truncated !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 16) return DIAGNOSTICS_UNAVAILABLE;
  const entries: string[] = [];
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.method !== 'string' || (entry.state !== 'queued' && entry.state !== 'running') ||
      !integer(entry.queuedMs) || entry.runMs !== undefined && !integer(entry.runMs) || entry.command !== undefined && typeof entry.command !== 'string') return DIAGNOSTICS_UNAVAILABLE;
    const method = DIAGNOSTIC_METHODS.has(entry.method) ? entry.method : 'other';
    const command = method === 'ui.command' && typeof entry.command === 'string' && DIAGNOSTIC_COMMANDS.has(entry.command) ? `/${entry.command}` : '';
    entries.push(`${method}${command}:${entry.state} queuedMs=${entry.queuedMs}${entry.runMs === undefined ? '' : ` runMs=${entry.runMs}`}`);
  }
  return `bridge=modal:${Number(value.modalActive)},turn:${Number(value.runningTurn)},active:${value.activeCount},queued:${value.queuedCount},truncated:${Number(value.truncated)}; requests=[${entries.join('; ')}]`;
}

function screenDiagnosticText(snapshot: NativeUiSnapshot, phase: DiagnosticPhase, afterRevision: number, columns: number, rows: number): string {
  const lines = snapshot.text.split('\n'), start = lines.findLastIndex((line) => line.trim() === 'Effort');
  const effort = start < 0 ? [] : lines.slice(start), body = effort.join('\n');
  const labels = effort.find((line) => /\blow\s+medium\s+high\s+xhigh\s+max\b/.test(line));
  const pointerRows = effort.filter((line) => line.includes('\u25b2'));
  const pointers = [...body.matchAll(/\u25b2/g)].length;
  const centers = labels ? ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => {
      const match = new RegExp(`\\b${level}\\b`).exec(labels);
      return match ? match.index + (level.length - 1) / 2 : -1;
    }) : [];
  const pointerCol = pointerRows.length === 1 && pointers === 1 ? pointerRows[0].indexOf('\u25b2') : -1;
  const distances = centers.length && pointerCol >= 0 ? centers.map((center) => Math.abs(pointerCol - center)).sort((a, b) => a - b) : [];
  const aligned = distances.length > 0 && distances[0] <= 4 && distances[0] !== distances[1];
  const confirm = effort.some((line) => /Enter\s+to\s+confirm/i.test(line)), sessionOnly = /s\s+for\s+this\s+session\s+only/i.test(body), cancel = /Esc\s+to\s+cancel/i.test(body);
  const footer = /s\s+for\s+this\s+session\s+only.*Esc\s+to\s+cancel/i.test(effort.join(' '));
  const modelStart = lines.findLastIndex((line) => line.trim() === 'Select model');
  const modelPanel = modelStart < 0 ? '' : lines.slice(modelStart).join(' ');
  const panels = [
    start >= 0 && labels && aligned && footer ? 'effort' : undefined,
    modelStart >= 0 && /Enter\s+to\s+set\s+as\s+default.*s\s+to\s+use\s+this\s+session\s+only.*Esc\s+to\s+cancel/i.test(modelPanel) ? 'model' : undefined,
    /^\s*Manage MCP servers\s*$|^\s*.+ MCP Server\s*$/m.test(snapshot.text) ? 'mcp' : undefined,
    /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(snapshot.text) ? 'config' : undefined,
    /^\s*(?:Usage limit reached|Your usage limit has reset|What do you want to do\?)/m.test(snapshot.text) ? 'quota' : undefined,
    /^\s*(?:Select login method|Log in to Claude Code|Sign in to Claude Code|Authentication required)/mi.test(snapshot.text) ? 'auth' : undefined,
  ].filter((name) => name !== undefined);
  const required = Number.isSafeInteger(afterRevision) && afterRevision >= -1 ? afterRevision : 'unknown';
  const position = `projection0based=titleRow:${start},labelRow:${labels ? start + effort.indexOf(labels) : -1},pointerRow:${pointerCol >= 0 ? start + effort.indexOf(pointerRows[0]) : -1},pointerCol:${pointerCol},labelCenters:[${centers.join(',')}]`;
  return `phase=${phase}; revision=${snapshot.revision}; requiredRevision>${required}; geometry=${columns}x${rows}; panels=${panels.join(',') || 'none'}; effortParts=title:${Number(start >= 0)},labels:${Number(Boolean(labels))},pointers:${pointers},aligned:${Number(aligned)},confirm:${Number(confirm)},sessionOnly:${Number(sessionOnly)},cancel:${Number(cancel)},footer:${Number(footer)}; ${position}`;
}


interface Quarantine {
  owner: object;
  error: NativeControlGate;
  /** No write or tracked command of the failed transaction is still in flight. */
  settled(): boolean;
  /** A tracked command ended without a native answer, so the bridge must confirm no modal is left. */
  uncertain(): boolean;
}

/**
 * One owner for all built-in dialogs. A failed control quarantines input until its dialog is gone: its tracked
 * command completes, or the idle composer is back with nothing in flight (the user may close a leftover dialog).
 */
export class NativeUiController {
  private readonly options: NativeUiControllerOptions;
  private readonly screen: NativeTerminalScreen;
  private readonly verified: boolean;
  private readonly lifetime = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;
  private queued = 0;
  private quarantine: Quarantine | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryCheck: Promise<void> | undefined;
  private closed = false;
  constructor(options: NativeUiControllerOptions) {
    if (!options.sessionId) throw new NativeControlGate('ui', 'unverified native identity/version.');
    this.options = options; this.screen = options.screen ?? new NativeTerminalScreen(options.columns, options.rows);
    this.verified = nativeCliBuild(options.cliSha256, options.admittedBuilds) !== undefined;
  }
  observeTerminal(data = ''): void {
    if (this.closed) return;
    if (!this.options.screen && data) this.screen.write(data);
    if (this.quarantine) this.scheduleRecovery();
  }
  snapshot(): NativeUiSnapshot { return { sessionId: this.options.sessionId, cliSha256: this.options.cliSha256, revision: this.screen.revision, text: this.screen.text() }; }
  active(): boolean { return this.busy || this.queued > 0 || Boolean(this.quarantine); }
  /** A Relay transaction is reading or typing into a native dialog right now. */
  driving(): boolean { return this.busy; }
  /** Relay's own dialog drivers know this CLI build's layouts. */
  get supported(): boolean { return this.verified; }
  recoveryError(): NativeControlGate | undefined { return this.quarantine?.error; }
  /** Re-check a quarantine now, e.g. after the user closed the leftover dialog. */
  checkRecovery(): void { if (this.quarantine) this.scheduleRecovery(0); }
  private scheduleRecovery(delay = RECOVERY_CHECK_MS): void {
    if (this.closed || this.recoveryCheck || (this.recoveryTimer && delay)) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryCheck = this.tryRecover().catch(() => undefined).finally(() => { this.recoveryCheck = undefined; });
    }, delay);
  }
  private async tryRecover(): Promise<void> {
    const quarantine = this.quarantine;
    if (!quarantine) return;
    const ready = () => this.quarantine === quarantine && !this.closed && !this.busy && quarantine.settled() &&
      this.options.isIdle() && nativeComposerIdle(this.screen);
    if (!ready()) return;
    if (quarantine.uncertain()) {
      if (!this.options.readDiagnostics) return;
      const diagnostics = await this.options.readDiagnostics().catch(() => undefined);
      if (!record(diagnostics) || diagnostics.modalActive !== false || !ready()) return;
    }
    this.release(quarantine.owner);
  }
  private release(owner: object): void {
    if (this.closed || this.quarantine?.owner !== owner) return;
    this.quarantine = undefined;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    try { this.options.onRecovered?.(); } catch { /* Observers cannot keep input locked. */ }
    if (!this.active()) this.options.onActiveChange?.(false);
  }
  private async diagnosticSuffix(local: string): Promise<string> {
    let bridge = DIAGNOSTICS_UNAVAILABLE;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.options.readDiagnostics) {
      try {
        bridge = await Promise.race([
          Promise.resolve().then(() => this.options.readDiagnostics!()).then(bridgeDiagnosticText, () => DIAGNOSTICS_UNAVAILABLE),
          new Promise<string>((resolve) => { timer = setTimeout(() => resolve(DIAGNOSTICS_UNAVAILABLE), 500); }),
        ]);
      } catch { /* Inspector failures cannot replace the original timeout or reveal their payload. */ }
      finally { if (timer) clearTimeout(timer); }
    }
    return ` [Local UI diagnostic v1: ${local}; ${bridge}]`;
  }
  run<T>(operation: string, action: (transaction: NativeUiTransaction) => Promise<T>, runOptions: NativeUiRunOptions = {}): Promise<T> {
    const wasActive = this.active();
    this.queued++;
    if (!wasActive) this.options.onActiveChange?.(true);
    const work = this.tail.then(async () => {
      this.requireHealthy(operation);
      if (!this.verified) throw new NativeControlGate(operation, 'this Claude Code build is not verified for Relay\'s automatic dialog controls; run the slash command and use the CLI panel instead.');
      if (!this.options.isIdle()) throw new NativeControlGate(operation, 'native model/permission activity is not idle.');
      this.busy = true;
      // refused: the bridge declined before any dialog could open.
      type Command = { name: string; revision: number; state: 'pending' | 'fulfilled' | 'refused' | 'rejected'; promise?: Promise<unknown>; result?: unknown; error?: unknown };
      const commands: Command[] = [];
      const owner = {};
      let current = true;
      let panelSeen = false;
      let nativeInput = false;
      let failed = false, failureNotified = false, escapeSent = false;
      let pendingWrites = 0, writeUnconfirmed = false;
      let unconfirmedInputRevision: number | undefined;
      const settled = () => !pendingWrites && !writeUnconfirmed && commands.every((command) => command.state !== 'pending');
      const recoverCompleted = () => {
        if (!failed || !failureNotified || this.closed || this.quarantine?.owner !== owner || !settled()) return;
        // Completion of every dialog it opened proves none is left; otherwise wait for the idle composer.
        if (commands.length && commands.every((command) => command.state === 'fulfilled' || command.state === 'refused')) this.release(owner);
        else this.scheduleRecovery();
      };
      const write = async (bytes: string) => {
        pendingWrites++;
        try { await this.options.writeTerminal(bytes); }
        catch (error) { writeUnconfirmed = true; throw error; }
        finally { pendingWrites--; recoverCompleted(); }
      };
      const completeCommands = async (input: Promise<unknown> = Promise.resolve()) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          await Promise.race([
            input.then(() => Promise.all(commands.map((command) => command.promise))),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new NativeControlGate(operation, 'native command did not dismiss.')), 5_000); }),
            new Promise((_, reject) => {
              abort = () => reject(new NativeControlGate(operation, 'native UI driver is closed.'));
              this.lifetime.signal.addEventListener('abort', abort, { once: true });
              if (this.closed) abort();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          if (abort) this.lifetime.signal.removeEventListener('abort', abort);
        }
      };
      const requireTransaction = () => { this.requireHealthy(operation); if (!current) throw new NativeControlGate(operation, 'expired native UI transaction.'); };
      const wait = async (predicate: NativeUiPredicate, options: NativeUiWaitOptions = {}, completed?: () => NativeUiSnapshot | undefined, phase: DiagnosticPhase = 'wait') => {
        requireTransaction();
        const timeout = options.timeoutMs ?? 5_000, stable = options.stableMs ?? 80;
        if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000 || !Number.isFinite(stable) || stable < 0 || stable > timeout) throw new Error('Invalid native UI deadline.');
        const deadline = Date.now() + timeout;
        let matchingSince: number | undefined;
        while (Date.now() < deadline) {
          requireTransaction();
          const result = completed?.();
          if (result && predicate(result)) return result;
          const snapshot = this.snapshot();
          if (snapshot.revision > (options.afterRevision ?? -1) && predicate(snapshot)) {
            matchingSince ??= Date.now();
            if (Date.now() - matchingSince >= stable) return snapshot;
          } else matchingSince = undefined;
          await new Promise((resolve) => setTimeout(resolve, Math.min(20, stable || 1)));
        }
        const error = new NativeUiWaitTimeout(operation, 'native UI did not reach the attested expected state before its deadline.');
        // Freeze the timeout observation before the priority inspector can return a later native state.
        const local = screenDiagnosticText(this.snapshot(), phase, options.afterRevision ?? -1, this.screen.columns, this.screen.rows);
        error.message += await this.diagnosticSuffix(local);
        throw error;
      };
      const transaction: NativeUiTransaction = {
        snapshot: () => { requireTransaction(); return this.snapshot(); }, wait,
        open: async (command, args, predicate, options = {}) => {
          requireTransaction();
          if (!['mcp', 'model', 'effort', 'plan', 'config', 'rate-limit-options'].includes(command) || !(args === '' || command === 'effort' && args === 'ultracode')) throw new NativeControlGate(operation, 'untrusted native command/default-setting arguments.');
          if (!this.options.isIdle()) throw new NativeControlGate(operation, 'native activity resumed before the dialog opened.');
          const before = this.snapshot().revision;
          // Built-in commands may await dialog dismissal, so observe their panel without awaiting completion.
          const tracked: Command = { name: command, revision: before, state: 'pending' };
          commands.push(tracked);
          // A dialog ends when it is dismissed, however long that takes; a deadline would only lose its completion.
          tracked.promise = Promise.resolve().then(() => this.options.port.request('command.run', { command, args }, { signal: this.lifetime.signal, timeoutMs: null }))
            .then((result) => { tracked.state = 'fulfilled'; tracked.result = result; recoverCompleted(); return result; },
              (error: unknown) => {
                tracked.state = error instanceof Error && PRE_DISPATCH_REFUSAL.test(error.message) ? 'refused' : 'rejected';
                tracked.error = error; recoverCompleted(); throw error;
              });
          void tracked.promise.catch(() => undefined);
          const snapshot = await wait(predicate, { ...options, afterRevision: Math.max(before, options.afterRevision ?? -1) }, () => {
            if (tracked.state === 'rejected' || tracked.state === 'refused') throw tracked.error;
            const text = tracked.state === 'fulfilled' ? options.completedText?.(tracked.result) : undefined;
            return text === undefined ? undefined : { ...this.snapshot(), text, source: 'command-result' };
          }, `open:${command}`);
          panelSeen = snapshot.source !== 'command-result';
          return snapshot;
        },
        key: async (bytes, guard, settled, options = {}) => {
          requireTransaction();
          if (!this.options.isIdle()) throw new NativeControlGate(operation, 'native activity resumed while the modal owned input.');
          if (!panelSeen) throw new NativeControlGate(operation, 'no fresh native command panel has been observed.');
          if (!['\r', '\x1b', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', 's'].includes(bytes)) throw new NativeControlGate(operation, 'unverified native key.');
          const before = this.snapshot();
          if (!guard(before)) throw new NativeControlGate(operation, 'native selection guard refused the key.');
          nativeInput = true;
          escapeSent ||= bytes === '\x1b'; unconfirmedInputRevision = before.revision;
          await write(bytes);
          const snapshot = await wait(settled, { ...options, afterRevision: Math.max(before.revision, options.afterRevision ?? -1) }, undefined, `key:${DIAGNOSTIC_KEYS[bytes as keyof typeof DIAGNOSTIC_KEYS]}`);
          unconfirmedInputRevision = undefined;
          // A confirmed detail-to-catalog Escape is navigation, not a failed recovery attempt.
          if (operation === 'mcp.status.dialog' && bytes === '\x1b' && mcpPanel(snapshot)) escapeSent = false;
          return snapshot;
        },
        cyclePermissionMode: async (guard, settled, options = {}) => {
          requireTransaction();
          if (panelSeen || !this.options.isIdle()) throw new NativeControlGate(operation, 'native permission cycle requires the idle composer, not a dialog.');
          const before = this.snapshot();
          if (!guard(before)) throw new NativeControlGate(operation, 'native idle-composer guard refused the permission cycle.');
          nativeInput = true;
          unconfirmedInputRevision = before.revision;
          await write('\x1b[Z');
          const snapshot = await wait(settled, { ...options, afterRevision: Math.max(before.revision, options.afterRevision ?? -1) }, undefined, 'key:shift-tab');
          unconfirmedInputRevision = undefined;
          return snapshot;
        },
        quotaKey: async (bytes, guard, settled, options = {}) => {
          requireTransaction();
          if (!((operation === 'quota.cancel' && bytes === '\x1b') || (operation === 'quota.continue' && bytes === '\r'))) throw new NativeControlGate(operation, 'unverified native quota operation/key.');
          if (panelSeen || !this.options.isIdle()) throw new NativeControlGate(operation, 'native quota action requires the idle native wait view, not a dialog.');
          const before = this.snapshot();
          if (!guard(before)) throw new NativeControlGate(operation, 'native quota banner guard refused the key.');
          nativeInput = true;
          escapeSent ||= bytes === '\x1b'; unconfirmedInputRevision = before.revision;
          await write(bytes);
          const snapshot = await wait(settled, { ...options, afterRevision: Math.max(before.revision, options.afterRevision ?? -1) }, undefined, `key:${DIAGNOSTIC_KEYS[bytes]}`);
          unconfirmedInputRevision = undefined;
          return snapshot;
        },
      };
      try {
        const result = await action(transaction);
        await completeCommands();
        return result;
      } catch (error) {
        if (nativeInput || commands.some((command) => command.state !== 'refused')) {
          failed = true;
          this.quarantine = { owner, error: new NativeControlGate(operation, 'a prior native modal failed; input recovery is required before another send or control. Background work has not been stopped.'),
            settled, uncertain: () => commands.some((command) => command.state === 'rejected') };
          // Detach never-dispatched intent before either immediate or late command completion unlocks input.
          try { this.options.onControlFailure?.(error instanceof Error ? error : new Error(String(error))); failureNotified = true; }
          catch { /* A failed queue notification must not release input or replace the original control error. */ }
          recoverCompleted();
          const command = commands[0];
          const expectedCommand = operation === 'settings.effort' ? 'effort' : operation === 'settings.model' ? 'model' : operation === 'mcp.status.dialog' ? 'mcp' : undefined;
          if (failureNotified && !this.closed && this.quarantine?.owner === owner && runOptions.cancelPanel && expectedCommand &&
            commands.length === 1 && command.name === expectedCommand && command.state === 'pending' && !escapeSent && !pendingWrites && !writeUnconfirmed && this.options.isIdle()) {
            const snapshot = this.snapshot();
            try {
              if (snapshot.revision > (unconfirmedInputRevision ?? command.revision) && runOptions.cancelPanel(snapshot)) {
                escapeSent = true;
                await completeCommands(write('\x1b'));
                recoverCompleted();
              }
            } catch { /* Unknown delivery/completion stays quarantined; never guess a second cancellation key. */ }
          }
        }
        throw error;
      }
      finally { current = false; this.busy = false; }
    });
    const run = work.finally(() => {
      this.queued--;
      try { this.options.onSettled?.(); } catch { /* Observers cannot change the transaction's outcome. */ }
      if (!this.active()) this.options.onActiveChange?.(false);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
  close(): void {
    this.closed = true; this.lifetime.abort();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }
  private requireHealthy(operation: string): void {
    if (this.closed) throw new NativeControlGate(operation, 'native UI driver is closed.');
    if (this.quarantine) throw this.quarantine.error;
  }
}

export type NativeMcpOperation = 'status' | 'toggle' | 'reconnect';
export type NativeMcpRoute =
  | { kind: 'typed'; method: 'mcp.status' | 'mcp.toggle' | 'mcp.reconnect' }
  | { kind: 'gated'; operation: NativeMcpOperation; reason: string; manualNativeCommand: 'mcp' };

/** A tool schema proves availability, not a live connection, disable state, or reconnect. */
export function nativeMcpRoute(operation: NativeMcpOperation, capabilities: readonly string[]): NativeMcpRoute {
  if (!['status', 'toggle', 'reconnect'].includes(operation)) throw new Error('Invalid native MCP operation.');
  const method = `mcp.${operation}` as 'mcp.status' | 'mcp.toggle' | 'mcp.reconnect';
  if (capabilities.includes(method)) return { kind: 'typed', method };
  return { kind: 'gated', operation, manualNativeCommand: 'mcp',
    reason: 'This bridge exposes no verified typed operation; the native MCP dialog is not a structured RPC equivalent.' };
}

export async function requestNativeMcp(port: NativeControlPort, capabilities: readonly string[], operation: NativeMcpOperation,
  args: { name?: string; enabled?: boolean } = {}, options?: NativeRequestOptions): Promise<unknown> {
  const route = nativeMcpRoute(operation, capabilities);
  if (route.kind === 'gated') throw new NativeControlGate(`mcp.${operation}`, route.reason);
  if (operation !== 'status' && (!args.name?.trim() || args.name.length > 200)) throw new Error('A native MCP server name is required.');
  if (operation === 'toggle' && typeof args.enabled !== 'boolean') throw new Error('A native MCP toggle requires a boolean.');
  return port.request(route.method, operation === 'status' ? {} : operation === 'toggle'
    ? { name: args.name, enabled: args.enabled } : { name: args.name }, options);
}

export interface NativeMcpDialogStatus {
  name: string;
  status: 'connected' | 'disabled' | 'failed' | 'needs-auth' | 'pending';
  source: 'native-dialog';
  toolCount?: number;
}
export interface NativeMcpPersistentActions {
  serverNames(): readonly string[];
  assertPreferenceScope(): void | Promise<void>;
  perform(operation: 'enable' | 'disable' | 'reconnect', name: string): Promise<unknown>;
}
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mcpConnectedGlyphs = ['\u221a', '\u2714'];
// Official 308 Windows/Unicode alternatives; retain the legacy parser's cross as well.
const mcpSettledGlyphs = [...mcpConnectedGlyphs, '\u203c', '\u26a0', '\u2717', '\u00d7', '\u2718'];
const mcpSettledGlyph = `(?:${mcpSettledGlyphs.map(escapePattern).join('|')})`;
const mcpStatusGlyph = `(?:${[...mcpSettledGlyphs, '( )', '\u25ef', '\u2026'].map(escapePattern).join('|')})`;
const mcpSelectedRow = new RegExp('^\\s*[>\\u276f\\u203a]\\s*' + mcpStatusGlyph + '\\s+\\S');
const mcpCatalogRow = new RegExp('^\\s*(?:[>\\u276f\\u203a]\\s*)?' + mcpStatusGlyph + '\\s+\\S');
function mcpPanelLines(snapshot: NativeUiSnapshot, name?: string): string[] | undefined {
  const lines = snapshot.text.split('\n');
  const start = lines.findLastIndex((line) => !mcpCatalogRow.test(line) && (line.trim() === 'Manage MCP servers' || /^\s*.+ MCP Server\s*$/i.test(line)));
  if (start < 0) return undefined;
  const heading = name === undefined ? /^\s*Manage MCP servers\s*$/ : new RegExp(`^\\s*${escapePattern(name)} MCP Server\\s*$`, 'i');
  if (!heading.test(lines[start])) return undefined;
  const footer = name === undefined ? /^\s*(?:\u2191\/\u2193 to navigate \u00b7 )?Enter to confirm \u00b7 Esc to cancel\s*$/
    : /^\s*(?:\u2191\/\u2193 to navigate \u00b7 )?Enter to select \u00b7 Esc to back\s*$/;
  const end = lines.findIndex((line, index) => index > start && !mcpCatalogRow.test(line) && footer.test(line));
  return end < 0 ? undefined : lines.slice(start, end + 1);
}
const mcpPanel = (snapshot: NativeUiSnapshot) => mcpPanelLines(snapshot) !== undefined;
const mcpDetail = (snapshot: NativeUiSnapshot, name: string) => mcpPanelLines(snapshot, name) !== undefined;
const selectedMcpAction = (snapshot: NativeUiSnapshot, name: string) => (mcpPanelLines(snapshot, name) ?? []).map((line) => line.match(/^\s*[>\u276f\u203a]\s*(\d+)\.\s*(View tools|Reconnect|Disable|Enable)\s*$/))
  .find((match) => match !== null);
// One pending-read budget leaves time to dismiss the existing 30-second native command.
export const NATIVE_MCP_PENDING_SETTLE_MS = 20_000;

/** Pinned English/native dialog adapter; deliberately not advertised as typed MCP parity. */
export class NativeMcpDialogControls {
  private readonly ui: NativeUiController;
  private readonly persistent?: NativeMcpPersistentActions;
  constructor(ui: NativeUiController, persistent?: NativeMcpPersistentActions) { this.ui = ui; this.persistent = persistent; }
  inspect(name: string): Promise<NativeMcpDialogStatus> {
    this.validateName(name);
    return this.ui.run('mcp.status.dialog', async (tx) => {
      const deadline = Date.now() + NATIVE_MCP_PENDING_SETTLE_MS;
      await this.openDetail(tx, name);
      const status = await this.readDetailAndReturnToCatalog(tx, name, deadline);
      await tx.key('\x1b', mcpPanel, (snapshot) => !mcpPanel(snapshot) && !mcpDetail(snapshot, name) && /\? for shortcuts/.test(snapshot.text));
      return status;
    }, { cancelPanel: mcpPanel });
  }
  reconnect(name: string): Promise<NativeMcpDialogStatus> {
    this.validateName(name);
    if (this.persistent) return this.performNativeAction('reconnect', name).then((states) => states.find((state) => state.name === name)!);
    return this.ui.run('mcp.reconnect.dialog', async (tx) => {
      await this.openDetail(tx, name);
      this.readDetail(tx.snapshot(), name);
      for (let step = 0; step < 4; step++) {
        const current = selectedMcpAction(tx.snapshot(), name);
        if (!current) throw new NativeControlGate('mcp.reconnect.dialog', 'ambiguous native MCP action selection.');
        if (current[2] === 'Reconnect') break;
        const target = mcpPanelLines(tx.snapshot(), name)?.join('\n').match(/^\s*(?:[>\u276f\u203a]\s*)?(\d+)\.\s*Reconnect\s*$/m);
        if (!target) throw new NativeControlGate('mcp.reconnect.dialog', 'native reconnect action is unavailable.');
        const prior = current[2];
        await tx.key(Number(current[1]) < Number(target[1]) ? '\x1b[B' : '\x1b[A',
          (s) => mcpDetail(s, name) && selectedMcpAction(s, name)?.[2] === prior,
          (s) => mcpDetail(s, name) && Boolean(selectedMcpAction(s, name)) && selectedMcpAction(s, name)?.[2] !== prior);
      }
      await tx.key('\r', (s) => mcpDetail(s, name) && selectedMcpAction(s, name)?.[2] === 'Reconnect',
        (s) => !mcpPanel(s) && !mcpDetail(s, name) && s.text.includes(`Reconnected to ${name}.`), { timeoutMs: 20_000 });
      await this.openDetail(tx, name);
      const result = this.readDetail(tx.snapshot(), name);
      if (result.status !== 'connected') throw new NativeControlGate('mcp.reconnect.dialog', 'native reconnect did not restore a connected detail.');
      await this.dismiss(tx, name);
      return result;
    });
  }
  setEnabled(name: string, enabled: boolean): Promise<NativeMcpDialogStatus> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Native MCP enabled must be boolean.'));
    return this.performNativeAction(enabled ? 'enable' : 'disable', name).then((states) => states.find((state) => state.name === name)!);
  }
  inspectCatalog(knownNames: readonly string[] = []): Promise<NativeMcpDialogStatus[]> {
    this.validateNames(knownNames);
    return this.ui.run('mcp.status.dialog', (tx) => this.inspectTargets(tx, knownNames), { cancelPanel: mcpPanel });
  }
  performNativeAction(operation: 'enable' | 'disable' | 'reconnect', name: string): Promise<NativeMcpDialogStatus[]> {
    this.validateName(name);
    if (!['enable', 'disable', 'reconnect'].includes(operation)) return Promise.reject(new NativeControlGate('mcp.nativeAction', 'unsupported native MCP operation.'));
    if (name.toLowerCase() === 'all') return Promise.reject(new NativeControlGate('mcp.nativeAction', 'reserved all is not a single server.'));
    const persistent = this.persistent;
    if (!persistent) return Promise.reject(new NativeControlGate('mcp.toggle.dialog', 'native disabledMcpServers persistence requires an independently scoped Relay account.'));
    return this.ui.run('mcp.' + operation + '.native', async (tx) => {
      const known = [...persistent.serverNames()]; this.validateNames(known);
      await persistent.assertPreferenceScope();
      let attested = known.includes(name);
      if (!attested) {
        const observed = await this.inspectTargets(tx, known);
        attested = observed.some((state) => state.name === name);
      }
      if (!attested) throw new NativeControlGate('mcp.nativeAction', 'target is not a configured or natively observed server.');
      await persistent.assertPreferenceScope();
      await persistent.perform(operation, name);
      const states = await this.inspectTargets(tx, known);
      const actual = states.find((state) => state.name === name);
      if (!actual || (operation === 'disable' ? actual.status !== 'disabled' : actual.status === 'disabled')) throw new NativeControlGate('mcp.nativeAction', 'native panel did not confirm the requested state.');
      return states;
    });
  }
  private validateName(name: string): void {
    if (typeof name !== 'string' || !name.length || name.length > 256 || name.trim() !== name || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) throw new NativeControlGate('mcp.dialog', 'unsupported/ambiguous native server label.');
  }
  private validateNames(names: readonly string[]): void {
    if (!Array.isArray(names) || names.length > 128) throw new NativeControlGate('mcp.dialog', 'invalid or excessive server catalog.');
    names.forEach((name) => this.validateName(name));
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new NativeControlGate('mcp.dialog', 'ambiguous case-colliding server labels.');
  }
  private selectedServer(snapshot: NativeUiSnapshot): string | undefined {
    const rows = (mcpPanelLines(snapshot) ?? []).filter((line) => mcpSelectedRow.test(line));
    return rows.length === 1 ? rows[0].trim() : undefined;
  }
  private exactSelected(snapshot: NativeUiSnapshot, name: string): boolean {
    const row = this.selectedServer(snapshot);
    return row !== undefined && new RegExp('^\\s*[>\\u276f\\u203a]\\s*' + mcpStatusGlyph + '\\s+' + escapePattern(name) + '(?:\\s+\\d+ tools?)?\\s*$').test(row);
  }
  private async selectServer(tx: NativeUiTransaction, name: string): Promise<void> {
    const seen = new Set<string>();
    for (let step = 0; ; step++) {
      const snapshot = tx.snapshot();
      if (this.exactSelected(snapshot, name)) return;
      const lines = mcpPanelLines(snapshot) ?? [];
      const row = this.selectedServer(snapshot), cycle = row !== undefined && seen.has(row);
      const targetRow = new RegExp('^\\s*(?:[>\\u276f\\u203a]\\s*)?' + mcpStatusGlyph + '\\s+' + escapePattern(name) + '(?:\\s+\\d+ tools?)?\\s*$');
      if (!row || cycle || step >= 256) {
        // Literal presence is diagnostic only; selection still requires the full anchored row.
        const literal = new RegExp('(?:^|\\s)' + escapePattern(name) + '(?=\\s|$)');
        throw new NativeControlGate('mcp.dialog', `exact server was not observable in the bounded native catalog. [step=${step}; selectedRowCount=${lines.filter((line) => mcpSelectedRow.test(line)).length}; cycle=${cycle}; targetRowMatchedCount=${lines.filter((line) => targetRow.test(line)).length}; targetLiteralRowCount=${lines.slice(1, -1).filter((line) => literal.test(line)).length}]`);
      }
      seen.add(row);
      const selected = lines.findIndex((line) => line.trim() === row);
      const target = lines.findIndex((line) => targetRow.test(line));
      await tx.key(target >= 0 && target < selected ? '\x1b[A' : '\x1b[B',
        (snapshot) => mcpPanel(snapshot) && this.selectedServer(snapshot) === row,
        (snapshot) => mcpPanel(snapshot) && Boolean(this.selectedServer(snapshot)) && this.selectedServer(snapshot) !== row);
    }
  }
  private catalogNames(snapshot: NativeUiSnapshot): string[] {
    const values: string[] = [];
    for (const line of mcpPanelLines(snapshot) ?? []) {
      const row = line.match(new RegExp('^\\s*(?:[>\\u276f\\u203a]\\s*)?(' + mcpStatusGlyph + ')\\s+(.+?)\\s*$'));
      if (!row) continue;
      const name = mcpConnectedGlyphs.includes(row[1]) ? row[2].replace(/\s+\d+ tools?\s*$/, '') : row[2];
      this.validateName(name); values.push(name);
    }
    return values;
  }
  private async inspectTargets(tx: NativeUiTransaction, known: readonly string[]): Promise<NativeMcpDialogStatus[]> {
    const deadline = Date.now() + NATIVE_MCP_PENDING_SETTLE_MS;
    const empty = (snapshot: NativeUiSnapshot) => /^\s*No MCP servers configured(?:[.!]|$)/mi.test(snapshot.text);
    const opened = await tx.open('mcp', '', (snapshot) => mcpPanel(snapshot) || empty(snapshot), { completedText: (result) => {
      const value = record(result) && typeof result.text === 'string' ? result.text : undefined;
      return value !== undefined && /^\s*No MCP servers configured\.?\s*$/i.test(value) ? value : undefined;
    } });
    if (empty(opened)) {
      if (known.length) throw new NativeControlGate('mcp.status.dialog', 'native reports no servers despite known startup configuration.');
      return [];
    }
    const count = Number(mcpPanelLines(tx.snapshot())?.join('\n').match(/^\s*(\d+) servers?\s*$/m)?.[1]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 128) throw new NativeControlGate('mcp.status.dialog', 'native server count is not bounded/observable.');
    const observed = new Set(this.catalogNames(tx.snapshot()));
    const visited = new Set<string>();
    while (observed.size < count) {
      const row = this.selectedServer(tx.snapshot());
      if (!row || visited.has(row)) throw new NativeControlGate('mcp.status.dialog', `native server catalog was not completely observable. [knownCount=${known.length}; observedCount=${observed.size}]`);
      visited.add(row);
      await tx.key('\x1b[B', (snapshot) => mcpPanel(snapshot) && this.selectedServer(snapshot) === row,
        (snapshot) => mcpPanel(snapshot) && Boolean(this.selectedServer(snapshot)) && this.selectedServer(snapshot) !== row);
      this.catalogNames(tx.snapshot()).forEach((name) => observed.add(name));
    }
    const names = [...new Set([...known, ...observed])]; this.validateNames(names);
    const states: NativeMcpDialogStatus[] = [];
    for (const name of names) {
      try {
        await this.selectServer(tx, name);
        await tx.key('\r', (snapshot) => this.exactSelected(snapshot, name), (snapshot) => mcpDetail(snapshot, name));
        states.push(await this.readDetailAndReturnToCatalog(tx, name, deadline));
      } catch (error) {
        if (error instanceof NativeControlGate) error.message += ` [targetOrigin=${known.includes(name) ? 'configured' : 'observed'}; knownCount=${known.length}; observedCount=${observed.size}]`;
        throw error;
      }
    }
    await tx.key('\x1b', mcpPanel, (snapshot) => !mcpPanel(snapshot) && !names.some((name) => mcpDetail(snapshot, name)));
    return states;
  }
  private async openDetail(tx: NativeUiTransaction, name: string): Promise<void> {
    await tx.open('mcp', '', mcpPanel);
    await this.selectServer(tx, name);
    // Do not navigate an unknown/partially visible catalog; only the observed selected exact server is safe.
    await tx.key('\r', (snapshot) => this.exactSelected(snapshot, name), (s) => mcpDetail(s, name));
  }
  private async readDetailAndReturnToCatalog(tx: NativeUiTransaction, name: string, deadline: number): Promise<NativeMcpDialogStatus> {
    let status = await this.readSettledDetail(tx, name, deadline);
    await tx.key('\x1b', (snapshot) => mcpDetail(snapshot, name), mcpPanel);
    // Native detail can retain its initial pending snapshot while the manager already knows the result.
    const settledRow = new RegExp('^\\s*(?:[>\\u276f\\u203a]\\s*)?' + mcpSettledGlyph + '\\s+' + escapePattern(name) + '(?:\\s+\\d+ tools?)?\\s*$', 'm');
    if (status.status === 'pending' && settledRow.test(mcpPanelLines(tx.snapshot())?.join('\n') ?? '')) {
      await this.selectServer(tx, name);
      await tx.key('\r', (snapshot) => this.exactSelected(snapshot, name) && settledRow.test(mcpPanelLines(snapshot)?.join('\n') ?? ''), (snapshot) => mcpDetail(snapshot, name));
      status = this.readDetail(tx.snapshot(), name);
      await tx.key('\x1b', (snapshot) => mcpDetail(snapshot, name), mcpPanel);
    }
    return status;
  }
  private readDetail(snapshot: NativeUiSnapshot, name: string): NativeMcpDialogStatus {
    const lines = mcpPanelLines(snapshot, name);
    if (!lines) throw new NativeControlGate('mcp.status.dialog', 'native MCP detail identity is ambiguous.');
    const detail = lines.join('\n');
    const matched = detail.match(new RegExp('^\\s*Status:\\s*(?:' + mcpStatusGlyph + '\\s+)?(connected|disabled|failed|needs authentication|needs-auth|pending|connecting)(\u2026|\\.{3})?\\s*$', 'mi'));
    const state = matched?.[1].toLowerCase();
    if (!state || matched?.[2] && state !== 'pending' && state !== 'connecting') throw new NativeControlGate('mcp.status.dialog', 'native connection state is not a verified layout.');
    const count = detail.match(/^\s*Tools:\s*(\d+) tools?\s*$/m);
    const status = state === 'needs authentication' ? 'needs-auth' : state === 'connecting' ? 'pending' : state;
    return { name, status: status as NativeMcpDialogStatus['status'], source: 'native-dialog', ...(count ? { toolCount: Number(count[1]) } : {}) };
  }
  private async readSettledDetail(tx: NativeUiTransaction, name: string, deadline: number): Promise<NativeMcpDialogStatus> {
    const snapshot = tx.snapshot();
    const initial = this.readDetail(snapshot, name);
    const remaining = deadline - Date.now();
    if (initial.status !== 'pending' || remaining <= 0) return initial;
    try {
      const settled = await tx.wait((next) => {
        try { return this.readDetail(next, name).status !== 'pending'; }
        catch (error) {
          if (error instanceof NativeControlGate && error.operation === 'mcp.status.dialog') return false;
          throw error;
        }
      }, { afterRevision: snapshot.revision, timeoutMs: remaining, stableMs: Math.min(80, remaining) });
      return this.readDetail(settled, name);
    } catch (error) {
      if (!(error instanceof NativeUiWaitTimeout)) throw error;
      // A slow connection is still pending, not a failed modal or proof of connectivity.
      return this.readDetail(tx.snapshot(), name);
    }
  }
  private async dismiss(tx: NativeUiTransaction, name: string): Promise<void> {
    await tx.key('\x1b', (s) => mcpDetail(s, name), mcpPanel);
    await tx.key('\x1b', mcpPanel, (s) => !mcpPanel(s) && !mcpDetail(s, name) && /\? for shortcuts/.test(s.text));
  }
}

export interface NativeWorkflowObservation {
  task: BackgroundTask;
  observedAgents: WorkflowAgent[];
  coverage: { phases: 'unobserved'; agents: 'observed-only'; replayedAgents: 'not-covered' };
}
interface WorkflowRun {
  task: BackgroundTask;
  agents: Map<number, WorkflowAgent>;
}

/** Records only native observations. agent.spawn alone cannot prove phases or journal replay. */
export class NativeWorkflowLedger {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly agentRuns = new Map<string, { runId: string; index: number }>();

  launch(result: unknown, toolUseId?: string): boolean {
    if (!record(result) || result.status !== 'async_launched' || result.taskType !== 'local_workflow' ||
      !text(result.taskId) || !text(result.runId)) return false;
    const runId = result.runId as string;
    const before = this.runs.get(runId);
    this.runs.set(runId, { task: { taskId: result.taskId as string, kind: 'workflow', taskType: 'local_workflow',
      description: text(result.workflowName) ?? text(result.summary) ?? result.taskId as string,
      status: before?.task.status ?? 'running', ...(text(result.workflowName) ? { workflowName: result.workflowName as string } : {}),
      ...(before?.task.durationMs !== undefined ? { durationMs: before.task.durationMs } : {}),
      ...(toolUseId ?? before?.task.toolUseId ? { toolUseId: toolUseId ?? before?.task.toolUseId } : {}) }, agents: before?.agents ?? new Map() });
    return true;
  }

  spawn(input: unknown, result: unknown): boolean {
    if (!record(input) || !record(input.workflow) || !record(result) || !text(result.agentId) ||
      !text(input.workflow.runId) || !integer(input.workflow.agentIndex)) return false;
    const runId = input.workflow.runId as string;
    const run = this.runs.get(runId);
    if (!run) return false;
    const index = input.workflow.agentIndex;
    const agentId = result.agentId as string;
    const previous = run.agents.get(index);
    if (previous?.agentId !== agentId) run.agents.set(index, { index, label: text(input.description) ?? `Agent ${index}`, state: 'running', agentId });
    this.agentRuns.set(agentId, { runId, index });
    return true;
  }

  complete(input: unknown): boolean {
    if (!record(input) || !text(input.agentId) || !['answer', 'aborted', 'refusal', 'error'].includes(String(input.reason))) return false;
    const owner = this.agentRuns.get(input.agentId as string);
    const agent = owner && this.runs.get(owner.runId)?.agents.get(owner.index);
    if (!agent) return false;
    agent.state = input.reason === 'answer' ? 'done' : 'failed';
    if (record(input.usage) && typeof input.usage.input_tokens === 'number' && typeof input.usage.output_tokens === 'number') {
      const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
      const counts = fields.map((field) => input.usage && record(input.usage) ? input.usage[field] : undefined);
      if (counts.every((count) => count === undefined || integer(count))) agent.tokens = counts.reduce<number>((sum, count) => sum + (typeof count === 'number' ? count : 0), 0);
    }
    return true;
  }

  notification(input: unknown): boolean {
    if (!record(input) || !text(input.id) || !text(input.status)) return false;
    const run = [...this.runs.values()].find((entry) => entry.task.taskId === input.id);
    if (!run) return false;
    const states: Record<string, BackgroundTask['status']> = { completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped' };
    const state = states[input.status as string];
    if (!state) return false;
    run.task.status = state;
    if (integer(input.durationMs)) run.task.durationMs = input.durationMs;
    return true;
  }

  snapshot(): NativeWorkflowObservation[] {
    return [...this.runs.values()].map((run) => ({ task: { ...run.task },
      observedAgents: [...run.agents.values()].sort((a, b) => a.index - b.index).map((agent) => ({ ...agent })),
      coverage: { phases: 'unobserved', agents: 'observed-only', replayedAgents: 'not-covered' } }));
  }
}

export interface NativeQueuedSend {
  id: string;
  priority: 'next' | 'later';
  delivered: Promise<void>;
}
export interface NativeQueueSnapshot {
  phase: 'idle' | 'held' | 'awaiting-start' | 'running' | 'stopping' | 'closed';
  mainTurnId?: string;
  pending: Array<{ id: string; priority: 'next' | 'later' }>;
}
interface PendingSend extends NativeQueuedSend {
  text: string;
  deliver?: NativeSendDelivery;
  done: boolean;
  resolve(): void;
  reject(reason: Error): void;
}
export type NativeSendDelivery = (id: string, signal: AbortSignal) => Promise<unknown>;
const TURN_COMPLETION_GRACE_MS = 3_000;
export interface NativeSendQueueOptions {
  sessionId: string;
  capabilities: readonly string[];
  port: NativeControlPort;
  newId?: () => string;
  maxPending?: number;
  isBlocked?(): boolean;
  /** Register transcript identity in actual delivery order, before any synchronous native echo. */
  onDispatch?(id: string, text: string): void;
  onState?(snapshot: NativeQueueSnapshot): void;
  onDeliveryError?(id: string, error: Error): void;
}

/** Hold later sends locally so a later native submission cannot overtake the user's next request. */
export class NativeSendQueue {
  private readonly options: NativeSendQueueOptions;
  private readonly pending: PendingSend[] = [];
  private readonly lifetime = new AbortController();
  private mainTurnId: string | undefined;
  private awaitingStart = false;
  private dispatching: PendingSend | undefined;
  private aborting: Promise<void> | undefined;
  private lastSequence = -1;
  private closed = false;

  constructor(options: NativeSendQueueOptions) {
    this.options = options;
    if (!options.sessionId) throw new Error('A native session identity is required.');
    if (options.maxPending !== undefined && (!integer(options.maxPending) || options.maxPending < 1)) throw new Error('Invalid pending-send capacity.');
  }

  submit(text: string, priority: 'next' | 'later' = 'next', deliver?: NativeSendDelivery): NativeQueuedSend {
    this.requireOpen('prompt.submit');
    if (!text.trim() && !deliver) throw new Error('Nothing to send.');
    if (/^\/[\w:-]+(?:\s|$)/.test(text.trimStart())) throw new NativeControlGate('prompt.command', 'slash commands need the native command dispatcher, not a model prompt.');
    if (priority !== 'next' && priority !== 'later') throw new Error('Invalid send priority.');
    if (this.pending.length + Number(Boolean(this.dispatching)) >= (this.options.maxPending ?? 64)) throw new Error('Native pending-send queue is full.');
    let resolve!: () => void, reject!: (error: Error) => void;
    const delivered = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // A GUI may await only acceptance and observe failures via onDeliveryError.
    void delivered.catch(() => undefined);
    const entry: PendingSend = { id: (this.options.newId ?? randomUUID)(), text, priority, delivered, resolve, reject, done: false, deliver };
    this.pending.push(entry);
    this.publish();
    if (priority === 'next' && this.mainTurnId) void this.abortMain().catch(() => undefined);
    else void this.drain();
    return { id: entry.id, priority, delivered };
  }

  observe(event: NativeEvent): void {
    if (this.closed || event.sessionId !== this.options.sessionId || !Number.isSafeInteger(event.sequence) || event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    if (!record(event.data) || event.data.agentId || !text(event.data.turnId)) return;
    if (event.event === 'turn.start') {
      this.mainTurnId = event.data.turnId as string;
      this.awaitingStart = false;
      this.publish();
      if (this.pending.some((entry) => entry.priority === 'next')) void this.abortMain().catch(() => undefined);
    } else if (event.event === 'turn.complete' && event.data.turnId === this.mainTurnId) {
      this.mainTurnId = undefined;
      this.awaitingStart = false;
      this.publish();
      queueMicrotask(() => { void this.drain(); });
    }
  }

  async interrupt(): Promise<void> {
    this.requireOpen('turn.abort');
    if (!this.mainTurnId) {
      if (this.awaitingStart) throw new NativeControlGate('turn.abort', 'the main native turn has not attested its identity yet.');
      return;
    }
    await this.abortMain();
  }

  snapshot(): NativeQueueSnapshot {
    return { phase: this.closed ? 'closed' : this.aborting && this.mainTurnId ? 'stopping' : this.mainTurnId ? 'running' : this.awaitingStart ? 'awaiting-start' : this.pending.length && this.options.isBlocked?.() ? 'held' : 'idle',
      ...(this.mainTurnId ? { mainTurnId: this.mainTurnId } : {}), pending: this.pending.map(({ id, priority }) => ({ id, priority })) };
  }

  refresh(): void { if (!this.closed) { this.publish(); void this.drain(); } }

  rejectPending(error: Error): void {
    for (const entry of this.pending.splice(0)) this.finish(entry, error);
    this.publish();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    const error = new Error('Native send queue closed before delivery.');
    for (const entry of this.pending.splice(0)) this.finish(entry, error);
    if (this.dispatching) this.finish(this.dispatching, error);
    this.publish();
  }

  private async abortMain(): Promise<void> {
    if (this.aborting) return this.aborting;
    const turnId = this.mainTurnId;
    if (!turnId || this.closed) return;
    const run = (async () => {
      try {
        this.requireOpen('turn.abort');
        const result = await this.options.port.request('turn.abort', { turnId }, { signal: this.lifetime.signal });
        if (record(result) && result.reason === 'not-running') {
          // The turn ended while its turn.complete was in flight; 'next' sends go out once it arrives.
          this.expectCompletion(turnId);
          return;
        }
        if (record(result) && (result.interrupted === false || text(result.deny))) throw new Error(text(result.deny) ?? 'Native main turn was not interrupted.');
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        // Never silently downgrade a failed next request into a later send or retry it.
        for (let index = this.pending.length - 1; index >= 0; index--) {
          if (this.pending[index].priority !== 'next') continue;
          const [entry] = this.pending.splice(index, 1);
          this.finish(entry, error);
        }
        throw error;
      }
    })();
    this.aborting = run;
    this.publish();
    try { await run; }
    finally {
      if (this.aborting === run) this.aborting = undefined;
      this.publish();
      if (!this.closed && !this.mainTurnId) void this.drain();
    }
  }

  /** A turn the bridge no longer runs must not hold the queue forever if its completion never arrives. */
  private expectCompletion(turnId: string): void {
    const timer = setTimeout(() => {
      if (this.closed || this.mainTurnId !== turnId) return;
      this.mainTurnId = undefined;
      this.awaitingStart = false;
      this.publish();
      void this.drain();
    }, TURN_COMPLETION_GRACE_MS);
    timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.closed || this.mainTurnId || this.awaitingStart || this.dispatching || this.aborting || this.options.isBlocked?.() || !this.pending.length) return;
    const nextIndex = this.pending.findIndex((entry) => entry.priority === 'next');
    const [entry] = this.pending.splice(nextIndex < 0 ? 0 : nextIndex, 1);
    this.dispatching = entry;
    this.awaitingStart = true;
    this.publish();
    try {
      this.options.onDispatch?.(entry.id, entry.text);
      const result = entry.deliver
        ? await entry.deliver(entry.id, this.lifetime.signal)
        : await this.options.port.request('prompt.submit', { text: entry.text, asUser: true }, { signal: this.lifetime.signal });
      if (record(result) && (text(result.drop) || text(result.deny))) throw new Error(text(result.drop) ?? text(result.deny));
      this.finish(entry);
    } catch (reason) {
      this.finish(entry, reason instanceof Error ? reason : new Error(String(reason)));
      if (!this.mainTurnId) this.awaitingStart = false;
    } finally {
      if (this.dispatching === entry) this.dispatching = undefined;
      this.publish();
      if (!this.mainTurnId && !this.awaitingStart) queueMicrotask(() => { void this.drain(); });
    }
  }
  private finish(entry: PendingSend, error?: Error): void {
    if (entry.done) return;
    entry.done = true;
    if (error) { entry.reject(error); if (!this.closed) this.options.onDeliveryError?.(entry.id, error); }
    else entry.resolve();
  }
  private requireOpen(capability: string): void {
    if (this.closed) throw new Error('Native send queue is closed.');
    if (!this.options.capabilities.includes(capability)) throw new NativeControlGate(capability, 'the attested native bridge does not expose this operation.');
  }
  private publish(): void { this.options.onState?.(this.snapshot()); }
}
