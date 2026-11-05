import { describe, expect, it, vi } from 'vitest';
import type { NativeEvent } from '../../src/main/native/contract';
import { NativeControlGate, NativeUiWaitTimeout, NativeSendQueue, NativeWorkflowLedger, NativeUiController, NativeTerminalScreen, NativeMcpDialogControls,
  NATIVE_UI_PINNED_SHA256, nativeMcpRoute, requestNativeMcp } from '../../src/main/native/controls';
import { nativeEffortView, nativeModelView } from '../../src/main/native/sessionSettings';

const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('one serialized native modal owner', () => {
  const setup = (idle = true, readDiagnostics?: () => Promise<unknown>) => {
    const request = vi.fn(async (): Promise<unknown> => ({})), writeTerminal = vi.fn(async (_data: string) => undefined), onActiveChange = vi.fn(), onControlFailure = vi.fn();
    const controller = new NativeUiController({ sessionId: 's', cliSha256: NATIVE_UI_PINNED_SHA256, port: { request },
      writeTerminal, isIdle: () => idle, onActiveChange, onControlFailure, readDiagnostics });
    return { controller, request, writeTerminal, onActiveChange, onControlFailure };
  };
  it('drives dialogs only on an accepted CLI build and refuses busy native activity before changing anything', async () => {
    const request = vi.fn(), writeTerminal = vi.fn();
    const unlisted = new NativeUiController({ sessionId: 's', cliSha256: 'f'.repeat(64), port: { request }, writeTerminal, isIdle: () => true });
    expect(unlisted.supported).toBe(false);
    await expect(unlisted.run('settings.effort', async (tx) => tx.open('effort', '', () => true))).rejects.toThrow('not verified');
    expect(request).not.toHaveBeenCalled(); expect(writeTerminal).not.toHaveBeenCalled();
    expect(unlisted.recoveryError()).toBeUndefined(); expect(unlisted.active()).toBe(false);
    expect(() => new NativeUiController({ sessionId: '', cliSha256: NATIVE_UI_PINNED_SHA256, port: { request }, writeTerminal, isIdle: () => true })).toThrow('identity');
    const h = setup(false);
    await expect(h.controller.run('mcp', async () => undefined)).rejects.toThrow('not idle');
    expect(h.request).not.toHaveBeenCalled(); expect(h.writeTerminal).not.toHaveBeenCalled(); expect(h.controller.active()).toBe(false);
  });
  it('serializes MCP/model transactions and requires fresh command and key revisions', async () => {
    const h = setup(), seen: string[] = [];
    h.request.mockImplementation(async () => { h.controller.observeTerminal('\x1b[2J\x1b[HNative panel'); return {}; });
    h.writeTerminal.mockImplementation(async () => { h.controller.observeTerminal('\x1b[2J\x1b[HCommitted this session only'); });
    const first = h.controller.run('effort', async (tx) => {
      seen.push('effort-open');
      await tx.open('effort', '', (s) => s.text === 'Native panel', { stableMs: 0 });
      await tx.key('s', (s) => s.text === 'Native panel', (s) => s.text.includes('this session only'), { stableMs: 0 });
      seen.push('effort-done');
    });
    const second = h.controller.run('model', async () => { seen.push('model'); });
    await Promise.all([first, second]);
    expect(seen).toEqual(['effort-open', 'effort-done', 'model']);
    expect(h.onActiveChange.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('s'); h.controller.close();
  });
  it.each(['identical redraw', 'cursor-only output', 'unrelated screen updates'] as const)('settles a valid panel despite continuous %s during the 80 ms stability window', async (noise) => {
    vi.useFakeTimers();
    const h = setup();
    let panelOpen = false;
    let updates = 0;
    let completeCommand: ((value: unknown) => void) | undefined;
    const draw = () => h.controller.observeTerminal('\x1b[2J\x1b[HNative panel');
    h.request.mockImplementation(() => {
      panelOpen = true; draw();
      return new Promise((resolve) => { completeCommand = resolve; });
    });
    h.writeTerminal.mockImplementation(async (key) => {
      expect(key).toBe('\x1b');
      panelOpen = false;
      h.controller.observeTerminal('\x1b[2J\x1b[HIdle composer');
      completeCommand?.({});
    });
    const redraw = setInterval(() => {
      if (!panelOpen) return;
      if (noise === 'identical redraw') draw();
      else if (noise === 'cursor-only output') h.controller.observeTerminal('\x1b[?25l\x1b[?25h');
      else h.controller.observeTerminal(`\x1b[2J\x1b[HNative panel\r\nBackground tick ${++updates}`);
    }, 20);
    try {
      const run = h.controller.run('settings.effort', async (tx) => {
        const panel = await tx.open('effort', '', (snapshot) => snapshot.text.startsWith('Native panel'), { timeoutMs: 200, stableMs: 80 });
        await tx.key('\x1b', (snapshot) => snapshot.text.startsWith('Native panel'), (snapshot) => snapshot.text === 'Idle composer', { timeoutMs: 200, stableMs: 0 });
        return panel;
      });
      void run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(240);
      await expect(run).resolves.toMatchObject({ text: expect.stringMatching(/^Native panel(?:\n|$)/) });
      expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b');
      expect(h.onActiveChange.mock.calls.map(([active]) => active)).toEqual([true, false]);
    } finally {
      clearInterval(redraw); completeCommand?.({}); h.controller.close(); vi.useRealTimers();
    }
  });
  it('does not authorize historical model output, guesses or failed modal recovery', async () => {
    const h = setup(); h.controller.observeTerminal('Native panel');
    h.request.mockReturnValue(new Promise(() => undefined));
    await expect(h.controller.run('mcp', (tx) => tx.open('mcp', '', () => true, { timeoutMs: 10, stableMs: 0 }))).rejects.toThrow('deadline');
    expect(h.controller.active()).toBe(true);
    await expect(h.controller.run('model', async () => undefined)).rejects.toThrow('prior native modal failed');
    expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
    const noOpen = setup();
    await expect(noOpen.controller.run('mcp', (tx) => tx.key('\r', () => true, () => true))).rejects.toThrow('no fresh');
    expect(noOpen.writeTerminal).not.toHaveBeenCalled(); noOpen.controller.close();
  });
  it.each(['cursor-only', 'identical redraw'] as const)('does not make a historical panel fresh through %s traffic', async (noise) => {
    vi.useFakeTimers();
    const h = setup(), command = deferred();
    h.controller.observeTerminal('Native panel');
    const before = h.controller.snapshot().revision;
    h.request.mockReturnValue(command.promise);
    const redraw = setInterval(() => h.controller.observeTerminal(noise === 'cursor-only' ? '\x1b[?25l\x1b[?25h' : '\x1b[2J\x1b[HNative panel'), 20);
    try {
      const run = h.controller.run('settings.effort', (tx) => tx.open('effort', '', (snapshot) => snapshot.text === 'Native panel', { timeoutMs: 200, stableMs: 80 }), { cancelPanel: () => true });
      void run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(240);
      await expect(run).rejects.toBeInstanceOf(NativeUiWaitTimeout);
      expect(h.controller.snapshot().revision).toBe(before);
      expect(h.controller.recoveryError()).toBeInstanceOf(NativeControlGate);
      expect(h.writeTerminal).not.toHaveBeenCalled();
    } finally { clearInterval(redraw); h.controller.close(); command.resolve({}); vi.useRealTimers(); }
  });
  it('resets stability when the expected panel stops matching', async () => {
    vi.useFakeTimers();
    const h = setup(), command = deferred(); let match = true;
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    const redraw = setInterval(() => { match = !match; h.controller.observeTerminal(`\x1b[2J\x1b[H${match ? 'Native panel' : 'Other view'}`); }, 30);
    try {
      const run = h.controller.run('settings.effort', (tx) => tx.open('effort', '', (snapshot) => snapshot.text === 'Native panel', { timeoutMs: 200, stableMs: 80 }));
      void run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(240);
      await expect(run).rejects.toBeInstanceOf(NativeUiWaitTimeout);
      expect(h.writeTerminal).not.toHaveBeenCalled();
    } finally { clearInterval(redraw); h.controller.close(); command.resolve({}); vi.useRealTimers(); }
  });
  it('reports an unconfirmed result before unlocking an already fulfilled command, without claiming success or writing recovery keys', async () => {
    const h = setup(), original = new NativeUiWaitTimeout('settings.effort', 'Unconfirmed setting result');
    const order: string[] = [];
    h.onActiveChange.mockImplementation((active) => order.push(active ? 'active' : 'released'));
    h.onControlFailure.mockImplementation((error) => {
      expect(error).toBe(original); expect(h.controller.recoveryError()).toBeDefined(); order.push('failed');
    });
    h.request.mockImplementation(async () => { h.controller.observeTerminal('Native panel'); return {}; });
    await expect(h.controller.run('settings.effort', async (tx) => {
      await tx.open('effort', '', () => true, { stableMs: 0 }); throw original;
    }, { cancelPanel: () => true })).rejects.toBe(original);
    expect(order).toEqual(['active', 'failed', 'released']);
    expect(h.controller.recoveryError()).toBeUndefined(); expect(h.controller.active()).toBe(false);
    expect(h.writeTerminal).not.toHaveBeenCalled();
    await expect(h.controller.run('manual-next-control', async () => 'new explicit action')).resolves.toBe('new explicit action');
    h.controller.close();
  });
  it('keeps an unknown panel quarantined until its exact command fulfills, without automatic keys or another failure notification', async () => {
    const h = setup(), command = deferred(), original = new Error('Unconfirmed native result');
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    await expect(h.controller.run('settings.effort', async (tx) => {
      await tx.open('effort', '', () => true, { stableMs: 0 });
      h.controller.observeTerminal('\x1b[2J\x1b[HUnknown overlay'); throw original;
    }, { cancelPanel: (snapshot) => snapshot.text === 'Native panel' })).rejects.toBe(original);
    expect(h.controller.active()).toBe(true); expect(h.controller.recoveryError()).toBeInstanceOf(NativeControlGate);
    await expect(h.controller.run('new-control', async () => 'unsafe')).rejects.toThrow('recovery is required');
    expect(h.onActiveChange.mock.calls).toEqual([[true]]);
    command.resolve({}); await tick();
    expect(h.controller.active()).toBe(false); expect(h.controller.recoveryError()).toBeUndefined();
    expect(h.onActiveChange.mock.calls).toEqual([[true], [false]]);
    expect(h.onControlFailure).toHaveBeenCalledExactlyOnceWith(original);
    expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it('does not treat a rejected command wait as native modal completion', async () => {
    const h = setup(), original = new Error('Local request timed out');
    h.request.mockImplementation(async () => { h.controller.observeTerminal('Native panel'); throw original; });
    await expect(h.controller.run('settings.effort', (tx) => tx.open('effort', '', () => true, { stableMs: 0 }), { cancelPanel: () => true })).rejects.toBe(original);
    expect(h.controller.recoveryError()).toBeDefined(); expect(h.controller.active()).toBe(true);
    expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it.each(['effort', 'model'] as const)('cancels a fresh owned %s panel once and awaits the original command, preserving the failed operation', async (name) => {
    const h = setup(), command = deferred(), original = new Error('Unconfirmed setting');
    const order: string[] = [];
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    h.onControlFailure.mockImplementation(() => order.push('failed'));
    h.writeTerminal.mockImplementation(async (key) => {
      expect(key).toBe('\x1b'); order.push('cancel');
      h.controller.observeTerminal('\x1b[2J\x1b[HComposer'); command.resolve({});
    });
    await expect(h.controller.run(`settings.${name}`, async (tx) => {
      await tx.open(name, '', () => true, { stableMs: 0 }); throw original;
    }, { cancelPanel: (snapshot) => snapshot.text === 'Native panel' })).rejects.toBe(original);
    expect(order).toEqual(['failed', 'cancel']); expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b');
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.controller.active()).toBe(false); expect(h.controller.recoveryError()).toBeUndefined(); h.controller.close();
  });
  it('does not cancel from a stale panel after an unconfirmed input even if cursor output arrives', async () => {
    const h = setup(), command = deferred();
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    h.writeTerminal.mockImplementation(async () => { h.controller.observeTerminal('\x1b[?25l\x1b[?25h'); });
    await expect(h.controller.run('settings.effort', async (tx) => {
      await tx.open('effort', '', () => true, { stableMs: 0 });
      await tx.key('s', () => true, () => false, { timeoutMs: 10, stableMs: 0 });
    }, { cancelPanel: (snapshot) => snapshot.text === 'Native panel' })).rejects.toBeInstanceOf(NativeUiWaitTimeout);
    expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('s'); expect(h.controller.recoveryError()).toBeDefined();
    h.controller.close(); command.resolve({});
  });
  it('bounds a cancellation without native completion, sends no second Escape, and never unlocks after close', async () => {
    vi.useFakeTimers();
    const h = setup(), command = deferred(), original = new Error('Unconfirmed setting');
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    try {
      const run = h.controller.run('settings.effort', async (tx) => {
        await tx.open('effort', '', () => true, { stableMs: 0 }); throw original;
      }, { cancelPanel: (snapshot) => snapshot.text === 'Native panel' });
      void run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5010);
      await expect(run).rejects.toBe(original);
      expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b'); expect(h.controller.recoveryError()).toBeDefined();
      h.controller.close(); command.resolve({}); await tick();
      expect(h.onActiveChange.mock.calls).toEqual([[true]]);
      expect(h.controller.recoveryError()).toBeDefined(); expect(h.writeTerminal).toHaveBeenCalledTimes(1);
    } finally { h.controller.close(); command.resolve({}); vi.useRealTimers(); }
  });
  it('freezes timeout panel facts before inspecting and projects only safe diagnostic fields', async () => {
    vi.useFakeTimers();
    const inspection = deferred(), command = deferred(), read = vi.fn(() => inspection.promise);
    const h = setup(true, read), secret = 'SCREEN_SECRET_CREDENTIAL_UUID_PATH_CANARY';
    h.request.mockImplementation(() => {
      h.controller.observeTerminal(`${secret}\r\nEffort\r\n \u25b2\r\nlow medium high xhigh max\r\nEnter to confirm - s for this session only - Esc to cancel`);
      return command.promise;
    });
    try {
      const run = h.controller.run('settings.effort', (tx) => tx.open('effort', '', () => false, { timeoutMs: 10, stableMs: 0 }));
      const outcome = run.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(read).toHaveBeenCalledTimes(1);
      h.controller.observeTerminal('\x1b[2J\x1b[HLATER_SCREEN_SECRET');
      inspection.resolve({ version: 1, modalActive: false, runningTurn: false, activeCount: 3, queuedCount: 2, truncated: false,
        text: 'RAW_INSPECTOR_SECRET', env: 'ENV_INSPECTOR_SECRET',
        entries: [
          { method: 'session.messages', state: 'running', queuedMs: 2, runMs: 5000, id: 'ID_INSPECTOR_SECRET' },
          { method: 'ui.command', command: 'effort', state: 'queued', queuedMs: 4999, args: 'ARGS_INSPECTOR_SECRET' },
          { method: 'METHOD_INSPECTOR_SECRET', command: 'COMMAND_INSPECTOR_SECRET', state: 'queued', queuedMs: 3 },
        ] });
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeUiWaitTimeout);
      const summary = (error as Error).message;
      expect(summary).toContain('native UI did not reach the attested expected state');
      expect(summary).toContain('phase=open:effort; revision=1; requiredRevision>0; geometry=120x40; panels=effort');
      expect(summary).toContain('effortParts=title:1,labels:1,pointers:1,aligned:1,confirm:1,sessionOnly:1,cancel:1,footer:1');
      expect(summary).toContain('projection0based=titleRow:1,labelRow:3,pointerRow:2,pointerCol:1,labelCenters:[1,6.5,12.5,18,23]');
      expect(summary).toContain('bridge=modal:0,turn:0,active:3,queued:2,truncated:0');
      expect(summary).toContain('session.messages:running queuedMs=2 runMs=5000');
      expect(summary).toContain('ui.command/effort:queued queuedMs=4999');
      expect(summary).toContain('other:queued queuedMs=3');
      expect(summary).not.toContain('SECRET'); expect(summary).not.toContain(secret);
      expect(h.onControlFailure).toHaveBeenCalledExactlyOnceWith(error);
      expect(h.onActiveChange.mock.calls).toEqual([[true]]);
      expect(h.writeTerminal).not.toHaveBeenCalled();
      command.resolve({}); await tick();
      expect(h.onActiveChange.mock.calls).toEqual([[true], [false]]);
    } finally { h.controller.close(); command.resolve({}); inspection.resolve({}); vi.useRealTimers(); }
  });
  it.each([
    ['wrapped model footer', 'Select model\n> 1. Opus New Opus 5.5 Native description\nEnter to set as default -\ns to use this session only -\nEsc to cancel', 'model', undefined],
    ['split irrelevant effort confirmation', 'Effort\n \u25b2\nlow medium high xhigh max\nEnter to\nconfirm - s for this session only - Esc to cancel', 'effort', false],
    ['missing irrelevant effort confirmation', 'Effort\n \u25b2\nlow medium high xhigh max\ns for this session only - Esc to cancel', 'effort', false],
    ['wrapped effort footer', 'Effort\n \u25b2\nlow medium high xhigh max\nEnter to confirm\ns for this session only -\nEsc to cancel', 'effort', true],
  ] as const)('uses existing panel normalization for diagnostic shape: %s', async (_name, screen, panel, confirm) => {
    const h = setup(); h.controller.observeTerminal(screen.replaceAll('\n', '\r\n'));
    const snapshot = h.controller.snapshot();
    expect(nativeEffortView(snapshot) ? 'effort' : nativeModelView(snapshot) ? 'model' : 'none').toBe(panel);
    const error = await h.controller.run('fixture-wait', (tx) => tx.wait(() => false, { timeoutMs: 1, stableMs: 0 })).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeUiWaitTimeout);
    expect((error as Error).message).toContain(`panels=${panel};`);
    if (confirm !== undefined) expect((error as Error).message).toContain(`confirm:${Number(confirm)}`);
    expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it.each([
    { version: 2 },
    { activeCount: 'COUNT_SECRET' },
    { queuedCount: -1 },
    { runningTurn: 'TURN_ID_SECRET' },
    { entries: [{ method: 'session.messages', state: 'STATE_SECRET', queuedMs: 0 }] },
    { entries: [{ method: 'session.messages', state: 'running', queuedMs: Infinity }] },
    { entries: Array.from({ length: 17 }, () => ({ method: 'session.messages', state: 'queued', queuedMs: 0 })) },
  ])('uses one fixed marker for malformed diagnostic metadata %j', async (patch) => {
    const h = setup(true, async () => ({ version: 1, modalActive: false, runningTurn: false, activeCount: 0, queuedCount: 0, truncated: false, entries: [], ...patch }));
    const error = await h.controller.run('fixture-wait', (tx) => tx.wait(() => false, { timeoutMs: 1, stableMs: 0 })).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeUiWaitTimeout);
    expect((error as Error).message).toContain('phase=wait');
    expect((error as Error).message).toContain('bridge=unavailable'); expect((error as Error).message).not.toContain('SECRET');
    expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it('uses the same safe marker for a rejected or missing inspector without altering the timeout type', async () => {
    for (const read of [undefined, async () => { throw new Error('INSPECTOR_REJECTION_SECRET'); }]) {
      const h = setup(true, read);
      const error = await h.controller.run('fixture-wait', (tx) => tx.wait(() => false, { timeoutMs: 1, stableMs: 0 })).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeUiWaitTimeout);
      expect((error as Error).message).toContain('bridge=unavailable'); expect((error as Error).message).not.toContain('SECRET');
      expect(h.onControlFailure).not.toHaveBeenCalled(); expect(h.controller.active()).toBe(false); h.controller.close();
    }
  });
  it('bounds a hung optional inspector to 500 ms beyond the original timeout', async () => {
    vi.useFakeTimers();
    const h = setup(true, () => new Promise(() => undefined));
    try {
      const started = Date.now(); let settled = false;
      const outcome = h.controller.run('fixture-wait', (tx) => tx.wait(() => false, { timeoutMs: 10, stableMs: 0 }))
        .catch((error: unknown) => { settled = true; return error; });
      await vi.advanceTimersByTimeAsync(509); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeUiWaitTimeout); expect(Date.now() - started).toBe(510);
      expect((error as Error).message).toContain('bridge=unavailable');
      expect(h.writeTerminal).not.toHaveBeenCalled(); expect(h.controller.active()).toBe(false);
    } finally { h.controller.close(); vi.useRealTimers(); }
  });
  it('labels the exact guarded key wait without including raw key bytes or inspecting successful controls', async () => {
    const read = vi.fn(async () => ({ version: 1, modalActive: true, runningTurn: false, activeCount: 1, queuedCount: 0, entries: [{ method: 'ui.command', command: 'effort', state: 'running', queuedMs: 0, runMs: 10 }], truncated: false }));
    const h = setup(true, read), command = deferred();
    await h.controller.run('successful-read', async () => true); expect(read).not.toHaveBeenCalled();
    h.request.mockImplementation(() => { h.controller.observeTerminal('Native panel'); return command.promise; });
    const error = await h.controller.run('settings.effort', async (tx) => {
      await tx.open('effort', '', () => true, { stableMs: 0 });
      await tx.key('s', () => true, () => false, { timeoutMs: 1, stableMs: 0 });
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NativeUiWaitTimeout);
    expect((error as Error).message).toContain('phase=key:session-only');
    expect((error as Error).message).toContain('ui.command/effort:running queuedMs=0 runMs=10');
    expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('s'); expect(read).toHaveBeenCalledTimes(1);
    h.controller.close(); command.resolve({});
  });
  it('refuses an Enter unless the current selection guard succeeds and poisons the modal', async () => {
    const h = setup();
    h.request.mockImplementation(() => { h.controller.observeTerminal('Unexpected save-default row'); return new Promise(() => undefined); });
    await expect(h.controller.run('model', async (tx) => {
      await tx.open('model', '', () => true, { stableMs: 0 });
      await tx.key('\r', (s) => s.text.includes('Verified fixture row'), () => true);
    })).rejects.toThrow('selection guard');
    expect(h.writeTerminal).not.toHaveBeenCalled(); expect(h.controller.active()).toBe(true); h.controller.close();
  });
  it('projects the current screen rather than historical ANSI-erased labels', () => {
    const screen = new NativeTerminalScreen();
    screen.write('> 3. Disable\r\nMCP panel'); screen.write('\x1b[2J\x1b[H> 2. Enable');
    expect(screen.text()).toBe('> 2. Enable');
    screen.write('\x1b]0;untrusted title\x07'); expect(screen.text()).not.toContain('untrusted');
    screen.write('\r\x1b[2Knew'); expect(screen.text()).toBe('new');
  });
  it('never lets default-saving command arguments reach the native command dispatcher', async () => {
    const h = setup();
    await expect(h.controller.run('model', (tx) => tx.open('model', 'opus', () => true))).rejects.toThrow('default-setting');
    expect(h.request).not.toHaveBeenCalled(); expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it('gates persistent native MCP toggles and invalid labels before opening a dialog', async () => {
    const h = setup(), mcp = new NativeMcpDialogControls(h.controller);
    await expect(mcp.setEnabled('server', false)).rejects.toThrow('disabledMcpServers');
    expect(() => mcp.inspect('server\nmalicious')).toThrow('ambiguous');
    expect(h.request).not.toHaveBeenCalled(); expect(h.writeTerminal).not.toHaveBeenCalled(); h.controller.close();
  });
  it('returns an honest empty MCP catalog from a completed nonmodal command without a terminal frame or poisoned UI', async () => {
    const h = setup(); h.request.mockResolvedValue({ text: 'No MCP servers configured.' });
    const mcp = new NativeMcpDialogControls(h.controller);
    await expect(mcp.inspectCatalog([])).resolves.toEqual([]);
    expect(h.writeTerminal).not.toHaveBeenCalled(); expect(h.controller.active()).toBe(false);
    await expect(h.controller.run('next-readonly', async () => 'still usable')).resolves.toBe('still usable'); h.controller.close();
  });
  it.each(['inspect', 'inspectCatalog'] as const)('dismisses only the fresh owned MCP catalog after %s selection failure and preserves the error', async (method) => {
    const h = setup(), command = deferred(), mcp = new NativeMcpDialogControls(h.controller);
    h.request.mockImplementation(() => {
      h.controller.observeTerminal('Manage MCP servers\r\n1 server\r\n  \u221a server 1 tool\r\nEnter to confirm \u00b7 Esc to cancel');
      return command.promise;
    });
    h.writeTerminal.mockImplementation(async (key) => {
      expect(key).toBe('\x1b'); h.controller.observeTerminal('\x1b[2J\x1b[H>\r\n? for shortcuts'); command.resolve({});
    });
    try {
      const error = await (method === 'inspect' ? mcp.inspect('server') : mcp.inspectCatalog(['server'])).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(NativeControlGate); expect((error as Error).message).toContain('exact server was not observable');
      expect(h.onControlFailure).toHaveBeenCalledExactlyOnceWith(error);
      expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b'); expect(h.request).toHaveBeenCalledOnce();
      expect(h.controller.active()).toBe(false); expect(h.controller.recoveryError()).toBeUndefined();
      await expect(h.controller.run('new-explicit-control', async () => true)).resolves.toBe(true);
    } finally { h.controller.close(); command.resolve({}); }
  });
  it('never guesses a detail-to-catalog Escape sequence after an unrecognized MCP detail', async () => {
    const h = setup(), command = deferred(), mcp = new NativeMcpDialogControls(h.controller);
    h.request.mockImplementation(() => {
      h.controller.observeTerminal('Manage MCP servers\r\n1 server\r\n> \u221a server 1 tool\r\nEnter to confirm \u00b7 Esc to cancel');
      return command.promise;
    });
    h.writeTerminal.mockImplementation(async (key) => {
      expect(key).toBe('\r');
      h.controller.observeTerminal('\r\nserver MCP Server\r\nStatus: unknown layout\r\nEnter to select \u00b7 Esc to back');
    });
    try {
      await expect(mcp.inspectCatalog(['server'])).rejects.toThrow('connection state is not a verified layout');
      expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\r');
      expect(h.controller.active()).toBe(true); expect(h.controller.recoveryError()).toBeDefined();
    } finally { h.controller.close(); command.resolve({}); }
  });
  it('does not authorize a catalog from a server row containing the footer text when the real footer is absent', async () => {
    vi.useFakeTimers(); const h = setup(), command = deferred(), mcp = new NativeMcpDialogControls(h.controller);
    const name = 'alpha Enter to confirm \u00b7 Esc to cancel';
    h.request.mockImplementation(() => {
      h.controller.observeTerminal(`Manage MCP servers\r\n1 server\r\n> \u00d7 ${name}`); return command.promise;
    });
    try {
      const result = mcp.inspectCatalog([name]); void result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5500);
      await expect(result).rejects.toBeInstanceOf(NativeUiWaitTimeout);
      expect(h.writeTerminal).not.toHaveBeenCalled();
    } finally { h.controller.close(); command.resolve({}); vi.useRealTimers(); }
  });
  it('allows one recovery Escape after confirmed detail-to-catalog navigation without replaying rejected intent', async () => {
    vi.useFakeTimers(); const h = setup(), command = deferred(), mcp = new NativeMcpDialogControls(h.controller);
    const request = vi.fn(async () => ({})), deliveryError = vi.fn();
    const queue = new NativeSendQueue({ sessionId: 's', capabilities: ['prompt.submit'], port: { request },
      isBlocked: () => h.controller.active(), onDeliveryError: deliveryError });
    h.onControlFailure.mockImplementation((error: Error) => queue.rejectPending(error));
    h.onActiveChange.mockImplementation((active: boolean) => { if (!active) queue.refresh(); });
    let view: 'manager' | 'detail' | 'idle' = 'manager', returned = false;
    const draw = () => h.controller.observeTerminal('\x1b[2J\x1b[H' + (view === 'manager'
      ? `Manage MCP servers\r\n1 server\r\n${returned ? ' ' : '>'} \u221a alpha 1 tool\r\nEnter to confirm \u00b7 Esc to cancel`
      : view === 'detail' ? 'alpha MCP Server\r\nStatus: connected\r\nTools: 1 tool\r\n> 1. View tools\r\nEnter to select \u00b7 Esc to back'
        : '>\r\n? for shortcuts'));
    h.request.mockImplementation(() => { draw(); return command.promise; });
    h.writeTerminal.mockImplementation(async (key) => {
      if (view === 'manager' && !returned && key === '\r') view = 'detail';
      else if (view === 'detail' && key === '\x1b') { view = 'manager'; returned = true; }
      else if (view === 'manager' && returned && key === '\x1b') { view = 'idle'; command.resolve({}); }
      else throw new Error('Unexpected key in confirmed-navigation recovery fixture');
      draw();
    });
    try {
      const outcome = mcp.inspectCatalog(['alpha', 'missing']).catch((error: unknown) => error);
      const held = queue.submit('old never-dispatched intent');
      await vi.advanceTimersByTimeAsync(1000);
      const error = await outcome;
      expect(error).toBeInstanceOf(NativeControlGate); expect((error as Error).message).toContain('exact server was not observable');
      await expect(held.delivered).rejects.toBe(error); expect(deliveryError).toHaveBeenCalledExactlyOnceWith(held.id, error);
      expect(h.writeTerminal.mock.calls.map(([key]) => key)).toEqual(['\r', '\x1b', '\x1b']);
      expect(h.controller.active()).toBe(false); expect(h.controller.recoveryError()).toBeUndefined();
      expect(request).not.toHaveBeenCalled(); expect(queue.snapshot().pending).toEqual([]);
      await queue.submit('new explicit intent').delivered;
      expect(request).toHaveBeenCalledExactlyOnceWith('prompt.submit', { text: 'new explicit intent', asUser: true }, expect.anything());
    } finally { queue.close(); h.controller.close(); command.resolve({}); vi.useRealTimers(); }
  });
  it('does not reset the MCP Escape guard after an unsettled navigation write', async () => {
    const h = setup(), command = deferred();
    const catalog = 'Manage MCP servers\r\n1 server\r\n> \u221a alpha 1 tool\r\nEnter to confirm \u00b7 Esc to cancel';
    h.request.mockImplementation(() => { h.controller.observeTerminal(catalog); return command.promise; });
    h.writeTerminal.mockImplementation(async () => { h.controller.observeTerminal('\x1b[2J\x1b[H' + catalog.replace('1 tool', '2 tools')); });
    try {
      await expect(h.controller.run('mcp.status.dialog', async (tx) => {
        await tx.open('mcp', '', () => true, { stableMs: 0 });
        await tx.key('\x1b', () => true, () => false, { timeoutMs: 1, stableMs: 0 });
      }, { cancelPanel: () => true })).rejects.toBeInstanceOf(NativeUiWaitTimeout);
      expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b'); expect(h.controller.recoveryError()).toBeDefined();
    } finally { h.controller.close(); command.resolve({}); }
  });
  it('does not apply read-only catalog recovery to MCP mutation transactions', async () => {
    const h = setup(), command = deferred(), failure = new Error('Unconfirmed mutation');
    h.request.mockImplementation(() => {
      h.controller.observeTerminal('Manage MCP servers\r\n1 server\r\n> \u221a alpha 1 tool\r\nEnter to confirm \u00b7 Esc to cancel');
      return command.promise;
    });
    try {
      await expect(h.controller.run('mcp.reconnect.dialog', async (tx) => {
        await tx.open('mcp', '', () => true, { stableMs: 0 }); throw failure;
      }, { cancelPanel: () => true })).rejects.toBe(failure);
      expect(h.writeTerminal).not.toHaveBeenCalled(); expect(h.controller.recoveryError()).toBeDefined();
    } finally { h.controller.close(); command.resolve({}); }
  });
  it('uses only current detail status, tool count and selected actions during a guarded reconnect', async () => {
    vi.useFakeTimers();
    const h = setup(), mcp = new NativeMcpDialogControls(h.controller);
    let view: 'manager' | 'detail' | 'reconnect' | 'idle' = 'idle', command: ReturnType<typeof deferred> | undefined;
    const history = 'Status: failed\r\nTools: 999 tools\r\n> 1. Reconnect\r\n';
    const draw = () => h.controller.observeTerminal('\x1b[2J\x1b[H' + history + (view === 'manager'
      ? 'Manage MCP servers\r\n1 server\r\n> \u221a server 2 tools\r\nEnter to confirm \u00b7 Esc to cancel'
      : view === 'detail' || view === 'reconnect' ? `server MCP Server\r\nStatus: connected\r\nTools: 2 tools\r\n${view === 'detail' ? '>' : ' '} 1. View tools\r\n${view === 'reconnect' ? '>' : ' '} 2. Reconnect\r\nEnter to select \u00b7 Esc to back`
        : 'Reconnected to server.\r\n? for shortcuts'));
    h.request.mockImplementation(() => { command = deferred(); view = 'manager'; draw(); return command.promise; });
    h.writeTerminal.mockImplementation(async (key) => {
      if (view === 'manager' && key === '\r') view = 'detail';
      else if (view === 'detail' && key === '\x1b[B') view = 'reconnect';
      else if (view === 'reconnect' && key === '\r') { view = 'idle'; command!.resolve({}); }
      else if ((view === 'detail' || view === 'reconnect') && key === '\x1b') view = 'manager';
      else if (view === 'manager' && key === '\x1b') { view = 'idle'; command!.resolve({}); }
      else throw new Error('Historical action must never authorize this key');
      draw();
    });
    try {
      const result = mcp.reconnect('server'); void result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(result).resolves.toMatchObject({ name: 'server', status: 'connected', toolCount: 2 });
      expect(h.writeTerminal.mock.calls.map(([key]) => key)).toEqual(['\r', '\x1b[B', '\r', '\r', '\x1b', '\x1b']);
      expect(h.controller.active()).toBe(false);
    } finally { h.controller.close(); command?.resolve({}); vi.useRealTimers(); }
  });
});
function queueSetup(capabilities = ['prompt.submit', 'turn.abort']) {
  let sequence = 0, id = 0;
  const request = vi.fn(async (_method: string, _args?: unknown, _options?: unknown): Promise<unknown> => ({}));
  const error = vi.fn();
  const queue = new NativeSendQueue({ sessionId: 'session', capabilities, port: { request }, newId: () => `send-${++id}`, onDeliveryError: error });
  const event = (name: string, data: unknown, extra: Partial<NativeEvent> = {}) => queue.observe({
    event: name, data, sessionId: 'session', sequence: ++sequence, ...extra,
  });
  return { queue, request, event, error };
}

describe('native MCP control routes', () => {
  it('does not mistake tool availability or a native dialog for structured MCP control', async () => {
    const port = { request: vi.fn() };
    expect(nativeMcpRoute('status', ['tool.list', 'command.run', 'mcp.connect'])).toMatchObject({ kind: 'gated', manualNativeCommand: 'mcp' });
    await expect(requestNativeMcp(port, ['tool.list', 'command.run'], 'reconnect', { name: 'server' })).rejects.toBeInstanceOf(NativeControlGate);
    expect(port.request).not.toHaveBeenCalled();
  });
  it('uses only an attested exact method and validates mutation arguments', async () => {
    const port = { request: vi.fn(async () => ({ accepted: true })) };
    await requestNativeMcp(port, ['mcp.toggle'], 'toggle', { name: 'server', enabled: false });
    expect(port.request).toHaveBeenCalledExactlyOnceWith('mcp.toggle', { name: 'server', enabled: false }, undefined);
    await expect(requestNativeMcp(port, ['mcp.toggle'], 'toggle', { name: 'server' })).rejects.toThrow('boolean');
    expect(() => nativeMcpRoute('unknown' as 'status', ['mcp.unknown'])).toThrow('Invalid');
  });
});

describe('native workflow observation coverage', () => {
  const launch = { status: 'async_launched', taskType: 'local_workflow', taskId: 'task1', runId: 'wf_1', workflowName: 'Synthetic' };
  it('preserves actual run/task identities without inventing phases or replay completeness', () => {
    const ledger = new NativeWorkflowLedger();
    expect(ledger.launch(launch, 'tu1')).toBe(true);
    expect(ledger.spawn({ workflow: { runId: 'wf_1', agentIndex: 2 }, description: 'Audit' }, { agentId: 'a2' })).toBe(true);
    expect(ledger.complete({ agentId: 'a2', reason: 'answer', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 } })).toBe(true);
    expect(ledger.snapshot()).toEqual([{ task: { taskId: 'task1', kind: 'workflow', taskType: 'local_workflow',
      description: 'Synthetic', status: 'running', workflowName: 'Synthetic', toolUseId: 'tu1' },
      observedAgents: [{ index: 2, label: 'Audit', state: 'done', agentId: 'a2', tokens: 9 }],
      coverage: { phases: 'unobserved', agents: 'observed-only', replayedAgents: 'not-covered' } }]);
    expect(ledger.snapshot()[0].task).not.toHaveProperty('workflow');
  });
  it('does not interpret absent agents or unrelated stops as workflow completion', () => {
    const ledger = new NativeWorkflowLedger(); ledger.launch(launch);
    expect(ledger.notification({ id: 'other', status: 'completed' })).toBe(false);
    expect(ledger.complete({ agentId: 'unknown', reason: 'answer' })).toBe(false);
    expect(ledger.notification({ id: 'task1', status: 'running' })).toBe(false);
    expect(ledger.snapshot()[0].task.status).toBe('running');
    expect(ledger.notification({ id: 'task1', status: 'completed', durationMs: 123 })).toBe(true);
    expect(ledger.snapshot()[0].task).toMatchObject({ status: 'completed', durationMs: 123 });
  });
  it('ignores malformed/remote/foreign observations and returns detached snapshots', () => {
    const ledger = new NativeWorkflowLedger();
    expect(ledger.launch({ ...launch, status: 'remote_launched' })).toBe(false);
    ledger.launch(launch);
    expect(ledger.spawn({ workflow: { runId: 'foreign', agentIndex: 1 } }, { agentId: 'a' })).toBe(false);
    expect(ledger.spawn({ workflow: { runId: 'wf_1', agentIndex: -1 } }, { agentId: 'a' })).toBe(false);
    ledger.snapshot()[0].task.status = 'failed';
    expect(ledger.snapshot()[0].task.status).toBe('running');
  });
  it('does not revive completed native task/agent observations on duplicate transcript delivery', () => {
    const ledger = new NativeWorkflowLedger(); ledger.launch(launch, 'tu');
    const input = { workflow: { runId: 'wf_1', agentIndex: 1 } }, result = { agentId: 'a' };
    ledger.spawn(input, result); ledger.complete({ agentId: 'a', reason: 'answer' });
    ledger.notification({ id: 'task1', status: 'completed', durationMs: 8 });
    ledger.launch(launch); ledger.spawn(input, result);
    expect(ledger.snapshot()[0].task).toMatchObject({ status: 'completed', durationMs: 8, toolUseId: 'tu' });
    expect(ledger.snapshot()[0].observedAgents[0].state).toBe('done');
  });
});

describe('native next/later queue ownership', () => {
  it('announces the actual dispatch UUID before native submission can synchronously echo it', async () => {
    const order: string[] = [];
    const queue = new NativeSendQueue({ sessionId: 's', capabilities: ['prompt.submit'], newId: () => 'specific-id',
      onDispatch: (id, text) => order.push(`${id}:${text}`), port: { request: async () => { order.push('native'); return {}; } } });
    await queue.submit('specific-text').delivered;
    expect(order).toEqual(['specific-id:specific-text', 'native']); queue.close();
  });
  it('holds accepted GUI sends while a native modal owns input, then drains on release', async () => {
    let blocked = true;
    const request = vi.fn(async () => ({}));
    const queue = new NativeSendQueue({ sessionId: 's', port: { request }, capabilities: ['prompt.submit'], isBlocked: () => blocked });
    const send = queue.submit('wait for native controls'); await tick();
    expect(queue.snapshot().phase).toBe('held'); expect(request).not.toHaveBeenCalled();
    blocked = false; queue.refresh(); await send.delivered;
    expect(request).toHaveBeenCalledExactlyOnceWith('prompt.submit', { text: 'wait for native controls', asUser: true }, expect.anything()); queue.close();
  });
  it('rejects only never-dispatched pending sends without aborting or replaying actual in-flight delivery', async () => {
    const h = queueSetup(), delivered = deferred(), failure = new Error('Native control failed before these sends were dispatched');
    h.request.mockReturnValueOnce(delivered.promise);
    const first = h.queue.submit('already dispatching');
    const later = h.queue.submit('not dispatched later', 'later');
    const next = h.queue.submit('not dispatched next');
    let firstSettled = false; void first.delivered.then(() => { firstSettled = true; });
    h.queue.rejectPending(failure);
    await expect(later.delivered).rejects.toBe(failure); await expect(next.delivered).rejects.toBe(failure);
    expect(firstSettled).toBe(false); expect(h.queue.snapshot()).toMatchObject({ phase: 'awaiting-start', pending: [] });
    expect(h.error.mock.calls).toEqual([[later.id, failure], [next.id, failure]]);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect((h.request.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(false);
    h.queue.refresh(); h.queue.rejectPending(failure); delivered.resolve({}); await first.delivered;
    h.event('turn.start', { turnId: 'actual-main' }); h.event('turn.complete', { turnId: 'actual-main' }); await tick();
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.error).toHaveBeenCalledTimes(2);
    await h.queue.submit('new explicit request').delivered;
    expect(h.request.mock.calls.map(([, args]) => args)).toEqual([{ text: 'already dispatching', asUser: true }, { text: 'new explicit request', asUser: true }]);
    h.queue.close();
  });
  it('delivers idle text as honest user text and waits for the native turn identity', async () => {
    const h = queueSetup();
    const first = h.queue.submit('first'); await first.delivered;
    expect(h.request).toHaveBeenCalledWith('prompt.submit', { text: 'first', asUser: true }, expect.anything());
    expect(h.queue.snapshot().phase).toBe('awaiting-start');
    h.event('turn.start', { turnId: 't1' });
    expect(h.queue.snapshot()).toMatchObject({ phase: 'running', mainTurnId: 't1' });
    h.queue.close();
  });
  it('holds later locally and gives a subsequent next priority after the exact old turn ends', async () => {
    const h = queueSetup(); h.event('turn.start', { turnId: 'old' });
    const later = h.queue.submit('later', 'later');
    expect(h.request).not.toHaveBeenCalled();
    const next = h.queue.submit('next', 'next'); await tick();
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['turn.abort']);
    expect(h.request.mock.calls[0][1]).toEqual({ turnId: 'old' });
    h.event('turn.complete', { turnId: 'old', reason: 'aborted' }); await tick(); await next.delivered;
    expect(h.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => args))
      .toEqual([{ text: 'next', asUser: true }]);
    h.event('turn.start', { turnId: 'new' }); h.event('turn.complete', { turnId: 'new', reason: 'answer' });
    await tick(); await later.delivered;
    expect(h.request.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, args]) => args))
      .toEqual([{ text: 'next', asUser: true }, { text: 'later', asUser: true }]);
    h.queue.close();
  });
  it('does not use child, foreign, duplicate or stale completion events to release queued messages', async () => {
    const h = queueSetup(); h.event('turn.start', { turnId: 'main' });
    h.queue.submit('pending', 'later');
    h.event('turn.complete', { turnId: 'main', agentId: 'child' });
    h.event('turn.complete', { turnId: 'main' }, { sessionId: 'foreign' });
    h.event('turn.complete', { turnId: 'main' }, { sequence: 1 });
    h.event('turn.complete', { turnId: 'older' }); await tick();
    expect(h.request).not.toHaveBeenCalled();
    h.queue.close();
  });
  it('waits for an attested main start before preempting a just-submitted send', async () => {
    const h = queueSetup(); const first = h.queue.submit('first'); await first.delivered;
    const next = h.queue.submit('next'); await tick();
    expect(h.request.mock.calls.filter(([method]) => method === 'turn.abort')).toHaveLength(0);
    h.event('turn.start', { turnId: 'known' }); await tick();
    expect(h.request).toHaveBeenCalledWith('turn.abort', { turnId: 'known' }, expect.anything());
    h.event('turn.complete', { turnId: 'known', reason: 'aborted' }); await tick(); await next.delivered;
    h.queue.close();
  });
  it('rejects failed next delivery rather than changing it to later or retrying', async () => {
    const h = queueSetup(); h.event('turn.start', { turnId: 't' });
    h.request.mockRejectedValueOnce(new Error('Native abort rejected'));
    const next = h.queue.submit('next');
    await expect(next.delivered).rejects.toThrow('abort rejected'); await tick();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.queue.snapshot().pending).toEqual([]);
    h.queue.close();
  });
  it('reports a failed explicit interrupt and never sends a model prompt as its replacement', async () => {
    const h = queueSetup(); h.event('turn.start', { turnId: 't' });
    h.request.mockResolvedValueOnce({ interrupted: false });
    await expect(h.queue.interrupt()).rejects.toThrow('not interrupted');
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['turn.abort']);
    h.queue.close();
  });
  it('rejects pending sends on close and never dispatches them after a late completion', async () => {
    const h = queueSetup(); h.event('turn.start', { turnId: 't' });
    const later = h.queue.submit('pending', 'later');
    h.queue.close(); h.event('turn.complete', { turnId: 't' });
    await expect(later.delivered).rejects.toThrow('closed'); await tick();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.queue.snapshot().phase).toBe('closed');
  });
  it('does not replay a rejected native prompt and allows a fresh user submission', async () => {
    const h = queueSetup(); h.request.mockResolvedValueOnce({ drop: 'Policy refused this text' });
    await expect(h.queue.submit('denied').delivered).rejects.toThrow('Policy'); await tick();
    const second = h.queue.submit('accepted'); await second.delivered;
    expect(h.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(2);
    h.queue.close();
  });
  it('gates unsupported capabilities, slash commands and bounded queue capacity', async () => {
    const noCaps = queueSetup([]);
    expect(() => noCaps.queue.submit('x')).toThrow(NativeControlGate);
    expect(noCaps.request).not.toHaveBeenCalled();
    const h = queueSetup();
    expect(() => h.queue.submit('/mcp')).toThrow('command dispatcher');
    h.queue.close(); noCaps.queue.close();
    const bounded = new NativeSendQueue({ sessionId: 's', port: { request: vi.fn() }, capabilities: ['prompt.submit'], maxPending: 1 });
    bounded.observe({ sessionId: 's', sequence: 1, event: 'turn.start', data: { turnId: 't' } });
    bounded.submit('one', 'later'); expect(() => bounded.submit('two', 'later')).toThrow('full'); bounded.close();
  });
  it('keeps a next send pending when the bridge says the turn already ended, and sends it after the completion', async () => {
    const h = queueSetup();
    h.request.mockImplementation(async (method: string) => method === 'turn.abort' ? { interrupted: false, reason: 'not-running' } : {});
    h.event('turn.start', { turnId: 'ending' });
    const sent = h.queue.submit('typed as the reply ended', 'next'); await tick();
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['turn.abort']);
    expect(h.error).not.toHaveBeenCalled(); expect(h.queue.snapshot().pending).toHaveLength(1);
    h.event('turn.complete', { turnId: 'ending' }); await tick();
    await sent.delivered;
    expect(h.request).toHaveBeenLastCalledWith('prompt.submit', { text: 'typed as the reply ended', asUser: true }, expect.anything());
    // An explicit Stop that races the end of its turn is not an error either.
    h.event('turn.start', { turnId: 'next-turn' });
    await expect(h.queue.interrupt()).resolves.toBeUndefined(); h.queue.close();
  });
  it('does not hold the queue forever when the completion of an ended turn never arrives', async () => {
    vi.useFakeTimers();
    try {
      const h = queueSetup();
      h.request.mockImplementation(async (method: string) => method === 'turn.abort' ? { interrupted: false, reason: 'not-running' } : {});
      h.event('turn.start', { turnId: 'lost' });
      const sent = h.queue.submit('next', 'next'); await vi.advanceTimersByTimeAsync(2_900);
      expect(h.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false);
      await vi.advanceTimersByTimeAsync(200); await sent.delivered;
      expect(h.request).toHaveBeenLastCalledWith('prompt.submit', { text: 'next', asUser: true }, expect.anything());
      h.queue.close();
    } finally { vi.useRealTimers(); }
  });
});

describe('native control quarantine recovery', () => {
  const composer = '\x1b[2J\x1b[H>\r\n? for shortcuts';
  const docked = `\x1b[2J\x1b[H${'▔'.repeat(60)}\r\n   Effort\r\n   Esc to cancel`;
  const setup = (readDiagnostics?: () => Promise<unknown>) => {
    const request = vi.fn(async (_method: string, _args?: unknown, _options?: unknown): Promise<unknown> => ({}));
    const writeTerminal = vi.fn(async (_data: string) => undefined), onActiveChange = vi.fn(), onRecovered = vi.fn(), onSettled = vi.fn();
    const screen = new NativeTerminalScreen(80, 20);
    const controller = new NativeUiController({ sessionId: 's', cliSha256: NATIVE_UI_PINNED_SHA256, port: { request }, writeTerminal,
      isIdle: () => true, screen, onActiveChange, onRecovered, onSettled, readDiagnostics });
    const show = (text: string) => { screen.write(text); controller.observeTerminal(); };
    return { controller, request, writeTerminal, onActiveChange, onRecovered, onSettled, show };
  };

  it.each(['>', '❯'])('releases a commandless failure once the idle composer (%s) is back, not while a dialog is docked', async (pointer) => {
    const composer = `\x1b[2J\x1b[H${pointer}\r\n? for shortcuts`;
    const h = setup(); h.show(composer);
    await expect(h.controller.run('settings.permissionMode', async (tx) => {
      await tx.cyclePermissionMode!(() => true, () => false, { timeoutMs: 50, stableMs: 0 });
    })).rejects.toBeInstanceOf(NativeUiWaitTimeout);
    expect(h.writeTerminal).toHaveBeenCalledExactlyOnceWith('\x1b[Z'); expect(h.onSettled).toHaveBeenCalledOnce();
    h.show(docked); await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.controller.recoveryError()).toBeDefined(); expect(h.controller.active()).toBe(true);
    h.show(composer);
    await vi.waitFor(() => expect(h.controller.recoveryError()).toBeUndefined());
    expect(h.onRecovered).toHaveBeenCalledOnce(); expect(h.controller.active()).toBe(false);
    expect(h.onActiveChange.mock.calls.at(-1)).toEqual([false]);
    h.controller.close();
  });

  it('treats a bridge refusal before any dialog opened as no failure at all', async () => {
    const h = setup();
    h.request.mockRejectedValueOnce(new Error('Native transport: Native control requires an idle session without pending approval or attachments'));
    await expect(h.controller.run('settings.effort', async (tx) => tx.open('effort', '', () => true, { timeoutMs: 500 }))).rejects.toThrow('idle session');
    expect(h.controller.recoveryError()).toBeUndefined(); expect(h.controller.active()).toBe(false);
    expect(h.request).toHaveBeenCalledWith('command.run', { command: 'effort', args: '' }, { signal: expect.any(AbortSignal), timeoutMs: null });
    h.controller.close();
  });

  it('asks the bridge before releasing when a dialog command ended without a native answer', async () => {
    let modalActive = true;
    const h = setup(async () => ({ version: 1, modalActive, runningTurn: false, activeCount: 0, queuedCount: 0, entries: [], truncated: false }));
    h.show(composer);
    h.request.mockRejectedValueOnce(new Error('Native transport: request aborted'));
    await expect(h.controller.run('settings.effort', async (tx) => tx.open('effort', '', () => false, { timeoutMs: 200 }))).rejects.toThrow();
    h.show(composer); await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.controller.recoveryError()).toBeDefined();
    modalActive = false; h.show(composer);
    await vi.waitFor(() => expect(h.controller.recoveryError()).toBeUndefined());
    h.controller.close();
  });

  it('releases as soon as the dialog a failed control opened completes, e.g. after the user closed it', async () => {
    const h = setup(); let finish!: (value: unknown) => void;
    h.request.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const run = h.controller.run('settings.effort', async (tx) => {
      const opened = tx.open('effort', '', () => true, { stableMs: 0 });
      h.show(docked); await opened;
      throw new Error('layout not recognized');
    }, { cancelPanel: () => false });
    await expect(run).rejects.toThrow('layout not recognized');
    expect(h.controller.recoveryError()).toBeDefined();
    finish({});
    await vi.waitFor(() => expect(h.controller.recoveryError()).toBeUndefined());
    expect(h.writeTerminal).not.toHaveBeenCalled();
    h.controller.close();
  });
});
