import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_SESSION_ID, renderApp, sidebar } from './helpers';

const LAUNCH = { action: 'resume' as const, sessionId: MAIN_SESSION_ID, cwd: 'D:\\demos\\relay-desk', profileId: 'default' };

describe('take-over flow', () => {
  it('a launch request asks first, resumes only after the confirmation, and shows the banner', async () => {
    const { api, user, controller } = await renderApp({ launchRequest: LAUNCH });
    const open = vi.spyOn(api.engine, 'open');
    const dialog = await screen.findByRole('alertdialog', { name: 'Take over this session in Relay Desk?' });
    expect(within(dialog).getByText('Do not type in this session in the desktop until you press “Hand back to desktop”.')).toBeInTheDocument();
    expect(within(dialog).getByText('Relay Desk packaging plan')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByText('Turn every official desktop and CLI hand-off command into a button, and keep the common replies.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]![0]).toEqual({ profileId: 'default', cwd: 'D:\\demos\\relay-desk', resumeSessionId: MAIN_SESSION_ID, startupRequestId: expect.any(String) });
    expect(await screen.findByTestId('takeover-banner')).toHaveTextContent('Relay Desk is running this session');
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
  });

  it('hand back confirms, closes the Relay handle through toDesktop and shows the result', async () => {
    const { api, user, controller } = await renderApp({ launchRequest: LAUNCH });
    const toDesktop = vi.spyOn(api.handoff, 'toDesktop');
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const handleId = controller.currentView()!.handleId!;

    await user.click(within(await screen.findByTestId('takeover-banner')).getByRole('button', { name: /Hand back to desktop/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Hand back to the desktop?' });
    expect(toDesktop).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Hand back to desktop' }));
    await waitFor(() =>
      expect(toDesktop).toHaveBeenCalledWith({ profileId: 'default', sessionId: MAIN_SESSION_ID, cwd: 'D:\\demos\\relay-desk', handleId }),
    );
    expect(await screen.findByTestId('handoff-result')).toHaveTextContent('Handed back · mock: handed back to the desktop');
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
    expect(controller.currentView()?.handleId).toBeUndefined();
    expect(screen.getByTestId('readonly-note')).toHaveTextContent('Handed back to the desktop.');
  });

  it('any confirmed take-over of a listed session shows the banner; Relay’s own new session never does', async () => {
    const { user, controller } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await user.click(within(await screen.findByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    expect(await screen.findByTestId('takeover-banner')).toBeInTheDocument();
    await act(async () => controller.newSession('D:\\demos\\demo-app'));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
  });

  it('"Only view" keeps the session read-only', async () => {
    const { api, user } = await renderApp({ launchRequest: LAUNCH });
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Only view' }));
    expect(screen.queryByTestId('takeover-dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('readonly-note')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it('a launch request pushed while running opens the same confirmation', async () => {
    const { api } = await renderApp();
    act(() => api.mock.pushLaunchRequest(LAUNCH));
    expect(await screen.findByTestId('takeover-dialog')).toBeInTheDocument();
  });

  it('sending from a read-only session asks for the take-over first and sends after it', async () => {
    const { api, user } = await renderApp();
    const open = vi.spyOn(api.engine, 'open');
    const send = vi.spyOn(api.engine, 'send');
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'pick it up{Enter}');
    const dialog = await screen.findByTestId('takeover-dialog');
    expect(within(dialog).getByText('pick it up')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.stringMatching(/^mock-handle-/), 'pick it up', undefined));
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID });
  });
});

describe('launch links (AS-2)', () => {
  it('a new-session link waits for the first send and names the folder and the account it switched to', async () => {
    let open!: ReturnType<typeof vi.spyOn>;
    const { user, controller } = await renderApp(
      { launchRequest: { action: 'new', cwd: 'D:\\work\\linked', profileId: 'profile-work' } },
      (api) => { open = vi.spyOn(api.engine, 'open'); },
    );
    const note = await screen.findByTestId('launch-note');
    expect(note).toHaveTextContent('Opened from a link with the account “Work account”: a new session in D:\\work\\linked. Nothing runs until you send the first message.');
    expect(controller.state.activeProfileId).toBe('profile-work');
    expect(controller.currentView()).toMatchObject({ engineState: 'none', isNew: true, cwd: 'D:\\work\\linked' });
    expect(open).not.toHaveBeenCalled();
    expect(controller.state.settings.recentFolders).not.toContain('D:\\work\\linked');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'start here{Enter}');
    await waitFor(() => expect(open).toHaveBeenCalledWith({ profileId: 'profile-work', cwd: 'D:\\work\\linked', startupRequestId: expect.any(String) }));
    await waitFor(() => expect(screen.queryByTestId('launch-note')).not.toBeInTheDocument());
    expect(controller.state.settings.recentFolders).toContain('D:\\work\\linked');
  });

  it('a new-session link in the current account names only the folder', async () => {
    await renderApp({ launchRequest: { action: 'open', cwd: 'D:\\work\\linked' } });
    expect(await screen.findByTestId('launch-note')).toHaveTextContent('Opened from a link: a new session in D:\\work\\linked.');
  });

  it('a resume link keeps the recorded folder unless the user picks the link’s different one', async () => {
    const elsewhere = { ...LAUNCH, cwd: 'D:\\elsewhere' };
    const first = await renderApp({ launchRequest: elsewhere });
    const ask = await screen.findByRole('alertdialog', { name: 'Use the folder from the link?' });
    expect(ask).toHaveTextContent('D:\\demos\\relay-desk');
    expect(ask).toHaveTextContent('D:\\elsewhere');
    expect(screen.queryByTestId('takeover-dialog')).not.toBeInTheDocument();
    await first.user.click(within(ask).getByRole('button', { name: 'Keep the recorded folder' }));
    const open = vi.spyOn(first.api.engine, 'open');
    await first.user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\demos\\relay-desk', resumeSessionId: MAIN_SESSION_ID, startupRequestId: expect.any(String) }));
    cleanup();

    const second = await renderApp({ launchRequest: elsewhere });
    await second.user.click(within(await screen.findByRole('alertdialog', { name: 'Use the folder from the link?' })).getByRole('button', { name: 'Use the link’s folder' }));
    const reopen = vi.spyOn(second.api.engine, 'open');
    await second.user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\elsewhere', resumeSessionId: MAIN_SESSION_ID, startupRequestId: expect.any(String) }));
  });
});
