import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '@shared/events';
import type {
  PermissionDecision,
  PermissionRequest,
  Question,
  QuestionAnswer,
  QuestionOption,
  QuestionRequest,
} from '@shared/types';
import { DENIAL_PREFIX, isRecord, str } from './mapTranscript';

/** Message the model receives for a denial; same wording as the CLI's own rejection. */
export function denialMessage(userMessage?: string): string {
  const note = userMessage?.trim();
  const rejected = `${DENIAL_PREFIX} The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).`;
  return note
    ? `${rejected} To tell you how to proceed, the user said:\n${note}`
    : `${rejected} STOP what you are doing and wait for the user to tell you how to proceed.`;
}

export const QUESTION_DISMISSED_MESSAGE = 'The user dismissed the question without answering.';

export interface BrokerOptions {
  /** Pending request count changed (drives the 'awaiting' state). */
  onPendingChange?(count: number): void;
  /** A request was settled by the user (not cancelled). */
  onDecision?(info: { toolUseId?: string; behavior: 'allow' | 'deny' }): void;
  newRequestId?(): string;
}

type Pending =
  | { kind: 'permission'; resolve(d: PermissionDecision): void }
  | { kind: 'question'; resolve(a: QuestionAnswer | null): void };

interface Entry {
  pending: Pending;
  cancel(message: string): void;
  /** The permission or question event the renderer was sent. */
  event?: EngineEvent;
}

/** Parses AskUserQuestion input; undefined when it is not the documented shape. */
export function parseQuestions(input: Record<string, unknown>): Question[] | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const questions: Question[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || !Array.isArray(raw.options)) return undefined;
    const options: QuestionOption[] = [];
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.label !== 'string') return undefined;
      const description = str(option.description);
      const preview = str(option.preview);
      options.push({ label: option.label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) });
    }
    const header = str(raw.header);
    questions.push({ question: raw.question, ...(header ? { header } : {}), multiSelect: raw.multiSelect === true, options });
  }
  return questions;
}

/** "Allow for this session" must not persist rules to settings files, so every update targets the session. */
function sessionScoped(suggestions: readonly PermissionUpdate[]): PermissionUpdate[] {
  return suggestions.map((update) => ({ ...update, destination: 'session' }));
}

/**
 * The CLI suggests a rule only for a named workflow, so a script Claude wrote could never be allowed for the session.
 * Those launches get the tool-wide rule instead (like the desktop card's Always); a launch the
 * CLI marks as never-always-allowed keeps none.
 */
const WORKFLOW_SESSION_RULE: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'Workflow' }],
  behavior: 'allow',
  destination: 'session',
};

function suggestionsFor(toolName: string, given: readonly PermissionUpdate[] | undefined, suppressed: boolean): PermissionUpdate[] {
  if (toolName === 'Workflow' && !given?.length && !suppressed) return [WORKFLOW_SESSION_RULE];
  return [...(given ?? [])];
}

/**
 * canUseTool for one handle: AskUserQuestion -> `question` event, other tools -> `permission` event.
 * Pending requests resolve as deny on abort or close.
 */
export class PermissionBroker {
  readonly handleId: string;
  protected readonly emit: (event: EngineEvent) => void;
  private readonly options: BrokerOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(handleId: string, emit: (event: EngineEvent) => void, options: BrokerOptions = {}) {
    this.handleId = handleId;
    this.emit = emit;
    this.options = options;
  }

  get pendingCount(): number {
    return this.entries.size;
  }

  readonly canUseTool: CanUseTool = (toolName, input, context) => {
    const { signal } = context;
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'The request was cancelled.' });
    const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : undefined;
    const requestId = this.options.newRequestId?.() ?? randomUUID();
    const toolUseId = context.toolUseID;
    const suppressed = context.suppressAlwaysAllowRule === true;
    const suggestions = suggestionsFor(toolName, context.suggestions, suppressed);

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        this.settle(requestId, (entry) => entry.cancel('The request was cancelled.'));
      };
      const finish = (result: PermissionResult): void => {
        signal.removeEventListener('abort', onAbort);
        resolve({ ...result, toolUseID: toolUseId });
      };

      let pending: Pending;
      if (questions) {
        pending = {
          kind: 'question',
          resolve: (answer) => {
            const answered = answer !== null && Object.keys(answer).length > 0;
            this.options.onDecision?.({ toolUseId, behavior: answered ? 'allow' : 'deny' });
            finish(
              answered
                ? { behavior: 'allow', updatedInput: { ...input, answers: { ...answer } }, decisionClassification: 'user_temporary' }
                : { ...deny(QUESTION_DISMISSED_MESSAGE), decisionClassification: 'user_reject' },
            );
          },
        };
      } else {
        pending = {
          kind: 'permission',
          resolve: (decision) => {
            this.options.onDecision?.({ toolUseId, behavior: decision.behavior });
            finish(this.toResult(decision, input, suggestions, suppressed));
          },
        };
      }

      const entry: Entry = {
        pending,
        cancel: (message) => finish(deny(message)),
      };
      this.entries.set(requestId, entry);
      signal.addEventListener('abort', onAbort, { once: true });

      if (questions) {
        const request: QuestionRequest = { requestId, handleId: this.handleId, questions, toolUseId };
        entry.event = { type: 'question', request };
        this.emit(entry.event);
      } else {
        const request: PermissionRequest = {
          requestId,
          handleId: this.handleId,
          toolName,
          input,
          toolUseId,
          ...optional('title', context.title),
          ...optional('displayName', context.displayName),
          ...optional('description', context.description),
          ...optional('decisionReason', context.decisionReason),
          ...optional('blockedPath', context.blockedPath),
          ...optional('agentId', context.agentID),
          ...(context.defaultToNo ? { defaultToNo: true } : {}),
          ...(suppressed ? { suppressAlwaysAllowRule: true } : {}),
          ...(suggestions.length ? { suggestions: [...suggestions] } : {}),
        };
        entry.event = { type: 'permission', request };
        this.emit(entry.event);
      }
      this.options.onPendingChange?.(this.entries.size);
    });
  };

  private toResult(
    decision: PermissionDecision,
    input: Record<string, unknown>,
    suggestions: readonly PermissionUpdate[],
    suppressSessionScope: boolean,
  ): PermissionResult {
    if (decision.behavior === 'deny') {
      return { ...deny(denialMessage(decision.message)), decisionClassification: 'user_reject' };
    }
    const updatedInput = isRecord(decision.updatedInput) ? decision.updatedInput : input;
    if (decision.scope === 'session' && !suppressSessionScope && suggestions.length > 0) {
      return {
        behavior: 'allow',
        updatedInput,
        updatedPermissions: sessionScoped(suggestions),
        decisionClassification: 'user_permanent',
      };
    }
    return { behavior: 'allow', updatedInput, decisionClassification: 'user_temporary' };
  }

  /** Runs `resolve` once for a pending request, drops it and tells the renderer. */
  private settle(requestId: string, resolve: (entry: Entry) => void): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.entries.delete(requestId);
    resolve(entry);
    this.emit({ type: 'requestClosed', handleId: this.handleId, requestId });
    this.options.onPendingChange?.(this.entries.size);
    return true;
  }

  /** True when `requestId` is pending here. */
  has(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  /** Settles a permission request; false when it is not pending here. */
  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.entries.get(requestId)?.pending;
    if (pending?.kind !== 'permission') return false;
    return this.settle(requestId, () => pending.resolve(decision));
  }

  /** Settles a question; null = dismissed. False when it is not pending here. */
  respondQuestion(requestId: string, answer: QuestionAnswer | null): boolean {
    const pending = this.entries.get(requestId)?.pending;
    if (pending?.kind !== 'question') return false;
    return this.settle(requestId, () => pending.resolve(answer));
  }

  /** Sends every pending request again, for a renderer that adopts this handle anew. */
  republish(): void {
    for (const entry of this.entries.values()) if (entry.event) this.emit(entry.event);
  }

  /** Denies every pending request (handle closing). */
  cancelAll(reason: string): void {
    for (const requestId of [...this.entries.keys()]) {
      this.settle(requestId, (entry) => entry.cancel(reason));
    }
  }
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value ? { [key]: value } : {}) as { [P in K]?: string };
}
