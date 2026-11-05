import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContextUsage } from '../../src/shared/types';
import { renderApp, takeOverMain } from './helpers';

describe('context usage of open sessions', () => {
  it('asks again when an open session without a reading comes into view, and not when it has one', async () => {
    // The context ring once took about ten minutes to appear (main read it only after a turn).
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const handleId = await takeOverMain(rendered);
    const key = controller.currentView()!.key;
    expect(controller.currentView()?.context).toBeDefined();
    const refresh = vi.spyOn(api.engine, 'refreshContext');

    act(() => controller.navigate(null));
    act(() => controller.navigate(key));
    expect(refresh).not.toHaveBeenCalled();

    act(() => (controller as unknown as { patchView(key: string, patch: object): void }).patchView(key, { context: undefined }));
    act(() => controller.navigate(null));
    await act(async () => controller.navigate(key));
    expect(refresh).toHaveBeenCalledWith(handleId);
    expect(controller.currentView()?.context).toBeDefined();
  });

  it.each(['resolve', 'reject'] as const)('ignores an old handle context refresh %s after the view is reopened', async (outcome) => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const firstHandle = await takeOverMain(rendered);
    const key = controller.currentView()!.key;
    const full = controller.currentView()!.context!;
    let resolve!: (usage: ContextUsage) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<ContextUsage>((done, fail) => { resolve = done; reject = fail; });
    vi.spyOn(api.engine, 'refreshContext').mockReturnValueOnce(pending);
    let refresh!: Promise<void>;
    act(() => { refresh = controller.refreshContext(key); });

    await act(async () => controller.closeSession(key));
    await act(async () => controller.openEngine(key, true));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const nextHandle = controller.currentView()!.handleId!;
    expect(nextHandle).not.toBe(firstHandle);
    const fresh = { ...full, usedTokens: full.usedTokens + 1000, percent: 29 };
    act(() => api.mock.emitEngine({ type: 'context', handleId: nextHandle, usage: fresh }));

    await act(async () => {
      if (outcome === 'resolve') resolve({ ...full, percent: 97 });
      else reject(new Error('old handle context failure'));
      await refresh;
    });
    expect(controller.currentView()?.context).toEqual(fresh);
    expect(controller.state.toasts.some((toast) => toast.text === 'old handle context failure')).toBe(false);
  });
});

describe('context total from the latest reply', () => {
  it('shows the live total on the ring and the card, and says the categories are from the last full reading', async () => {
    const rendered = await renderApp();
    const { api, controller } = rendered;
    const handleId = await takeOverMain(rendered);
    const full = controller.currentView()!.context!;
    act(() => controller.setCard('context', true));
    await screen.findByTestId('context-breakdown');
    expect(screen.queryByTestId('context-live-note')).toBeNull();

    const usedTokens = full.usedTokens + 40_000;
    const percent = Math.round((usedTokens / full.maxTokens) * 100);
    act(() => api.mock.emitEngine({ type: 'context', handleId, usage: { ...full, usedTokens, percent, live: true } }));
    expect(await screen.findByTestId('context-live-note')).toHaveTextContent(
      'The total follows the latest reply; the categories are from the last full reading and update when the turn ends.',
    );
    expect(controller.currentView()?.context).toMatchObject({ usedTokens, percent, live: true });

    act(() => api.mock.emitEngine({ type: 'context', handleId, usage: full }));
    await waitFor(() => expect(screen.queryByTestId('context-live-note')).toBeNull());
  });
});

describe('Refresh context usage during a turn setting', () => {
  it('is off by default, opens sessions without it, and applies a saved change to open sessions at once', async () => {
    const rendered = await renderApp();
    const { api, controller, user } = rendered;
    const open = vi.spyOn(api.engine, 'open');
    const live = vi.spyOn(api.engine, 'setLiveContext');
    const handleId = await takeOverMain(rendered);
    expect(open.mock.calls[0]![0]).not.toHaveProperty('liveContext');

    act(() => controller.openSettings(true));
    const dialog = await screen.findByTestId('settings-dialog');
    const select = within(dialog).getByRole('combobox', { name: 'Refresh context usage during a turn' }) as HTMLSelectElement;
    expect(select.value).toBe('off');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', 'On']);
    await act(async () => controller.updateSettings({ liveContext: false }));
    expect(live).not.toHaveBeenCalled();

    await user.selectOptions(select, 'on');
    await waitFor(() => expect(live).toHaveBeenCalledWith(handleId, true));
    expect(controller.state.settings.liveContext).toBe(true);
    await user.selectOptions(select, 'off');
    await waitFor(() => expect(live).toHaveBeenLastCalledWith(handleId, false));
    expect(live).toHaveBeenCalledTimes(2);
  });

  it('opens with liveContext only when the saved setting is on, and brings a session that was opening up to date', async () => {
    const on = await renderApp({ settings: { liveContext: true, activeProfileId: 'default' } });
    const openOn = vi.spyOn(on.api.engine, 'open');
    await takeOverMain(on);
    expect(openOn.mock.calls[0]![0]).toMatchObject({ liveContext: true });

    const rendered = await renderApp();
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(api.engine, 'open').mockImplementationOnce(async (request) => {
      await gate;
      return open(request);
    });
    const live = vi.spyOn(api.engine, 'setLiveContext');
    let opened!: Promise<void>;
    act(() => {
      opened = controller.newSession('D:\\work\\fresh');
    });
    await act(async () => controller.updateSettings({ liveContext: true }));
    expect(live).not.toHaveBeenCalled();
    release();
    await act(async () => {
      await opened;
    });
    await waitFor(() => expect(live).toHaveBeenCalledWith(controller.currentView()!.handleId, true));
  });
});
