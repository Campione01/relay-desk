import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/types';

export interface PrivateHandleInfo {
  readonly path: string;
  readonly id: string;
  readonly ownerSid: string;
  readonly protectedDacl: boolean;
  readonly aceCount: number;
  readonly inheritedAceCount: number;
  readonly linkCount: number;
  readonly kind: 'directory' | 'file';
  readonly byteLength: number;
}
export interface PrivateFileInfo extends PrivateHandleInfo { readonly sha256: string }
export interface PrivateJsonInfo extends PrivateFileInfo {}
interface TaskReceipt { readonly prototypeRoot: string; readonly ancestors: readonly PrivateHandleInfo[]; readonly task: PrivateHandleInfo }
interface LaunchReceipt { readonly task: TaskReceipt; readonly launch: PrivateHandleInfo }
export interface PrivateLaunch { readonly path: string; readonly identity: string }
export interface PrivateLaunchRecord { readonly version: 1; readonly receipt: LaunchReceipt; readonly files: readonly PrivateFileInfo[] }
export interface PrivateState { readonly value: unknown; readonly file: PrivateFileInfo }
export interface PrivateLaunchVerification { readonly launch: PrivateHandleInfo; readonly files: readonly PrivateFileInfo[] }
export interface PrivateStorageOptions { helperPath: string; prototypeRoot: string; persistentKey?: string }

const BOUNDARY = 'C:\\RelayDeskNativePrototype';
const MAX_JSON_BYTES = 1024 * 1024;
const nonce = () => randomBytes(16).toString('hex');

export function assertPrivateStorageRoot(root: string): void {
  const prefix = root.toLowerCase();
  if ((prefix !== BOUNDARY.toLowerCase() && !prefix.startsWith(`${BOUNDARY.toLowerCase()}\\`))
    || root !== win32.normalize(root) || root.length > 512 || root.endsWith('\\')
    || !root.slice(3).split('\\').every((part) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(part))) {
    throw new Error('Private storage requires a canonical path inside C:\\RelayDeskNativePrototype.');
  }
}

/** Synchronous to fit session creation. Payloads travel only over the hidden helper's stdin. */
export function createPrivateStorage(options: PrivateStorageOptions) {
  if (process.platform !== 'win32') throw new Error('Native private storage requires Windows.');
  assertPrivateStorageRoot(options.prototypeRoot);
  if (!win32.isAbsolute(options.helperPath) || !options.helperPath.toLowerCase().endsWith('.exe')) throw new Error('An absolute private-storage helper executable is required.');
  if (options.persistentKey !== undefined && !/^[a-f0-9]{64}$/.test(options.persistentKey)) throw new Error('A persistent private-storage key must be a SHA-256 digest.');
  const prototypeRoot = options.prototypeRoot;
  let task: TaskReceipt | undefined;
  const launches = new Map<PrivateLaunch, { receipt: LaunchReceipt; files: PrivateFileInfo[]; jsonCount: number; attachmentCount: number; attachmentBytes: number; restored?: true }>();

  function invoke<T>(request: Record<string, unknown>): T {
    const child = spawnSync(options.helperPath, [], {
      input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, shell: false,
      cwd: prototypeRoot, timeout: 15_000, maxBuffer: request.command === 'read-state' ? 8 * 1024 * 1024 : 128 * 1024,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: prototypeRoot, TMP: prototypeRoot },
    });
    if (child.error || child.signal) throw new Error('Private storage helper failed or timed out; no unsafe fallback was attempted.');
    let response: { ok?: boolean; code?: string; result?: T };
    try { response = JSON.parse(child.stdout) as typeof response; }
    catch { throw new Error('Private storage helper returned an invalid receipt.'); }
    if (child.status !== 0 || response.ok !== true) {
      const code = typeof response.code === 'string' && /^[a-z0-9_]{1,80}$/.test(response.code) ? response.code : 'helper_failure';
      throw new Error(`Private storage refused: ${code}`);
    }
    return response.result as T;
  }
  function ensureTaskRoot(): PrivateHandleInfo {
    if (task) return invoke<PrivateHandleInfo>({ command: 'verify-task', task });
    task = invoke<TaskReceipt>(options.persistentKey
      ? { command: 'ensure-task', prototypeRoot, key: options.persistentKey }
      : { command: 'create-task', prototypeRoot, name: `private-task-${nonce()}` });
    return task.task;
  }
  function owned(launch: PrivateLaunch) {
    const state = launches.get(launch);
    if (!state) throw new Error('Private launch is not owned by this storage instance.');
    return state;
  }
  function createLaunch(): PrivateLaunch {
    ensureTaskRoot();
    const receipt = invoke<LaunchReceipt>({ command: 'create-launch', task, name: `launch-${nonce()}` });
    const launch = Object.freeze({ path: receipt.launch.path, identity: receipt.launch.id });
    launches.set(launch, { receipt, files: [], jsonCount: 0, attachmentCount: 0, attachmentBytes: 0 });
    return launch;
  }
  function writeJson(launch: PrivateLaunch, value: unknown, name = 'mcp.json'): PrivateJsonInfo {
    const state = owned(launch);
    if (!/^[a-z][a-z0-9-]{0,63}\.json$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.json$/.test(name)) throw new Error('Private JSON requires a simple non-device lowercase .json filename.');
    if (state.jsonCount >= 16) throw new Error('Private launch JSON file limit reached.');
    const content = JSON.stringify(value);
    if (content === undefined || Buffer.byteLength(content) > MAX_JSON_BYTES) throw new Error('Private JSON must be serializable and at most 1 MiB.');
    const info = invoke<PrivateJsonInfo>({ command: 'write-json', launch: state.receipt, name, content });
    if (info.sha256 !== createHash('sha256').update(content).digest('hex') || info.byteLength !== Buffer.byteLength(content)) throw new Error('Private storage content receipt did not match.');
    state.files.push(info);
    state.jsonCount += 1;
    return info;
  }
  function writeBytes(launch: PrivateLaunch, bytes: Uint8Array, name: string): PrivateFileInfo {
    const state = owned(launch);
    if (!/^[a-z][a-z0-9-]{0,63}\.(png|jpg|jpeg|webp|gif|pdf)$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./.test(name)) throw new Error('Private attachment requires a simple non-device lowercase image/PDF filename.');
    if (!(bytes instanceof Uint8Array)) throw new Error('Private attachment bytes must be a Uint8Array.');
    const maximum = name.endsWith('.pdf') ? MAX_PDF_ATTACHMENT_BYTES : MAX_IMAGE_ATTACHMENT_BYTES;
    if (bytes.byteLength > maximum) throw new Error(`Private attachment exceeds its ${maximum / 1024 / 1024} MiB file limit.`);
    if (state.attachmentCount >= MAX_PROMPT_ATTACHMENTS) throw new Error('Private launch attachment count exceeds 10.');
    if (state.attachmentBytes + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Private launch attachments exceed the cumulative 20 MiB limit.');
    // Snapshot only this view, not unrelated bytes before/after it in the backing buffer.
    const content = Buffer.from(bytes);
    const info = invoke<PrivateFileInfo>({ command: 'write-bytes', launch: state.receipt, name, contentBase64: content.toString('base64') });
    if (info.sha256 !== createHash('sha256').update(content).digest('hex') || info.byteLength !== content.byteLength) throw new Error('Private storage attachment receipt did not match.');
    state.files.push(info);
    state.attachmentCount += 1;
    state.attachmentBytes += content.byteLength;
    return info;
  }
  function verify(launch: PrivateLaunch): PrivateLaunchVerification {
    const state = owned(launch);
    const verified = invoke<PrivateLaunchVerification>({ command: 'verify-launch', launch: state.receipt, files: state.files });
    if (state.restored) {
      if (verified.files.length !== state.files.length || verified.files.some((file, index) => file.byteLength !== state.files[index].byteLength)) throw new Error('Private launch recorded size changed.');
      state.files = [...verified.files]; delete state.restored;
    }
    return verified;
  }
  function removeLaunch(launch: PrivateLaunch): void {
    const state = owned(launch);
    invoke({ command: 'remove-launch', launch: state.receipt, files: state.files });
    launches.delete(launch);
  }
  /** The current record without a helper call; exportLaunch is the verified form. */
  function describeLaunch(launch: PrivateLaunch): PrivateLaunchRecord {
    const state = owned(launch);
    return JSON.parse(JSON.stringify({ version: 1, receipt: state.receipt, files: state.files })) as PrivateLaunchRecord;
  }
  function exportLaunch(launch: PrivateLaunch): PrivateLaunchRecord {
    verify(launch);
    return describeLaunch(launch);
  }
  /** Registers a recorded launch without a helper call; its first verify() proves the recorded files and sizes. */
  function restoreLaunch(input: unknown): PrivateLaunch {
    // Every launch command re-verifies the task chain itself, so a known root needs no separate verify-task.
    if (!task) ensureTaskRoot();
    const record = input as PrivateLaunchRecord | undefined;
    if (!record || record.version !== 1 || !record.receipt?.task?.task || !record.receipt.launch
      || record.receipt.task.prototypeRoot !== prototypeRoot || record.receipt.task.task.path !== task!.task.path
      || record.receipt.task.task.id !== task!.task.id || !Array.isArray(record.files) || record.files.length > 26
      || record.files.some((file) => typeof file?.path !== 'string' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0)) throw new Error('Private launch record does not belong to this root.');
    const receipt = JSON.parse(JSON.stringify(record.receipt)) as LaunchReceipt;
    const files = JSON.parse(JSON.stringify(record.files)) as PrivateFileInfo[];
    const json = files.filter((file) => file.path.endsWith('.json'));
    const attachments = files.filter((file) => !file.path.endsWith('.json'));
    const attachmentBytes = attachments.reduce((total, file) => total + file.byteLength, 0);
    if (json.length > 16 || attachments.length > MAX_PROMPT_ATTACHMENTS || attachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Private launch record exceeds its limits.');
    const launch = Object.freeze({ path: receipt.launch.path, identity: receipt.launch.id });
    launches.set(launch, { receipt, files, jsonCount: json.length, attachmentCount: attachments.length, attachmentBytes, restored: true });
    return launch;
  }
  function readState(): PrivateState | undefined {
    if (!options.persistentKey) throw new Error('Private state requires an explicitly persistent store.');
    ensureTaskRoot();
    const result = invoke<{ file: PrivateFileInfo; content: string } | null>({ command: 'read-state', task });
    if (!result) return;
    try { return { file: result.file, value: JSON.parse(result.content) as unknown }; }
    catch { throw new Error('Private asset metadata is not valid JSON.'); }
  }
  function writeState(value: unknown, previous: PrivateFileInfo | null): PrivateFileInfo {
    if (!options.persistentKey) throw new Error('Private state requires an explicitly persistent store.');
    ensureTaskRoot();
    const content = JSON.stringify(value);
    if (content === undefined || Buffer.byteLength(content) > MAX_JSON_BYTES) throw new Error('Private asset metadata exceeds 1 MiB.');
    const info = invoke<PrivateFileInfo>({ command: 'write-state', task, content, previous });
    if (info.sha256 !== createHash('sha256').update(content).digest('hex') || info.byteLength !== Buffer.byteLength(content)) throw new Error('Private state write receipt did not match.');
    return info;
  }
  function forgetLaunch(launch: PrivateLaunch): void { owned(launch); launches.delete(launch); }
  function dispose(): void {
    if (options.persistentKey) throw new Error('Persistent private assets cannot be disposed as temporary storage.');
    for (const launch of launches.keys()) removeLaunch(launch);
    if (task) { invoke({ command: 'remove-task', task }); task = undefined; }
  }
  return { ensureTaskRoot, createLaunch, writeJson, writeBytes, verify, removeLaunch, describeLaunch, exportLaunch, restoreLaunch, readState, writeState, forgetLaunch, dispose };
}
