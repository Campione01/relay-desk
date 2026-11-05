import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, type PromptAttachment } from '../../shared/types.ts';
import type { NativeRuntime } from './contract.ts';
import type { PrivateLaunch, PrivateFileInfo, PrivateLaunchVerification } from './privateStorage.ts';

const MAX_RESERVED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' } as const;
type ImageType = keyof typeof EXTENSIONS;
type MediaType = ImageType | 'application/pdf';
type Expected = { type: 'image'; mediaType: ImageType; filename: string };
export class NativeAttachmentError extends Error { override name = 'NativeAttachmentError'; }
function error(message: string): NativeAttachmentError { return new NativeAttachmentError(message); }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw error('Attachment submission was cancelled.'); }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export interface NativeAttachmentDescriptor { type: 'image' | 'document'; mediaType: MediaType; filename: string; path: string; bytes: number; sha256: string; displayName?: string }
export interface NativePdfReference { type: 'document'; mediaType: 'application/pdf'; path: string; filename: string; sha256: string }
export interface NativePdfTools {
  readonly directory: string;
  readonly hashes: Readonly<Record<'pdfinfo.exe' | 'pdftoppm.exe', string>>;
  verify(): void;
  withEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}
export interface NativeComposerSnapshot { text: string; cursor: number }
export interface NativeAttachmentGuardStatus {
  id: string;
  state: 'armed' | 'accepted' | 'rejected' | 'cancelled';
  entered?: boolean;
  enteredText?: string;
  reason?: string;
  observed?: readonly { type: string; mediaType?: string; filename?: string }[];
  text?: string;
  origin?: { kind: string };
}
/** These callbacks must be backed by genuine native Mod APIs, not terminal-output parsing. */
export interface NativeAttachmentComposer {
  read(signal: AbortSignal): Promise<NativeComposerSnapshot>;
  replace(text: string, signal: AbortSignal): Promise<{ isFilled: boolean; text: string }>;
  arm(input: { id: string; expected: readonly Expected[]; references: readonly NativePdfReference[]; text: string }, signal: AbortSignal): Promise<{ id: string; armed: true; guard: 'native-before-model-v1' }>;
  status(id: string, signal: AbortSignal): Promise<NativeAttachmentGuardStatus>;
  disarm(id: string): Promise<void>;
}
/** Parent injects the native, handle-verified current-SID + SYSTEM private store. */
export interface NativeAttachmentStorage {
  createLaunch(): PrivateLaunch;
  writeBytes(launch: PrivateLaunch, bytes: Uint8Array, name: string): PrivateFileInfo;
  verify(launch: PrivateLaunch): PrivateLaunchVerification;
  removeLaunch(launch: PrivateLaunch): void;
}
export interface NativeAttachmentOptions {
  runtime: Pick<NativeRuntime, 'writeTerminal' | 'onEvent' | 'close'>;
  composer: NativeAttachmentComposer;
  /** Each message owns one launch; the parent retains ownership of store.dispose(). */
  storage: NativeAttachmentStorage;
  /** The SAME hash-bound dependency used to prepare this owned CLI child's environment. */
  pdfTools?: NativePdfTools;
  isBusy(): boolean;
  waitForIdle(signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
  maxReservedBytes?: number;
  /** Called before Enter so a synchronous native echo retains the GUI message identity. */
  onPrepared?(input: { id: string; nativeText: string; files: readonly NativeAttachmentDescriptor[] }): void;
  /** A failure here cannot recall the accepted prompt: it becomes an onWarning and the parent storage keeps the files. */
  onAccepted?(input: { id: string; launch: PrivateLaunch; nativeText: string; files: readonly NativeAttachmentDescriptor[] }): void | Promise<void>;
  /** Non-fatal problems after the CLI accepted a prompt, or a file cleanup failure while closing. */
  onWarning?(error: Error): void;
}
export interface NativeAttachmentReceipt { id: string; nativeText: string; files: readonly NativeAttachmentDescriptor[]; turnId?: string; pdf?: { state: 'native-read-required'; references: readonly NativePdfReference[]; retention: 'explicit-release-or-session-close'; resume: 'requires-parent-durable-assets' } }
export interface NativeAttachmentJob {
  id: string;
  queued: boolean;
  submitted: Promise<NativeAttachmentReceipt>;
  /** Before acceptance only. After acceptance the session's ordinary turn.abort owns cancellation. */
  cancel(): Promise<void>;
}
export interface NativeAttachmentSubmission { text: string; attachments: readonly PromptAttachment[]; queue?: boolean; signal?: AbortSignal }

/** Never changes global PATH, installs tools, or launches a model. All non-PATH entries are preserved. */
export function createNativePdfTools(options: { directory: string; hashes: Readonly<Record<'pdfinfo.exe' | 'pdftoppm.exe', string>> }): NativePdfTools {
  const directory = options.directory;
  const hashes = Object.freeze({ ...options.hashes });
  function verify(): void {
    if (!/^[A-Za-z]:\\/.test(directory) || directory !== win32.normalize(directory) || CONTROL.test(directory) || /[\r\n;]/.test(directory)) throw error('PDF tools require a canonical local directory.');
    for (let current = directory; ; current = win32.dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) throw error('PDF tools cannot follow reparse points.');
      if (win32.dirname(current) === current) break;
    }
    if (realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw error('PDF tool directory identity changed.');
    for (const name of ['pdfinfo.exe', 'pdftoppm.exe'] as const) {
      const full = win32.join(directory, name); const stat = lstatSync(full);
      if (!/^[a-f0-9]{64}$/.test(hashes[name]) || !stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(full)) !== hashes[name]) throw error(`PDF dependency hash did not match: ${name}`);
    }
  }
  verify();
  return Object.freeze({ directory, hashes, verify, withEnvironment(env: NodeJS.ProcessEnv) {
    verify(); const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
    if (keys.length > 1) throw error('Native child environment contains duplicate PATH keys.');
    const key = keys[0] ?? 'PATH'; const original = env[key] ?? '';
    return { ...env, [key]: original.split(';').some((part) => part.toLowerCase() === directory.toLowerCase()) ? original : `${original}${original ? ';' : ''}${directory}` };
  } });
}

export function validateNativeAttachmentSubmission(input: NativeAttachmentSubmission, pdfEnabled = false): Array<{ file: PromptAttachment; bytes: Buffer; mediaType: MediaType }> {
  if (typeof input.text !== 'string' || CONTROL.test(input.text) || /^\s*[!/]/.test(input.text)) throw error('Attachment text contains unsafe terminal controls or a terminal command.');
  if (Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw error('Native attachment prompt text exceeds 16 MiB.');
  if (!Array.isArray(input.attachments) || !input.attachments.length || input.attachments.length > MAX_PROMPT_ATTACHMENTS) throw error('A native attachment message requires one to ten files.');
  let total = 0;
  return input.attachments.map((file) => {
    const pdf = file?.kind === 'pdf';
    if (pdf && !pdfEnabled) throw error('Native PDF attachment requires the verified portable PDF tools in this CLI child; no text-only fallback was submitted.');
    if (!file || (pdf ? file.mediaType !== 'application/pdf' : file.kind !== 'image' || !Object.hasOwn(EXTENSIONS, file.mediaType))) throw error('Unsupported native attachment type.');
    const limit = pdf ? MAX_PDF_ATTACHMENT_BYTES : MAX_IMAGE_ATTACHMENT_BYTES;
    if (typeof file.data !== 'string' || file.data.length > Math.ceil(limit / 3) * 8 || /^data:/i.test(file.data)) throw error('Invalid native attachment data.');
    const data = file.data.replace(/[\r\n]/g, '');
    if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw error('Invalid native attachment base64.');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== data) throw error(`Native attachment is empty, noncanonical, or exceeds ${pdf ? '20' : '5'} MiB.`);
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw error('Native attachments together exceed 20 MiB.');
    const mediaType = file.mediaType as MediaType;
    const head = bytes.toString('latin1', 0, 12);
    const valid = pdf ? head.startsWith('%PDF-') : mediaType === 'image/png' ? head.startsWith('\x89PNG\r\n\x1a\n')
      : mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mediaType === 'image/gif' ? head.startsWith('GIF87a') || head.startsWith('GIF89a')
          : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
    if (!valid) throw error('Native attachment bytes do not match their media type.');
    if (file.name !== undefined && (typeof file.name !== 'string' || file.name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(file.name))) throw error('Invalid attachment display name.');
    return { file, bytes, mediaType };
  });
}

export function createNativeAttachmentAdapter(options: NativeAttachmentOptions) {
  type Job = { controller: AbortController; files: NativeAttachmentDescriptor[]; launch: PrivateLaunch; state: string; turnId?: string; ended: boolean; bytes: number; settled: Promise<void>; releasing?: Promise<void>; kept?: boolean };
  const jobs = new Map<string, Job>();
  let closed = false; let poisoned = false; let reserved = 0; let reservedJobs = 0; let tail: Promise<void> = Promise.resolve();
  let runtimeClosed = false; let closingRuntime: Promise<void> | undefined;
  let closingAdapter: Promise<void> | undefined;
  let committing: string | undefined;
  const isBusy = (): boolean => options.isBusy() || [...jobs.values()].some((job) => (job.state === 'accepted' || job.state === 'committing') && !job.ended);
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 15_000, 120_000));
  const capacity = Math.min(options.maxReservedBytes ?? MAX_RESERVED_BYTES, MAX_RESERVED_BYTES);
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(capacity) || capacity < 1) throw error('Native attachment limits must be finite and positive.');
  function closeRuntime(): Promise<void> {
    return closingRuntime ??= options.runtime.close().then(() => { runtimeClosed = true; });
  }
  function warn(cause: unknown): void {
    try { options.onWarning?.(cause instanceof Error ? cause : new Error(String(cause))); } catch { /* A diagnostic sink cannot change attachment ownership. */ }
  }
  function verifyFiles(job: Job): void {
    const receipt = options.storage.verify(job.launch);
    if (receipt.files.length !== job.files.length || !receipt.launch.protectedDacl || receipt.launch.inheritedAceCount !== 0) throw error('Private attachment launch verification failed.');
    for (const file of job.files) {
      const found = receipt.files.find((item) => item.path === file.path);
      if (!found || found.kind !== 'file' || !found.protectedDacl || found.inheritedAceCount !== 0 || found.linkCount !== 1 || found.byteLength !== file.bytes || found.sha256 !== file.sha256) throw error('Staged attachment identity, permissions, or bytes changed.');
    }
  }
  async function release(id: string, failed = false): Promise<void> {
    const job = jobs.get(id); if (!job) return;
    if (!failed && !job.ended && !runtimeClosed) throw error('Attachment files remain owned by an active native turn.');
    return job.releasing ??= Promise.resolve().then(() => { if (!job.kept) options.storage.removeLaunch(job.launch); }).finally(() => {
      jobs.delete(id); reserved -= job.bytes; reservedJobs--;
    });
  }
  const unsubscribe = options.runtime.onEvent((event) => {
    const data = event.data as { turnId?: string; agentId?: string };
    if (!data || data.agentId || typeof data.turnId !== 'string') return;
    if (event.event === 'turn.start' && committing) {
      const job = jobs.get(committing); if (job && !job.turnId) { job.turnId = data.turnId; committing = undefined; }
    }
    if (event.event === 'turn.complete') for (const [id, job] of jobs) {
      if (job.turnId === data.turnId) {
        job.ended = true;
        // A PDF may need a later native Read. Do not imply that merely mentioning it consumed it.
        if (!job.files.some((file) => file.type === 'document')) void job.settled.then(() => release(id)).catch(() => { poisoned = true; });
      }
    }
  });
  async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal: AbortSignal): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      aborted(signal); const value = await read(); aborted(signal);
      if (ready(value)) return value;
      if (Date.now() >= deadline) throw error('Native attachment ingestion was not confirmed before its deadline.');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  async function enqueue(input: NativeAttachmentSubmission): Promise<NativeAttachmentJob> {
    if (closed || poisoned) throw error('Native attachment adapter is closed or requires session recovery.');
    aborted(input.signal);
    const immutable = { text: input.text, attachments: input.attachments, queue: input.queue, signal: input.signal };
    const validated = validateNativeAttachmentSubmission(immutable, Boolean(options.pdfTools));
    if (validated.some((item) => item.file.kind === 'pdf')) options.pdfTools!.verify();
    const bytes = validated.reduce((sum, item) => sum + item.bytes.length, Buffer.byteLength(immutable.text));
    if (reservedJobs >= 128 || reserved + bytes > capacity) throw error('Native attachment staging capacity is exhausted.');
    reserved += bytes; reservedJobs++;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    immutable.signal?.addEventListener('abort', onAbort, { once: true });
    const id = randomUUID();
    const files: NativeAttachmentDescriptor[] = [];
    let launch: PrivateLaunch | undefined;
    try {
      aborted(controller.signal); launch = options.storage.createLaunch();
      if (!win32.isAbsolute(launch.path) || CONTROL.test(launch.path) || /[\r\n]/.test(launch.path) || launch.path.startsWith('\\\\')) throw error('Private attachment path is unsafe for terminal ingestion.');
      for (const [index, item] of validated.entries()) {
        aborted(controller.signal);
        const filename = `attachment-${index + 1}${item.mediaType === 'application/pdf' ? '.pdf' : EXTENSIONS[item.mediaType]}`;
        const info = options.storage.writeBytes(launch, item.bytes, filename);
        if (info.path !== win32.join(launch.path, filename) || info.sha256 !== hash(item.bytes) || info.byteLength !== item.bytes.length) throw error('Private attachment write receipt did not match.');
        files.push({ type: item.file.kind === 'pdf' ? 'document' : 'image', mediaType: item.mediaType, filename, path: info.path, bytes: item.bytes.length, sha256: info.sha256, ...(item.file.name ? { displayName: item.file.name } : {}) });
      }
    } catch (cause) {
      immutable.signal?.removeEventListener('abort', onAbort);
      try { if (launch) options.storage.removeLaunch(launch); }
      finally { reserved -= bytes; reservedJobs--; }
      throw cause;
    }
    const queued = Boolean(immutable.queue && isBusy());
    let resolveReceipt!: (value: NativeAttachmentReceipt) => void;
    let rejectReceipt!: (cause: unknown) => void;
    const submitted = new Promise<NativeAttachmentReceipt>((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject; });
    void submitted.catch(() => undefined);
    const job: Job = { controller, files, launch, state: 'staged', bytes, ended: false, settled: Promise.resolve() };
    jobs.set(id, job);
    const execute = async (): Promise<void> => {
      let touched = false; let guardAttempted = false;
      try {
        aborted(controller.signal);
        if (closed || poisoned) throw error('Native attachment session is unavailable.');
        if (isBusy()) {
          if (!immutable.queue) throw error('Interrupt the active turn before submitting native attachments.');
          while (isBusy()) {
            await options.waitForIdle(controller.signal); aborted(controller.signal);
            if (isBusy()) await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
        }
        const before = await options.composer.read(controller.signal);
        if (before.text || before.cursor) throw error('Native composer contains a draft; it was not overwritten.');
        verifyFiles(job);
        const images = files.filter((file) => file.type === 'image');
        const expected = images.map(({ mediaType, filename }) => ({ type: 'image' as const, mediaType: mediaType as ImageType, filename }));
        const references = files.filter((file) => file.type === 'document').map(({ path, filename, sha256 }) => ({ type: 'document' as const, mediaType: 'application/pdf' as const, path, filename, sha256 }));
        if (references.length) options.pdfTools!.verify();
        // Arm before any input mutation. The native hook MUST reject mismatches before next/model.
        guardAttempted = true;
        const arm = await options.composer.arm({ id, expected, references, text: immutable.text }, controller.signal);
        if (arm.id !== id || arm.armed !== true || arm.guard !== 'native-before-model-v1') throw error('Native pre-model attachment guard is unavailable.');
        let draft = before;
        for (const [index, file] of images.entries()) {
          aborted(controller.signal); touched = true;
          await options.runtime.writeTerminal(`\x1b[200~${file.path}\x1b[201~`);
          draft = await poll(() => options.composer.read(controller.signal), (snapshot) => {
            const tokens = snapshot.text.match(/\[Image #\d+\]/g) ?? [];
            return tokens.length === index + 1 && new Set(tokens).size === tokens.length && snapshot.text.replace(/\[Image #\d+\]/g, '').trim() === '';
          }, controller.signal);
        }
        const nativeText = [draft.text, ...references.map((file) => `@${file.path}`), immutable.text].filter(Boolean).join(' ');
        touched = true;
        const filled = await options.composer.replace(nativeText, controller.signal);
        if (!filled.isFilled || filled.text !== nativeText) throw error('Native composer did not retain the full attachment message.');
        options.onPrepared?.({ id, nativeText, files: files.map((file) => ({ ...file })) });
        aborted(controller.signal); committing = id; job.state = 'committing';
        await options.runtime.writeTerminal('\r');
        const status = await poll(() => options.composer.status(id, controller.signal), (value) => value.state !== 'armed', controller.signal);
        if (status.state === 'rejected' || status.state === 'cancelled') throw error(`Native attachment was not admitted: ${status.reason?.slice(0, 4096) ?? status.state}`);
        if (status.id !== id || status.state !== 'accepted' || status.entered !== true || status.origin?.kind !== 'composer' || status.text !== nativeText || status.observed?.length !== expected.length ||
          status.observed.some((item, index) => item.type !== 'image' || item.mediaType !== expected[index].mediaType || item.filename !== expected[index].filename)) {
          throw error('The native pre-model hook rejected the actual attachment metadata.');
        }
        job.state = 'accepted';
        try { await options.onAccepted?.({ id, launch: job.launch, nativeText, files: files.map((file) => ({ ...file })) }); }
        catch (cause) {
          job.kept = true;
          warn(error(`The message was sent, but its attachments could not be saved for resumed sessions: ${cause instanceof Error ? cause.message : String(cause)}`));
        }
        resolveReceipt({ id, files: files.map((file) => ({ ...file })), nativeText, ...(job.turnId ? { turnId: job.turnId } : {}), ...(references.length ? { pdf: { state: 'native-read-required' as const, references, retention: 'explicit-release-or-session-close' as const, resume: 'requires-parent-durable-assets' as const } } : {}) });
      } catch (cause) {
        try {
          let uncertainGuard = false;
          if (guardAttempted) await options.composer.disarm(id).catch(() => { uncertainGuard = true; });
          if (touched || uncertainGuard) {
            // No verified image-buffer reset API exists. Do not let a later bare prompt inherit it.
            poisoned = true; await closeRuntime();
          }
          await release(id, true); rejectReceipt(cause);
        } catch (cleanupError) { poisoned = true; rejectReceipt(cleanupError); }
      } finally {
        if (committing === id && job.state !== 'accepted') committing = undefined;
        immutable.signal?.removeEventListener('abort', onAbort);
      }
    };
    job.settled = tail.then(execute); tail = job.settled.catch(() => undefined);
    return { id, queued, submitted, async cancel() { if (job.state === 'accepted') throw error('Attachment prompt already entered; use native turn.abort.'); controller.abort(); await job.settled; } };
  }
  return {
    enqueue,
    async submit(input: NativeAttachmentSubmission): Promise<NativeAttachmentReceipt> { return (await enqueue(input)).submitted; },
    release(id: string): Promise<void> { return release(id); },
    retainedAssets() {
      return [...jobs.entries()].filter(([, job]) => job.state === 'accepted').map(([id, job]) => ({ id, turnComplete: job.ended, turnId: job.turnId, files: job.files.map((file) => ({ ...file })), retention: job.files.some((file) => file.type === 'document') ? 'explicit-release-or-session-close' as const : 'main-turn-complete' as const }));
    },
    /** Verifies ownership/identity before a native Read; does NOT override native permission policy. */
    verifyPdfRead(filePath: string): NativeAttachmentDescriptor | undefined {
      for (const job of jobs.values()) {
        const file = job.files.find((item) => item.type === 'document' && item.path.toLowerCase() === filePath.toLowerCase());
        if (file) { if (closed || poisoned || job.state !== 'accepted') throw error('Native PDF reference is no longer available.'); verifyFiles(job); options.pdfTools!.verify(); return { ...file }; }
      }
      return undefined;
    },
    close(): Promise<void> {
      return closingAdapter ??= (async () => {
        closed = true; for (const job of jobs.values()) job.controller.abort();
        await closeRuntime(); await tail; unsubscribe();
        for (const id of [...jobs.keys()]) await release(id).catch(warn);
      })();
    },
  };
}
