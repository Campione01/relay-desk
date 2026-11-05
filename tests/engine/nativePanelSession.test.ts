import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { NativePanel } from '@shared/types';
import { PermissionBroker } from '../../src/main/engine/broker';
import type { NativeEvent, NativeExitCause, NativeLaunch, NativeReady, NativeRuntime } from '../../src/main/native/contract';
import { NATIVE_UI_PINNED_SHA256 } from '../../src/main/native/controls';
import { NativeInteractiveSession, type NativeInteractiveSessionOptions } from '../../src/main/native/session';

vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('The native adapter must not import the SDK runtime.'); });

const CAPS = ['prompt.submit', 'turn.abort', 'interaction.reply', 'session.usage', 'session.model', 'session.messages',
  'config.list', 'command.list', 'command.run', 'tool.list', 'tool.call', 'agent.list', 'ui.command', 'env.effort', 'bridge.diagnostics'];
const LAUNCH: NativeLaunch = { exe: 'D:\\synthetic\\claude.exe', args: [], cwd: 'D:\\synthetic', env: {}, handleId: 'h', cols: 80, rows: 24 };
const BORDER = '\u2594'.repeat(60);
const draw = (lines: string[]) => `\x1b[2J\x1b[H${lines.join('\r\n')}`;
const IDLE = (effort: string, mode: string) => draw([`${' '.repeat(50)}\u25c9 ${effort} \u00b7 /effort`, '\u2500'.repeat(70), '>', '\u2500'.repeat(70), `  ${mode} \u00b7 ? for shortcuts`]);

/** The native CLI for one session: /config draws a docked dialog that Esc steps out of, then closes. */
class PanelRuntime implements NativeRuntime {
  readonly events = new Set<(event: NativeEvent) => void>();
  readonly terminals = new Set<(data: string) => void>();
  readonly exits = new Set<(code: number | null, cause?: NativeExitCause) => void>();
  sequence = 0;
  ready: NativeReady = { sessionId: 'native-session', isInteractive: true, surface: 'terminal', protocol: 1, capabilities: CAPS, model: 'claude-opus-5-5', cwd: LAUNCH.cwd };
  dialog: 'none' | 'search' | 'list' = 'none';
  after = IDLE('high', '\u23f5\u23f5 accept edits on');
  private finish: ((value: unknown) => void) | undefined;
  start = vi.fn(async (): Promise<NativeReady> => {
    this.terminal('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h' + IDLE('xhigh', '\u23f8 manual mode on'));
    return this.ready;
  });
  request = vi.fn(async (method: string, args?: unknown): Promise<unknown> => {
    switch (method) {
      case 'command.run': {
        const { command } = args as { command: string };
        if (command !== 'config') return {};
        this.dialog = 'search'; this.render();
        return new Promise((resolve) => { this.finish = resolve; });
      }
      case 'command.list': return [{ name: 'config', description: 'Open config panel' }];
      case 'tool.list': return [{ name: 'Read' }];
      case 'config.list': return [];
      case 'agent.list': return [];
      case 'session.model': return 'claude-opus-5-5';
      case 'session.usage': return { context: { tokens: 10, window: 100, percent: 10 }, rateLimits: [] };
      case 'bridge.diagnostics': return { version: 1, modalActive: this.dialog !== 'none', runningTurn: false, activeCount: 0, queuedCount: 0, entries: [], truncated: false };
      default: return {};
    }
  });
  writeTerminal = vi.fn(async (data: string) => {
    if (data !== '\x1b' || this.dialog === 'none') return;
    if (this.dialog === 'search') { this.dialog = 'list'; this.render(); return; }
    this.dialog = 'none'; this.terminal(this.after); this.finish?.({});
  });
  close = vi.fn(async () => undefined);
  resize = vi.fn(async () => undefined);
  render(): void {
    this.terminal(draw([...Array<string>(10).fill(''), BORDER, '   Settings  Status  Config  Usage  Stats',
      this.dialog === 'search' ? '   \u2315 Search settings\u2026' : '   > Auto-compact   true', '   Esc to close']));
  }
  onEvent(listener: (event: NativeEvent) => void) { this.events.add(listener); return () => this.events.delete(listener); }
  onTerminal(listener: (data: string) => void) { this.terminals.add(listener); return () => this.terminals.delete(listener); }
  onExit(listener: (code: number | null, cause?: NativeExitCause) => void) { this.exits.add(listener); return () => this.exits.delete(listener); }
  emit(event: string, data: unknown): void { for (const listener of this.events) listener({ event, data, sessionId: this.ready.sessionId, sequence: ++this.sequence }); }
  terminal(text: string): void { for (const listener of this.terminals) listener(text); }
}

function setup(runtime = new PanelRuntime(),
  controls: NativeInteractiveSessionOptions['controls'] = { cliSha256: NATIVE_UI_PINNED_SHA256, preferenceFingerprint: async () => 'a'.repeat(64) }) {
  const events: EngineEvent[] = [];
  let session: NativeInteractiveSession;
  const broker = new PermissionBroker('h', (event) => events.push(event), { onPendingChange: (count) => session.onPendingChange(count) });
  session = new NativeInteractiveSession({ handleId: 'h', runtime, launch: LAUNCH, controls,
    request: { cwd: LAUNCH.cwd, profileId: 'default', effort: 'xhigh' },
    profile: { id: 'default', name: 'Default', configDir: null, createdAt: 0 },
    broker, emit: (event) => events.push(event), newId: () => 'command-1' });
  const panels = () => events.flatMap((event) => event.type === 'panel' ? [event.panel] : []);
  const rows = (panel: NativePanel | null | undefined) => panel?.rows.map((row) => row.runs.map((run) => run.text).join('').trim()) ?? [];
  return { session, runtime, events, panels, rows };
}

describe('fixture admission of a staged CLI build in a session', () => {
  it('reaches the dialog drivers and the quota view only when the controls name the staged build', async () => {
    const staged = Object.freeze({ version: '9.9.9', sha256: 'a'.repeat(64) });
    const waiting = draw(['Usage limit reached · limit resets 3pm', 'Continuing automatically at 3pm · Esc to cancel', '❯']);
    for (const admittedBuilds of [undefined, [staged]]) {
      const runtime = new PanelRuntime(); const answer = runtime.request.getMockImplementation()!;
      // A forced effort makes a driven picker stop at once, so the drivers' admission shows without a dialog.
      runtime.request.mockImplementation(async (method, args) => method === 'env.effort' ? 'max' : answer(method, args));
      const h = setup(runtime, { cliSha256: staged.sha256, ...(admittedBuilds ? { admittedBuilds } : {}), preferenceFingerprint: async () => 'a'.repeat(64) });
      await h.session.start();
      await expect(h.session.setEffort('high')).rejects.toThrow(admittedBuilds ? 'outranks this picker' : 'not verified');
      h.runtime.terminal(waiting);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const phases = h.events.flatMap((event) => event.type === 'autoContinue' ? [event.state.phase] : []);
      if (admittedBuilds) expect(phases).toContain('native-waiting'); else expect(phases).not.toContain('native-waiting');
      await h.session.close();
    }
  });
});

describe('native panel mirror in a session', () => {
  it('shows a slash command dialog, carries keys and text to it, and closes it like Esc does', async () => {
    const h = setup(); await h.session.start();
    const command = h.session.send('/config');
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    expect(h.panels().at(-1)).toMatchObject({ command: 'config', columns: 80, mouse: true });
    expect(h.rows(h.panels().at(-1))).toEqual(['Settings  Status  Config  Usage  Stats', '\u2315 Search settings\u2026', 'Esc to close']);
    expect(h.session.currentState).toBe('running');
    await h.session.panelInput({ kind: 'text', text: 'theme' });
    await h.session.panelInput({ kind: 'key', key: 'down' });
    expect(h.runtime.writeTerminal.mock.calls.map(([data]) => data)).toEqual(['theme', '\x1b[B']);
    await h.session.panelClose();
    await command;
    // Two Escs: the first leaves the search box, the second closes the dialog.
    expect(h.runtime.writeTerminal.mock.calls.map(([data]) => data).slice(2)).toEqual(['\x1b', '\x1b']);
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeNull());
    expect(h.session.currentState).toBe('idle');
    await h.session.close();
  });

  it('reads the effort and permission mode the CLI shows once the dialog is gone', async () => {
    const h = setup(); await h.session.start();
    const command = h.session.send('/config');
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    await h.session.panelClose(); await command;
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === 'init').at(-1)).toMatchObject({ effort: 'high', permissionMode: 'acceptEdits' }));
    expect(h.runtime.request.mock.calls.map(([method]) => method)).toEqual(expect.arrayContaining(['session.model', 'command.list', 'tool.list']));
    await h.session.close();
  });

  it('turns Stop into closing the dialog, not a turn abort', async () => {
    const h = setup(); await h.session.start();
    const command = h.session.send('/config');
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    await h.session.interrupt(); await command;
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'turn.abort')).toBe(false);
    expect(h.runtime.dialog).toBe('none');
    await h.session.close();
  });

  it('delivers a message typed while the dialog is open after it closes', async () => {
    const h = setup(); await h.session.start();
    const command = h.session.send('/config');
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    const message = h.session.send('after the dialog');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.runtime.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false);
    await h.session.panelClose(); await command; await message;
    expect(h.runtime.request).toHaveBeenCalledWith('prompt.submit', { text: 'after the dialog', asUser: true }, expect.anything());
    await h.session.close();
  });

  it('does not mirror anything while no command or failed control owns a dialog', async () => {
    const h = setup(); await h.session.start();
    h.runtime.dialog = 'search'; h.runtime.render();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.panels()).toEqual([]);
    await expect(h.session.panelInput({ kind: 'key', key: 'enter' })).rejects.toThrow('No CLI panel is open.');
    await h.session.close();
  });

  it('shows a local command\'s printed result once, from its row or else from the command result', async () => {
    const h = setup();
    const original = h.runtime.request.getMockImplementation()!;
    h.runtime.request.mockImplementation(async (method: string, args?: unknown) => {
      if (method !== 'command.run') return original(method, args);
      const { command } = args as { command: string };
      if (command === 'plan') {
        h.runtime.emit('session.append', { uuid: 'plan-row', door: 'command',
          message: { type: 'user', content: [{ type: 'text', text: '<local-command-stdout>Enabled plan mode</local-command-stdout>' }] } });
        return { text: 'Enabled plan mode' };
      }
      return { text: '\x1b[1mTotal cost: $0.12\x1b[22m' };
    });
    await h.session.start();
    await h.session.send('/plan'); await h.session.send('/cost');
    const systems = h.events.flatMap((event) => event.type === 'item' && event.item.kind === 'system' ? [event.item.text] : []);
    expect(systems).toEqual(['Enabled plan mode', 'Total cost: $0.12']);
    await h.session.close();
  });

  it('updates the last context breakdown from a live measure instead of replacing it', async () => {
    const h = setup();
    h.runtime.request.mockImplementation(async (method: string) => method === 'session.usage'
      ? { context: { breakdown: { totalTokens: 30, maxTokens: 100, percentage: 30, model: 'claude-opus-5-5',
        categories: [{ name: 'Messages', tokens: 30, kind: 'used' }], memoryFiles: [{ path: 'CLAUDE.md', type: 'Project', tokens: 5 }] } }, rateLimits: [] }
      : method === 'command.list' ? [] : method === 'agent.list' ? [] : method === 'config.list' ? [] : {});
    await h.session.start(); await h.session.contextUsage('full');
    h.runtime.emit('session.measure', { context: { tokens: 42, window: 100, percent: 42 } });
    const last = h.events.filter((event) => event.type === 'context').at(-1);
    expect(last).toMatchObject({ usage: { usedTokens: 42, percent: 42, maxTokens: 100, live: true,
      categories: [{ name: 'Messages', tokens: 30, kind: 'used' }], memoryFiles: [{ path: 'CLAUDE.md', type: 'Project', tokens: 5 }] } });
    await h.session.close();
  });

  it('re-sends live state, a shown dialog and pending requests for a renderer that adopts the handle again', async () => {
    const h = setup(); await h.session.start();
    const command = h.session.send('/config');
    await vi.waitFor(() => expect(h.panels().at(-1)).toBeTruthy());
    h.events.length = 0;
    h.session.republish();
    expect(h.events.map((event) => event.type)).toEqual(expect.arrayContaining(['init', 'commands', 'tasks', 'panel', 'state']));
    expect(h.events.find((event) => event.type === 'state')).toMatchObject({ state: 'running' });
    await h.session.panelClose(); await command; await h.session.close();
  });
});
