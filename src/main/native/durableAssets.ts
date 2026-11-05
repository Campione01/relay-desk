import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { createPrivateStorage } from './privateStorage';
import type { PrivateFileInfo, PrivateHandleInfo, PrivateLaunch, PrivateLaunchRecord, PrivateStorageOptions } from './privateStorage';
import type { NativeAttachmentDescriptor, NativeAttachmentStorage } from './attachments';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_FULL = 'Saved attachment storage for this account is full, so this message was not sent. No existing attachments were removed.';
const DIGEST = /^[a-f0-9]{64}$/;
const NAMES = /^[a-z][a-z0-9-]{0,63}\.(png|jpg|jpeg|webp|gif|pdf)$/;
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' } as const;
type Backend = ReturnType<typeof createPrivateStorage>;
type SessionRecord = { batches: string[]; forkedFrom?: string };
interface Manifest { version: 1; profileKey: string; taskIdentity: string; sessions: Record<string, SessionRecord>; batches: Record<string, PrivateLaunchRecord> }
export interface NativeDurableAssetOptions extends Pick<PrivateStorageOptions, 'helperPath' | 'prototypeRoot'> { profileId: string }
export interface NativeDurableSessionOptions {
  sessionId: string;
  resumeSessionId?: string;
  fork?: boolean;
  ephemeral?: boolean;
  /** Optional exact paths recovered from history; missing ownership is an error, never a rewritten reference. */
  requiredPaths?: readonly string[];
}
export interface NativeDurableAssetLease {
  readonly storage: NativeAttachmentStorage;
  /** Call after the authoritative native guard accepts, before adapter settlement or cleanup. */
  retain(launch: PrivateLaunch): void;
  verifyPath(path: string): NativeAttachmentDescriptor | undefined;
  listReferences(): readonly NativeAttachmentDescriptor[];
  /** Parent must close the adapter/owned runtime before closing this lease. */
  close(): void;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function identifier(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Durable assets require a bounded non-control profile/session identifier.');
  return value;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function batchKey(launch: PrivateLaunch): string { return digest(`${launch.identity}\0${launch.path}`); }
/** The largest record this launch can publish: ten attachments with the longest accepted names and sizes. */
function largestRecord(record: PrivateLaunchRecord): PrivateLaunchRecord {
  const file: PrivateFileInfo = { ...record.receipt.launch, path: win32.join(record.receipt.launch.path, `${'a'.repeat(64)}.jpeg`), kind: 'file', byteLength: 20 * 1024 * 1024, sha256: '0'.repeat(64) };
  return { ...record, files: Array.from({ length: 10 }, () => file) };
}
function descriptor(file: PrivateFileInfo): NativeAttachmentDescriptor {
  const filename = win32.basename(file.path);
  if (!NAMES.test(filename)) throw new Error('Durable asset manifest contains a non-attachment filename.');
  const extension = filename.slice(filename.lastIndexOf('.') + 1) as keyof typeof MEDIA;
  return { type: extension === 'pdf' ? 'document' : 'image', mediaType: MEDIA[extension], filename, path: file.path, bytes: file.byteLength, sha256: file.sha256 };
}
function validateManifest(value: unknown, profileKey: string, root: PrivateHandleInfo, prototypeRoot: string): Manifest {
  if (!object(value) || value.version !== 1 || value.profileKey !== profileKey || value.taskIdentity !== root.id
    || !object(value.sessions) || !object(value.batches) || Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) throw new Error('Durable asset manifest identity or format changed.');
  const manifest = value as unknown as Manifest;
  const referenced = new Set<string>();
  for (const [key, session] of Object.entries(manifest.sessions)) {
    if (!DIGEST.test(key) || !object(session) || !Array.isArray(session.batches) || new Set(session.batches).size !== session.batches.length
      || (session.forkedFrom !== undefined && !DIGEST.test(session.forkedFrom))) throw new Error('Durable asset session ownership is invalid.');
    for (const batch of session.batches) {
      if (typeof batch !== 'string' || !DIGEST.test(batch) || !Object.hasOwn(manifest.batches, batch)) throw new Error('Durable asset session references a missing batch.');
      referenced.add(batch);
    }
  }
  const paths = new Set<string>();
  for (const [key, record] of Object.entries(manifest.batches)) {
    if (!DIGEST.test(key) || !referenced.has(key) || !object(record) || record.version !== 1 || !object(record.receipt) || !object(record.receipt.task)
      || !object(record.receipt.task.task) || record.receipt.task.task.id !== root.id || record.receipt.task.task.path !== root.path
      || record.receipt.task.prototypeRoot !== prototypeRoot || !object(record.receipt.launch) || !Array.isArray(record.files) || !record.files.length || record.files.length > 10) throw new Error('Durable asset batch ownership is invalid.');
    const launchPath = record.receipt.launch.path;
    if (typeof launchPath !== 'string' || !/^launch-[a-f0-9]{32}$/.test(win32.basename(launchPath)) || win32.dirname(launchPath) !== root.path) throw new Error('Durable asset batch escaped its profile root.');
    if (key !== digest(`${record.receipt.launch.id}\0${launchPath}`)) throw new Error('Durable asset batch identity changed.');
    for (const file of record.files) {
      if (!object(file) || typeof file.path !== 'string' || win32.dirname(file.path) !== launchPath || !NAMES.test(win32.basename(file.path))
        || paths.has(file.path) || file.kind !== 'file' || typeof file.sha256 !== 'string' || !DIGEST.test(file.sha256)
        || typeof file.byteLength !== 'number' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > 20 * 1024 * 1024) throw new Error('Durable asset file reference is invalid.');
      paths.add(file.path);
    }
  }
  return manifest;
}

/** One small ownership manifest per profile; retained files never move and are not garbage-collected. */
export function createNativeDurableAssets(options: NativeDurableAssetOptions) {
  const profileKey = digest(`relay-native-assets-v1\0${identifier(options.profileId)}`);
  const persistent = createPrivateStorage({ helperPath: options.helperPath, prototypeRoot: options.prototypeRoot, persistentKey: profileKey });
  const activeSessions = new Set<string>();

  function load() {
    const root = persistent.ensureTaskRoot(); const state = persistent.readState();
    if (state) return { root, manifest: validateManifest(state.value, profileKey, root, options.prototypeRoot), previous: state.file };
    const manifest: Manifest = { version: 1, profileKey, taskIdentity: root.id, sessions: {}, batches: {} };
    return { root, manifest, previous: persistent.writeState(manifest, null) };
  }
  function save(manifest: Manifest, previous: PrivateFileInfo): void {
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) throw new Error('Durable asset manifest has reached its 1 MiB capacity; no existing references were removed.');
    persistent.writeState(manifest, previous);
  }
  function openSession(input: NativeDurableSessionOptions): NativeDurableAssetLease {
    const sessionId = identifier(input.sessionId);
    const sourceId = input.resumeSessionId === undefined ? undefined : identifier(input.resumeSessionId);
    if (input.fork && (!sourceId || sourceId === sessionId)) throw new Error('A durable fork requires distinct authoritative source and target session IDs.');
    if (!input.ephemeral && sourceId && !input.fork && sourceId !== sessionId) throw new Error('The resumed durable session identity did not match.');
    const sessionKey = digest(sessionId), sourceKey = sourceId ? digest(sourceId) : undefined;
    if (activeSessions.has(sessionKey)) throw new Error('This durable asset session already has an active lease.');
    const ephemeral = Boolean(input.ephemeral);
    const current = ephemeral && !sourceKey ? undefined : load();
    const source = current?.manifest.sessions[sourceKey ?? sessionKey];
    let session: SessionRecord = clone(source ?? { batches: [] });
    if (input.fork && !ephemeral) {
      const existing = current!.manifest.sessions[sessionKey];
      if (existing && existing.forkedFrom !== sourceKey) throw new Error('The fork target already belongs to a different durable session.');
      session = existing ? clone(existing) : { batches: [...session.batches], forkedFrom: sourceKey };
    }
    const temporary = ephemeral ? createPrivateStorage({ helperPath: options.helperPath, prototypeRoot: options.prototypeRoot }) : undefined;
    const backend = temporary ?? persistent;
    type Batch = { launch: PrivateLaunch; backend: Backend; phase: 'staged' | 'retained' | 'pinned' };
    const owned = new Map<PrivateLaunch, Batch>();
    const references = new Map<string, Batch>();
    const inherited = new Set<Batch>();
    let closed = false;
    // The newest manifest this lease read or published; other leases may have grown it since.
    let known = ephemeral ? undefined : current?.manifest;
    function available(): void { if (closed) throw new Error('Durable asset lease is closed.'); }
    /** Refuses a send before the CLI can accept it when its batch, with every unpublished one, could not be recorded. */
    function headroom(): void {
      if (!known) return;
      const next = clone(known); const owner = next.sessions[sessionKey] ??= clone(session);
      for (const batch of owned.values()) {
        if (batch.phase === 'retained') continue;
        const key = batchKey(batch.launch);
        if (!owner.batches.includes(key)) owner.batches.push(key);
        next.batches[key] = largestRecord(persistent.describeLaunch(batch.launch));
      }
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_MANIFEST_BYTES) throw new Error(MANIFEST_FULL);
    }
    function own(launch: PrivateLaunch): Batch {
      available(); const batch = owned.get(launch);
      if (!batch) throw new Error('Attachment launch is not owned by this session lease.');
      return batch;
    }
    function index(batch: Batch, files: readonly PrivateFileInfo[]): void { for (const file of files) references.set(file.path, batch); }
    try {
      for (const key of session.batches) {
        const record = current!.manifest.batches[key]; const launch = persistent.restoreLaunch(record);
        const batch: Batch = { launch, backend: persistent, phase: 'retained' }; inherited.add(batch); index(batch, record.files);
      }
      for (const path of input.requiredPaths ?? []) {
        if (typeof path !== 'string' || !references.has(path)) throw new Error('A history asset reference is missing from this session; its path was not rewritten.');
      }
      if (!ephemeral && input.fork && !current!.manifest.sessions[sessionKey]) {
        const next = clone(current!.manifest); next.sessions[sessionKey] = session; save(next, current!.previous); known = next;
      }
    } catch (error) {
      for (const batch of inherited) persistent.forgetLaunch(batch.launch);
      throw error;
    }
    activeSessions.add(sessionKey);

    const storage: NativeAttachmentStorage = {
      createLaunch() {
        available(); const launch = backend.createLaunch(); owned.set(launch, { launch, backend, phase: 'staged' });
        try { headroom(); } catch (cause) {
          try { storage.removeLaunch(launch); } catch { /* A staged batch that could not be removed now is removed at lease close. */ }
          throw cause;
        }
        return launch;
      },
      writeBytes(launch, bytes, name) {
        const batch = own(launch);
        if (batch.phase !== 'staged') throw new Error('Accepted durable assets cannot be extended or rewritten.');
        const file = backend.writeBytes(launch, bytes, name); references.set(file.path, batch); return file;
      },
      verify(launch) { return own(launch).backend.verify(launch); },
      removeLaunch(launch) {
        const batch = own(launch);
        if (batch.phase === 'pinned') throw new Error(`Accepted assets require metadata recovery and were preserved at ${launch.path}`);
        if (batch.phase === 'staged') {
          batch.backend.removeLaunch(launch);
          for (const [path, owner] of references) if (owner === batch) references.delete(path);
        } else inherited.add(batch);
        owned.delete(launch);
      },
    };
    function retain(launch: PrivateLaunch): void {
      const batch = own(launch);
      if (batch.phase === 'retained') { backend.verify(launch); return; }
      if (ephemeral) { backend.verify(launch); return; }
      // Acceptance already happened. A manifest failure must not turn adapter cleanup into data loss.
      batch.phase = 'pinned';
      const record = persistent.exportLaunch(launch);
      if (!record.files.length || record.files.some((file) => !NAMES.test(win32.basename(file.path)))) throw new Error('Accepted durable batch has no valid attachments.');
      const latest = load(); known = latest.manifest; const next = clone(latest.manifest);
      const key = batchKey(launch);
      next.sessions[sessionKey] ??= clone(session);
      if (!next.sessions[sessionKey].batches.includes(key)) next.sessions[sessionKey].batches.push(key);
      next.batches[key] = record;
      save(next, latest.previous); known = next;
      batch.phase = 'retained'; session = clone(next.sessions[sessionKey]); index(batch, record.files);
    }
    function verifyPath(path: string): NativeAttachmentDescriptor | undefined {
      available(); const batch = references.get(path); if (!batch) return;
      const file = batch.backend.verify(batch.launch).files.find((entry) => entry.path === path);
      if (!file) throw new Error('A known durable asset is missing; its history reference was not rewritten.');
      return descriptor(file);
    }
    function listReferences(): readonly NativeAttachmentDescriptor[] {
      available(); const result: NativeAttachmentDescriptor[] = [];
      for (const batch of new Set(references.values())) for (const file of batch.backend.verify(batch.launch).files) result.push(descriptor(file));
      return result;
    }
    function close(): void {
      if (closed) return;
      // Accepted but unrecorded files stay on disk instead of being deleted under a reply that may still read them.
      for (const [launch, batch] of [...owned]) if (batch.phase === 'pinned') { batch.backend.forgetLaunch(launch); owned.delete(launch); }
      for (const launch of [...owned.keys()]) storage.removeLaunch(launch);
      for (const batch of inherited) batch.backend.forgetLaunch(batch.launch);
      temporary?.dispose(); references.clear(); inherited.clear(); activeSessions.delete(sessionKey); closed = true;
    }
    return { storage, retain, verifyPath, listReferences, close };
  }
  return { openSession };
}
