import type { EngineInterface, On, PromptSubmitInput } from 'claude-code';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_TIMEOUT_MS, createAttachmentGuard, MAX_ATTACHMENT_TRANSACTIONS } from '../../native-mod/hooks/attachmentGuard';
import { CAPABILITIES, createNativeBridge } from '../../native-mod/hooks/bridge';
import type { BridgeOutput, BridgeRequest } from '../../native-mod/hooks/protocol';
import { register } from '../../native-mod/hooks/register';
import { createProcessTransport, type BridgeTransport } from '../../native-mod/hooks/transport';

vi.mock('../../native-mod/hooks/transport', async (original) => ({ ...await original<typeof import('../../native-mod/hooks/transport')>(), createProcessTransport: vi.fn() }));
const png = { type: 'image' as const, mediaType: 'image/png', filename: 'attachment-1.png' };
const pdf = { type: 'document' as const, mediaType: 'application/pdf', filename: 'attachment-2.pdf', path: 'C:\\RelayDeskNativePrototype\\assets\\launch-one\\attachment-2.pdf', sha256: '1'.repeat(64) };
const arm = (overrides: Record<string, unknown> = {}) => ({ id: 'transaction-1', text: 'safe text', expected: [png], references: [], ...overrides });
const event = (overrides: Partial<PromptSubmitInput> = {}): PromptSubmitInput => ({ text: '[Image #3] safe text', wait: false, origin: { kind: 'composer' }, attachments: [{ ...png, id: 'native-media-1' }], ...overrides });
const request = (id: string, method: string, args?: unknown): BridgeRequest => ({ type: 'request', id, method, args });
const tick = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };

function fixture() {
  const outputs: BridgeOutput[] = [];
  const timers: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  let inbound: (request: BridgeRequest) => void = () => undefined;
  let session = 'native-session';
  const transport: BridgeTransport = {
    send: vi.fn((output) => { outputs.push(output); }), start: vi.fn((receive) => { inbound = receive; }), close: vi.fn(), flush: vi.fn(async () => undefined),
  };
  const api = {
    env: { get: vi.fn(async (_key: string): Promise<string | undefined> => undefined) },
    session: { id: vi.fn(async () => session), cwd: vi.fn(async () => 'C:\\fixture'), model: vi.fn(async () => 'claude-opus-5-5'), compact: vi.fn(async () => ({})) },
    prompt: { read: vi.fn(async () => ({ text: '', cursor: 0 })), fill: vi.fn(async (args: { text: string }) => ({ isFilled: true, text: args.text, cursor: args.text.length })), submit: vi.fn(async () => ({ turnId: 'main' })) },
    turn: { abort: vi.fn(async () => undefined) },
    command: { run: vi.fn(async () => ({})) },
    clock: { after: vi.fn((_ms: number, callback: () => void) => { const timer = { callback, cancel: vi.fn() }; timers.push(timer); return timer; }) },
  };
  const $ = api as unknown as EngineInterface;
  const bridge = createNativeBridge($, transport);
  let number = 0;
  async function rpc(method: string, args?: unknown) {
    const id = `request-${++number}`;
    await bridge.receive(request(id, method, args));
    const reply = outputs.findLast((row) => row.type === 'response' && row.id === id);
    if (!reply || reply.type !== 'response') throw new Error('No synthetic RPC response');
    return reply;
  }
  return { $, api, bridge, transport, outputs, timers, rpc, inbound: (value: BridgeRequest) => inbound(value), setSession: (value: string) => { session = value; } };
}

async function hooksFixture(interactive = true) {
  const f = fixture(); vi.mocked(createProcessTransport).mockResolvedValue(f.transport);
  const handlers = new Map<string, (...args: any[]) => any>(); const catches = new Map<string, (...args: any[]) => any>();
  const on = (name: string, matcherOrHandler: any, handler?: any) => { if (handlers.has(name)) throw new Error('duplicate hook'); handlers.set(name, handler ?? matcherOrHandler); return { catch: (caught: any) => catches.set(name, caught) }; };
  register(on as unknown as On, {});
  await handlers.get('session.start')!(f.$, { isInteractive: interactive, surface: interactive ? 'terminal' : null }, async () => ({ cwd: 'C:\\fixture' }));
  return { ...f, handlers, catches };
}
beforeEach(() => vi.clearAllMocks());

describe('native authoritative attachment guard', () => {
  it('accepts actual composer metadata and text, never manufactures attachment bytes or origin', () => {
    const guard = createAttachmentGuard(); expect(guard.arm(arm())).toEqual({ id: 'transaction-1', armed: true, guard: 'native-before-model-v1' });
    const checked = guard.checkPrompt(event()); expect(checked.reason).toBeUndefined(); expect(checked.checked).toMatchObject({ state: 'armed', entered: false, observed: [{ ...png, id: 'native-media-1' }], origin: { kind: 'composer' }, text: '[Image #3] safe text' });
    expect(guard.complete(checked.transactionId!, { text: event().text })).toMatchObject({ state: 'accepted', entered: true });
    const copy = guard.status('transaction-1'); copy.observed![0].filename = 'spoof.png'; expect(guard.status('transaction-1').observed![0].filename).toBe('attachment-1.png');
    expect(() => guard.disarm('transaction-1')).toThrow('turn.abort');
  });

  it('binds mixed and PDF-only native references exactly without pretending the PDF is a document block', () => {
    const guard = createAttachmentGuard(); guard.arm(arm({ references: [pdf] }));
    const mixed = guard.checkPrompt(event({ text: `[Image #3] @${pdf.path} safe text` })); expect(guard.complete(mixed.transactionId!, { text: `[Image #3] @${pdf.path} safe text` })?.state).toBe('accepted');
    guard.arm(arm({ id: 'pdf-only', expected: [], references: [pdf] }));
    const checked = guard.checkPrompt(event({ text: `@${pdf.path} safe text`, attachments: [] })); expect(checked.checked).toMatchObject({ state: 'armed', entered: false, observed: [] }); expect(guard.complete(checked.transactionId!, { text: `@${pdf.path} safe text` })).toMatchObject({ state: 'accepted', entered: true });
  });

  it.each([
    { text: '[Image #3] changed text' },
    { attachments: [] },
    { attachments: [{ ...png, mediaType: 'image/jpeg' }] },
    { attachments: [{ ...png, filename: 'wrong.png' }] },
    { attachments: [{ type: 'audio' as const, mediaType: 'image/png', filename: 'attachment-1.png' }] },
    { origin: { kind: 'bridge' as const } },
    { origin: { kind: 'plugin' as const, name: 'other', asUser: true as const } },
    { turnId: 'a-turn-already-running' },
    { isMeta: true as const },
    { command: { name: 'clear', args: '' } },
    { text: '[Image #3]\x1b[201~ safe text' },
  ])('rejects unexpected human submission before model admission: %j', (changed) => {
    const guard = createAttachmentGuard(); guard.arm(arm()); expect(guard.checkPrompt(event(changed)).reason).toContain('did not match'); expect(guard.status('transaction-1').state).toBe('rejected');
  });

  it('rejects forged PDF references and extra/duplicate image tokens', () => {
    const guard = createAttachmentGuard(); guard.arm(arm({ references: [pdf] }));
    expect(guard.checkPrompt(event({ text: `[Image #3] @${pdf.path.replace('launch-one', 'unowned')} safe text` })).reason).toBeTruthy();
    guard.arm(arm({ id: 'double' })); expect(guard.checkPrompt(event({ text: '[Image #3][Image #3] safe text' })).reason).toBeTruthy();
  });

  it('passes real engine task notifications unchanged without consuming attachment ownership', () => {
    const guard = createAttachmentGuard(); guard.arm(arm());
    const notification = event({ text: 'a completed task, not an image-token guess', isMeta: true, origin: { kind: 'task-notification' }, attachments: [] });
    expect(guard.checkPrompt(notification)).toEqual({}); expect(guard.status('transaction-1').state).toBe('armed');
    const checked = guard.checkPrompt(event()); expect(guard.complete(checked.transactionId!, { text: event().text })?.state).toBe('accepted');
  });

  it('does not mistake model text or foreign binary attachments for an engine notification', () => {
    const guard = createAttachmentGuard(); guard.arm(arm());
    expect(guard.checkPrompt(event({ origin: { kind: 'task-notification' } })).reason).toBeTruthy();
    const second = createAttachmentGuard(); second.arm(arm());
    expect(second.checkPrompt(event({ origin: { kind: 'composer' }, attachments: [], text: 'task-notification [Image #3] safe text' })).reason).toBeTruthy();
  });

  it('rejects unowned native binary data, but preserves ordinary native text and stronger base guards', () => {
    const guard = createAttachmentGuard(); expect(guard.checkPrompt(event()).reason).toContain('armed owned');
    expect(guard.checkPrompt(event({ attachments: [], origin: { kind: 'plugin', name: 'relay', asUser: true } }))).toEqual({ reason: undefined });
    guard.arm(arm()); expect(guard.checkPrompt(event(), 'Native no-history protection is no longer active').reason).toContain('no-history');
  });

  it.each([
    { text: '/clear' }, { text: 'safe\runsafe' }, { context: ['injected'] }, { expected: [] },
    { expected: [png, png] }, { expected: [{ ...png, filename: '..\\bad.png' }] }, { expected: [{ ...png, mediaType: '__proto__' }] },
    { references: [{ ...pdf, path: 'C:\\x\\..\\attachment-2.pdf' }] },
    { references: [{ ...pdf, path: '\\\\server\\share\\attachment-2.pdf' }] },
    { references: [{ ...pdf, path: 'C:\\safe\nunsafe\\attachment-2.pdf' }] },
    { references: [{ ...pdf, sha256: 'wrong' }] },
  ])('validates untrusted arm descriptors before ownership: %j', (changed) => {
    const guard = createAttachmentGuard(); expect(() => guard.arm(arm(changed))).toThrow(); expect(guard.isArmed()).toBe(false);
  });

  it('rejects concurrent/replayed ownership and stale cancellation without touching the active id', () => {
    const guard = createAttachmentGuard(); guard.arm(arm()); expect(() => guard.arm(arm({ id: 'other' }))).toThrow('owns');
    guard.disarm('transaction-1'); guard.arm(arm({ id: 'other' })); guard.disarm('transaction-1'); expect(guard.activeId()).toBe('other');
    expect(() => guard.disarm('unknown')).toThrow('Unknown'); guard.disarm('other'); expect(() => guard.arm(arm())).toThrow('already used');
  });

  it('expires abandoned ownership and keeps a finite status history', () => {
    let now = 0; const guard = createAttachmentGuard(() => now); guard.arm(arm()); now = ATTACHMENT_TIMEOUT_MS;
    expect(guard.status('transaction-1').state).toBe('cancelled'); expect(guard.checkPrompt(event()).reason).toBeTruthy();
    for (let index = 0; index < MAX_ATTACHMENT_TRANSACTIONS + 2; index++) { const id = `later-${index}`; guard.arm(arm({ id })); guard.disarm(id); }
    expect(() => guard.status('transaction-1')).toThrow('Unknown'); expect(guard.status(`later-${MAX_ATTACHMENT_TRANSACTIONS + 1}`).state).toBe('cancelled');
  });

  it('waits for core entry, preserves legitimate native rewrites, and never reclaims a cancelled transaction', () => {
    const guard = createAttachmentGuard(); guard.arm(arm()); const checked = guard.checkPrompt(event());
    expect(guard.status('transaction-1')).toMatchObject({ state: 'armed', entered: false });
    expect(() => guard.validateFill(event().text)).toThrow('awaiting core');
    expect(guard.complete(checked.transactionId!, { text: 'Legitimate downstream hook rewrite', origin: { kind: 'composer' } })).toMatchObject({ state: 'accepted', entered: true, text: event().text, enteredText: 'Legitimate downstream hook rewrite' });
    guard.arm(arm({ id: 'cancel-before-core' })); const second = guard.checkPrompt(event()); guard.disarm('cancel-before-core');
    expect(guard.complete(second.transactionId!, { text: event().text })).toBeUndefined(); expect(guard.status('cancel-before-core')).toMatchObject({ state: 'cancelled', entered: false });
  });

  it('records downstream drop/rejection without confirming delivery or replaying any prompt', () => {
    const guard = createAttachmentGuard(); guard.arm(arm()); const checked = guard.checkPrompt(event());
    expect(guard.complete(checked.transactionId!, { drop: 'user policy refused' })).toMatchObject({ state: 'rejected', entered: false, reason: expect.stringContaining('user policy refused') });
    guard.arm(arm({ id: 'next-rejected' })); const second = guard.checkPrompt(event());
    expect(guard.reject(second.transactionId!, 'native next rejected')).toMatchObject({ state: 'rejected', entered: false });
  });
});

describe('real Mod attachment RPC and middleware integration', () => {
  it('uses genuine prompt.read/fill and advertises the exact narrow RPC contract', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal');
    expect(CAPABILITIES).toEqual(expect.arrayContaining(['prompt.read', 'prompt.fill', 'attachment.arm', 'attachment.status', 'attachment.disarm']));
    expect(await f.rpc('prompt.read')).toMatchObject({ ok: true, value: { text: '', cursor: 0 } });
    expect(await f.rpc('attachment.arm', arm())).toMatchObject({ ok: true, value: { id: 'transaction-1', armed: true, guard: 'native-before-model-v1' } });
    expect(await f.rpc('prompt.fill', { text: '[Image #3] safe text' })).toMatchObject({ ok: true, value: { isFilled: true } });
    expect(f.api.prompt.fill).toHaveBeenCalledWith({ text: '[Image #3] safe text', mode: 'replace' }); expect(f.api.prompt.submit).not.toHaveBeenCalled();
    expect(await f.rpc('prompt.fill', { text: 'bare text', mode: 'append' })).toMatchObject({ ok: false });
    expect(await f.rpc('attachment.disarm', { id: 'transaction-1' })).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(await f.rpc('prompt.fill', { text: '[Image #3] safe text' })).toMatchObject({ ok: false });
  });

  it('rejects draft/active-turn/approval ownership and preserves ephemeral protection', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal'); f.api.prompt.read.mockResolvedValue({ text: 'existing user draft', cursor: 19 });
    expect(await f.rpc('attachment.arm', arm())).toMatchObject({ ok: false }); expect(f.api.prompt.fill).not.toHaveBeenCalled();
    f.api.prompt.read.mockResolvedValue({ text: '', cursor: 0 }); f.bridge.setTurn('running'); expect(await f.rpc('attachment.arm', arm({ id: 'busy' }))).toMatchObject({ ok: false }); f.bridge.setTurn(undefined);
    const permission = f.bridge.interact({ kind: 'permission', toolName: 'Read', input: {} }); expect(await f.rpc('attachment.arm', arm({ id: 'approval' }))).toMatchObject({ ok: false }); f.bridge.cancelInteractions('done'); await permission;
    const ephemeral = fixture(); ephemeral.api.env.get.mockResolvedValue('1'); await ephemeral.bridge.start(true, 'terminal'); ephemeral.api.env.get.mockResolvedValue('0');
    expect(await ephemeral.rpc('attachment.arm', arm())).toMatchObject({ ok: false }); expect(ephemeral.api.prompt.read).not.toHaveBeenCalled();
  });

  it('blocks unrelated bridge mutations while armed, but permits status/cancellation and ordinary usage events', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal'); await f.rpc('attachment.arm', arm());
    for (const [method, args] of [['prompt.submit', { text: 'unrelated' }], ['command.run', { command: 'status' }], ['session.compact', {}], ['ui.command', { command: 'model' }]] as const) expect(await f.rpc(method, args)).toMatchObject({ ok: false });
    expect(f.api.prompt.submit).not.toHaveBeenCalled(); expect(f.api.command.run).not.toHaveBeenCalled(); expect(f.api.session.compact).not.toHaveBeenCalled();
    expect(await f.rpc('attachment.status', { id: 'transaction-1' })).toMatchObject({ value: { state: 'armed' } });
    expect(await f.rpc('turn.abort')).toMatchObject({ ok: true, value: { interrupted: false, reason: 'not-running' } });
    expect(await f.rpc('attachment.status', { id: 'transaction-1' })).toMatchObject({ value: { state: 'armed' } }); expect(f.api.turn.abort).not.toHaveBeenCalled();
    f.bridge.setTurn('running'); expect(await f.rpc('turn.abort')).toMatchObject({ ok: true, value: { interrupted: true } });
    expect(await f.rpc('attachment.status', { id: 'transaction-1' })).toMatchObject({ value: { state: 'cancelled' } });
  });

  it('settles timeout and clears old ownership on native session rebinding', async () => {
    const f = fixture(); await f.bridge.start(true, 'terminal'); await f.rpc('attachment.arm', arm()); f.timers.at(-1)!.callback();
    expect(await f.rpc('attachment.status', { id: 'transaction-1' })).toMatchObject({ value: { state: 'cancelled' } });
    await f.rpc('attachment.arm', arm({ id: 'new-arm' })); f.setSession('replacement'); await f.bridge.rebind();
    expect(await f.rpc('attachment.status', { id: 'new-arm' })).toMatchObject({ ok: false }); expect(f.timers.at(-1)!.cancel).toHaveBeenCalled();
  });

  it('checks the real prompt hook before next once, rejects unowned/mismatch and leaves headless inert', async () => {
    const f = await hooksFixture(); const next = vi.fn(async () => ({ text: 'native result' }));
    const prompt = f.handlers.get('prompt.submit')!; expect(await prompt(f.$, event(), next)).toMatchObject({ drop: expect.any(String) }); expect(next).not.toHaveBeenCalled();
    f.inbound(request('arm-real-hook', 'attachment.arm', arm())); await tick();
    expect(await prompt(f.$, event(), next)).toEqual({ text: 'native result' }); expect(next).toHaveBeenCalledExactlyOnceWith(event());
    expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'attachment.checked')).toMatchObject({ data: { state: 'accepted', origin: { kind: 'composer' } } });
    const headless = await hooksFixture(false); const unchanged = { text: 'headless core' }; expect(await headless.handlers.get('prompt.submit')!(headless.$, event(), async () => unchanged)).toBe(unchanged);
  });

  it('passes real native task notifications during ownership without consuming it', async () => {
    const f = await hooksFixture(); f.inbound(request('arm-notification', 'attachment.arm', arm())); await tick();
    const notification = event({ origin: { kind: 'task-notification' }, isMeta: true, text: 'a task ended', attachments: [] }); const unchanged = { text: 'native notification' }; const next = vi.fn(async () => unchanged);
    expect(await f.handlers.get('prompt.submit')!(f.$, notification, next)).toBe(unchanged); expect(next).toHaveBeenCalledExactlyOnceWith(notification);
    f.inbound(request('status-notification', 'attachment.status', { id: 'transaction-1' })); await tick(); expect(f.outputs.findLast((row) => row.type === 'response' && row.id === 'status-notification')).toMatchObject({ value: { state: 'armed' } });
    await f.handlers.get('turn.start')!(f.$, { turnId: 'notification-turn' }, async () => ({}));
    f.inbound(request('busy-fill', 'prompt.fill', { text: '[Image #3] safe text' })); await tick(); expect(f.outputs.findLast((row) => row.type === 'response' && row.id === 'busy-fill')).toMatchObject({ ok: false }); expect(f.api.prompt.fill).not.toHaveBeenCalled();
  });

  it('does not acknowledge a native prompt until exactly one next confirms entry or queueing', async () => {
    const f = await hooksFixture(); f.inbound(request('arm-core-ack', 'attachment.arm', arm())); await tick();
    let resolve!: (result: { text: string }) => void; const entered = new Promise<{ text: string }>((done) => { resolve = done; });
    const next = vi.fn(() => entered); const pending = f.handlers.get('prompt.submit')!(f.$, event(), next); await tick();
    f.inbound(request('pre-core-status', 'attachment.status', { id: 'transaction-1' })); await tick();
    expect(f.outputs.findLast((row) => row.type === 'response' && row.id === 'pre-core-status')).toMatchObject({ value: { state: 'armed', entered: false } });
    resolve({ text: 'User hook legitimately rewrote this text' }); expect(await pending).toEqual({ text: 'User hook legitimately rewrote this text' });
    expect(next).toHaveBeenCalledTimes(1); expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'attachment.checked')).toMatchObject({ data: { state: 'accepted', entered: true, text: event().text, enteredText: 'User hook legitimately rewrote this text' } });
  });

  it('preserves downstream drop/rejection and never reports accepted delivery or retries next', async () => {
    const f = await hooksFixture(); const prompt = f.handlers.get('prompt.submit')!;
    f.inbound(request('arm-downstream-drop', 'attachment.arm', arm())); await tick();
    const drop = { drop: 'native user rule dropped this prompt' }; const droppedNext = vi.fn(async () => drop);
    expect(await prompt(f.$, event(), droppedNext)).toBe(drop); expect(droppedNext).toHaveBeenCalledTimes(1);
    expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'attachment.checked')).toMatchObject({ data: { state: 'rejected', entered: false } });
    f.inbound(request('arm-downstream-error', 'attachment.arm', arm({ id: 'reject-next' }))); await tick();
    const failedNext = vi.fn(async () => { throw new Error('native rejection after entering the lower hook'); });
    await expect(prompt(f.$, event(), failedNext)).rejects.toThrow('native rejection'); expect(failedNext).toHaveBeenCalledTimes(1);
    expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'attachment.checked')).toMatchObject({ data: { id: 'reject-next', state: 'rejected', entered: false } });
  });

  it('passes through native workflow/task/measurement event bodies and returns exact results once', async () => {
    const f = await hooksFixture();
    for (const name of ['tool.call', 'agent.spawn']) {
      const input = { tool: 'Agent', agentId: 'child', tool_use_id: 'call', opaque: { value: 1 } }; const result = { ref: 'native-ref', result: { id: 'agent', taskId: 'task' }, isError: false }; const next = vi.fn(async () => result);
      expect(await f.handlers.get(name)!(f.$, input, next)).toBe(result); expect(next).toHaveBeenCalledExactlyOnceWith(input); expect(f.outputs.findLast((row) => row.type === 'event' && row.event === name)).toMatchObject({ data: { input, result } });
    }
    const measurement = { context: { percent: 12 }, rateLimits: [{ percentUsed: 33 }], cost: { total: 0.2 }, changed: ['rateLimits'] }; const measured = { changed: ['rateLimits'] }; const measuredNext = vi.fn(async () => measured);
    expect(await f.handlers.get('session.measure')!(f.$, measurement, measuredNext)).toBe(measured); expect(measuredNext).toHaveBeenCalledExactlyOnceWith(measurement); expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'session.measure')).toMatchObject({ data: measurement });
    const task = { id: 'background', status: 'completed', toolUseId: 'background-tool' }; const rendered = { type: 'Text', children: 'native' }; const renderedNext = vi.fn(async () => rendered);
    expect(await f.handlers.get('ui.render')!(f.$, { component: 'UserMessage', props: { origin: { kind: 'task-notification' }, task } }, renderedNext)).toBe(rendered); expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'task.notification')).toMatchObject({ data: task });
    const before = f.outputs.length; await f.handlers.get('ui.render')!(f.$, { component: 'UserMessage', props: { origin: { kind: 'composer' }, task } }, renderedNext); expect(f.outputs.length).toBe(before);
    const stopped = { additionalContext: ['keep native hook output'] }; const stopNext = vi.fn(async () => stopped); const stopping = { background_tasks: [{ id: 'live', status: 'running' }] };
    expect(await f.handlers.get('classic.Stop')!(f.$, stopping, stopNext)).toBe(stopped); expect(stopNext).toHaveBeenCalledExactlyOnceWith(stopping); expect(f.outputs.findLast((row) => row.type === 'event' && row.event === 'classic.Stop')).toMatchObject({ data: stopping });
    const count = f.outputs.length; await f.handlers.get('classic.Stop')!(f.$, { agent_id: 'child', background_tasks: [] }, stopNext); expect(f.outputs.length).toBe(count);
  });

  it('never retries a native append after next has already executed and rejected', async () => {
    const f = await hooksFixture(); let appended = 0;
    const next = vi.fn(async () => { appended++; throw new Error('native append completed then reporting failed'); });
    await expect(f.handlers.get('session.append')!(f.$, { message: { type: 'user', content: [] } }, next)).rejects.toThrow('reporting failed');
    expect(appended).toBe(1); expect(next).toHaveBeenCalledTimes(1); expect(f.catches.has('session.append')).toBe(false);
  });
});
