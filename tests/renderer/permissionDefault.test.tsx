import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle, OpenSessionRequest } from '@shared/types';
import type { MockRelayApi } from '../../src/renderer/mock/api';
import { createView } from '../../src/renderer/state/sessionReducer';
import { MAIN_SESSION_ID, renderApp, sidebar } from './helpers';

const BYPASS = { defaultPermissionMode: 'bypassPermissions' as const };
const LAUNCH = { action: 'resume' as const, sessionId: MAIN_SESSION_ID, cwd: 'D:\\demos\\relay-desk', profileId: 'default' };

const modeButton = (name: string | RegExp): HTMLElement => within(screen.getByTestId('prompt-footer')).getByRole('button', { name });

/** Holds engine.open until release() so the footer can be checked while the engine is still opening. */
function holdOpen(api: MockRelayApi) {
  const original = api.engine.open.bind(api.engine);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const open = vi.spyOn(api.engine, 'open').mockImplementation(async (request: OpenSessionRequest): Promise<EngineHandle> => {
    await gate;
    return original(request);
  });
  return { open, release };
}

describe('Settings default permission mode (R4-mode)', () => {
  it('a new session from the folder picker shows the default while opening and asks the engine for it', async () => {
    const { api, user, controller } = await renderApp({ settings: BYPASS });
    const { open, release } = holdOpen(api);
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(controller.currentView()?.handleId).toBeUndefined();
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
    expect(open.mock.calls[0]![0]).toMatchObject({ cwd: 'D:\\demos\\demo-app', permissionMode: 'bypassPermissions' });
    release();
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
  });

  it('a listed session shows the pending default read-only and resumes with it when the user sends', async () => {
    const { api, user, controller } = await renderApp({ settings: BYPASS });
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
    await user.click(modeButton('Bypass permissions'));
    const menu = await screen.findByRole('menu', { name: 'Permission mode' });
    expect(within(menu).getByRole('menuitemradio', { name: /Bypass permissions/ })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go on{Enter}');
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, permissionMode: 'bypassPermissions' });
    await waitFor(() => expect(controller.currentView()?.engineState).not.toBe('none'));
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
  });

  it('a desktop-mod resume launch takes over with the default', async () => {
    const { api, user, controller } = await renderApp({ settings: BYPASS, launchRequest: LAUNCH });
    const open = vi.spyOn(api.engine, 'open');
    const dialog = await screen.findByTestId('takeover-dialog');
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    expect(open.mock.calls[0]![0]).toEqual({
      profileId: 'default',
      cwd: 'D:\\demos\\relay-desk',
      resumeSessionId: MAIN_SESSION_ID,
      permissionMode: 'bypassPermissions',
      startupRequestId: expect.any(String),
    });
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
  });

  it('a mode the CLI reported is shown live but the next open asks for the Settings default again', async () => {
    const { api, controller } = await renderApp({ settings: BYPASS });
    const open = vi.spyOn(api.engine, 'open');
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    act(() => controller.openSummary(summary));
    const key = controller.state.currentKey!;
    const took = controller.takeOver(key);
    await waitFor(() => expect(controller.state.takeover).not.toBeNull());
    act(() => controller.confirmTakeover());
    await act(async () => { await took; });
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));
    const handleId = controller.view(key)!.handleId!;
    act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: MAIN_SESSION_ID, model: 'opus', permissionMode: 'plan', slashCommands: [], tools: [], cwd: summary.cwd }));
    expect(modeButton('Plan')).toBeInTheDocument();
    await act(async () => controller.closeSession(key));
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('closed'));
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
    await act(async () => { await controller.openEngine(key, true); });
    expect(open).toHaveBeenCalledTimes(2);
    for (const [request] of open.mock.calls) expect(request.permissionMode).toBe('bypassPermissions');
  });

  it('a mode picked in the view wins over the default, before and after the open', async () => {
    const { api, user, controller } = await renderApp({ settings: BYPASS });
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    await user.click(modeButton('Bypass permissions'));
    await user.click(await screen.findByRole('menuitemradio', { name: /Accept edits/ }));
    expect(modeButton('Accept edits')).toBeInTheDocument();
    const key = controller.state.currentKey!;
    const took = controller.takeOver(key);
    await waitFor(() => expect(controller.state.takeover).not.toBeNull());
    act(() => controller.confirmTakeover());
    await act(async () => { await took; });
    expect(open.mock.calls[0]![0]).toMatchObject({ permissionMode: 'acceptEdits' });
  });

  it('changing the Settings default reaches a view that has not opened yet', async () => {
    const { api, user, controller } = await renderApp({ settings: BYPASS, launchRequest: { action: 'new', cwd: 'D:\\work\\linked' } });
    const open = vi.spyOn(api.engine, 'open');
    await screen.findByTestId('launch-note');
    expect(modeButton('Bypass permissions')).toBeInTheDocument();
    await act(async () => controller.updateSettings({ defaultPermissionMode: 'plan' }));
    expect(modeButton('Plan')).toBeInTheDocument();
    await act(async () => controller.updateSettings({ defaultPermissionMode: undefined }));
    expect(modeButton('Settings default')).toBeInTheDocument();
    await act(async () => controller.updateSettings({ defaultPermissionMode: 'acceptEdits' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'start{Enter}');
    await waitFor(() => expect(open).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\work\\linked', permissionMode: 'acceptEdits', startupRequestId: expect.any(String) }));
  });

  it('a side chat opens its unsaved fork with the default too', async () => {
    const { api, controller } = await renderApp({ settings: BYPASS });
    const open = vi.spyOn(api.engine, 'open');
    const summary = controller.state.sessions.find((s) => s.sessionId === MAIN_SESSION_ID)!;
    const view = createView({ key: 'side-1', profileId: 'default', sessionId: MAIN_SESSION_ID, cwd: summary.cwd, title: 'Side chat', confirmed: true, sideChatOf: 's:x' });
    act(() => controller.store.set((state) => ({ ...state, views: { ...state.views, [view.key]: view } })));
    await act(async () => { await controller.openEngine('side-1', true); });
    expect(open.mock.calls[0]![0]).toMatchObject({ forkSession: true, ephemeral: true, permissionMode: 'bypassPermissions' });
  });

  it('without a Relay default nothing is requested and the picker says the settings decide', async () => {
    const { api, user, controller } = await renderApp();
    const open = vi.spyOn(api.engine, 'open');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    expect(open.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
    expect(modeButton('Settings default')).toBeInTheDocument();
  });
});
