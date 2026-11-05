import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { utilityProcess } from 'electron';
import { MAX_HISTORY_CURSOR, type BackgroundTask, type HistoryPage, type Profile, type SessionSummary, type TranscriptItem } from '@shared/types';
import { buildChildEnv } from '../system/env';
import { deriveHistoryTasks } from './historyTasks';
import { imageStore, storeImageBlocks, type ImageStore } from './images';
import { AUTO_CONTINUE_PROMPT, isRecord, mapSessionMessages } from './mapTranscript';
import { redactSecrets, StderrLines } from './redaction';

/** main -> listing worker (utilityProcess parentPort message). */
export type ListingRequest =
  | { id: number; op: 'list' }
  /** The SDK's history of the latest compaction segment with its subagents (task list). */
  | { id: number; op: 'history'; sessionId: string; cwd?: string }
  /** One page of the whole history: without `before` the newest. */
  | { id: number; op: 'page'; sessionId: string; cwd?: string; before?: string }
  | { id: number; op: 'subagent'; sessionId: string; agentId: string; cwd?: string }
  | { id: number; op: 'rename'; sessionId: string; title: string; cwd?: string }
  | { id: number; op: 'fork'; sessionId: string; cwd?: string }
  | { id: number; op: 'delete'; sessionId: string; cwd?: string };

/** listing worker -> main. */
export type ListingResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** Distributes Omit over the request union. */
type RequestBody = ListingRequest extends infer R ? (R extends ListingRequest ? Omit<R, 'id'> : never) : never;

/**
 * Per-profile session listing. listSessions() reads CLAUDE_CONFIG_DIR from its process env, so each
 * profile gets its own utilityProcess, started with the environment of the profile's saved CLI sign-in: a reader of
 * saved sessions never gets the launch-environment authentication values.
 */
export interface ListingClient {
  list(profile: Profile): Promise<SessionSummary[]>;
  /** One page of a saved session across its compactions: the newest without `before`, else the page before that cursor. */
  history(profile: Profile, sessionId: string, cwd?: string, before?: string): Promise<HistoryPage>;
  rename(profile: Profile, sessionId: string, title: string): Promise<void>;
  /** A copy of the session under a new id (SDK forkSession). */
  fork(profile: Profile, sessionId: string, cwd?: string): Promise<string>;
  delete(profile: Profile, sessionId: string, cwd?: string): Promise<void>;
  /** Background tasks derived from the saved history (U5). */
  tasks(profile: Profile, sessionId: string, cwd?: string): Promise<BackgroundTask[]>;
  /** One subagent's own transcript, mapped as a main thread (its calls still running stay running). */
  subagent(profile: Profile, sessionId: string, agentId: string, cwd?: string): Promise<TranscriptItem[]>;
  /** Kills the workers. */
  dispose(): void;
}

/** Structural subset of Electron's UtilityProcess. */
export interface WorkerProcess {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type ForkWorker = (modulePath: string, env: NodeJS.ProcessEnv, serviceName: string) => WorkerProcess;

export interface ListingDeps {
  fork?: ForkWorker;
  buildEnv?(profile: Profile): NodeJS.ProcessEnv;
  /** Per request. */
  timeoutMs?: number;
  /** A worker with no pending request exits after this long. */
  idleMs?: number;
  /** Worker stderr lines. */
  log?(line: string): void;
  /** Where history images go; the process-wide store by default. */
  images?: ImageStore;
}

export const LISTING_TIMEOUT_MS = 30_000;
export const LISTING_IDLE_MS = 60_000;

const forkUtility: ForkWorker = (modulePath, env, serviceName) =>
  utilityProcess.fork(modulePath, [], { env, serviceName, stdio: 'pipe' });

interface Pending {
  worker: WorkerProcess;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One reused utilityProcess per profile: request ids, timeouts, idle shutdown, restart after a crash. */
class ProfileWorker {
  private worker: WorkerProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly spawn: () => WorkerProcess,
    private readonly timeoutMs: number,
    private readonly idleMs: number,
    private readonly log: (line: string) => void,
  ) {}

  request(body: RequestBody): Promise<unknown> {
    this.clearIdle();
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error('Reading the session list timed out.'));
        this.stop(worker, 'The session list reader was restarted after a timeout.');
      }, this.timeoutMs);
      this.pending.set(id, { worker, resolve, reject, timer });
      try {
        worker.postMessage({ ...body, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
        this.stop(worker, 'The session list reader could not be reached.');
      }
    });
  }

  private ensure(): WorkerProcess {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.worker = worker;
    worker.on('message', (message) => this.onMessage(message));
    worker.on('exit', (code) => this.fail(worker, `The session list reader stopped unexpectedly (exit code ${code}).`));
    worker.stdout?.on('data', () => undefined);
    const stderr = new StderrLines((line) => {
      if (line.trim()) this.log(redactSecrets(line));
    });
    worker.stderr?.on('data', (chunk: Buffer | string) => stderr.write(String(chunk)));
    worker.stderr?.once('end', () => stderr.flush());
    worker.stderr?.once('close', () => stderr.flush());
    return worker;
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(new Error(typeof message.error === 'string' ? redactSecrets(message.error) : 'Session listing failed.'));
    if (this.pending.size === 0) this.scheduleIdle();
  }

  /** Forgets `worker` and rejects what it still owed. */
  private fail(worker: WorkerProcess, reason: string): void {
    if (this.worker === worker) this.worker = undefined;
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  /** Kills `worker`; the next request starts a fresh one. */
  private stop(worker: WorkerProcess, reason: string): void {
    this.fail(worker, reason);
    try {
      worker.kill();
    } catch {
      // already gone
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker && this.pending.size === 0) this.stop(this.worker, 'The session list reader was idle.');
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  dispose(): void {
    this.clearIdle();
    if (this.worker) this.stop(this.worker, 'The session list reader was closed.');
  }
}

function asSummaries(result: unknown): SessionSummary[] {
  if (!Array.isArray(result)) throw new Error('The session list reader returned an unexpected answer.');
  return result.filter((s): s is SessionSummary => isRecord(s) && typeof s.sessionId === 'string');
}

/** The CLI keeps the resume prompt of an automatic continue as the session's last prompt, which the SDK lists as its title. */
function withoutResumeTitle(summary: SessionSummary): SessionSummary {
  if (summary.title !== AUTO_CONTINUE_PROMPT) return summary;
  const first = summary.firstPrompt?.trim();
  return { ...summary, title: first && first !== AUTO_CONTINUE_PROMPT ? first : '' };
}

const UNEXPECTED_HISTORY = 'The session history reader returned an unexpected answer.';

function asMessages(result: unknown): SessionMessage[] {
  if (!isRecord(result) || !Array.isArray(result.messages)) throw new Error(UNEXPECTED_HISTORY);
  return result.messages as SessionMessage[];
}

function asPage(result: unknown): { messages: SessionMessage[]; older?: string } {
  const messages = asMessages(result);
  const older = isRecord(result) ? result.older : undefined;
  if (older === undefined) return { messages };
  if (typeof older !== 'string' || !older || older.length > MAX_HISTORY_CURSOR) throw new Error(UNEXPECTED_HISTORY);
  return { messages, older };
}

export function createListingClient(workerPath: string, deps: ListingDeps = {}): ListingClient {
  const fork = deps.fork ?? forkUtility;
  const buildEnv = deps.buildEnv ?? ((profile: Profile) => buildChildEnv(profile));
  const log = deps.log ?? ((line: string) => console.warn(`[relay:listing] ${line}`));
  const images = deps.images ?? imageStore;
  const workers = new Map<string, ProfileWorker>();

  const workerFor = (profile: Profile): ProfileWorker => {
    const key = `${profile.id}\u0000${profile.configDir ?? ''}`;
    let worker = workers.get(key);
    if (!worker) {
      worker = new ProfileWorker(
        () => fork(workerPath, buildEnv({ ...profile, authenticationSource: 'cli-config' }), `relay-listing-${profile.id}`),
        deps.timeoutMs ?? LISTING_TIMEOUT_MS,
        deps.idleMs ?? LISTING_IDLE_MS,
        log,
      );
      workers.set(key, worker);
    }
    return worker;
  };

  return {
    async list(profile) {
      return asSummaries(await workerFor(profile).request({ op: 'list' })).map(withoutResumeTitle);
    },
    async history(profile, sessionId, cwd, before) {
      const result = await workerFor(profile).request({
        op: 'page',
        sessionId,
        ...(cwd ? { cwd } : {}),
        ...(before !== undefined ? { before } : {}),
      });
      const page = asPage(result);
      const items = mapSessionMessages(page.messages, {
        ...(cwd ? { cwd } : {}),
        sessionId,
        storeImages: (content, keyPrefix) => storeImageBlocks(content, keyPrefix, images),
        settleOpenTools: true,
        ...(before !== undefined ? { settleTrailingTools: true } : {}),
      });
      return { items, ...(page.older ? { older: page.older } : {}) };
    },
    async rename(profile, sessionId, title) {
      await workerFor(profile).request({ op: 'rename', sessionId, title });
    },
    async fork(profile, sessionId, cwd) {
      const result = await workerFor(profile).request({ op: 'fork', sessionId, ...(cwd ? { cwd } : {}) });
      const forked = (result as { sessionId?: unknown } | null)?.sessionId;
      if (typeof forked !== 'string' || !forked) throw new Error('The session history reader returned an unexpected answer.');
      return forked;
    },
    async delete(profile, sessionId, cwd) {
      await workerFor(profile).request({ op: 'delete', sessionId, ...(cwd ? { cwd } : {}) });
    },
    async tasks(profile, sessionId, cwd) {
      const result = await workerFor(profile).request({ op: 'history', sessionId, ...(cwd ? { cwd } : {}) });
      return deriveHistoryTasks(asMessages(result));
    },
    async subagent(profile, sessionId, agentId, cwd) {
      const result = await workerFor(profile).request({ op: 'subagent', sessionId, agentId, ...(cwd ? { cwd } : {}) });
      // Shown on its own, a subagent's messages are its main thread, not calls nested under the parent's Agent call.
      const messages = asMessages(result).map((message) => ({ ...message, parent_tool_use_id: null }));
      return mapSessionMessages(messages, {
        ...(cwd ? { cwd } : {}),
        sessionId,
        storeImages: (content, keyPrefix) => storeImageBlocks(content, keyPrefix, images),
      });
    },
    dispose() {
      for (const worker of workers.values()) worker.dispose();
      workers.clear();
    },
  };
}
