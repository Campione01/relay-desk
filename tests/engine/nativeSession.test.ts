import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { EngineEvent } from '@shared/events';
import type { ModelOption, OpenSessionRequest, TranscriptItem } from '@shared/types';
import { PermissionBroker } from '../../src/main/engine/broker';
import type { EngineSessionLike } from '../../src/main/engine/ipc';
import type { NativeEvent, NativeExitCause, NativeLaunch, NativeReady, NativeRequestOptions, NativeRuntime } from '../../src/main/native/contract';
import { NativeCapabilityError, NativeInteractiveSession, type NativeInteractiveSessionOptions } from '../../src/main/native/session';
import { NativeControlGate, NativeUiWaitTimeout, NATIVE_MCP_PENDING_SETTLE_MS, NATIVE_UI_PINNED_SHA256 } from '../../src/main/native/controls';
import type { NativeAttachmentComposer, NativeAttachmentGuardStatus, NativeAttachmentStorage } from '../../src/main/native/attachments';
import type { PrivateFileInfo, PrivateLaunch } from '../../src/main/native/privateStorage';

vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('The native adapter must not import the SDK runtime.'); });

const BASE_CAPS = ['prompt.submit', 'turn.abort', 'interaction.reply', 'session.usage', 'session.model',
  'session.messages', 'session.compact', 'config.list', 'config.set', 'command.list', 'command.run', 'tool.list', 'tool.call', 'agent.list'];
const LAUNCH: NativeLaunch = { exe: 'D:\\synthetic\\claude.exe', args: ['--effort', 'xhigh'], cwd: 'D:\\synthetic', env: {}, handleId: 'h' };

class FakeRuntime implements NativeRuntime {
  readonly events = new Set<(event: NativeEvent) => void>();
  readonly exits = new Set<(code: number | null, cause?: NativeExitCause) => void>();
  readonly terminals = new Set<(data: string) => void>();
  sequence = 0;
  ready: NativeReady = { sessionId: 'native-session', isInteractive: true, surface: 'terminal', protocol: 1,
    capabilities: BASE_CAPS, model: 'native-opus', cwd: LAUNCH.cwd };
  config = [{ key: 'effortLevel', value: 'xhigh', kind: 'choice', isLocked: false },
    { key: 'model', value: 'opus', kind: 'choice', isLocked: false, options: ['opus', 'sonnet'] }];
  handler?: (method: string, args?: unknown, options?: NativeRequestOptions) => unknown | Promise<unknown>;
  start = vi.fn(async (_launch: NativeLaunch): Promise<NativeReady> => this.ready);
  request = vi.fn(async (method: string, args?: unknown, _options?: NativeRequestOptions): Promise<unknown> => {
    if (this.handler) {
      const answer = await this.handler(method, args, _options);
      if (answer !== undefined) return answer;
    }
    switch (method) {
      case 'command.list': return [{ name: 'compact', description: 'Compact the conversation' }];
      case 'tool.list': return [{ name: 'Read' }, { name: 'TaskStop' }];
      case 'config.list': return this.config;
      case 'agent.list': return [];
      case 'session.model': return 'native-opus';
      case 'session.usage': return { startedAt: 1, context: { tokens: 10, window: 100, percent: 10 }, rateLimits: [] };
      case 'prompt.submit': return { text: (args as { text: string }).text };
      default: return {};
    }
  });
  close = vi.fn(async () => undefined);
  writeTerminal = vi.fn(async (_data: string) => undefined);
  resize = vi.fn(async (_cols: number, _rows: number) => undefined);
  onTerminal(listener: (data: string) => void): () => void { this.terminals.add(listener); return () => this.terminals.delete(listener); }
  onEvent(listener: (event: NativeEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  onExit(listener: (code: number | null, cause?: NativeExitCause) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emit(event: string, data: unknown, overrides: Partial<NativeEvent> = {}): void {
    const frame: NativeEvent = { event, data, sessionId: this.ready.sessionId, sequence: ++this.sequence, ...overrides };
    for (const listener of this.events) listener(frame);
  }
  exit(code: number | null, cause?: NativeExitCause): void { for (const listener of this.exits) listener(code, cause); }
  terminal(text: string): void { for (const listener of this.terminals) listener(text); }
}

function setup(request: Partial<OpenSessionRequest> = {}, runtime = new FakeRuntime(), controls?: NativeInteractiveSessionOptions['controls'], attachments?: NativeInteractiveSessionOptions['attachments'], mcpControls?: NativeInteractiveSessionOptions['mcpControls'], now = () => 1000) {
  const events: EngineEvent[] = [];
  let session: NativeInteractiveSession;
  const broker = new PermissionBroker('h', (event) => events.push(event), {
    onPendingChange: (count) => session.onPendingChange(count),
    onDecision: (info) => session.onToolDecision(info),
  });
  const closed = vi.fn();
  let id = 0;
  session = new NativeInteractiveSession({ handleId: 'h', runtime, launch: LAUNCH, controls, attachments, mcpControls,
    request: { cwd: LAUNCH.cwd, profileId: 'default', effort: 'xhigh', ...request },
    profile: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
    broker, emit: (event) => events.push(event), onClosed: closed, newId: () => `send-${++id}`, now });
  const compatible: EngineSessionLike = session;
  void compatible;
  return { session, runtime, events, broker, closed };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function holdNativeCommand(runtime: FakeRuntime) {
  let complete!: (value: unknown) => void, fail!: (error: Error) => void;
  const pending = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const original = runtime.handler;
  runtime.handler = (method, args, options) => {
    if (method !== 'command.run') return original?.(method, args, options);
    options?.signal?.addEventListener('abort', () => fail(new Error('Native transport: request aborted')), { once: true });
    return pending;
  };
  return { complete, fail };
}

function attachmentSession() {
  const runtime = new FakeRuntime();
  runtime.ready.capabilities = [...BASE_CAPS, 'prompt.read', 'prompt.fill', 'attachment.arm', 'attachment.status', 'attachment.disarm'];
  let draft = '', turn = 0, count = 0;
  let armed: Parameters<NativeAttachmentComposer['arm']>[0];
  let status: NativeAttachmentGuardStatus;
  const files = new Map<PrivateLaunch, PrivateFileInfo[]>();
  const info = (path: string, kind: 'file' | 'directory' = 'directory') => ({ path, kind, id: path,
    ownerSid: 'S-test', protectedDacl: true, aceCount: 2, inheritedAceCount: 0, linkCount: 1, byteLength: 0 });
  const storage: NativeAttachmentStorage = {
    createLaunch: vi.fn(() => { const launch = { path: `C:\\RelayDeskNativePrototype\\fixture\\launch-${++count}`, identity: String(count) }; files.set(launch, []); return launch; }),
    writeBytes: vi.fn((launch, bytes, name) => {
      const file = { ...info(win32.join(launch.path, name), 'file'), byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      files.get(launch)!.push(file); return file;
    }),
    verify: vi.fn((launch) => ({ launch: info(launch.path), files: files.get(launch)! })),
    removeLaunch: vi.fn((launch) => { files.delete(launch); }),
  };
  const retained = vi.fn(), cleanup = vi.fn();
  const h = setup({}, runtime, undefined, () => ({ storage, onAccepted: retained, close: cleanup }));
  const image = { kind: 'image' as const, mediaType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  const submitted: string[] = [];
  runtime.handler = (method, args) => {
    const input = args as Record<string, unknown>;
    if (method === 'prompt.read') return { text: draft, cursor: draft.length };
    if (method === 'prompt.fill') { draft = input.text as string; return { isFilled: true, text: draft }; }
    if (method === 'attachment.arm') { armed = input as unknown as typeof armed; status = { id: armed.id, state: 'armed' }; return { id: armed.id, armed: true, guard: 'native-before-model-v1' }; }
    if (method === 'attachment.status') return status;
    if (method === 'attachment.disarm') { status.state = 'cancelled'; return {}; }
    if (method === 'prompt.submit') {
      submitted.push(input.text as string); runtime.emit('turn.start', { turnId: `t${++turn}` }); return {};
    }
    if (method === 'turn.abort') { runtime.emit('turn.complete', { turnId: input.turnId, reason: 'aborted' }); return { interrupted: true }; }
    return undefined;
  };
  runtime.writeTerminal.mockImplementation(async (key) => {
    if (key === '\r') {
      const nativeText = draft;
      status = { id: armed.id, state: 'accepted', entered: true, observed: armed.expected, text: nativeText, origin: { kind: 'composer' } };
      submitted.push(nativeText); draft = '';
      runtime.emit('turn.start', { turnId: `t${++turn}` });
      runtime.emit('session.append', { uuid: `echo-${turn}`, door: 'prompt', message: { type: 'user', content: [{ type: 'text', text: nativeText }] } });
    } else draft += `[Image #${(draft.match(/\[Image #\d+\]/g)?.length ?? 0) + 1}]`;
  });
  return { ...h, image, storage, retained, cleanup, files, submitted, complete: () => runtime.emit('turn.complete', { turnId: `t${turn}`, reason: 'answer' }) };
}

describe('native session attachment integration', () => {
  it('keeps image previews and GUI identity through a synchronous native echo without SDK submission', async () => {
    const h = attachmentSession(); await h.session.start();
    await h.session.send('first line\nsecond line', { attachments: [h.image, h.image] });
    const users = h.events.filter((event) => event.type === 'item' && event.item.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ item: { id: 'send-1', text: 'first line\nsecond line', images: 2, imageRefs: [{}, {}] } });
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false);
    expect(h.retained).toHaveBeenCalledTimes(1);
    await h.session.close(); expect(h.files.size).toBe(0); expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
  it('shares next/later order across text and attachments and stages only when actually dispatched', async () => {
    const h = attachmentSession(); await h.session.start(); await h.session.send('A');
    await h.session.send('B', { queue: true, attachments: [h.image] });
    expect(h.storage.createLaunch).not.toHaveBeenCalled();
    await h.session.send('C');
    await vi.waitFor(() => expect(h.submitted).toEqual(['A', 'C']));
    h.complete();
    await vi.waitFor(() => expect(h.submitted).toEqual(['A', 'C', '[Image #1] B']));
    expect(h.retained).toHaveBeenCalledTimes(1); await h.session.close();
  });
  it('accepts image-only sends and rejects invalid bytes before any private file or terminal input', async () => {
    const h = attachmentSession(); await h.session.start();
    await expect(h.session.send('', { attachments: [{ ...h.image, data: 'AA==' }] })).rejects.toThrow('media type');
    expect(h.storage.createLaunch).not.toHaveBeenCalled(); expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    await h.session.send('', { attachments: [h.image] });
    expect(h.submitted).toEqual(['[Image #1]']); await h.session.close();
  });
  it('drops queued attachments on close without staging and cleans assets on an unplanned child exit', async () => {
    const h = attachmentSession(); await h.session.start(); await h.session.send('A', { attachments: [h.image] });
    await h.session.send('B', { queue: true, attachments: [h.image] });
    expect(h.storage.createLaunch).toHaveBeenCalledTimes(1);
    h.runtime.exit(3);
    await vi.waitFor(() => expect(h.session.currentState).toBe('closed'));
    expect(h.files.size).toBe(0); expect(h.cleanup).toHaveBeenCalledTimes(1); expect(h.submitted).toHaveLength(1);
  });
});

function withControls(options: { forcedEffort?: string; fingerprintChange?: boolean; autoCommit?: boolean;
  attachments?: NativeInteractiveSessionOptions['attachments'] } = {}) {
  const runtime = new FakeRuntime();
  runtime.ready.capabilities = [...BASE_CAPS, 'ui.command', 'env.effort',
    ...(options.attachments ? ['prompt.read', 'prompt.fill', 'attachment.arm', 'attachment.status', 'attachment.disarm'] : [])];
  const preferenceFingerprint = vi.fn(async () => (options.fingerprintChange && committed ? 'b' : 'a').repeat(64));
  const h = setup({}, runtime, { cliSha256: NATIVE_UI_PINNED_SHA256, preferenceFingerprint }, options.attachments);
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const models = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', row: 'Opus New Opus 5.5' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', row: 'Fable New Fable 5.1' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', row: 'Sonnet New Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', row: 'Haiku New Haiku 5.5' }];
  let active: 'model' | 'effort' | undefined, effort = 3, model = 0, selectedModel = 0, committed = false;
  let resolveCommand: ((value: unknown) => void) | undefined;
  const render = (text: string) => runtime.terminal(`\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`);
  const draw = () => {
    if (active === 'model') render(`Select model\nYour pick becomes the default for new sessions.\n${models.map((item, index) => `${selectedModel === index ? '>' : ' '} ${index + 1}. ${item.row}`).join('\n')}\nEnter to set as default · s to use this session only · Esc to cancel`);
    else {
      const labels = 'low     medium     high     xhigh      max';
      const selected = efforts[effort], start = selected === 'high' ? labels.indexOf('medium') : 0;
      const column = labels.indexOf(selected, start) + Math.floor((selected.length - 1) / 2);
      render(`Effort\n${' '.repeat(column)}▲\n${labels}\n←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`);
    }
  };
  runtime.handler = (method, args) => {
    if (method === 'env.effort') return options.forcedEffort ?? null;
    if (method === 'session.model') return models[model].id;
    if (method === 'ui.command') {
      active = (args as { command: 'model' | 'effort' }).command;
      draw();
      return new Promise((resolve) => { resolveCommand = resolve; });
    }
    return undefined;
  };
  const complete = () => {
    committed = true;
    if (active === 'model') model = selectedModel;
    render(active === 'model' ? `Set model to ${models[model].name} for this session only` : `Set effort level to ${efforts[effort]} (this session only)`);
    active = undefined; resolveCommand?.({});
  };
  runtime.writeTerminal.mockImplementation(async (key) => {
    if (key === 's') { if (options.autoCommit !== false) complete(); return; }
    if (active === 'model') selectedModel += key === '\x1b[B' ? 1 : -1;
    else effort += key === '\x1b[C' ? 1 : -1;
    draw();
  });
  return { ...h, preferenceFingerprint, render, complete };
}

function withDefaultMcpCatalog(known: readonly string[], servers: readonly { name: string; status: 'connected' | 'disabled' | 'needs-auth'; toolCount: number }[]) {
  const h = withControls();
  h.session.options.mcpServers = Object.fromEntries(known.map((name) => [name, { command: 'synthetic-only' }]));
  let view: 'manager' | 'detail' | 'idle' = 'idle', selected = 0;
  let complete: ((value: unknown) => void) | undefined;
  const draw = () => h.render(view === 'manager'
    ? `Manage MCP servers\n${servers.length} servers\n${servers.map((server, index) => `${index === selected ? '>' : ' '} ${server.status === 'connected' ? '\u221a' : server.status === 'disabled' ? '( )' : '\u203c'} ${server.name}${server.status === 'connected' ? ` ${server.toolCount} tools` : ''}`).join('\n')}\nEnter to confirm \u00b7 Esc to cancel`
    : view === 'detail' ? `${servers[selected].name} MCP Server\nStatus: ${servers[selected].status === 'needs-auth' ? 'needs authentication' : servers[selected].status}\nTools: ${servers[selected].toolCount} tools\n> 1. View tools\n  2. Reconnect\nEnter to select \u00b7 Esc to back`
      : '>\n? for shortcuts');
  const original = h.runtime.handler!;
  h.runtime.handler = (method, args) => {
    if (method !== 'ui.command') return original(method, args);
    expect(args).toEqual({ command: 'mcp', args: '' });
    if (servers.length === 0) return { text: 'No MCP servers configured.' };
    view = 'manager'; selected = 0; draw();
    return new Promise((resolve) => { complete = resolve; });
  };
  h.runtime.writeTerminal.mockImplementation(async (key) => {
    if (view === 'manager' && key === '\x1b[B') selected = (selected + 1) % servers.length;
    else if (view === 'manager' && key === '\x1b[A') selected = (selected + servers.length - 1) % servers.length;
    else if (view === 'manager' && key === '\r') view = 'detail';
    else if (view === 'detail' && key === '\x1b') view = 'manager';
    else if (view === 'manager' && key === '\x1b') { view = 'idle'; complete?.({}); }
    else throw new Error('Unexpected mutation or unguarded key in read-only MCP catalog fixture');
    draw();
  });
  return { ...h, catalogView: () => view };
}

function withPendingMcp(pendingLabel = '… connecting') {
  const runtime = new FakeRuntime();
  runtime.ready.capabilities = [...BASE_CAPS, 'ui.command', 'env.effort', 'mcp.nativeAction'];
  const h = setup({}, runtime, { cliSha256: NATIVE_UI_PINNED_SHA256,
    preferenceFingerprint: async () => 'a'.repeat(64), assertPreferenceScope: () => {} });
  h.session.options.mcpServers = { alpha: { command: 'synthetic-only' } };
  let view: 'idle' | 'manager' | 'detail' | 'closed' = 'idle';
  let status: 'pending' | 'connected' = 'pending', toolCount = 0;
  let resolveCommand: ((value: unknown) => void) | undefined;
  let openedAt = 0;
  const durations: number[] = [];
  const draw = () => runtime.terminal('\x1b[2J\x1b[H' + (view === 'manager'
    ? `Manage MCP servers\r\n1 server\r\n> ${status === 'pending' ? '…' : '√'} alpha${status === 'connected' ? ` ${toolCount} tools` : ''}\r\nEnter to confirm · Esc to cancel`
    : view === 'detail' ? `alpha MCP Server\r\nStatus: ${status === 'pending' ? pendingLabel : '√ connected'}\r\nTools: ${toolCount} tools\r\n> 1. View tools\r\nEnter to select · Esc to back`
      : '>\r\n? for shortcuts'));
  runtime.handler = (method, args) => {
    if (method !== 'ui.command') return undefined;
    expect(args).toEqual({ command: 'mcp', args: '' });
    openedAt = Date.now(); view = 'manager'; draw();
    return new Promise((resolve) => { resolveCommand = resolve; });
  };
  runtime.writeTerminal.mockImplementation(async (key) => {
    if (key === '\r' && view === 'manager') view = 'detail';
    else if (key === '\x1b' && view === 'detail') view = 'manager';
    else if (key === '\x1b' && view === 'manager') {
      view = 'idle'; durations.push(Date.now() - openedAt); resolveCommand?.({});
    } else throw new Error('Unsafe synthetic MCP key');
    draw();
  });
  runtime.close.mockImplementation(async () => { view = 'closed'; resolveCommand?.({}); });
  return { ...h, durations, view: () => view,
    connect: (count: number, redraw = true) => { status = 'connected'; toolCount = count; if (redraw) draw(); } };
}

describe('native MCP pending dialog reads', () => {
  it('does not open the MCP dialog at startup, where it would hold the first message and refuse commands', async () => {
    vi.useFakeTimers(); const h = withPendingMcp();
    try {
      await h.session.start(); await vi.advanceTimersByTimeAsync(NATIVE_MCP_PENDING_SETTLE_MS + 1000);
      expect(h.view()).toBe('idle');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(0);
      await h.session.send('first');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('refreshes a stale pending detail once when the same native manager has already observed connection', async () => {
    vi.useFakeTimers(); const h = withPendingMcp('( ) connecting\u2026');
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(500);
      expect(h.view()).toBe('detail');
      h.connect(4, false);
      await vi.advanceTimersByTimeAsync(NATIVE_MCP_PENDING_SETTLE_MS + 1000);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: [{ status: 'connected', toolCount: 4 }] });
      expect(h.events.some((event) => event.type === 'error')).toBe(false);
      expect(h.view()).toBe('idle');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
      expect(h.runtime.request.mock.calls.some(([method]) => ['prompt.submit', 'mcp.nativeAction'].includes(method))).toBe(false);
      expect(h.runtime.writeTerminal.mock.calls.map(([key]) => key)).toEqual(['\r', '\x1b', '\r', '\x1b', '\x1b']);
      expect(h.durations[0]).toBeLessThan(25_000);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it.each(['( ) connecting\u2026', '( ) connecting...'])('accepts native pending punctuation %s without poisoning the dialog', async (label) => {
    vi.useFakeTimers(); const h = withPendingMcp(label);
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(500);
      expect(h.view()).toBe('detail');
      expect(h.events.some((event) => event.type === 'error' || event.type === 'mcp')).toBe(false);
      h.connect(2); await vi.advanceTimersByTimeAsync(500);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: [{ status: 'connected', toolCount: 2 }] });
      expect(h.view()).toBe('idle');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
      expect(h.runtime.close).not.toHaveBeenCalled();
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('discovers dynamically installed controls and publishes a late connected redraw without another prompt or action', async () => {
    vi.useFakeTimers(); const h = withPendingMcp();
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(500);
      expect(h.view()).toBe('detail');
      expect(h.events.filter((event) => event.type === 'mcp')).toHaveLength(0);
      h.connect(7); await vi.advanceTimersByTimeAsync(500);
      expect(h.events.filter((event) => event.type === 'mcp')).toEqual([
        { type: 'mcp', handleId: 'h', servers: [{ name: 'alpha', status: 'connected', toolCount: 7,
          relay: true, source: 'native-account-dialog', scope: 'relay-account-project' }] },
      ]);
      expect(h.view()).toBe('idle');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
      expect(h.runtime.request.mock.calls.some(([method]) => ['prompt.submit', 'mcp.nativeAction', 'mcp.toggle', 'mcp.reconnect'].includes(method))).toBe(false);
      expect(h.runtime.writeTerminal.mock.calls.map(([key]) => key)).toEqual(['\r', '\x1b', '\x1b']);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('expires one pending read before the native RPC deadline, dismisses safely and leaves later reads usable', async () => {
    vi.useFakeTimers(); const h = withPendingMcp();
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(NATIVE_MCP_PENDING_SETTLE_MS + 1000);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: [{ status: 'pending', toolCount: 0 }] });
      expect(h.events.some((event) => event.type === 'error')).toBe(false);
      expect(h.view()).toBe('idle'); expect(h.durations[0]).toBeLessThan(25_000);
      h.connect(3); const refreshed = h.session.mcpStatus();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(refreshed).resolves.toMatchObject([{ status: 'connected', toolCount: 3 }]);
      expect(h.view()).toBe('idle');
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('waits through an incomplete terminal redraw instead of poisoning the owned pending dialog', async () => {
    vi.useFakeTimers(); const h = withPendingMcp();
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(500);
      expect(h.view()).toBe('detail');
      h.runtime.terminal('\x1b[2J\x1b[Halpha MCP Server\r\n');
      await vi.advanceTimersByTimeAsync(200);
      expect(h.events.some((event) => event.type === 'error' || event.type === 'mcp')).toBe(false);
      h.connect(5); await vi.advanceTimersByTimeAsync(500);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: [{ status: 'connected', toolCount: 5 }] });
      expect(h.view()).toBe('idle');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('cancels a pending read on close, closing its runtime without late keys or status events', async () => {
    vi.useFakeTimers(); const h = withPendingMcp();
    try {
      await h.session.start(); void h.session.mcpStatus().catch(() => undefined); await vi.advanceTimersByTimeAsync(500);
      expect(h.view()).toBe('detail'); const keys = h.runtime.writeTerminal.mock.calls.length;
      await h.session.close(); await vi.advanceTimersByTimeAsync(100);
      h.connect(9); await vi.advanceTimersByTimeAsync(NATIVE_MCP_PENDING_SETTLE_MS);
      expect(h.view()).toBe('closed'); expect(h.runtime.close).toHaveBeenCalledOnce();
      expect(h.runtime.writeTerminal).toHaveBeenCalledTimes(keys);
      expect(h.events.filter((event) => event.type === 'mcp')).toHaveLength(0);
      expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(h.session.currentState).toBe('closed');
    } finally { await h.session.close(); vi.useRealTimers(); }
  });
});

describe('native interactive session startup and ownership', () => {
  it('starts exactly one injected interactive runtime with unchanged effort and no SDK query', async () => {
    const { session, runtime, events } = setup();
    expect(await session.start()).toEqual({ handleId: 'h', profileId: 'default', cwd: LAUNCH.cwd, sessionId: 'native-session' });
    await settle();
    expect(runtime.start).toHaveBeenCalledExactlyOnceWith(LAUNCH);
    expect(LAUNCH.args).toEqual(['--effort', 'xhigh']);
    expect(events.some((event) => event.type === 'commands')).toBe(true);
    expect(events.find((event) => event.type === 'init')).toMatchObject({ model: 'native-opus' });
    expect(session.currentState).toBe('idle');
    await expect(session.start()).rejects.toThrow('already started');
    await session.close();
  });

  it('rejects a headless/foreign surface and closes the process', async () => {
    const runtime = new FakeRuntime();
    runtime.ready.isInteractive = false;
    const { session } = setup({}, runtime);
    await expect(session.start()).rejects.toThrow('real interactive');
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(session.currentState).toBe('closed');
  });

  it('rejects an unsaved side chat until native no-persistence has a verified capability', async () => {
    const { session, runtime } = setup({ ephemeral: true, forkSession: true, resumeSessionId: 'parent' });
    await expect(session.start()).rejects.toThrow('session.ephemeral');
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a resume/fork handshake that would target the wrong writer', async () => {
    for (const request of [{ resumeSessionId: 'wanted' }, { resumeSessionId: 'native-session', forkSession: true }]) {
      const h = setup(request);
      await expect(h.session.start()).rejects.toThrow('resume/fork ownership');
      expect(h.runtime.close).toHaveBeenCalledTimes(1);
    }
    const h = setup({ resumeSessionId: 'NATIVE-SESSION' });
    await expect(h.session.start()).resolves.toMatchObject({ sessionId: 'native-session' });
    await h.session.close();
  });

  it('does not reopen a process or emit ready state when closed during startup', async () => {
    const h = setup();
    let resolve!: (ready: NativeReady) => void;
    h.runtime.start.mockImplementationOnce(() => new Promise<NativeReady>((done) => { resolve = done; }));
    const started = h.session.start();
    await h.session.close();
    resolve(h.runtime.ready);
    await expect(started).rejects.toThrow('closed during startup');
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.type === 'init')).toHaveLength(0);
  });

  it('buffers startup events and filters foreign, duplicate and out-of-order frames', async () => {
    const h = setup();
    h.runtime.start.mockImplementationOnce(async () => {
      h.runtime.emit('turn.start', { turnId: 't' });
      return h.runtime.ready;
    });
    await h.session.start();
    h.runtime.emit('turn.step', { turnId: 't', stepId: 's', chunk: { kind: 'text', index: 0, text: 'safe' } }, { sessionId: 'other' });
    h.runtime.emit('turn.step', { turnId: 't', stepId: 's', chunk: { kind: 'text', index: 0, text: 'one' } });
    const last = h.runtime.sequence;
    h.runtime.emit('turn.step', { turnId: 't', stepId: 's', chunk: { kind: 'text', index: 0, text: 'duplicate' } }, { sequence: last });
    expect(h.events.filter((event) => event.type === 'item').map((event) => event.item)).toEqual([
      { kind: 'assistant', id: 'native:t:s:main:0:assistant', text: 'one', streaming: true },
    ]);
    await h.session.close();
  });
});

describe('native sends and native turn identity', () => {
  it('keeps identical queued texts bound to their actual-delivery UUIDs instead of acceptance order', async () => {
    const h = setup(); await h.session.start(); await h.session.send('first');
    h.runtime.emit('turn.start', { turnId: 'a' });
    await h.session.send('same', { queue: true }); await h.session.send('same');
    let nativeMessage = 0;
    h.runtime.handler = (method) => {
      if (method === 'prompt.submit') h.runtime.emit('session.append', { uuid: `native-${++nativeMessage}`, door: 'prompt', message: { type: 'user', content: 'same' } });
      return undefined;
    };
    h.runtime.emit('turn.complete', { turnId: 'a', reason: 'aborted' }); await settle();
    h.runtime.emit('turn.start', { turnId: 'c' }); h.runtime.emit('turn.complete', { turnId: 'c', reason: 'answer' }); await settle();
    const echoes = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' && event.item.text === 'same' ? [event.item] : []);
    expect(echoes).toEqual([{ kind: 'user', id: 'send-2', text: 'same', queued: true }, { kind: 'user', id: 'send-3', text: 'same', queued: true },
      { kind: 'user', id: 'send-3', text: 'same' }, { kind: 'user', id: 'send-2', text: 'same' }]);
    await h.session.close();
  });

  it('cancels pending later sends on close without any late native submission', async () => {
    const h = setup(); await h.session.start(); h.runtime.emit('turn.start', { turnId: 'a' });
    await h.session.send('never deliver', { queue: true });
    await h.session.close(); h.runtime.emit('turn.complete', { turnId: 'a', reason: 'answer' }); await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    expect(h.runtime.terminals.size).toBe(0);
  });

  it('reports an acknowledged next cancellation without retrying or downgrading its priority', async () => {
    const h = setup(); await h.session.start(); h.runtime.emit('turn.start', { turnId: 'a' });
    h.runtime.handler = (method) => method === 'turn.abort' ? { deny: 'Synthetic abort refusal' } : undefined;
    await h.session.send('next'); await settle();
    expect(h.events.filter((event) => event.type === 'error').some((event) => event.message.includes('not delivered'))).toBe(true);
    h.runtime.emit('turn.complete', { turnId: 'a', reason: 'answer' }); await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
    await h.session.close();
  });
  it('reuses one session and submits A,next C,later B only after each native turn completes', async () => {
    const h = setup();
    await h.session.start();
    await h.session.send('first');
    h.runtime.emit('turn.start', { turnId: 'main-1' });
    await h.session.send('later', { queue: true });
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'turn.abort')).toHaveLength(0);
    await h.session.send('next');
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'turn.abort').map(([, args]) => args)).toEqual([{ turnId: 'main-1' }]);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => args)).toEqual([{ text: 'first', asUser: true }]);
    expect(h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : [])).toEqual([
      { kind: 'user', id: 'send-1', text: 'first' }, { kind: 'user', id: 'send-2', text: 'later', queued: true }, { kind: 'user', id: 'send-3', text: 'next', queued: true },
    ]);
    h.runtime.emit('turn.complete', { turnId: 'main-1', reason: 'aborted' }); await settle();
    h.runtime.emit('turn.start', { turnId: 'main-2' });
    h.runtime.emit('turn.complete', { turnId: 'main-2', reason: 'answer' }); await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => args)).toEqual([
      { text: 'first', asUser: true }, { text: 'next', asUser: true }, { text: 'later', asUser: true },
    ]);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    await h.session.close();
  });

  it('does not fake attachment ingestion and waits for identity before preempting a submitted turn', async () => {
    const h = setup();
    await h.session.start();
    await expect(h.session.send('image', { attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AA==' }] }))
      .rejects.toThrow('prompt.attachments');
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
    await h.session.send('first');
    await h.session.send('second');
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'turn.abort')).toHaveLength(0);
    h.runtime.emit('turn.start', { turnId: 'known' }); await settle();
    expect(h.runtime.request).toHaveBeenCalledWith('turn.abort', { turnId: 'known' }, expect.anything());
    await h.session.close();
  });

  it('does not resurrect a turn that completed before its submission acknowledgement', async () => {
    const h = setup();
    h.runtime.handler = (method) => {
      if (method === 'prompt.submit') {
        h.runtime.emit('turn.start', { turnId: 'quick' });
        h.runtime.emit('turn.complete', { turnId: 'quick', reason: 'answer', answer: 'ok', durationMs: 1 });
        return { text: 'hello' };
      }
    };
    await h.session.start();
    await h.session.send('hello');
    expect(h.session.currentState).toBe('idle');
    await h.session.close();
  });

  it('reports native output counts without adding cumulative step counts twice', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('turn.start', { turnId: 't' });
    const stop = { turnId: 't', stepId: 0, chunk: { kind: 'stop', usage: { output_tokens: 7 } } };
    h.runtime.emit('turn.step', stop);
    h.runtime.emit('turn.step', stop);
    h.runtime.emit('turn.step', { turnId: 't', stepId: 1, chunk: { kind: 'stop', usage: { output_tokens: 3 } } });
    expect(h.events.filter((event) => event.type === 'state').at(-1)).toMatchObject({ state: 'running', tokens: 10 });
    h.runtime.emit('turn.complete', { turnId: 't', reason: 'answer', usage: { output_tokens: 10 } });
    expect(h.events.filter((event) => event.type === 'state').at(-1)).toMatchObject({ state: 'idle', tokens: 10 });
    await h.session.close();
  });

  it('dispatches slash commands through the native command bus rather than a model prompt', async () => {
    const h = setup();
    await h.session.start();
    await h.session.send('/compact retain the plan');
    expect(h.runtime.request).toHaveBeenCalledWith('command.run', { command: 'compact', args: 'retain the plan' }, expect.anything());
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
    expect(h.session.currentState).toBe('idle');
    await h.session.close();
  });

  it('preserves the GUI draft on native rejection and permits a later manual retry', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.handler = (method) => method === 'prompt.submit' ? { drop: 'Native policy refused this send.' } : undefined;
    await expect(h.session.send('blocked')).rejects.toThrow('Native policy');
    expect(h.events.filter((event) => event.type === 'item' && event.item.kind === 'user')).toHaveLength(0);
    h.runtime.handler = undefined;
    await expect(h.session.send('allowed')).resolves.toBeUndefined();
    await h.session.close();
  });
});

describe('completion-owned native slash commands', () => {
  it('waits 106 seconds for an empty completion, then refreshes context and delivers only the following explicit input', async () => {
    vi.useFakeTimers(); const h = setup();
    try {
      await h.session.start(); await settle(); h.runtime.request.mockClear();
      const native = holdNativeCommand(h.runtime);
      const command = h.session.send('/compact retain the plan');
      const settled = vi.fn(); void command.then(settled, () => undefined);
      await settle();
      const next = h.session.send('Explicitly submitted after compact');
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(106_000);
      expect(settled).not.toHaveBeenCalled();
      expect(h.runtime.request).toHaveBeenCalledExactlyOnceWith('command.run', { command: 'compact', args: 'retain the plan' },
        { timeoutMs: null, signal: expect.any(AbortSignal) });
      // The command shows as running, with the time it started, while the native CLI works on it.
      expect(h.session.currentState).toBe('running');
      expect(h.events.filter((event) => event.type === 'state').at(-1)).toMatchObject({ state: 'running', startedAt: 1000 });
      expect(h.runtime.close).not.toHaveBeenCalled(); expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
      native.complete({}); await command; await next; await settle();
      expect(h.runtime.request.mock.calls.map(([method]) => method).slice(0, 3)).toEqual(['command.run', 'session.usage', 'prompt.submit']);
      expect(h.runtime.request).toHaveBeenCalledWith('session.usage', { breakdown: 'summary' }, expect.anything());
      // Settings a command may have changed are read back once the composer is back.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(expect.arrayContaining(['session.model', 'command.list', 'config.list', 'tool.list']));
      // The message typed during the command showed as queued at once, then as sent (same item).
      const users = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : []);
      // The renderer keeps its own echoes in typed order; main confirms the command only when it ends.
      expect([...new Map(users.map((item) => [item.id, item.text])).values()].sort()).toEqual(['/compact retain the plan', 'Explicitly submitted after compact']);
      expect(users.find((item) => item.text === 'Explicitly submitted after compact')).toMatchObject({ queued: true });
      expect(users.at(-1)).toMatchObject({ text: 'Explicitly submitted after compact' });
      expect(users.at(-1)).not.toHaveProperty('queued');
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('blocks panel acquisition while the exact command owns native input and stops it with one Esc, never two', async () => {
    const h = withControls(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/compact'); await settle();
    try {
      await expect(h.session.setEffort('max')).rejects.toThrow('not idle');
      expect(h.session.currentState).toBe('running');
      // Two quick Escs open the CLI's message rewind, so a second Stop right away sends nothing.
      await h.session.interrupt(); await h.session.interrupt();
      expect(h.runtime.writeTerminal.mock.calls).toEqual([['\x1b']]);
      expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(['command.run']);
    } finally { native.complete({}); await command; await h.session.close(); }
  });

  it('refuses a second slash command at once instead of stacking it behind the first', async () => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/config'); await settle();
    await expect(h.session.send('/status')).rejects.toThrow('Finish /config before running another command.');
    const message = h.session.send('typed while the panel is open'); await settle();
    expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(['command.run']);
    native.complete({}); await command; await message; await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1);
    h.runtime.emit('turn.start', { turnId: 'reply' }); h.runtime.emit('turn.complete', { turnId: 'reply', reason: 'answer' }); await settle();
    await expect(h.session.send('/status')).resolves.toBeUndefined();
    await h.session.close();
  });

  it('holds an already queued normal prompt across turn completion until the pending command settles', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.emit('turn.start', { turnId: 'earlier-main' });
    await h.session.send('Already queued explicit input', { queue: true });
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/compact', { queue: true }); await settle();
    h.runtime.request.mockClear();
    h.runtime.emit('turn.complete', { turnId: 'earlier-main', reason: 'answer' }); await settle();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false);
    native.complete({}); await command; await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1);
    expect(h.runtime.request).toHaveBeenCalledWith('prompt.submit', { text: 'Already queued explicit input', asUser: true }, expect.anything());
    expect(h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' && event.item.text === '/compact' ? [event.item.queued] : []))
      .toEqual([undefined]);
    await h.session.close();
  });

  it('owns the input boundary before awaiting an existing main-turn interruption', async () => {
    const h = withControls(); await h.session.start(); await settle();
    let finishAbort!: (value: unknown) => void;
    const original = h.runtime.handler;
    h.runtime.handler = (method, args, options) => method === 'turn.abort'
      ? new Promise((resolve) => { finishAbort = resolve; }) : original?.(method, args, options);
    const native = holdNativeCommand(h.runtime);
    h.runtime.emit('turn.start', { turnId: 'main-to-interrupt' });
    const command = h.session.send('/compact'); await settle();
    h.runtime.emit('turn.complete', { turnId: 'main-to-interrupt', reason: 'aborted' });
    try {
      await expect(h.session.setEffort('max')).rejects.toThrow('not idle');
      expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command' || method === 'command.run')).toBe(false);
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
      finishAbort({ interrupted: true }); await settle(); native.complete({}); await command;
    } finally { finishAbort({ interrupted: true }); native.complete({}); await h.session.close(); }
  });

  it('does not replace newer native turn or permission state when a command completes', async () => {
    const h = setup(); await h.session.start(); await settle();
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/compact'); await settle();
    h.runtime.emit('turn.start', { turnId: 'newer-main' }); h.session.onPendingChange(1);
    native.complete({}); await command;
    expect(h.session.currentState).toBe('awaiting');
    h.session.onPendingChange(0); expect(h.session.currentState).toBe('running');
    await h.session.close();
  });

  it('requests fresh summary usage after a pre-command read settles instead of reusing that stale result', async () => {
    const h = setup(); await h.session.start(); await settle();
    let finishRead!: (value: unknown) => void, reads = 0;
    h.runtime.handler = (method) => method === 'session.usage' && ++reads === 1
      ? new Promise((resolve) => { finishRead = resolve; }) : undefined;
    const prior = h.session.contextUsage('summary');
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/compact'); await settle();
    native.complete({}); await command; await settle(); expect(reads).toBe(1);
    finishRead({ context: { tokens: 90, window: 100, percent: 90 } }); await prior; await settle();
    expect(reads).toBe(2);
    expect(h.events.filter((event) => event.type === 'context').at(-1)).toMatchObject({ usage: { usedTokens: 10 } });
    await h.session.close();
  });

  it.each(['Unknown native command', 'Native command rejected'])('preserves %s without refresh, replay or runtime closure', async (message) => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/unknown');
    const rejected = expect(command).rejects.toThrow(message); await settle(); native.fail(new Error(message)); await rejected;
    expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(['command.run']);
    expect(h.runtime.close).not.toHaveBeenCalled(); expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    await h.session.send('New explicit input after rejection');
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'command.run')).toHaveLength(1);
    await h.session.close();
  });

  it.each(['close', 'fatal'] as const)('rejects the pending command and never sends the input queued behind it on %s', async (ending) => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    const native = holdNativeCommand(h.runtime); const command = h.session.send('/compact');
    const rejected = expect(command).rejects.toThrow('aborted'); await settle();
    // Accepted as queued behind the command; the closed session (and the renderer's closed state) leaves it unsent.
    await h.session.send('Never dispatched after closure');
    expect(h.events.some((event) => event.type === 'item' && event.item.kind === 'user' && event.item.text === 'Never dispatched after closure' && event.item.queued)).toBe(true);
    if (ending === 'close') await h.session.close();
    else h.runtime.emit('error', { message: 'Synthetic fatal bridge failure', fatal: true });
    await rejected; await settle();
    native.complete({}); await settle();
    expect(h.session.currentState).toBe('closed');
    expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(['command.run']);
    expect(h.runtime.close).toHaveBeenCalledOnce(); expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
  });
});

describe('native command results read back from the transcript (native.13)', () => {
  // Synthetic transcripts in a temp folder only; the real ~/.claude is never read.
  let folder = '';
  beforeAll(async () => { folder = await mkdtemp(join(tmpdir(), 'relay-native-results-')); });
  afterAll(async () => { await rm(folder, { recursive: true, force: true }); });
  type Line = Record<string, unknown>;
  const jsonl = (lines: readonly Line[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  let files = 0;
  const transcript = async (lines: readonly Line[]) => {
    const file = join(folder, `session-${++files}.jsonl`);
    await writeFile(file, jsonl(lines));
    return file;
  };
  const row = (type: string, uuid: string, parentUuid: string | null, timestamp: string, extra: Line = {}): Line =>
    ({ parentUuid, isSidechain: false, type, uuid, timestamp, sessionId: 'native-session', ...extra });
  const user = (uuid: string, parentUuid: string | null, timestamp: string, content: string, extra: Line = {}) =>
    row('user', uuid, parentUuid, timestamp, { message: { role: 'user', content }, ...extra });
  const commandName = (name: string) => `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`;
  const COMPACTED = [
    row('system', 'boundary', null, '2026-10-24T06:34:34.939Z', { subtype: 'compact_boundary', content: 'Conversation compacted', logicalParentUuid: 'ask' }),
    user('summary', 'boundary', '2026-10-24T06:34:34.940Z', 'This session is being continued from a previous conversation. SUMMARY BODY', { isCompactSummary: true }),
    user('caveat', 'summary', '2026-10-24T06:31:47.192Z', '<local-command-caveat>Caveat: synthetic.</local-command-caveat>', { isMeta: true }),
    user('command', 'caveat', '2026-10-24T06:31:47.192Z', commandName('compact')),
    user('stdout', 'command', '2026-10-24T06:34:35.038Z', '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'),
  ];
  const items = (events: EngineEvent[]) => events.flatMap((event) => event.type === 'item' ? [event] : []);
  const systemItems = (events: EngineEvent[]) => items(events).filter((event) => event.item.kind === 'system');
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('shows the 308 /compact result once the transcript has it: echo-only events, an empty reply, the row under its command', async () => {
    const file = await transcript([user('ask', null, '2026-10-24T06:20:00.000Z', 'Earlier question')]);
    const h = setup(); const located = vi.fn(async () => file); h.session.options.commandTranscript = located;
    await h.session.start(); await settle();
    h.runtime.handler = (method) => {
      if (method !== 'command.run') return undefined;
      h.runtime.emit('session.append', { uuid: 'typed', door: 'note', origin: { kind: 'plugin', name: 'relay-native-bridge' },
        message: { type: 'user', content: [{ type: 'text', text: '/compact' }] } });
      return {};
    };
    await h.session.send('/compact');
    expect(h.session.currentState).toBe('idle');
    await appendFile(file, jsonl(COMPACTED));
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(1));
    await pause(300);
    expect(items(h.events)).toEqual([
      { type: 'item', handleId: 'h', item: { kind: 'user', id: 'send-1', text: '/compact' } },
      { type: 'item', handleId: 'h', afterId: 'send-1', anchorId: 'command', item: { kind: 'system', id: 'stdout', text: 'Compacted', level: 'info', durationMs: 167_846 } },
    ]);
    expect(located).toHaveBeenCalledExactlyOnceWith('native-session', LAUNCH.cwd);
    await h.session.close();
  });

  it('shows a 308 /rename result from its system rows when the reply has no text and the rows reach the session after it', async () => {
    const file = await transcript([
      user('ask', null, '2026-10-24T10:20:13.737Z', 'Earlier question'),
      row('system', 'turn-end', 'ask', '2026-10-24T10:20:13.901Z', { subtype: 'turn_duration', durationMs: 178, isMeta: false }),
    ]);
    const at = '2026-10-24T10:20:14.141Z';
    const named = '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>synthetic-name</command-args>';
    const printed = '<local-command-stdout>Session renamed to: synthetic-name</local-command-stdout>';
    const local = (uuid: string, parentUuid: string, content: string) =>
      row('system', uuid, parentUuid, at, { subtype: 'local_command', content, level: 'info', isMeta: false });
    const h = setup(); h.session.options.commandTranscript = async () => file;
    await h.session.start(); await settle();
    h.runtime.handler = async (method) => {
      if (method !== 'command.run') return undefined;
      await appendFile(file, jsonl([{ type: 'custom-title', customTitle: 'synthetic-name', sessionId: 'native-session' },
        local('rename', 'turn-end', named), local('rename-out', 'rename', printed),
        user('rename-meta', 'rename-out', at, 'Synthetic meta note.', { isMeta: true })]));
      // As in the receipt: the rows' appends reach the session after the reply, once the command window has closed.
      setTimeout(() => {
        for (const [uuid, text] of [['rename', named], ['rename-out', printed]]) {
          h.runtime.emit('session.append', { uuid, door: 'command', origin: { kind: 'engine' },
            message: { type: 'system', name: 'local_command', content: [{ type: 'text', text }] } });
        }
        h.runtime.emit('session.append', { uuid: 'rename-meta', door: 'prompt', origin: { kind: 'plugin' },
          message: { type: 'user', isMeta: true, content: [{ type: 'text', text: 'Synthetic meta note.' }] } });
      }, 0);
      return { context: { tokens: 10, window: 100, percent: 10 } };
    };
    await h.session.send('/rename synthetic-name');
    expect(h.session.currentState).toBe('idle');
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(1));
    await pause(300);
    expect(items(h.events)).toEqual([
      { type: 'item', handleId: 'h', item: { kind: 'user', id: 'send-1', text: '/rename synthetic-name' } },
      { type: 'item', handleId: 'h', afterId: 'send-1', anchorId: 'rename', item: { kind: 'system', id: 'rename-out', text: 'Session renamed to: synthetic-name', level: 'info' } },
    ]);
    await h.session.close();
  });

  it('keeps several result rows of one command in order below it, replacing the one shown live without a fallback', async () => {
    const at = '2026-10-24T09:05:03.000Z';
    const file = await transcript([
      user('mcp', 'ask', at, commandName('mcp')),
      user('out', 'mcp', at, '<local-command-stdout>Reconnected to alpha.</local-command-stdout>'),
      user('err', 'out', at, '<local-command-stderr>Failed to reconnect to beta</local-command-stderr>'),
    ]);
    const h = setup(); h.session.options.commandTranscript = async () => file;
    await h.session.start(); await settle();
    h.runtime.handler = (method) => {
      if (method !== 'command.run') return undefined;
      h.runtime.emit('session.append', { uuid: 'out', door: 'command', message: { type: 'user', content: [{ type: 'text', text: '<local-command-stdout>Reconnected to alpha.</local-command-stdout>' }] } });
      return { text: 'Reconnected to alpha.' };
    };
    await h.session.send('/mcp');
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(3));
    await pause(300);
    // The echo comes before the output shown live: the read-back replaces that row in place.
    expect(items(h.events)).toEqual([
      { type: 'item', handleId: 'h', item: { kind: 'user', id: 'send-1', text: '/mcp' } },
      { type: 'item', handleId: 'h', item: { kind: 'system', id: 'out', text: 'Reconnected to alpha.', level: 'info' } },
      { type: 'item', handleId: 'h', afterId: 'send-1', anchorId: 'mcp', item: { kind: 'system', id: 'out', text: 'Reconnected to alpha.', level: 'info' } },
      { type: 'item', handleId: 'h', afterId: 'out', anchorId: 'mcp', item: { kind: 'system', id: 'err', text: 'Failed to reconnect to beta', level: 'warn' } },
    ]);
    await h.session.close();
  });

  it('shows the text command.run answered only when the transcript has no result row for the command', async () => {
    const at = '2026-10-24T07:10:05.123Z';
    const file = await transcript([
      user('effort', 'ask', at, commandName('effort')),
      user('effort-out', 'effort', at, '<local-command-stdout>Set effort level to max</local-command-stdout>'),
      user('status', 'effort-out', '2026-10-24T07:11:00.000Z', commandName('status')),
      user('next', 'status', '2026-10-24T07:11:01.000Z', 'A message sent after the command'),
    ]);
    const h = setup(); h.session.options.commandTranscript = async () => file;
    await h.session.start(); await settle();
    h.runtime.handler = (method, args) => method === 'command.run'
      ? { text: (args as { command: string }).command === 'effort' ? 'Set effort level to max' : 'Status text the transcript lacks' } : undefined;
    await h.session.send('/effort');
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(1));
    await h.session.send('/status');
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(2));
    await pause(300);
    expect(systemItems(h.events)).toEqual([
      { type: 'item', handleId: 'h', afterId: 'send-1', anchorId: 'effort', item: { kind: 'system', id: 'effort-out', text: 'Set effort level to max', level: 'info' } },
      { type: 'item', handleId: 'h', afterId: 'send-2', anchorId: 'status', item: { kind: 'system', id: 'native-command:send-2', text: 'Status text the transcript lacks', level: 'info' } },
    ]);
    await h.session.close();
  });

  it('does not hold idle, the queued message or the context refresh while the transcript is read back', async () => {
    const h = setup(); h.session.options.commandTranscript = () => new Promise<string | undefined>(() => undefined);
    await h.session.start(); await settle(); h.runtime.request.mockClear();
    const native = holdNativeCommand(h.runtime);
    const command = h.session.send('/compact'); await settle();
    const message = h.session.send('Typed while the command ran'); await settle();
    const mark = h.events.length;
    native.complete({ text: 'Compacted' }); await command; await message; await settle();
    expect(h.events.slice(mark).some((event) => event.type === 'state' && event.state === 'idle')).toBe(true);
    expect(h.runtime.request.mock.calls.map(([method]) => method).slice(0, 3)).toEqual(['command.run', 'session.usage', 'prompt.submit']);
    expect(systemItems(h.events)).toEqual([]);
    await h.session.close();
  });

  it('stops reading the transcript when the session closes', async () => {
    const file = await transcript([]);
    const h = setup(); const located = vi.fn(async () => file); h.session.options.commandTranscript = located;
    await h.session.start(); await settle();
    await h.session.send('/compact');
    await h.session.close();
    await appendFile(file, jsonl(COMPACTED));
    await pause(400);
    expect(located).not.toHaveBeenCalled(); expect(systemItems(h.events)).toEqual([]);
  });

  // The steal case: a run that printed nothing still reads while the next run of the same command writes its rows.
  it.each([
    { label: 'the same name, no text', first: '/sandbox', second: '/sandbox probe', named: 'sandbox', reply: {}, fallback: [] },
    { label: 'an alias, with text', first: '/rename', second: '/name probe', named: 'rename', reply: { text: 'First run text' },
      fallback: [{ type: 'item', handleId: 'h', afterId: 'send-1', item: { kind: 'system', id: 'native-command:send-1', text: 'First run text', level: 'info' } }] },
  ])('stops the read-back of an earlier run when the command runs again ($label), so the newer rows stay with the newer run', async ({ first, second, named, reply, fallback }) => {
    const file = await transcript([user('ask', null, '2026-10-24T09:00:00.000Z', 'Earlier question')]);
    const h = setup(); h.session.options.commandTranscript = async () => file;
    await h.session.start(); await settle();
    let runs = 0;
    h.runtime.handler = async (method) => {
      if (method !== 'command.run') return undefined;
      if (++runs === 1) return reply;
      await appendFile(file, jsonl([user('cmd-2', 'ask', '2026-10-24T09:00:11.600Z', commandName(named)),
        user('out-2', 'cmd-2', '2026-10-24T09:00:11.600Z', '<local-command-stdout>Second run line</local-command-stdout>')]));
      // The earlier read-back looks again (at 250 ms) before this run answers.
      await pause(250);
      return {};
    };
    await h.session.send(first);
    await pause(150);
    await h.session.send(second);
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(fallback.length + 1));
    await pause(300);
    expect(systemItems(h.events)).toEqual([...fallback,
      { type: 'item', handleId: 'h', afterId: 'send-2', anchorId: 'cmd-2', item: { kind: 'system', id: 'out-2', text: 'Second run line', level: 'info' } }]);
    await h.session.close();
  });

  it("leaves a stopped earlier run's late row alone: the newer run takes only rows dated after it was sent", async () => {
    const file = await transcript([user('ask', null, '2026-10-24T09:00:00.000Z', 'Earlier question')]);
    let clock = Date.parse('2026-10-24T09:00:10.000Z');
    const h = setup({}, new FakeRuntime(), undefined, undefined, undefined, () => clock); h.session.options.commandTranscript = async () => file;
    await h.session.start(); await settle();
    let runs = 0;
    h.runtime.handler = (method) => {
      if (method !== 'command.run') return undefined;
      // Each run writes its rows after answering, as a dialog writes its closing line.
      const run = ++runs, at = run === 1 ? '2026-10-24T09:00:10.500Z' : '2026-10-24T09:00:11.500Z';
      setTimeout(() => void appendFile(file, jsonl([user(`cmd-${run}`, 'ask', at, commandName('sandbox')),
        user(`out-${run}`, `cmd-${run}`, at, `<local-command-stdout>Run ${run} line</local-command-stdout>`)])), run === 1 ? 150 : 300);
      return {};
    };
    await h.session.send('/sandbox');
    await pause(180);
    clock = Date.parse('2026-10-24T09:00:11.000Z');
    await h.session.send('/sandbox');
    await vi.waitFor(() => expect(systemItems(h.events)).toHaveLength(1));
    await pause(300);
    expect(systemItems(h.events)).toEqual([
      { type: 'item', handleId: 'h', afterId: 'send-2', anchorId: 'cmd-2', item: { kind: 'system', id: 'out-2', text: 'Run 2 line', level: 'info' } }]);
    await h.session.close();
  });

  it("reads back only the user's own commands, never Relay's model and effort controls", async () => {
    const h = withControls(); const located = vi.fn(async () => undefined); h.session.options.commandTranscript = located;
    await h.session.start(); await settle();
    await h.session.setModel('claude-sonnet-5-5'); await h.session.setEffort('max');
    await pause(300);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(2);
    expect(located).not.toHaveBeenCalled();
    await h.session.send('/effort');
    await vi.waitFor(() => expect(located).toHaveBeenCalled());
    await h.session.close();
  });
});

describe('default-account native MCP catalog reads', () => {
  it('surfaces the first MCP wait timeout once as a safe nonfatal error and does not replace it with retry quarantine errors', async () => {
    const h = withDefaultMcpCatalog(['alpha', 'beta'], []);
    h.runtime.ready.capabilities = [...h.runtime.ready.capabilities, 'bridge.diagnostics'];
    const original = h.runtime.handler!; let complete: ((value: unknown) => void) | undefined;
    h.runtime.handler = (method, args) => {
      if (method === 'bridge.diagnostics') return { version: 1, modalActive: true, runningTurn: false, activeCount: 1, queuedCount: 0, truncated: false,
        text: 'PRIVATE_INSPECTOR_PAYLOAD', entries: [{ method: 'ui.command', command: 'mcp', state: 'running', queuedMs: 0, runMs: 5000 }] };
      if (method === 'ui.command') {
        h.render('PRIVATE_SCREEN_PAYLOAD'); return new Promise((resolve) => { complete = resolve; });
      }
      return original(method, args);
    };
    await h.session.start(); await settle(); vi.useFakeTimers();
    try {
      const outcome = h.session.mcpStatus().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5500);
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeUiWaitTimeout);
      expect((error as NativeControlGate).operation).toBe('mcp.status.dialog');
      const failures = () => h.events.filter((event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error');
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toMatchObject({ fatal: false, message: (error as Error).message });
      expect(failures()[0].message).toContain('phase=open:mcp');
      expect(failures()[0].message).toContain('ui.command/mcp:running queuedMs=0 runMs=5000');
      expect(failures()[0].message).not.toContain('PRIVATE_');
      await expect(h.session.mcpStatus()).rejects.toThrow('prior native modal failed');
      await expect(h.session.mcpStatus()).rejects.toThrow('prior native modal failed');
      expect(failures()).toHaveLength(1);
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled(); expect(h.runtime.close).not.toHaveBeenCalled();
    } finally { await h.session.close(); complete?.({}); vi.useRealTimers(); }
  });
  it.each(['mcp.status.dialog', 'mcp.dialog', 'generic'] as const)('reports the first owned MCP failure safely and preserves the original rejection: %s', async (kind) => {
    const h = withDefaultMcpCatalog(['alpha', 'beta'], []);
    const failure = kind === 'generic' ? new Error('PRIVATE_SERVER_PAYLOAD')
      : new NativeControlGate(kind, 'Native MCP read failed: Bearer synthetic-secret');
    const original = h.runtime.handler!;
    h.runtime.handler = (method, args) => method === 'ui.command' ? Promise.reject(failure) : original(method, args);
    try {
      await h.session.start(); await expect(h.session.mcpStatus()).rejects.toBe(failure);
      const errors = h.events.filter((event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error');
      expect(errors).toHaveLength(1); expect(errors[0].fatal).toBe(false);
      expect(errors[0].message).not.toContain('PRIVATE_SERVER_PAYLOAD'); expect(errors[0].message).not.toContain('synthetic-secret');
      expect(errors[0].message).toContain(kind === 'generic' ? 'Native MCP status command failed; safe diagnostic metadata is unavailable.' : 'Bearer [redacted]');
      await expect(h.session.mcpStatus()).rejects.toThrow('prior native modal failed');
      expect(h.events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled(); expect(h.runtime.close).not.toHaveBeenCalled();
    } finally { await h.session.close(); }
  });
  it.each([false, true])('keeps a message queued behind a failed MCP read and reports its first cause even if the reporter throws (%s)', async (reporterThrows) => {
    const h = withDefaultMcpCatalog(['alpha', 'beta'], []);
    const failure = new NativeControlGate('mcp.dialog', 'The native selected row was not observable.');
    const original = h.runtime.handler!; let rejectRead: ((error: Error) => void) | undefined;
    h.runtime.handler = (method, args) => method === 'ui.command' ? new Promise((_, reject) => { rejectRead = reject; }) : original(method, args);
    const emit = h.session.options.emit;
    h.session.options.emit = (event) => {
      if (reporterThrows && event.type === 'error' && event.message === failure.message) throw new Error('Synthetic reporter failure');
      emit(event);
    };
    await h.session.start(); await settle(); vi.useFakeTimers();
    try {
      const outcome = h.session.mcpStatus().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      await h.session.send('Keep this never-dispatched intent');
      rejectRead!(failure); await vi.advanceTimersByTimeAsync(30);
      expect(await outcome).toBe(failure);
      const userItems = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : []);
      expect(userItems).toEqual([expect.objectContaining({ text: 'Keep this never-dispatched intent', queued: true })]);
      const errors = h.events.filter((event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error');
      if (!reporterThrows) expect(errors[0]).toMatchObject({ message: failure.message, fatal: false });
      expect(errors.filter((event) => event.message === failure.message)).toHaveLength(reporterThrows ? 0 : 1);
      expect(errors.some((event) => event.message.includes('Queued native send'))).toBe(false);
      // Unconfirmed dialog state: nothing is typed or submitted until the bridge confirms no modal is left.
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit' || method === 'turn.abort')).toHaveLength(0);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });
  it('reads two configured servers and inherited native rows without enabling persistent mutations', async () => {
    const observed = [{ name: 'alpha', status: 'connected' as const, toolCount: 2 },
      { name: 'beta', status: 'connected' as const, toolCount: 5 }, { name: 'inherited docs', status: 'needs-auth' as const, toolCount: 0 }];
    const h = withDefaultMcpCatalog(['alpha', 'beta'], observed);
    try {
      await h.session.start();
      expect(h.session.options.profile).toMatchObject({ id: 'default', configDir: null });
      expect(h.session.options.controls?.assertPreferenceScope).toBeUndefined();
      const expected = observed.map((row) => ({ ...row, relay: row.name !== 'inherited docs', source: 'native-dialog' }));
      await expect(h.session.mcpStatus()).resolves.toEqual(expected);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: expected });
      expect(h.catalogView()).toBe('idle'); expect(h.preferenceFingerprint).not.toHaveBeenCalled();
      await expect(h.session.mcpToggle('alpha', false)).rejects.toThrow('mcp.status');
      await expect(h.session.mcpReconnect('alpha')).rejects.toThrow('one known literal');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
      expect(h.runtime.request.mock.calls.some(([method]) => ['mcp.nativeAction', 'mcp.toggle', 'mcp.reconnect', 'config.set'].includes(method))).toBe(false);
    } finally { await h.session.close(); }
  });
  it('discovers inherited rows when Relay has no configured servers and does not claim ownership', async () => {
    const h = withDefaultMcpCatalog([], [{ name: 'inherited only', status: 'connected', toolCount: 4 }]);
    try {
      await h.session.start();
      await expect(h.session.mcpStatus()).resolves.toEqual([{ name: 'inherited only', status: 'connected', toolCount: 4, relay: false, source: 'native-dialog' }]);
      expect(h.catalogView()).toBe('idle');
      await expect(h.session.mcpReconnect('inherited only')).rejects.toThrow('one known literal');
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
    } finally { await h.session.close(); }
  });
  it('publishes an empty catalog only from the native empty result without terminal input', async () => {
    const h = withDefaultMcpCatalog([], []);
    try {
      await h.session.start(); await expect(h.session.mcpStatus()).resolves.toEqual([]);
      expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: [] });
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
    } finally { await h.session.close(); }
  });
  it.each([{ known: ['bad\nname'] }, { known: [' alpha'] }, { known: ['alpha', 'ALPHA'] }])('rejects malformed or ambiguous known catalog names before querying: %j', async ({ known }) => {
    const h = withDefaultMcpCatalog(known, []);
    try {
      await h.session.start();
      await expect(h.session.mcpStatus()).rejects.toThrow('ambiguous');
      expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(false);
      expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
      expect(h.events.some((event) => event.type === 'mcp')).toBe(false);
    } finally { await h.session.close(); }
  });
});

describe('native session controls integration', () => {
  it.each([false, true])('reads bounded priority diagnostics on a control timeout only when advertised (%s)', async (advertised) => {
    const h = withControls({ autoCommit: false });
    if (advertised) h.runtime.ready.capabilities = [...h.runtime.ready.capabilities, 'bridge.diagnostics'];
    const original = h.runtime.handler!;
    let commandCompleted = false, inspectedWhileCommandPending = false;
    h.runtime.handler = (method, args) => {
      if (method === 'bridge.diagnostics') {
        inspectedWhileCommandPending = !commandCompleted;
        return { version: 1, modalActive: true, runningTurn: false, activeCount: 1, queuedCount: 0, truncated: false,
          text: 'INSPECTOR_SECRET', entries: [{ method: 'ui.command', command: 'effort', state: 'running', queuedMs: 0, runMs: 5000, args: 'ARGS_SECRET' }] };
      }
      const result = original(method, args);
      return method === 'ui.command' ? Promise.resolve(result).finally(() => { commandCompleted = true; }) : result;
    };
    await h.session.start(); await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'bridge.diagnostics')).toHaveLength(0);
    vi.useFakeTimers();
    try {
      const outcome = h.session.setEffort('max').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(h.runtime.writeTerminal.mock.calls.some(([key]) => key === 's')).toBe(true);
      h.render('SCREEN_SECRET unknown overlay');
      await vi.advanceTimersByTimeAsync(5500);
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeUiWaitTimeout);
      expect((error as Error).message).toContain('phase=key:session-only');
      expect((error as Error).message).not.toContain('SECRET');
      const calls = h.runtime.request.mock.calls.filter(([method]) => method === 'bridge.diagnostics');
      expect(calls).toHaveLength(advertised ? 1 : 0);
      if (advertised) {
        expect(calls[0][1]).toEqual({}); expect(calls[0][2]?.timeoutMs).toBe(450);
        expect(inspectedWhileCommandPending).toBe(true); expect(commandCompleted).toBe(false);
        expect((error as Error).message).toContain('ui.command/effort:running queuedMs=0 runMs=5000');
      } else expect((error as Error).message).toContain('bridge=unavailable');
      expect(h.runtime.close).not.toHaveBeenCalled();
      expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit' || method === 'turn.abort')).toHaveLength(0);
      expect(h.runtime.writeTerminal.mock.calls.some(([key]) => key === '\x1b')).toBe(false);
    } finally { await h.session.close(); h.complete(); vi.useRealTimers(); }
  });
  it('uses verified native model/effort dialogs and only session-only s commits', async () => {
    const h = withControls();
    h.runtime.start.mockImplementationOnce(async () => {
      expect(h.runtime.terminals.size).toBe(1);
      h.runtime.terminal('Synthetic native startup screen'); return h.runtime.ready;
    });
    await h.session.start(); await settle(); h.runtime.request.mockClear();
    await h.session.setModel('claude-sonnet-5-5');
    await h.session.setEffort('max'); await h.session.setEffort('xhigh');
    expect(h.events.filter((event) => event.type === 'init').at(-1)).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command').map(([, args]) => args)).toEqual([
      { command: 'model', args: '' }, { command: 'effort', args: '' }, { command: 'effort', args: '' },
    ]);
    expect(h.runtime.request.mock.calls.some(([method]) => ['config.set', 'command.run', 'model.session'].includes(method))).toBe(false);
    expect(h.runtime.writeTerminal.mock.calls.some(([key]) => key === '\r')).toBe(false);
    expect(h.preferenceFingerprint).toHaveBeenCalledTimes(6);
    await h.session.close();
  });

  it('immediately acknowledges a queued GUI echo during a modal but does not submit until dismissal', async () => {
    const h = withControls(); await h.session.start();
    const changed = h.session.setEffort('max');
    await vi.waitFor(() => expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(true));
    await h.session.send('held behind native modal');
    expect(h.events.some((event) => event.type === 'item' && event.item.kind === 'user' && event.item.queued === true)).toBe(true);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
    await changed; await settle();
    expect(h.runtime.request).toHaveBeenCalledWith('prompt.submit', { text: 'held behind native modal', asUser: true }, expect.anything());
    await h.session.close();
  });

  it('rejects settings while native turn/permission ownership is active before writing terminal input', async () => {
    const h = withControls(); await h.session.start(); h.runtime.emit('turn.start', { turnId: 'active' });
    await expect(h.session.setModel('claude-opus-5-5')).rejects.toThrow('not idle');
    expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(false);
    await h.session.close();
  });

  it('keeps a message sent during a failed control queued and sends it once, after the dialog is gone', async () => {
    const h = withControls({ fingerprintChange: true }); await h.session.start();
    const change = h.session.setEffort('max');
    const rejected = expect(change).rejects.toThrow('persistent defaults');
    await h.session.send('not a fallback model call');
    await rejected; await settle();
    // The dialog completed before the check failed, so nothing is left to close and the queue goes on.
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => args))
      .toEqual([{ text: 'not a fallback model call', asUser: true }]);
    const items = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : []);
    expect(items[0]).toMatchObject({ text: 'not a fallback model call', queued: true });
    expect(items.some((item) => item.deliveryUnconfirmed)).toBe(false);
    expect(h.events.some((event) => event.type === 'error' && event.message.includes('Queued native send'))).toBe(false);
    expect(h.runtime.close).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('holds text and images while a timed-out dialog stays open, mirrors it, and sends them in order once it closes', async () => {
    vi.useFakeTimers();
    const notStaged = () => { throw new Error('Held attachments must not be staged'); };
    const storage: NativeAttachmentStorage = { createLaunch: vi.fn(notStaged), writeBytes: vi.fn(notStaged),
      verify: vi.fn(notStaged), removeLaunch: vi.fn(notStaged) };
    const h = withControls({ autoCommit: false, attachments: () => ({ storage }) });
    const image = { kind: 'image' as const, mediaType: 'image/png' as const,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
    const userItems = (): Array<Extract<TranscriptItem, { kind: 'user' }>> =>
      h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : []);
    const submitted = () => h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => (args as { text: string }).text);
    try {
      await h.session.start(); await settle();
      const change = h.session.setEffort('max');
      const rejected = expect(change).rejects.toThrow('deadline');
      await vi.advanceTimersByTimeAsync(250);
      expect(h.runtime.writeTerminal).toHaveBeenCalledWith('s');
      h.render(`${'▔'.repeat(60)}\nEffort\nUnrecognized native overlay still owns the composer\nEsc to cancel`);
      await h.session.send('held text');
      await h.session.send('held image', { attachments: [image] });
      const queued = userItems();
      expect(queued).toHaveLength(2);
      expect(queued.every((item) => item.queued === true)).toBe(true);
      expect(queued[1].images).toBe(1); expect(queued[1].imageRefs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_100); await rejected; await settle();

      // The dialog Relay could not drive is shown to the user instead of locking the session.
      expect(h.events.filter((event) => event.type === 'panel').at(-1)).toMatchObject({ panel: { rows: expect.arrayContaining([expect.anything()]) } });
      expect(userItems().some((item) => item.deliveryUnconfirmed)).toBe(false);
      // The setter rejects to its caller; no error event or queued-send failure is raised besides.
      expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(h.session.currentState).toBe('idle'); expect(h.runtime.close).not.toHaveBeenCalled();
      await h.session.send('fresh text while the dialog is open');
      await expect(h.session.send('/compact')).rejects.toThrow('ui.command.busy');
      expect(storage.createLaunch).not.toHaveBeenCalled();
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit' || method === 'turn.abort')).toHaveLength(0);

      // The user closed it (here the CLI completes the command); the idle composer comes back.
      h.complete(); h.render('>\n? for shortcuts'); await vi.advanceTimersByTimeAsync(300);
      expect(h.events.filter((event) => event.type === 'panel').at(-1)).toMatchObject({ panel: null });
      expect(submitted()).toEqual(['held text']);
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'turn.abort')).toHaveLength(0);
    } finally { await h.session.close(); vi.useRealTimers(); }
  });

  it('keeps sends made before a control failure in order and delivers each exactly once', async () => {
    const h = withControls();
    const original = h.runtime.handler!; let turn = 0;
    h.runtime.handler = (method, args, options) => {
      if (method !== 'prompt.submit') return original(method, args, options);
      const turnId = `reply-${++turn}`;
      h.runtime.emit('turn.start', { turnId }); h.runtime.emit('turn.complete', { turnId, reason: 'answer' });
      return {};
    };
    let finishFingerprint: ((value: string) => void) | undefined;
    h.preferenceFingerprint.mockResolvedValueOnce('a'.repeat(64))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFingerprint = resolve; }));
    try {
      await h.session.start(); await settle();
      const change = h.session.setEffort('max');
      const rejected = expect(change).rejects.toThrow('persistent defaults');
      await vi.waitFor(() => expect(finishFingerprint).toBeTypeOf('function'));

      const first = h.session.send('A already reaches the held queue');
      const second = h.session.send('B submitted before failure but awaiting sendTail');
      finishFingerprint!('b'.repeat(64));
      await first; await rejected; await second; await settle();

      await h.session.send('C submitted after recovery'); await settle();
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => (args as { text: string }).text))
        .toEqual(['A already reaches the held queue', 'B submitted before failure but awaiting sendTail', 'C submitted after recovery']);
      const items = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'user' ? [event.item] : []);
      expect(items.some((item) => item.deliveryUnconfirmed)).toBe(false);
      expect(h.runtime.request.mock.calls.filter(([method]) => method === 'turn.abort')).toHaveLength(0);
      expect(h.runtime.close).not.toHaveBeenCalled();
    } finally { await h.session.close(); }
  });

  it('does not touch a picker when a native effort environment override outranks it', async () => {
    const h = withControls({ forcedEffort: 'xhigh' }); await h.session.start();
    await expect(h.session.setEffort('max')).rejects.toThrow('environment override');
    expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(false);
    await h.session.close();
  });

  it('keeps model controls gated when verification options or required bridge capabilities are absent', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'ui.command', 'env.effort'];
    const h = setup({}, runtime); await h.session.start();
    await expect(h.session.setModel('claude-opus-5-5')).rejects.toThrow('model.session');
    expect(runtime.writeTerminal).not.toHaveBeenCalled(); await h.session.close();
    const missing = setup({}, new FakeRuntime(), { cliSha256: NATIVE_UI_PINNED_SHA256, preferenceFingerprint: async () => 'a'.repeat(64) });
    await missing.session.start(); await expect(missing.session.setEffort('max')).rejects.toThrow('config.session');
    expect(missing.runtime.writeTerminal).not.toHaveBeenCalled(); await missing.session.close();
  });

  it('starts an unlisted CLI build with its dialog drivers off, and refuses unverified MCP mutation targets before native input', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'ui.command', 'env.effort'];
    const newer = setup({}, runtime, { cliSha256: 'f'.repeat(64), preferenceFingerprint: async () => 'a'.repeat(64) });
    await newer.session.start(); expect(runtime.close).not.toHaveBeenCalled();
    await expect(newer.session.setEffort('max')).rejects.toThrow('not verified');
    await newer.session.send('an unlisted build still chats');
    expect(runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(false);
    expect(runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1);
    expect(runtime.writeTerminal).not.toHaveBeenCalled(); await newer.session.close();
    const h = withControls(); await h.session.start();
    await expect(h.session.mcpReconnect('foreign')).rejects.toThrow('known literal');
    h.session.options.mcpServers = { fixture: { command: 'synthetic-only' } };
    await expect(h.session.mcpReconnect('foreign')).rejects.toThrow('not the known literal');
    await expect(h.session.mcpToggle('fixture', false)).rejects.toThrow('mcp.status');
    expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command' || method === 'mcp.toggle')).toBe(false);
    await h.session.close();
  });

  it('returns only actual selected-server dialog evidence through MCP inspect and reconnect', async () => {
    const h = withControls(); h.session.options.mcpServers = { fixture: { command: 'synthetic-only' } };
    let screen: 'list' | 'detail' | 'reconnect' | 'idle' = 'idle';
    const draw = () => h.render(screen === 'list' ? 'Manage MCP servers\n1 server\n> √ fixture 1 tool\n↑/↓ to navigate · Enter to confirm · Esc to cancel'
      : screen === 'detail' || screen === 'reconnect' ? `Fixture MCP Server\nStatus: √ connected\nTools: 1 tool\n${screen === 'detail' ? '>' : ' '} 1. View tools\n${screen === 'reconnect' ? '>' : ' '} 2. Reconnect\n  3. Disable\n↑/↓ to navigate · Enter to select · Esc to back`
        : 'Reconnected to fixture.\n? for shortcuts');
    h.runtime.handler = (method) => {
      if (method === 'ui.command') { screen = 'list'; draw(); return {}; }
      return undefined;
    };
    h.runtime.writeTerminal.mockImplementation(async (key) => {
      if (screen === 'list' && key === '\r') screen = 'detail';
      else if (screen === 'detail' && key === '\x1b[B') screen = 'reconnect';
      else if (screen === 'reconnect' && key === '\r') screen = 'idle';
      else if ((screen === 'detail' || screen === 'reconnect') && key === '\x1b') screen = 'list';
      else if (screen === 'list' && key === '\x1b') screen = 'idle';
      else throw new Error('Unverified MCP fixture key');
      draw();
    });
    await h.session.start();
    const expected = [{ name: 'fixture', status: 'connected', toolCount: 1, relay: true, source: 'native-dialog' }];
    expect(await h.session.mcpStatus()).toEqual(expected);
    expect(await h.session.mcpReconnect('fixture')).toEqual(expected);
    expect(h.runtime.request.mock.calls.some(([method]) => ['mcp.status', 'mcp.reconnect', 'mcp.toggle'].includes(method))).toBe(false);
    expect(h.events.filter((event) => event.type === 'mcp').at(-1)).toMatchObject({ servers: expected });
    await h.session.close();
  });

  it('projects any amount of startup output onto the bounded screen, so a long first draw still attests controls', async () => {
    const h = withControls();
    h.runtime.start.mockImplementationOnce(async () => { h.runtime.terminal('x'.repeat(512 * 1024 + 1)); return h.runtime.ready; });
    await h.session.start();
    expect(h.runtime.close).not.toHaveBeenCalled();
    await h.session.setEffort('max');
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'ui.command')).toHaveLength(1);
    await h.session.close();
  });

  it('cancels a pending native modal and held sends on close, retaining ownership if native close fails', async () => {
    const h = withControls({ autoCommit: false }); await h.session.start();
    const changed = h.session.setEffort('max'); const rejected = expect(changed).rejects.toThrow('closed');
    await vi.waitFor(() => expect(h.runtime.request.mock.calls.some(([method]) => method === 'ui.command')).toBe(true));
    await h.session.send('held');
    h.runtime.close.mockRejectedValueOnce(new Error('Process exit was not verified.'));
    await expect(h.session.close()).rejects.toThrow('not verified'); await rejected;
    expect(h.closed).not.toHaveBeenCalled(); expect(h.runtime.terminals.size).toBe(1);
    await h.session.close(); expect(h.closed).toHaveBeenCalledTimes(1); expect(h.runtime.terminals.size).toBe(0);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(0);
  });
});

describe('native GUI interactions', () => {
  it('forwards allow-session and AskUserQuestion answers through the existing broker without model calls', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('turn.start', { turnId: 't' });
    h.runtime.emit('interaction.request', { id: 'native-perm', toolName: 'Write', input: { file_path: 'a' }, toolUseId: 'tu',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'userSettings' }] });
    const permission = h.events.find((event) => event.type === 'permission');
    expect(permission?.type).toBe('permission');
    if (permission?.type !== 'permission') throw new Error('No permission card');
    expect(h.session.currentState).toBe('awaiting');
    h.broker.respondPermission(permission.request.requestId, { behavior: 'allow', scope: 'session' });
    await settle();
    expect(h.runtime.request).toHaveBeenCalledWith('interaction.reply', expect.objectContaining({ id: 'native-perm', result: expect.objectContaining({
      behavior: 'allow', updatedPermissions: [expect.objectContaining({ destination: 'session' })],
    }) }), expect.anything());
    h.runtime.emit('interaction.request', { id: 'q', toolName: 'AskUserQuestion', toolUseId: 'qu', input: {
      questions: [{ question: 'Choose?', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    } });
    const question = h.events.find((event) => event.type === 'question');
    if (question?.type !== 'question') throw new Error('No question card');
    h.broker.respondQuestion(question.request.requestId, { 'Choose?': 'A' });
    await settle();
    expect(h.runtime.request).toHaveBeenCalledWith('interaction.reply', expect.objectContaining({ id: 'q', result: expect.objectContaining({
      updatedInput: expect.objectContaining({ answers: { 'Choose?': 'A' } }),
    }) }), expect.anything());
    await h.session.close();
  });

  it('cancels pending cards on native cancellation/exit and never answers an orphan request', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('interaction.request', { id: 'one', toolName: 'Read', input: {} });
    h.runtime.emit('interaction.cancel', { id: 'one' });
    h.runtime.emit('interaction.request', { id: 'one', toolName: 'Read', input: {} });
    h.runtime.emit('interaction.request', { id: 'two', toolName: 'Write', input: {} });
    h.runtime.exit(3);
    await settle();
    expect(h.broker.pendingCount).toBe(0);
    expect(h.events.filter((event) => event.type === 'requestClosed')).toHaveLength(2);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'interaction.reply')).toHaveLength(0);
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.runtime.events.size).toBe(0);
    expect(h.session.currentState).toBe('closed');
  });

  it('fails malformed interactions closed without waiting for the native timeout', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('interaction.request', { id: 'bad', toolName: 'Write', input: null });
    await settle();
    expect(h.runtime.request).toHaveBeenCalledWith('interaction.reply', { id: 'bad', result: {
      behavior: 'deny', message: 'Malformed native interaction request.',
    } }, expect.anything());
    expect(h.broker.pendingCount).toBe(0);
    await h.session.close();
  });
});

describe('native capability gates and read-only metadata', () => {
  it('keeps actual MCP transport control separate and ignores legacy SDK startup overrides', async () => {
    let enabled = true;
    const rows = () => [{ name: 'alpha', status: enabled ? 'connected' as const : 'disabled' as const, toolCount: enabled ? 2 : 0, relay: true }];
    const controls = { status: vi.fn(async () => rows()),
      setEnabled: vi.fn(async (_name: string, value: boolean) => { enabled = value; return rows(); }),
      reconnect: vi.fn(async () => rows()) };
    const h = setup({ mcpOverrides: { alpha: false } }, new FakeRuntime(), undefined, undefined, controls);
    await h.session.start(); await settle();
    expect(controls.setEnabled).not.toHaveBeenCalled();
    expect(await h.session.mcpStatus()).toMatchObject([{ status: 'connected', toolCount: 2 }]);
    expect(await h.session.mcpToggle('alpha', true)).toMatchObject([{ status: 'connected', toolCount: 2 }]);
    await h.session.mcpReconnect('alpha');
    expect(controls.reconnect).toHaveBeenCalledWith('alpha');
    expect(h.runtime.request.mock.calls.some(([method]) => ['mcp.toggle', 'mcp.reconnect', 'command.run', 'ui.command', 'config.set'].includes(method))).toBe(false);
    expect(h.runtime.writeTerminal).not.toHaveBeenCalled();
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    expect(LAUNCH.args).toEqual(['--effort', 'xhigh']);
    await h.session.close(); controls.status.mockClear();
    await expect(h.session.mcpStatus()).rejects.toThrow('closed'); expect(controls.status).not.toHaveBeenCalled();
  });
  it('keeps workflow observations when the native agent catalog omits them', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.emit('tool.call', { input: { tool: 'Workflow', tool_use_id: 'wf-call' },
      result: { result: { status: 'async_launched', taskType: 'local_workflow', taskId: 'wf-task', runId: 'wf-run', workflowName: 'Fixture' } } });
    h.runtime.emit('agent.spawn', { input: { tool_use_id: 'wf-call', workflow: { runId: 'wf-run', agentIndex: 1 }, description: 'Child' },
      result: { agentId: 'child' } });
    h.runtime.emit('turn.complete', { turnId: 'child-turn', agentId: 'child', reason: 'answer' });
    h.runtime.emit('task.notification', { id: 'wf-task', toolUseId: 'wf-call', status: 'completed' });
    h.runtime.emit('turn.complete', { turnId: 'main', reason: 'answer' });
    await settle();
    expect(h.events.filter((event) => event.type === 'tasks').at(-1)).toMatchObject({ tasks: [{ taskId: 'wf-task', status: 'completed',
      workflow: { phases: [], agents: [{ agentId: 'child', state: 'done' }] } }] });
    await h.session.close();
  });
  it('projects native measure events without polling or fabricating a reset deadline', async () => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    h.runtime.emit('session.measure', { context: { tokens: 20, window: 100, percent: 20 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 15 }], cost: { usd: 0.25 }, changed: ['rateLimits'] });
    expect(h.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({ usage: { profileId: 'default',
      windows: [{ id: 'five_hour', percent: 15, resetsAt: null, resetUnknown: true }] } });
    expect(h.events.filter((event) => event.type === 'context').at(-1)).toMatchObject({ usage: { usedTokens: 20, maxTokens: 100 } });
    expect(h.runtime.request).not.toHaveBeenCalled(); await h.session.close();
  });
  it('rejects the GUI model setter before any native mutation without session-only model capability', async () => {
    const h = setup();
    await h.session.start();
    await settle();
    h.runtime.request.mockClear();
    await expect(h.session.setModel('sonnet')).rejects.toMatchObject({
      name: 'NativeCapabilityError', capability: 'model.session',
    });
    expect(h.runtime.request).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('uses only a verified session-only model operation, never the persistent command or menu writer', async () => {
    const runtime = new FakeRuntime();
    runtime.ready.capabilities = [...BASE_CAPS, 'model.session'];
    const h = setup({}, runtime);
    await h.session.start();
    await settle();
    runtime.request.mockClear();
    await h.session.setModel('sonnet');
    expect(runtime.request).toHaveBeenCalledWith('model.session', { model: 'sonnet' }, expect.anything());
    expect(runtime.request.mock.calls.some(([method]) => method === 'command.run' || method === 'config.set')).toBe(false);
    expect(h.events.filter((event) => event.type === 'init').at(-1)).toMatchObject({ model: 'native-opus' });
    await h.session.close();
  });

  it('does not persist effort through a menu writer without verified session-only semantics', async () => {
    const h = setup();
    await h.session.start();
    await expect(h.session.setEffort('xhigh')).rejects.toBeInstanceOf(NativeCapabilityError);
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(0);
    await expect(h.session.mcpStatus()).rejects.toThrow('mcp.status');
    await expect(h.session.planUsage()).rejects.toThrow('SDK quota ledger');
    await expect(h.session.taskOutput('unknown')).rejects.toThrow('task.output');
    await h.session.close();
  });

  it('uses opted-in native workflow persistence, while Default follows the saved native preference', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'workflow.set', 'config.persist:workflows'];
    const assertPreferenceScope = vi.fn();
    runtime.handler = (method, args) => method === 'workflow.set'
      ? { key: 'workflows', enabled: (args as { enabled: boolean }).enabled, scope: 'native-user' } : undefined;
    const h = setup({}, runtime, { cliSha256: NATIVE_UI_PINNED_SHA256,
      preferenceFingerprint: async () => 'a'.repeat(64), assertPreferenceScope });
    await h.session.start(); await settle(); runtime.request.mockClear();
    await h.session.setWorkflows('off');
    expect(runtime.request).toHaveBeenCalledWith('workflow.set', { enabled: false }, expect.anything());
    expect(assertPreferenceScope).toHaveBeenCalledTimes(2);
    runtime.request.mockClear(); await h.session.setWorkflows(null);
    expect(runtime.request).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(h.session.handle.sessionId).toBe('native-session');
    await h.session.close();
  });

  it('does not overwrite saved native MCP preferences with stale per-conversation SDK choices at startup', async () => {
    const mcp = { status: vi.fn(async () => []), setEnabled: vi.fn(async () => []), reconnect: vi.fn(async () => []) };
    const h = setup({ mcpOverrides: { alpha: false } }, new FakeRuntime(), {
      cliSha256: NATIVE_UI_PINNED_SHA256, preferenceFingerprint: async () => 'a'.repeat(64), assertPreferenceScope: () => {},
    }, undefined, mcp);
    await h.session.start(); await settle();
    expect(mcp.setEnabled).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('resumes Default with legacy MCP choices without unsupported writes or startup failure', async () => {
    const h = setup({ resumeSessionId: 'native-session', mcpOverrides: { alpha: false } });
    expect(await h.session.start()).toMatchObject({ profileId: 'default', sessionId: 'native-session' });
    await settle();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'mcp.toggle' || method === 'mcp.nativeAction')).toBe(false);
    expect(h.runtime.close).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('does not report workflow persistence success on a scope failure, native denial or wrong readback', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'workflow.set'];
    const assertPreferenceScope = vi.fn();
    const h = setup({}, runtime, { cliSha256: NATIVE_UI_PINNED_SHA256,
      preferenceFingerprint: async () => 'a'.repeat(64), assertPreferenceScope });
    await h.session.start(); await settle(); runtime.request.mockClear();
    assertPreferenceScope.mockImplementationOnce(() => { throw new Error('outside independent account'); });
    await expect(h.session.setWorkflows('on')).rejects.toThrow('outside independent');
    expect(runtime.request).not.toHaveBeenCalled();
    runtime.handler = (method) => method === 'workflow.set' ? { deny: 'Native setting is managed' } : undefined;
    await expect(h.session.setWorkflows('on')).rejects.toThrow('managed');
    runtime.handler = (method) => method === 'workflow.set' ? { enabled: false, scope: 'native-user' } : undefined;
    await expect(h.session.setWorkflows('on')).rejects.toThrow('confirm');
    expect(runtime.close).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('uses explicitly verified session settings and reports native denials without pretending success', async () => {
    const runtime = new FakeRuntime();
    runtime.ready.capabilities = [...BASE_CAPS, 'config.session:effortLevel'];
    const h = setup({}, runtime);
    await h.session.start();
    await h.session.setEffort('xhigh');
    expect(runtime.request).toHaveBeenCalledWith('config.set', { key: 'effortLevel', value: 'xhigh' }, expect.anything());
    runtime.handler = (method) => method === 'config.set' ? { deny: 'Managed source owns this value.' } : undefined;
    await expect(h.session.setEffort('high')).rejects.toThrow('Managed source');
    await h.session.close();
  });

  it('maps actual context/categories and native tool stop, but never fabricates model capabilities', async () => {
    const h = setup();
    await h.session.start();
    expect(await h.session.models()).toEqual([
      { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'] },
      { value: 'sonnet', label: 'Sonnet 5.5', catalogSource: 'native-config', equivalentValues: ['sonnet', 'claude-sonnet-5-5'] },
    ]);
    expect(await h.session.contextUsage('summary')).toMatchObject({ usedTokens: 10, maxTokens: 100, percent: 10 });
    await h.session.stopTask('a1');
    expect(h.runtime.request).toHaveBeenCalledWith('tool.call', { tool: 'TaskStop', task_id: 'a1' }, expect.anything());
    await h.session.close();
  });

  it('lists only the native config models the session-only switch can apply, without model/effort mutation', async () => {
    const runtime = new FakeRuntime();
    const raw = ['sonnet', 'opus', 'haiku', 'fable', 'opus[1m]', 'provider/custom-model'];
    runtime.config[1]!.options = raw;
    const h = setup({}, runtime); await h.session.start(); await settle();
    runtime.request.mockClear();
    const before = structuredClone(runtime.config);
    const rows = await h.session.models();
    // 1M and custom values cannot be chosen session-only in the native picker; listed, they would always fail.
    expect(rows.map((row) => row.value)).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
    expect(rows.every((row) => row.catalogSource === 'native-config')).toBe(true);
    expect(rows.find((row) => row.value === 'opus')).toMatchObject({ label: 'Opus 5.5', equivalentValues: ['opus', 'claude-opus-5-5'] });
    expect(runtime.config).toEqual(before);
    expect(runtime.request.mock.calls.map(([method]) => method)).toEqual(['config.list']);
    expect(runtime.writeTerminal).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('preserves genuine native model.list descriptions and capabilities rather than substituting adapter labels', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'model.list'];
    const observed: ModelOption[] = [{ value: 'provider/custom-version', label: 'Native custom model',
      description: 'Genuine upstream wording', supportsEffort: true, effortLevels: ['high', 'max'] }];
    runtime.handler = (method) => method === 'model.list' ? observed : undefined;
    const h = setup({}, runtime); await h.session.start(); await settle();
    runtime.request.mockClear();
    expect(await h.session.models()).toEqual(observed);
    expect(runtime.request.mock.calls.map(([method]) => method)).toEqual(['model.list']);
    expect(runtime.writeTerminal).not.toHaveBeenCalled();
    await h.session.close();
  });

  it('runs one full Context read after an in-flight summary and shares only equally detailed results', async () => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    let resolveSummary!: (value: unknown) => void, resolveFull!: (value: unknown) => void;
    const summaryValue = { context: { tokens: 10, window: 100 }, rateLimits: [] };
    const fullValue = { context: { breakdown: { totalTokens: 31, maxTokens: 100,
      categories: [{ name: 'System', tokens: 31, kind: 'used' }] } }, rateLimits: [] };
    h.runtime.handler = (method, args) => method === 'session.usage'
      ? new Promise((resolve) => { if ((args as { breakdown: string }).breakdown === 'summary') resolveSummary = resolve; else resolveFull = resolve; }) : undefined;
    const summary = h.session.contextUsage('summary');
    const full = h.session.contextUsage('full'), anotherFull = h.session.contextUsage('full');
    await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'session.usage').map(([, args]) => args)).toEqual([{ breakdown: 'summary' }]);
    resolveSummary(summaryValue); await summary; await settle();
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'session.usage').map(([, args]) => args)).toEqual([{ breakdown: 'summary' }, { breakdown: 'full' }]);
    const sharedSummary = h.session.contextUsage('summary');
    resolveFull(fullValue);
    for (const result of await Promise.all([full, anotherFull, sharedSummary])) {
      expect(result).toMatchObject({ usedTokens: 31, categories: [{ name: 'System', tokens: 31, kind: 'used' }] });
    }
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'session.usage')).toHaveLength(2);
    await h.session.close();
  });

  it('does not downgrade or discard a queued full read when the preceding summary fails', async () => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    let rejectSummary!: (error: Error) => void;
    h.runtime.handler = (method, args) => {
      if (method !== 'session.usage') return undefined;
      if ((args as { breakdown: string }).breakdown === 'summary') return new Promise((_resolve, reject) => { rejectSummary = reject; });
      return { context: { tokens: 35, window: 100 }, rateLimits: [] };
    };
    const summary = expect(h.session.contextUsage('summary')).rejects.toThrow('Optional summary unavailable');
    const full = h.session.contextUsage('full');
    await settle(); rejectSummary(new Error('Optional summary unavailable'));
    await summary; await expect(full).resolves.toMatchObject({ usedTokens: 35 });
    expect(h.runtime.request.mock.calls.filter(([method]) => method === 'session.usage').map(([, args]) => args)).toEqual([{ breakdown: 'summary' }, { breakdown: 'full' }]);
    expect(h.runtime.close).not.toHaveBeenCalled(); await h.session.close();
  });

  it('keeps the writer on an optional full Context error but still closes on a genuine fatal bridge fault', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.handler = (method, args) => {
      if (method === 'session.usage' && (args as { breakdown?: string }).breakdown === 'full') throw new Error('Optional native context counter unavailable');
      return undefined;
    };
    await expect(h.session.contextUsage('full')).rejects.toThrow('context counter unavailable');
    expect(h.session.currentState).toBe('idle'); expect(h.runtime.close).not.toHaveBeenCalled();
    await expect(h.session.models()).resolves.toHaveLength(2);
    h.runtime.emit('error', { message: 'Synthetic fatal transport fault', fatal: true });
    await settle(); expect(h.runtime.close).toHaveBeenCalledOnce(); expect(h.session.currentState).toBe('closed');
  });

  it('discovers the native Fast row while off and rereads native model promotion and preference after a genuine setter', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'fast.set', 'ui.command', 'env.effort'];
    let enabled = false, model = 'native-opus';
    runtime.handler = (method, args) => {
      if (method === 'config.list') return [...runtime.config, { key: 'fast', label: 'Fast mode (Opus 5.5)', kind: 'boolean', value: enabled, isLocked: false, provider: { plugin: 'engine', tier: 'core' } }];
      if (method === 'session.model') return model;
      if (method === 'fast.set') { enabled = (args as { enabled: boolean }).enabled; if (enabled) model = 'native-promoted-opus'; return { key: 'fast', enabled, nativeValue: enabled, scope: 'native-user' }; }
      return undefined;
    };
    const h = setup({}, runtime, { cliSha256: NATIVE_UI_PINNED_SHA256, preferenceFingerprint: async () => 'a'.repeat(64), assertPreferenceScope: () => {} });
    await h.session.start(); await settle();
    expect(h.events.findLast(event => event.type === 'init')).toMatchObject({ nativeFast: { available: true, requested: false, state: 'off' } });
    expect(await h.session.models()).toMatchObject([
      { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config' },
      { value: 'sonnet', label: 'Sonnet 5.5', catalogSource: 'native-config' },
    ]);
    await h.session.setFastMode(true);
    expect(h.events.findLast(event => event.type === 'init')).toMatchObject({ model: 'native-promoted-opus', nativeFast: { available: true, requested: true } });
    const on = h.events.findLast(event => event.type === 'init');
    expect(on?.type === 'init' && on.nativeFast?.state).toBeUndefined();
    await h.session.setFastMode(false);
    expect(h.events.findLast(event => event.type === 'init')).toMatchObject({ nativeFast: { requested: false, state: 'off' } });
    expect(runtime.request).toHaveBeenCalledWith('fast.set', { enabled: false }, expect.anything());
    await h.session.close();
  });

  it('reads native plan windows without invoking a token count or SDK quota ledger', async () => {
    const h = setup(); await h.session.start(); await settle(); h.runtime.request.mockClear();
    h.runtime.handler = (method) => method === 'session.usage'
      ? { rateLimits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: '2026-10-21T18:00:00Z' }] } : undefined;
    expect(await h.session.nativePlanUsage()).toMatchObject({ profileId: 'default', available: true,
      windows: [{ id: 'five_hour', percent: 25, resetsAt: Date.parse('2026-10-21T18:00:00Z') }] });
    expect(h.runtime.request).toHaveBeenCalledExactlyOnceWith('session.usage', {}, expect.anything());
    await expect(h.session.planUsage()).rejects.toThrow('SDK quota ledger');
    expect(h.runtime.request).toHaveBeenCalledTimes(1); await h.session.close();
  });

  it('rehydrates native task metadata and uses only its bound output path', async () => {
    const runtime = new FakeRuntime(); runtime.ready.capabilities = [...BASE_CAPS, 'session.taskHistory'];
    runtime.handler = (method) => method === 'session.taskHistory' ? [{ role: 'assistant', toolUses: [{ tool_use_id: 'task-use', tool: 'Bash',
      input: { command: 'synthetic-only' }, result: { backgroundTaskId: 'task-1', rawOutputPath: 'C:\\fixture\\task-1.output' } }] }] : undefined;
    const h = setup({}, runtime); const read = vi.fn(async () => 'bounded task output'); h.session.options.readTaskOutput = read;
    await h.session.start(); await settle();
    expect(h.events.filter(e => e.type === 'tasks').at(-1)).toMatchObject({ tasks: [{ taskId: 'task-1', status: 'unknown', hasOutput: true }] });
    expect(await h.session.taskOutput('task-1')).toBe('bounded task output');
    expect(read).toHaveBeenCalledExactlyOnceWith('C:\\fixture\\task-1.output');
    await h.session.close();
  });

  it('projects the native quota footer and resumes only through Enter plus a real main-turn start', async () => {
    const h = withControls(); await h.session.start(); await settle();
    h.runtime.terminal('\x1b[2J\x1b[H>\nYour usage limit has reset\nPress enter to continue');
    expect(h.events.filter(e => e.type === 'autoContinue').at(-1)).toMatchObject({ state: { phase: 'native-waiting', canContinue: true, schedule: 'unreported' } });
    h.runtime.writeTerminal.mockImplementation(async (key) => {
      expect(key).toBe('\r'); h.runtime.emit('turn.start', { turnId: 'native-retry' });
      h.runtime.terminal('\x1b[2J\x1b[HNative retry is running');
    });
    await h.session.continueAfterLimit();
    expect(h.runtime.writeTerminal).toHaveBeenCalledOnce();
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'autoContinue.continue' || method === 'usage.plan')).toBe(false);
    await h.session.close();
  });

  it('closes once, clears pending requests, aborts requests and rejects later sends', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('interaction.request', { id: 'p', toolName: 'Read', input: {} });
    await Promise.all([h.session.close(), h.session.close()]);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.broker.pendingCount).toBe(0);
    expect(h.runtime.request.mock.calls.every(([, , options]) => options?.signal?.aborted === true)).toBe(true);
    await expect(h.session.send('too late')).rejects.toThrow('closed');
  });

  it('retains writer ownership when close fails and permits a bounded caller retry', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.close.mockRejectedValueOnce(new Error('Process exit was not verified.'));
    await expect(h.session.close()).rejects.toThrow('not verified');
    expect(h.closed).not.toHaveBeenCalled();
    expect(h.session.currentState).not.toBe('closed');
    await h.session.close();
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.runtime.close).toHaveBeenCalledTimes(2);
  });

  it('closes its owned runtime on a fatal bridge event and redacts diagnostics', async () => {
    const h = setup();
    await h.session.start();
    h.runtime.emit('error', { message: 'Bearer secret-opaque-value', fatal: true });
    await settle();
    expect(h.events.find((event) => event.type === 'error' && event.fatal)).toMatchObject({ message: 'Bearer [redacted]' });
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
    expect(h.closed).toHaveBeenCalledTimes(1);
  });

  it('reports a causal transport failure with exit zero even without an outstanding request', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.exit(0, { kind: 'transport', message: 'Native transport: Mod receiver disconnected' });
    await settle();
    expect(h.events.filter((event) => event.type === 'error')).toEqual([{
      type: 'error', handleId: 'h', fatal: true,
      message: 'Native transport: Mod receiver disconnected. Native interactive process exited (0).',
    }]);
    expect(h.runtime.close).toHaveBeenCalledOnce(); expect(h.session.currentState).toBe('closed');
  });

  it('retains the causal exit diagnostic when queued delivery rejection runs after synchronous closure', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.emit('turn.start', { turnId: 'running' });
    let rejectAbort!: (error: Error) => void;
    h.runtime.handler = (method) => method === 'turn.abort' ? new Promise((_resolve, reject) => { rejectAbort = reject; }) : undefined;
    await h.session.send('queued next'); await settle();
    rejectAbort(new Error('Native transport: Mod receiver disconnected'));
    h.runtime.exit(0, { kind: 'transport', message: 'Native transport: Mod receiver disconnected' });
    await settle();
    expect(h.events.filter((event) => event.type === 'error')).toEqual([{
      type: 'error', handleId: 'h', fatal: true,
      message: 'Native transport: Mod receiver disconnected. Native interactive process exited (0).',
    }]);
    expect(h.runtime.close).toHaveBeenCalledOnce(); expect(h.session.currentState).toBe('closed');
  });

  it('does not diagnose a cause for a bare CLI exit or report an error on explicit close', async () => {
    const bare = setup(); await bare.session.start(); await settle();
    bare.runtime.exit(0); await settle();
    expect(bare.events.filter((event) => event.type === 'error')).toEqual([{
      type: 'error', handleId: 'h', fatal: true, message: 'Native interactive process exited (0).',
    }]);
    const requested = setup(); await requested.session.start(); await settle();
    requested.runtime.close.mockImplementation(async () => { requested.runtime.exit(0); });
    await requested.session.close();
    expect(requested.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(requested.session.currentState).toBe('closed');
  });

  it('redacts the optional transport exit diagnostic through the existing reporting boundary', async () => {
    const h = setup(); await h.session.start(); await settle();
    h.runtime.exit(0, { kind: 'transport', message: 'Bearer secret-opaque-value' }); await settle();
    expect(h.events.find((event) => event.type === 'error')).toMatchObject({
      fatal: true, message: 'Bearer [redacted] Native interactive process exited (0).',
    });
  });
});
