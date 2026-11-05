import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { EngineHandle } from '@shared/types';
import { renderApp } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function starting(language: 'en' | 'zh-TW' = 'en') {
  const pending = deferred<EngineHandle>();
  const app = await renderApp({ settings: { language } }, (api) => {
    vi.spyOn(api.engine, 'open').mockReturnValueOnce(pending.promise);
    vi.spyOn(api.engine, 'close').mockResolvedValue();
    vi.spyOn(api.engine, 'startupInput');
    vi.spyOn(api.engine, 'cancelStartup');
    vi.spyOn(api.engine, 'send');
  });
  let opening!: Promise<void>;
  act(() => { opening = app.controller.newSession('D:\\startup-fixture'); });
  const key = app.controller.state.currentKey!;
  const requestId = app.controller.view(key)!.openingRequestId!;
  const handle: EngineHandle = { handleId: 'native-fixture-handle', profileId: 'default', cwd: 'D:\\startup-fixture' };
  const emit = (revision: number, text = '1. No\n2. Yes, accept', phase: 'waiting' | 'ready' | 'closed' = 'waiting') => {
    act(() => app.api.mock.emitEngine({ type: 'startup', requestId, handleId: handle.handleId, revision, text, phase }));
  };
  return { ...app, pending, opening, key, requestId, handle, emit };
}

describe('native startup screen', () => {
  it('follows the current terminal prompt on revision and resize without sending a key', async () => {
    const resized: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized.push(callback); }
      observe() {}
      disconnect() {}
    });
    try {
      const app = await starting();
      app.emit(1);
      const region = screen.getByRole('region', { name: 'Native startup screen' });
      Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 900 });
      app.emit(2, 'Long warning\n> 1. No\n  2. Yes, accept');
      expect(region.scrollTop).toBe(900);
      region.scrollTop = 0;
      act(() => resized.at(-1)!());
      expect(region.scrollTop).toBe(900);
      const footer = screen.getByTestId('native-startup-footer');
      expect(within(footer).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
      expect(within(footer).getByRole('button', { name: 'Cancel startup' })).toBeInTheDocument();
      expect(region.contains(footer)).toBe(false);
      expect(app.api.engine.startupInput).not.toHaveBeenCalled();
      expect(app.api.engine.send).not.toHaveBeenCalled();
      await act(async () => { await app.controller.closeSession(app.key); app.pending.reject(new Error('cancelled')); await app.opening; });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses one startup scroll region and keeps history mounted while startup takes its space', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const css = readFileSync('src/renderer/styles/flows.css', 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    try {
      const app = await starting();
      app.emit(1);
      const history = screen.getByTestId('transcript-scroller');
      const card = screen.getByTestId('native-startup');
      const region = screen.getByRole('region', { name: 'Native startup screen' });
      expect(screen.getByTestId('session-pane')).toHaveAttribute('data-opening', 'true');
      expect(getComputedStyle(history).display).toBe('none');
      expect(getComputedStyle(card).overflow).toBe('hidden');
      expect(getComputedStyle(card).flexGrow).toBe('1');
      expect(getComputedStyle(region).overflow).toBe('auto');
      expect(getComputedStyle(region).flexGrow).toBe('1');
      expect(css).toMatch(/\.rd-startup__screen:focus-visible\s*\{\s*outline: 2px solid var\(--rd-focus-ring\)/);
      await act(async () => { await app.controller.closeSession(app.key); app.pending.reject(new Error('cancelled')); await app.opening; });
      expect(screen.getByTestId('transcript-scroller')).toBe(history);
      expect(getComputedStyle(history).display).not.toBe('none');
      expect(screen.getByTestId('session-pane')).toHaveAttribute('data-opening', 'false');
    } finally {
      style.remove();
    }
  });

  it('shows Starting before output, then plain native text; only explicit keys reach the exact request and revision', async () => {
    const app = await starting();
    const { api, user, controller, key, requestId, handle, emit } = app;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(screen.getByTestId('native-startup')).toHaveTextContent('Starting');
    expect(within(screen.getByTestId('native-startup')).queryByRole('group')).toBeNull();
    const text = '<img src=x onerror=alert(1)>\nBypass permissions warning\n1. No\n2. Yes, accept';
    emit(1, text);
    const region = screen.getByRole('region', { name: 'Native startup screen' });
    expect(region.textContent).toBe(text);
    expect(region.querySelector('img')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(api.engine.startupInput).not.toHaveBeenCalled();
    expect(api.engine.send).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.view(key)?.items)).not.toContain('Bypass permissions');
    expect(JSON.stringify(window.localStorage)).not.toContain(requestId);
    expect(JSON.stringify(window.localStorage)).not.toContain('Bypass permissions');

    const input = deferred<void>();
    vi.mocked(api.engine.startupInput).mockReturnValueOnce(input.promise);
    await user.click(screen.getByRole('button', { name: 'Down' }));
    expect(api.engine.startupInput).toHaveBeenCalledExactlyOnceWith(handle.handleId, requestId, { revision: 1, key: 'down' });
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(api.engine.startupInput).toHaveBeenCalledTimes(1);
    emit(2, '1. No\n> 2. Yes, accept');
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
    await act(async () => input.resolve());
    fireEvent.keyDown(region, { key: 'a' });
    fireEvent.keyDown(region, { key: 'Enter', repeat: true });
    expect(api.engine.startupInput).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.keyDown(region, { key: 'Enter' }));
    expect(api.engine.startupInput).toHaveBeenLastCalledWith(handle.handleId, requestId, { revision: 2, key: 'enter' });
    expect(api.engine.send).not.toHaveBeenCalled();
    await act(async () => { await controller.closeSession(key); app.pending.reject(new Error('cancelled')); await app.opening; });
  });

  it('can cancel during preparation and closes a late owned handle without adopting or sending', async () => {
    const app = await starting();
    await app.user.click(screen.getByRole('button', { name: 'Cancel startup' }));
    expect(app.api.engine.cancelStartup).toHaveBeenCalledExactlyOnceWith(app.requestId);
    expect(app.controller.view(app.key)).toMatchObject({ opening: false, engineState: 'closed' });
    expect(app.controller.view(app.key)?.openingRequestId).toBeUndefined();
    app.emit(1);
    expect(screen.queryByTestId('native-startup')).toBeNull();
    await act(async () => { app.pending.resolve(app.handle); await app.opening; });
    expect(app.api.engine.close).toHaveBeenCalledExactlyOnceWith(app.handle.handleId);
    expect(app.controller.view(app.key)?.handleId).toBeUndefined();
    expect(app.controller.state.handleToKey[app.handle.handleId]).toBeUndefined();
    expect(app.api.engine.send).not.toHaveBeenCalled();
  });

  it('does not close another view writer returned after cancellation', async () => {
    const app = await starting();
    await act(async () => app.controller.newSession('D:\\other-writer'));
    const other = app.controller.currentView()!;
    await waitFor(() => expect(app.controller.view(other.key)?.engineState).toBe('idle'));
    await act(async () => app.controller.closeSession(app.key));
    await act(async () => {
      app.pending.resolve({ handleId: other.handleId!, profileId: other.profileId, cwd: other.cwd, sessionId: other.sessionId });
      await app.opening;
    });
    expect(app.api.engine.close).not.toHaveBeenCalled();
    expect(app.controller.view(other.key)?.handleId).toBe(other.handleId);
  });

  it('reopens failures with a fresh ID and ignores stale events, revisions and callbacks', async () => {
    const app = await starting();
    app.emit(4, 'Current screen');
    app.emit(3, 'Stale screen');
    expect(app.controller.view(app.key)?.startup?.text).toBe('Current screen');
    await act(async () => app.controller.startupInput(app.key, app.requestId, { revision: 3, key: 'enter' }));
    expect(app.api.engine.startupInput).not.toHaveBeenCalled();
    await act(async () => { app.pending.reject(new Error('Native startup timed out')); await app.opening; });
    expect(app.controller.view(app.key)?.startup).toBeUndefined();
    expect(screen.getByText('Native startup timed out')).toBeInTheDocument();
    const retry = deferred<EngineHandle>();
    vi.mocked(app.api.engine.open).mockReturnValueOnce(retry.promise);
    await app.user.click(screen.getByRole('button', { name: 'Reopen' }));
    const requestId = app.controller.view(app.key)!.openingRequestId!;
    expect(requestId).not.toBe(app.requestId);
    app.emit(999, 'Late failed screen');
    act(() => app.api.mock.emitEngine({ type: 'error', handleId: app.handle.handleId, message: 'Late failure', fatal: true }));
    expect(app.controller.view(app.key)?.startup).toBeUndefined();
    expect(app.controller.view(app.key)?.errors).toEqual([]);
    const handleId = 'native-retry';
    act(() => app.api.mock.emitEngine({ type: 'startup', requestId, handleId, revision: 1, text: 'Retry menu', phase: 'waiting' }));
    const input = deferred<void>();
    vi.mocked(app.api.engine.startupInput).mockReturnValueOnce(input.promise);
    await app.user.click(screen.getByRole('button', { name: 'Enter' }));
    act(() => app.api.mock.emitEngine({ type: 'startup', requestId, handleId, revision: 2, text: '', phase: 'ready' }));
    act(() => app.api.mock.emitEngine({ type: 'startup', requestId, handleId, revision: 3, text: 'Too late', phase: 'waiting' }));
    await act(async () => input.reject(new Error('Stale input failure')));
    await act(async () => app.controller.startupInput(app.key, requestId, { revision: 3, key: 'enter' }));
    expect(app.controller.view(app.key)?.startup).toBeUndefined();
    expect(app.api.engine.startupInput).toHaveBeenCalledTimes(1);
    await act(async () => { retry.resolve({ ...app.handle, handleId }); await retry.promise; });
    expect(app.controller.view(app.key)?.handleId).toBe(handleId);
    expect(app.controller.view(app.key)?.errors).toEqual([]);
  });

  it('a cancelled open cannot overwrite or close a newer attempt in the same view', async () => {
    const app = await starting();
    app.emit(1);
    await act(async () => app.controller.closeSession(app.key));
    const retry = deferred<EngineHandle>();
    vi.mocked(app.api.engine.open).mockReturnValueOnce(retry.promise);
    let reopened!: Promise<boolean>;
    act(() => { reopened = app.controller.openEngine(app.key, false); });
    const requestId = app.controller.view(app.key)!.openingRequestId!;
    await act(async () => { app.pending.resolve(app.handle); await app.opening; });
    expect(app.controller.view(app.key)?.openingRequestId).toBe(requestId);
    expect(app.api.engine.close).toHaveBeenCalledExactlyOnceWith(app.handle.handleId);
    await act(async () => { retry.resolve({ ...app.handle, handleId: 'retry-handle' }); await reopened; });
    expect(app.controller.view(app.key)?.handleId).toBe('retry-handle');
  });

  it('bounds transient text and orphan buffers and retires them on failure', async () => {
    const app = await starting();
    app.emit(1, 'x'.repeat(100_000));
    expect(app.controller.view(app.key)?.startup?.text).toHaveLength(32_768);
    const internals = app.controller as unknown as { buffered: Map<string, EngineEvent[]>; openingAttempts: Map<string, unknown> };
    act(() => {
      for (let h = 0; h < 40; h += 1) {
        for (let i = 0; i < 510; i += 1) app.api.mock.emitEngine({ type: 'state', handleId: `orphan-${h}`, state: 'starting' });
      }
    });
    expect(internals.buffered.size).toBe(32);
    expect([...internals.buffered.values()].every((events) => events.length <= 500)).toBe(true);
    await act(async () => { app.pending.reject(new Error('failed')); await app.opening; });
    expect(internals.buffered.size).toBe(0);
    expect(internals.openingAttempts.size).toBe(0);
    act(() => app.api.mock.emitEngine({ type: 'state', handleId: 'late-orphan', state: 'starting' }));
    expect(internals.buffered.size).toBe(0);
  });

  it('supports Traditional Chinese labels and closes the input gate on a closed event', async () => {
    const app = await starting('zh-TW');
    app.emit(1, 'Trust this folder?');
    expect(screen.getByRole('region', { name: '原生啟動畫面' })).toHaveTextContent('Trust this folder?');
    expect(screen.getByRole('button', { name: '取消啟動' })).toBeInTheDocument();
    app.emit(1, '', 'closed');
    app.emit(3, 'Late screen');
    expect(app.controller.view(app.key)?.startup).toBeUndefined();
    await act(async () => app.controller.startupInput(app.key, app.requestId, { revision: 3, key: 'enter' }));
    expect(app.api.engine.startupInput).not.toHaveBeenCalled();
    await act(async () => { app.pending.reject(new Error('closed')); await app.opening; });
  });

  it('preserves a pending user draft without sending it if startup is cancelled', async () => {
    const pending = deferred<EngineHandle>();
    const { api, controller } = await renderApp({}, (mock) => {
      vi.spyOn(mock.engine, 'open').mockReturnValue(pending.promise);
      vi.spyOn(mock.engine, 'close').mockResolvedValue();
      vi.spyOn(mock.engine, 'send');
    });
    await act(async () => controller.newSession('D:\\startup-fixture', 'default', { launch: { cwd: 'D:\\startup-fixture' } }));
    const key = controller.state.currentKey!;
    let sending!: Promise<boolean>;
    act(() => { controller.setDraft(key, 'Keep this draft'); sending = controller.send(key, 'Keep this draft'); });
    await act(async () => controller.closeSession(key));
    let sent = true;
    await act(async () => {
      pending.resolve({ handleId: 'cancelled-send', profileId: 'default', cwd: 'D:\\startup-fixture' });
      sent = await sending;
    });
    expect(sent).toBe(false);
    expect(api.engine.send).not.toHaveBeenCalled();
    expect(controller.state.drafts[key]).toBe('Keep this draft');
    expect(controller.view(key)?.items).toEqual([]);
  });

  it('replays normal pre-open events on success, without retaining the startup screen', async () => {
    const app = await starting();
    app.emit(1);
    act(() => {
      app.api.mock.emitEngine({ type: 'init', handleId: app.handle.handleId, sessionId: 'new-session', cwd: app.handle.cwd,
        model: 'opus', slashCommands: [], tools: [] });
      app.api.mock.emitEngine({ type: 'state', handleId: app.handle.handleId, state: 'idle' });
    });
    app.emit(1, '', 'ready');
    await act(async () => { app.pending.resolve(app.handle); await app.opening; });
    expect(app.controller.view(app.key)).toMatchObject({ opening: false, engineState: 'idle', sessionId: 'new-session' });
    expect(app.controller.view(app.key)?.startup).toBeUndefined();
    expect(app.controller.view(app.key)?.openingRequestId).toBeUndefined();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    app.emit(2, 'Late ready screen');
    expect(screen.queryByTestId('native-startup')).toBeNull();
  });
});
