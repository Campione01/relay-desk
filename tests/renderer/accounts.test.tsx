import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SHARED_CONTEXT_ERROR_PREFIX, type Profile } from '@shared/types';
import { MOCK_PROFILES } from '../../src/renderer/mock/fixtures';
import { isManagedProfileDir } from '../../src/renderer/state/controller';
import { renderApp } from './helpers';

const CUSTOM: Profile = { id: 'custom', name: 'Custom folder', configDir: 'E:\\claude-accounts\\custom', createdAt: 0 };

describe('account login', () => {
  it('starts the official sign-in for the chosen account, whose menu holds exactly the account actions', async () => {
    const { api, controller, user } = await renderApp();
    const login = vi.spyOn(api.accounts, 'login').mockResolvedValue({ ok: true, message: '' });
    const external = vi.spyOn(api.app, 'openExternal');
    await user.click(within(screen.getByTestId('card-accounts')).getByRole('button'));
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(login).toHaveBeenCalledWith('profile-work', undefined);
    expect(controller.state.toasts.at(-1)?.text).toBe('The official Claude Code sign-in opened in its own console window. Complete it there; this account refreshes when that window closes.');
    await user.click(screen.getByRole('button', { name: `Actions for “${MOCK_PROFILES[1]!.name}”` }));
    const menu = await screen.findByRole('menu', { name: `Actions for “${MOCK_PROFILES[1]!.name}”` });
    const labels = within(menu).getAllByRole('menuitem').map((item) => item.querySelector('.rd-menu__label')?.firstChild?.textContent);
    expect(labels).toEqual(['Make active', 'Authentication source', 'Log in', 'Cancel pending login', 'Log out', 'Check status again', 'Rename', 'Remove']);
    expect(within(screen.getByTestId('card-accounts')).queryByRole('textbox')).not.toBeInTheDocument();
    expect(external).not.toHaveBeenCalled();
  });

  it('shows no failure for a login cancelled while it started; a real failure still shows', async () => {
    const { api, controller } = await renderApp();
    const login = vi.spyOn(api.accounts, 'login').mockResolvedValue({ ok: false, cancelled: true, message: 'Login canceled.' });
    const before = controller.state.toasts.length;
    await act(async () => controller.login('profile-work'));
    expect(controller.state.toasts).toHaveLength(before);
    login.mockResolvedValue({ ok: false, message: 'Could not open the login window: Could not start the login console.' });
    await act(async () => controller.login('profile-work'));
    expect(controller.state.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Could not open the login window: Could not start the login console.' });
  });
});

describe('shared Code context controls (EC-2)', () => {
  it('independent accounts get a sharing switch; the default account does not', async () => {
    const { api, user, controller } = await renderApp({ settings: { activeProfileId: 'profile-work' } });
    const set = vi.spyOn(api.accounts, 'setSharedCodeContext');
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    const toggle = within(dialog).getByRole('switch', { name: 'Share global instructions, rules and skills' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(set).toHaveBeenCalledWith('profile-work', false);
    await waitFor(() => expect(within(screen.getByTestId('code-context-dialog')).getByRole('switch')).not.toBeChecked());
    expect(controller.state.profiles.find((p) => p.id === 'profile-work')?.sharedCodeContext).toBe(false);

    await act(async () => controller.setActiveProfile('default'));
    await waitFor(() => expect(controller.state.codeContext?.profileId).toBe('default'));
    expect(within(screen.getByTestId('code-context-dialog')).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('stop sharing asks first and then lists what Relay kept', async () => {
    const { api, user, controller } = await renderApp({ settings: { activeProfileId: 'profile-work' } });
    const real = api.accounts.unshareCodeContext.bind(api.accounts);
    const unshare = vi.spyOn(api.accounts, 'unshareCodeContext');
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(unshare).not.toHaveBeenCalled();

    unshare.mockImplementationOnce(async (id) => ({ ...(await real(id)), warnings: ['Kept C:\\synthetic\\work\\CLAUDE.md: it was not created by Relay Desk.'] }));
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop sharing' }));
    const result = await screen.findByTestId('unshare-result');
    expect(unshare).toHaveBeenCalledWith('profile-work');
    expect(result).toHaveTextContent('Sharing removed.');
    expect(result).toHaveTextContent('Kept:');
    expect(within(result).getByRole('listitem')).toHaveTextContent('Kept C:\\synthetic\\work\\CLAUDE.md: it was not created by Relay Desk.');
    expect(controller.state.profiles.find((p) => p.id === 'profile-work')?.sharedCodeContext).toBe(false);
  });

  it('a shared-context failure on open offers one open without shared settings', async () => {
    const { api, controller } = await renderApp();
    const open = vi.spyOn(api.engine, 'open')
      .mockRejectedValueOnce(new Error(`Error invoking remote method 'relay:engine:open': Error: ${SHARED_CONTEXT_ERROR_PREFIX}conflict at C:\\synthetic\\work\\rules`));
    await act(async () => controller.newSession('D:\\demos\\demo-app', 'profile-work'));
    const key = controller.state.currentKey!;
    const error = controller.view(key)!.errors[0]!;
    expect(error).toMatchObject({ retry: { kind: 'open', skipSharedContext: true }, retryLabel: 'Open without shared settings this time' });
    expect(screen.getByTestId('inline-error')).toHaveTextContent('conflict at C:\\synthetic\\work\\rules');
    expect(within(screen.getByTestId('inline-error')).getByRole('button', { name: 'Open without shared settings this time' })).toBeInTheDocument();
    await act(async () => controller.retryError(key, error.id));
    expect(open).toHaveBeenLastCalledWith({ profileId: 'profile-work', cwd: 'D:\\demos\\demo-app', skipSharedContext: true, startupRequestId: expect.any(String) });
    await waitFor(() => expect(controller.view(key)?.engineState).toBe('idle'));

    open.mockRejectedValueOnce(new Error('Folder not found: D:\\gone'));
    await act(async () => controller.newSession('D:\\gone'));
    expect(controller.currentView()!.errors[0]).toMatchObject({ retry: { kind: 'open' } });
    expect(controller.currentView()!.errors[0]!.retryLabel).toBeUndefined();
  });
});

describe('account removal (RQ-11)', () => {
  it('a folder the user chose is never offered for deletion', async () => {
    const { api, user, controller } = await renderApp({ profiles: [...MOCK_PROFILES, CUSTOM] });
    const remove = vi.spyOn(api.accounts, 'remove');
    let action!: Promise<void>;
    act(() => { action = controller.removeProfile('custom'); });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('Its config folder was chosen by you, so Relay Desk keeps it: E:\\claude-accounts\\custom');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await action;
    expect(remove).toHaveBeenCalledWith('custom', { deleteDirectory: false });
  });

  it('only <userData>\\profiles\\<id> shaped folders count as app-managed', () => {
    expect(isManagedProfileDir(MOCK_PROFILES[1]!)).toBe(true);
    expect(isManagedProfileDir({ id: 'x', configDir: 'C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\Profiles\\X\\' })).toBe(true);
    expect(isManagedProfileDir({ id: 'x', configDir: 'D:\\accounts\\x' })).toBe(false);
    expect(isManagedProfileDir({ id: 'x', configDir: 'D:\\profiles\\y' })).toBe(false);
    expect(isManagedProfileDir({ id: 'default', configDir: null })).toBe(false);
  });
});
