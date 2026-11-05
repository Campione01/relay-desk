import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNativeAttachmentAdapter, validateNativeAttachmentSubmission, type NativeAttachmentComposer, type NativeAttachmentGuardStatus, type NativeAttachmentOptions, type NativeAttachmentStorage, type NativePdfTools } from '../../src/main/native/attachments';
import type { NativeEvent } from '../../src/main/native/contract';
import type { PrivateJsonInfo, PrivateLaunch } from '../../src/main/native/privateStorage';
import type { PromptAttachment } from '../../src/shared/types';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = (name = 'user.png'): PromptAttachment => ({ kind: 'image', mediaType: 'image/png', data: png, name });
const pdf = (): PromptAttachment => ({ kind: 'pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'), name: 'original layout.pdf' });
const pdfTools = (): NativePdfTools => ({ directory: 'C:\\private-poppler', hashes: { 'pdfinfo.exe': '1'.repeat(64), 'pdftoppm.exe': '2'.repeat(64) }, verify: vi.fn(), withEnvironment: (env) => ({ ...env }) });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(test: () => boolean): Promise<void> { for (let i = 0; i < 100; i++) { if (test()) return; await tick(); } throw new Error('test deadline'); }

function harness(overrides: Partial<NativeAttachmentOptions> = {}) {
  let listener: ((event: NativeEvent) => void) | undefined;
  let text = ''; let cursor = 0; let busy = false; let count = 0; let sequence = 0;
  let arm: Parameters<NativeAttachmentComposer['arm']>[0] | undefined;
  let status: NativeAttachmentGuardStatus | undefined;
  const files = new Map<PrivateLaunch, PrivateJsonInfo[]>();
  const staged: Buffer[] = [];
  const receipt = (path: string, kind: 'directory' | 'file' = 'directory') => ({ path, id: path, ownerSid: 'S-test', protectedDacl: true, aceCount: 2, inheritedAceCount: 0, linkCount: 1, kind, byteLength: 0 });
  const storage: NativeAttachmentStorage = {
    createLaunch: vi.fn(() => { const launch = { path: `C:\\RelayDeskNativePrototype\\attachments\\launch-${++count}`, identity: `${count}` }; files.set(launch, []); return launch; }),
    writeBytes: vi.fn((launch, bytes, name) => {
      staged.push(Buffer.from(bytes)); const info = { ...receipt(win32.join(launch.path, name), 'file'), byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      files.get(launch)!.push(info); return info;
    }),
    verify: vi.fn((launch) => ({ launch: receipt(launch.path), files: files.get(launch)! })),
    removeLaunch: vi.fn((launch) => { files.delete(launch); }),
  };
  function emit(event: string, turnId = 'main-turn', agentId?: string) { listener?.({ event, sessionId: 'test', sequence: ++sequence, data: { turnId, ...(agentId ? { agentId } : {}) } }); }
  const writes: string[] = [];
  const runtime: NativeAttachmentOptions['runtime'] = {
    onEvent: vi.fn((callback) => { listener = callback; return () => { listener = undefined; }; }),
    close: vi.fn(async () => undefined),
    writeTerminal: vi.fn(async (value) => {
      writes.push(value);
      if (value === '\r') { status = { id: arm!.id, state: 'accepted', entered: true, observed: arm!.expected, text, origin: { kind: 'composer' } }; busy = true; text = ''; cursor = 0; emit('turn.start'); }
      else { text += `[Image #${(text.match(/\[Image #\d+\]/g)?.length ?? 0) + 1}]`; cursor = text.length; }
    }),
  };
  const composer: NativeAttachmentComposer = {
    read: vi.fn(async () => ({ text, cursor })),
    replace: vi.fn(async (next) => { text = next; cursor = text.length; return { isFilled: true, text }; }),
    arm: vi.fn(async (input) => { arm = input; status = { id: input.id, state: 'armed' }; return { id: input.id, armed: true as const, guard: 'native-before-model-v1' as const }; }),
    status: vi.fn(async () => status!),
    disarm: vi.fn(async () => { if (status) status.state = 'cancelled'; }),
  };
  const adapter = createNativeAttachmentAdapter({ runtime, composer, storage, isBusy: () => busy, waitForIdle: async (signal) => { while (busy && !signal.aborted) await tick(); }, timeoutMs: 100, ...overrides });
  return { adapter, storage, composer, runtime, files, staged, writes, emit, setBusy(value: boolean) { busy = value; }, setDraft(value: string) { text = value; cursor = value.length; }, setStatus(value: NativeAttachmentGuardStatus) { status = value; } };
}

describe('native attachment adapter', () => {
  it('requires genuine core-entry acknowledgement, not only a successful pre-model metadata check', async () => {
    const h = harness();
    (h.composer.status as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({ id, state: 'accepted', entered: false,
      observed: [{ type: 'image', mediaType: 'image/png', filename: 'attachment-1.png' }], text: '[Image #1] safe', origin: { kind: 'composer' } }));
    await expect(h.adapter.submit({ text: 'safe', attachments: [image()] })).rejects.toThrow('metadata');
    expect(h.runtime.close).toHaveBeenCalledTimes(1); await h.adapter.close();
  });
  it('retains exact bytes and submits only after all native ingestion and fill steps', async () => {
    const h = harness();
    const result = await h.adapter.submit({ text: 'first line\nsecond line', attachments: [image('one.png'), image('two.png')] });
    expect(h.staged.map((bytes) => bytes.toString('base64'))).toEqual([png, png]);
    expect(result.files.map((file) => file.filename)).toEqual(['attachment-1.png', 'attachment-2.png']);
    expect(result.nativeText).toBe('[Image #1][Image #2] first line\nsecond line');
    expect(h.writes.filter((value) => value === '\r')).toHaveLength(1);
    expect(h.composer.arm).toHaveBeenCalledBefore(h.runtime.writeTerminal as ReturnType<typeof vi.fn>);
    expect(h.composer.replace).toHaveBeenCalledBefore((h.composer.status as ReturnType<typeof vi.fn>));
    expect(h.files.size).toBe(1);
    await expect(h.adapter.release(result.id)).rejects.toThrow('active native turn');
    h.emit('turn.complete'); await until(() => h.files.size === 0);
    await h.adapter.close();
  });

  it.each(['\x1b[201~bad\r', 'a\rb', '\u0000', '\u202eabc', '/clear', ' !echo bad'])('rejects unsafe terminal text %j before staging', async (text) => {
    const h = harness(); await expect(h.adapter.submit({ text, attachments: [image()] })).rejects.toThrow('unsafe'); expect(h.storage.createLaunch).not.toHaveBeenCalled(); await h.adapter.close();
  });

  it('rejects PDFs, invalid encodings, mismatched signatures, oversized files, and more than ten files', () => {
    const validate = (files: PromptAttachment[]) => validateNativeAttachmentSubmission({ text: 'safe', attachments: files });
    expect(() => validate([{ kind: 'pdf', mediaType: 'application/pdf', data: 'JVBERg==' }])).toThrow('PDF');
    expect(() => validate([{ ...image(), data: `${png}=` }])).toThrow('base64');
    expect(() => validate([{ ...image(), data: 'data:image/png;base64,' + png }])).toThrow('data');
    expect(() => validate([{ ...image(), mediaType: 'image/jpeg' }])).toThrow('media type');
    expect(() => validate([{ ...image(), mediaType: '__proto__' }])).toThrow('Unsupported');
    expect(() => validate([{ ...image(), data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }])).toThrow('5 MiB');
    expect(() => validate(Array.from({ length: 11 }, () => image()))).toThrow('one to ten');
  });

  it('stages mixed PDF/image bytes as explicit native references without claiming the PDF is consumed', async () => {
    const tools = pdfTools(); const h = harness({ pdfTools: tools });
    const result = await h.adapter.submit({ text: 'read the layout', attachments: [image(), pdf()] });
    expect(result.nativeText).toBe(`[Image #1] @${result.files[1].path} read the layout`);
    expect(result.files.map((file) => file.type)).toEqual(['image', 'document']);
    expect(result.pdf?.state).toBe('native-read-required');
    expect(h.composer.arm).toHaveBeenCalledWith(expect.objectContaining({ expected: [{ type: 'image', mediaType: 'image/png', filename: 'attachment-1.png' }], references: [{ type: 'document', mediaType: 'application/pdf', filename: 'attachment-2.pdf', path: result.files[1].path, sha256: result.files[1].sha256 }] }), expect.any(AbortSignal));
    expect(h.adapter.verifyPdfRead(result.files[1].path)).toEqual(result.files[1]);
    expect(h.adapter.verifyPdfRead('C:\\unowned.pdf')).toBeUndefined();
    h.emit('turn.complete'); await tick(); expect(h.files.size).toBe(1);
    (h.storage.verify as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('PDF hash changed'); });
    expect(() => h.adapter.verifyPdfRead(result.files[1].path)).toThrow('PDF hash changed');
    await h.adapter.close(); expect(h.files.size).toBe(0);
  });

  it('supports a PDF-only native composer reference with zero image pastes', async () => {
    const h = harness({ pdfTools: pdfTools() });
    const result = await h.adapter.submit({ text: 'inspect every page', attachments: [pdf()] });
    expect(h.writes).toEqual(['\r']); expect(result.nativeText).toBe(`@${result.files[0].path} inspect every page`);
    h.emit('turn.complete'); await tick(); await h.adapter.release(result.id); expect(h.files.size).toBe(0); await h.adapter.close();
  });

  it('snapshots validated text and never accepts changed terminal controls after enqueue', async () => {
    const h = harness(); h.setBusy(true); const input = { text: 'safe original', attachments: [image()], queue: true };
    const job = await h.adapter.enqueue(input); input.text = '\r/clear'; h.setBusy(false);
    const result = await job.submitted; expect(result.nativeText).toBe('[Image #1] safe original'); h.emit('turn.complete'); await until(() => h.files.size === 0); await h.adapter.close();
  });

  it('never overwrites an existing genuine composer draft', async () => {
    const h = harness(); h.setDraft('existing draft');
    await expect(h.adapter.submit({ text: 'next', attachments: [image()] })).rejects.toThrow('draft');
    expect(h.writes).toEqual([]); expect(h.runtime.close).not.toHaveBeenCalled(); expect(h.files.size).toBe(0); await h.adapter.close();
  });

  it('waits for idle for queued attachments without writing to or aborting the active turn', async () => {
    const h = harness(); h.setBusy(true);
    const job = await h.adapter.enqueue({ text: 'next', attachments: [image()], queue: true });
    expect(job.queued).toBe(true); await tick(); expect(h.writes).toEqual([]); expect(h.runtime.close).not.toHaveBeenCalled();
    h.setBusy(false); await job.submitted; h.emit('turn.complete'); await until(() => h.files.size === 0); await h.adapter.close();
  });

  it('waits on its own correlated turn even if the external busy snapshot is briefly stale', async () => {
    const h = harness(); await h.adapter.submit({ text: 'first', attachments: [image()] }); h.setBusy(false);
    const writes = h.writes.length; const next = await h.adapter.enqueue({ text: 'second', attachments: [image()], queue: true });
    expect(next.queued).toBe(true); await tick(); expect(h.writes.length).toBe(writes);
    h.emit('turn.complete'); await next.submitted; h.emit('turn.complete'); await until(() => h.files.size === 0); await h.adapter.close();
  });

  it('keeps ordinary turn.abort as the cancellation authority after acceptance', async () => {
    const h = harness(); const job = await h.adapter.enqueue({ text: 'first', attachments: [image()] }); await job.submitted;
    await expect(job.cancel()).rejects.toThrow('turn.abort'); expect(h.runtime.close).not.toHaveBeenCalled(); await h.adapter.close();
  });

  it('requires an actual native before-model guard before writing any terminal data', async () => {
    const h = harness(); (h.composer.arm as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'wrong', armed: true, guard: 'pretend' });
    await expect(h.adapter.submit({ text: 'safe', attachments: [image()] })).rejects.toThrow('guard'); expect(h.writes).toEqual([]); expect(h.runtime.close).not.toHaveBeenCalled(); await h.adapter.close();
  });

  it('shares one owned runtime closure and batch release across concurrent close and complete', async () => {
    const h = harness(); await h.adapter.submit({ text: 'safe', attachments: [image()] }); h.emit('turn.complete');
    await Promise.all([h.adapter.close(), h.adapter.close()]); expect(h.runtime.close).toHaveBeenCalledTimes(1); expect(h.storage.removeLaunch).toHaveBeenCalledTimes(1);
  });

  it('refuses nonfinite queue budgets and unavailable PDF dependencies without unsafe fallback', async () => {
    expect(() => harness({ maxReservedBytes: Number.NaN })).toThrow('finite');
    const tools = pdfTools(); (tools.verify as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('dependency changed'); });
    const h = harness({ pdfTools: tools }); await expect(h.adapter.submit({ text: 'pdf', attachments: [pdf()] })).rejects.toThrow('dependency'); expect(h.storage.createLaunch).not.toHaveBeenCalled(); await h.adapter.close();
  });

  it('cancels a queued job safely and rejects an un-preempted busy send', async () => {
    const h = harness(); h.setBusy(true);
    const job = await h.adapter.enqueue({ text: 'cancel', attachments: [image()], queue: true });
    await job.cancel(); await expect(job.submitted).rejects.toThrow('cancelled');
    expect(h.runtime.close).not.toHaveBeenCalled(); expect(h.files.size).toBe(0);
    await expect(h.adapter.submit({ text: 'busy', attachments: [image()] })).rejects.toThrow('Interrupt'); expect(h.writes).toEqual([]); await h.adapter.close();
  });

  it('checks native storage integrity immediately before any terminal input', async () => {
    const h = harness(); (h.storage.verify as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('identity changed'); });
    await expect(h.adapter.submit({ text: 'safe', attachments: [image()] })).rejects.toThrow('identity'); expect(h.writes).toEqual([]); expect(h.files.size).toBe(0); await h.adapter.close();
  });

  it('fails closed without Enter if placeholder ingestion cannot be proven', async () => {
    const h = harness(); (h.composer.read as ReturnType<typeof vi.fn>).mockResolvedValue({ text: '', cursor: 0 });
    await expect(h.adapter.submit({ text: 'safe', attachments: [image()] })).rejects.toThrow('ingestion');
    expect(h.writes).toHaveLength(1); expect(h.writes).not.toContain('\r'); expect(h.runtime.close).toHaveBeenCalledTimes(1); expect(h.files.size).toBe(0); await h.adapter.close();
  });

  it.each(['filename', 'origin', 'text', 'rejected'])('closes owned runtime on authoritative metadata mismatch: %s', async (kind) => {
    const h = harness();
    (h.composer.status as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({ id, state: kind === 'rejected' ? 'rejected' : 'accepted', observed: [{ type: 'image', mediaType: 'image/png', filename: kind === 'filename' ? 'wrong.png' : 'attachment-1.png' }], text: kind === 'text' ? 'wrong' : '[Image #1] safe', origin: { kind: kind === 'origin' ? 'mod' : 'composer' } }));
    await expect(h.adapter.submit({ text: 'safe', attachments: [image()] })).rejects.toThrow(kind === 'rejected' ? 'not admitted' : 'metadata'); expect(h.runtime.close).toHaveBeenCalledTimes(1); expect(h.files.size).toBe(0); await h.adapter.close();
  });

  it('keeps an accepted prompt and its runtime when durable retention fails, warning instead', async () => {
    const onWarning = vi.fn();
    const h = harness({ onAccepted: vi.fn().mockRejectedValueOnce(new Error('Durable asset manifest has reached its 1 MiB capacity')), onWarning });
    const result = await h.adapter.submit({ text: 'safe', attachments: [image()] });
    expect(result.nativeText).toBe('[Image #1] safe'); expect(h.runtime.close).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringMatching(/^The message was sent, but its attachments could not be saved.*1 MiB capacity$/) }));
    h.emit('turn.complete'); await until(() => h.adapter.retainedAssets().length === 0);
    expect(h.storage.removeLaunch).not.toHaveBeenCalled(); expect(h.files.size).toBe(1);
    h.setBusy(false); await h.adapter.submit({ text: 'next', attachments: [image()] });
    await h.adapter.close(); expect(h.runtime.close).toHaveBeenCalledTimes(1); expect(h.storage.removeLaunch).toHaveBeenCalledTimes(1);
  });

  it('finishes closing after a failed file release instead of rethrowing a cached rejection', async () => {
    const onWarning = vi.fn(); const h = harness({ onWarning });
    await h.adapter.submit({ text: 'safe', attachments: [image()] });
    (h.storage.removeLaunch as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('helper failed'); });
    h.emit('turn.complete'); await until(() => h.adapter.retainedAssets().length === 0);
    await expect(h.adapter.close()).resolves.toBeUndefined();
    const other = harness({ onWarning }); await other.adapter.submit({ text: 'safe', attachments: [image()] });
    (other.storage.removeLaunch as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('helper failed at close'); });
    await expect(other.adapter.close()).resolves.toBeUndefined(); await expect(other.adapter.close()).resolves.toBeUndefined();
    expect(onWarning).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'helper failed at close' }));
    expect(other.adapter.retainedAssets()).toEqual([]);
  });

  it('bounds staged queued bytes and cleans active files only after owned runtime closes', async () => {
    const h = harness({ maxReservedBytes: 100 }); h.setBusy(true);
    const first = await h.adapter.enqueue({ text: 'one', attachments: [image()], queue: true });
    await expect(h.adapter.enqueue({ text: 'two', attachments: [image()], queue: true })).rejects.toThrow('capacity');
    await first.cancel(); h.setBusy(false); await h.adapter.submit({ text: 'again', attachments: [image()] });
    let closed = false; (h.runtime.close as ReturnType<typeof vi.fn>).mockImplementation(async () => { closed = true; });
    const original = h.storage.removeLaunch; (h.storage.removeLaunch as ReturnType<typeof vi.fn>).mockImplementation((launch: PrivateLaunch) => { expect(closed).toBe(true); h.files.delete(launch); });
    await h.adapter.close(); expect(h.files.size).toBe(0); expect(original).toHaveBeenCalled();
  });
});
