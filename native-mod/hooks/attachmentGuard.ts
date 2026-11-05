import type { PromptSubmitInput, PromptSubmitResult } from 'claude-code';

export const ATTACHMENT_TIMEOUT_MS = 30_000;
export const MAX_ATTACHMENT_TRANSACTIONS = 64;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const IMAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'],
};
const BACKGROUND_ORIGINS = new Set([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay',
  'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'slack-ping',
]);
interface ExpectedImage { type: 'image'; mediaType: string; filename: string }
interface PdfReference { type: 'document'; mediaType: 'application/pdf'; path: string; filename: string; sha256: string }
export interface AttachmentStatus {
  id: string;
  state: 'armed' | 'accepted' | 'rejected' | 'cancelled';
  observed?: Array<{ type: string; mediaType?: string; filename?: string; id?: string }>;
  text?: string;
  origin?: { kind: string };
  reason?: string;
  entered: boolean;
  enteredText?: string;
  enteredTextOmitted?: true;
}
interface Transaction {
  status: AttachmentStatus;
  expected: ExpectedImage[];
  references: PdfReference[];
  inputText?: string;
  expiresAt: number;
  bytes: number;
  validated: boolean;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected native attachment arguments');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unexpected native attachment argument');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new Error('Invalid native attachment transaction id');
  return value;
}
function safeText(value: unknown): string {
  if (typeof value !== 'string' || CONTROL.test(value) || /^\s*[!/]/.test(value) || new TextEncoder().encode(value).length > MAX_TEXT_BYTES) throw new Error('Unsafe native attachment prompt text');
  return value;
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
function safePdfPath(value: unknown, filename: string): string {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z]:\\/.test(value) || CONTROL.test(value) || /[\s/<>"|?*]/.test(value)) throw new Error('Invalid native PDF reference path');
  const parts = value.slice(3).split('\\');
  if (parts.at(-1) !== filename || parts.some((part) => !part || part === '.' || part === '..' || /[:. ]$/.test(part) || part.includes(':') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Native PDF reference must use a canonical generated filename');
  return value;
}
function snapshot(transaction: Transaction): AttachmentStatus {
  return { ...transaction.status, ...(transaction.status.origin ? { origin: { ...transaction.status.origin } } : {}), ...(transaction.status.observed ? { observed: transaction.status.observed.map((item) => ({ ...item })) } : {}) };
}

/** Metadata comes only from the engine's pinned prompt.submit event, never from model/VT text. */
export function createAttachmentGuard(now: () => number = () => Date.now()) {
  const transactions = new Map<string, Transaction>();
  let active: string | undefined;
  let retainedBytes = 0;
  function trim(required = 0): void {
    for (const [id, transaction] of transactions) {
      if (transactions.size < MAX_ATTACHMENT_TRANSACTIONS && retainedBytes + required <= MAX_STATE_BYTES) break;
      if (id === active) continue;
      transactions.delete(id); retainedBytes -= transaction.bytes;
    }
    if (retainedBytes + required > MAX_STATE_BYTES) throw new Error('Native attachment guard capacity exhausted');
  }
  function settle(transaction: Transaction, state: AttachmentStatus['state'], reason?: string): void {
    retainedBytes -= transaction.bytes;
    transaction.inputText = undefined;
    transaction.expected = []; transaction.references = [];
    transaction.status.state = state;
    if (state !== 'accepted') transaction.status.entered = false;
    if (reason) transaction.status.reason = reason;
    transaction.bytes = bytes(transaction.status);
    retainedBytes += transaction.bytes;
    if (active === transaction.status.id) active = undefined;
    trim();
  }
  function cancelActive(reason: string): AttachmentStatus | undefined {
    const transaction = active ? transactions.get(active) : undefined;
    if (!transaction) return undefined;
    settle(transaction, 'cancelled', reason); return snapshot(transaction);
  }
  function expire(): void {
    if (active && now() >= transactions.get(active)!.expiresAt) cancelActive('Native attachment transaction expired');
  }
  function owned(value: unknown): Transaction {
    expire(); const transaction = transactions.get(identifier(value));
    if (!transaction) throw new Error('Unknown or expired native attachment transaction');
    return transaction;
  }
  function matchesText(transaction: Transaction, value: string): boolean {
    if (typeof value !== 'string' || CONTROL.test(value) || new TextEncoder().encode(value).length > MAX_TEXT_BYTES + 16 * 1024) return false;
    const tail = [...transaction.references.map((reference) => `@${reference.path}`), transaction.inputText ?? ''].filter(Boolean).join(' ');
    const suffix = tail ? `${transaction.expected.length ? ' ' : ''}${tail}` : '';
    if (suffix && !value.endsWith(suffix)) return false;
    const prefix = suffix ? value.slice(0, -suffix.length) : value;
    const tokens = prefix.match(/\[Image #\d+\]/g) ?? [];
    return prefix.length <= 1024 && tokens.length === transaction.expected.length && new Set(tokens).size === tokens.length && /^ *(?:\[Image #\d+\] *)*$/.test(prefix);
  }
  return {
    isArmed(): boolean { expire(); return active !== undefined; },
    activeId(): string | undefined { expire(); return active; },
    arm(value: unknown) {
      expire(); const args = record(value); exactKeys(args, ['id', 'expected', 'references', 'text']);
      const id = identifier(args.id);
      if (active) throw new Error('Another native attachment transaction owns the composer');
      if (transactions.has(id)) throw new Error('Native attachment transaction id was already used');
      const inputText = safeText(args.text);
      if (!Array.isArray(args.expected) || !Array.isArray(args.references) || args.expected.length + args.references.length < 1 || args.expected.length + args.references.length > 10) throw new Error('Native attachment transaction requires one to ten owned files');
      const names = new Set<string>(); const paths = new Set<string>();
      const expected: ExpectedImage[] = args.expected.map((value) => {
        const item = record(value); exactKeys(item, ['type', 'mediaType', 'filename']);
        const match = typeof item.filename === 'string' ? /^attachment-(?:[1-9]|10)\.(png|jpg|jpeg|gif|webp)$/.exec(item.filename) : null;
        if (item.type !== 'image' || typeof item.mediaType !== 'string' || !Object.hasOwn(IMAGE_EXTENSIONS, item.mediaType) || !match || !IMAGE_EXTENSIONS[item.mediaType].includes(match[1]) || names.has(String(item.filename))) throw new Error('Invalid or duplicate native image descriptor');
        names.add(item.filename as string);
        return { type: 'image', mediaType: item.mediaType, filename: item.filename as string };
      });
      const references: PdfReference[] = args.references.map((value) => {
        const item = record(value); exactKeys(item, ['type', 'mediaType', 'path', 'filename', 'sha256']);
        if (item.type !== 'document' || item.mediaType !== 'application/pdf' || typeof item.filename !== 'string' || !/^attachment-(?:[1-9]|10)\.pdf$/.test(item.filename) || names.has(item.filename) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid native PDF reference descriptor');
        const path = safePdfPath(item.path, item.filename);
        if (paths.has(path.toLowerCase())) throw new Error('Duplicate native PDF reference');
        names.add(item.filename); paths.add(path.toLowerCase());
        return { type: 'document', mediaType: 'application/pdf', path, filename: item.filename, sha256: item.sha256 };
      });
      const size = bytes({ id, expected, references, inputText }); trim(size);
      const transaction: Transaction = { status: { id, state: 'armed', entered: false }, expected, references, inputText, expiresAt: now() + ATTACHMENT_TIMEOUT_MS, bytes: size, validated: false };
      transactions.set(id, transaction); retainedBytes += size; active = id;
      return { id, armed: true as const, guard: 'native-before-model-v1' as const };
    },
    status(value: unknown): AttachmentStatus { return snapshot(owned(value)); },
    disarm(value: unknown): AttachmentStatus {
      const transaction = owned(value);
      if (transaction.status.state === 'accepted') throw new Error('Native attachment prompt already entered; use turn.abort');
      if (transaction.status.id === active) settle(transaction, 'cancelled', 'Native attachment transaction cancelled');
      return snapshot(transaction);
    },
    validateFill(value: unknown): string {
      expire(); if (!active) throw new Error('No armed native attachment transaction owns the composer');
      if (transactions.get(active)!.validated) throw new Error('Native attachment transaction is awaiting core entry');
      const text = safeText(value);
      if (!matchesText(transactions.get(active)!, text)) throw new Error('Native attachment fill does not match its owned transaction');
      return text;
    },
    checkPrompt(event: PromptSubmitInput, blockedReason?: string): { reason?: string; checked?: AttachmentStatus; transactionId?: string } {
      expire();
      const transaction = active ? transactions.get(active) : undefined;
      if (!transaction) return { reason: blockedReason ?? (event.attachments?.length ? 'Native attachments require an armed owned transaction' : undefined) };
      if (!blockedReason && !event.command && !event.attachments?.length && (BACKGROUND_ORIGINS.has(event.origin?.kind) || (event.origin?.kind === 'unclassified' && event.isMeta))) return {};
      if (transaction.validated) return { reason: blockedReason ?? 'Native attachment transaction is awaiting core entry' };
      const observed = (event.attachments ?? []).map(({ type, mediaType, filename, id }) => ({ type, mediaType, filename, id }));
      const expected = transaction.expected;
      const match = !blockedReason && event.origin?.kind === 'composer' && !event.command && !event.isMeta && event.turnId === undefined && matchesText(transaction, event.text) && observed.length === expected.length && observed.every((item, index) => item.type === 'image' && item.mediaType === expected[index].mediaType && item.filename === expected[index].filename);
      transaction.status.observed = observed;
      transaction.status.text = typeof event.text === 'string' && bytes(event.text) <= MAX_TEXT_BYTES + 32 * 1024 ? event.text : '';
      transaction.status.origin = { kind: event.origin?.kind ?? 'unclassified' };
      const reason = blockedReason ?? (match ? undefined : 'Native attachment metadata, text, or composer ownership did not match');
      if (!match) { settle(transaction, 'rejected', reason); return { reason, checked: snapshot(transaction) }; }
      retainedBytes -= transaction.bytes;
      transaction.validated = true;
      transaction.inputText = undefined; transaction.expected = []; transaction.references = [];
      transaction.bytes = bytes(transaction.status); retainedBytes += transaction.bytes;
      trim();
      return { checked: snapshot(transaction), transactionId: transaction.status.id };
    },
    complete(value: string, result: PromptSubmitResult): AttachmentStatus | undefined {
      expire(); const transaction = transactions.get(value);
      if (!transaction || !transaction.validated || transaction.status.state !== 'armed') return undefined;
      if (result && typeof result === 'object' && 'drop' in result) {
        settle(transaction, 'rejected', `Native prompt was dropped downstream: ${String(result.drop).slice(0, 1024)}`);
      } else if (result && typeof result === 'object' && typeof result.text === 'string') {
        transaction.status.entered = true;
        if (result.text !== transaction.status.text) {
          if (bytes(result.text) <= 64 * 1024) transaction.status.enteredText = result.text;
          else transaction.status.enteredTextOmitted = true;
        }
        settle(transaction, 'accepted');
      } else settle(transaction, 'rejected', 'Native core did not confirm prompt entry');
      return snapshot(transaction);
    },
    reject(value: string, reason: string): AttachmentStatus | undefined {
      const transaction = transactions.get(value);
      if (!transaction || transaction.status.state !== 'armed') return undefined;
      settle(transaction, 'rejected', reason); return snapshot(transaction);
    },
    cancelActive,
    clear(): void { active = undefined; transactions.clear(); retainedBytes = 0; },
  };
}
