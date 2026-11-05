import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatus, PlanUsage } from '@shared/types';
import { MOCK_PROFILES } from '../../src/renderer/mock/fixtures';
import { renderApp, type Rendered } from './helpers';

const profileId = 'profile-work';
const actionLabel = `Actions for “${MOCK_PROFILES[1]!.name}”`;
async function openAccounts(rendered: Rendered): Promise<void> {
  await rendered.user.click(within(screen.getByTestId('card-accounts')).getByRole('button'));
}
async function sourceDialog(rendered: Rendered): Promise<HTMLElement> {
  await rendered.user.click(screen.getByRole('button', { name: actionLabel }));
  await rendered.user.click(screen.getByRole('menuitem', { name: /Authentication source/ }));
  return screen.findByTestId('authentication-source-dialog');
}
async function selectEnvironment(rendered: Rendered, dialog: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Launch environment/ })).toBeEnabled());
  await rendered.user.click(within(dialog).getByRole('radio', { name: /Launch environment/ }));
  await rendered.user.click(within(dialog).getByRole('button', { name: 'Save' }));
  return screen.findByRole('alertdialog');
}

describe('explicit profile authentication source', () => {
  it('keeps CLI/config as default and inspects only names when the source view is explicitly opened', async () => {
    const inspect = vi.fn().mockResolvedValue({ available: true, variableNames: ['AWS_PROFILE', '', 'ANTHROPIC_API_KEY', 'INVALID=synthetic-secret'], value: 'synthetic-secret' });
    const rendered = await renderApp({}, (api) => { api.accounts.authenticationEnvironment = inspect; });
    const set = vi.spyOn(rendered.api.accounts, 'setAuthenticationSource');
    expect(inspect).not.toHaveBeenCalled(); await openAccounts(rendered); expect(inspect).not.toHaveBeenCalled();
    const dialog = await sourceDialog(rendered);
    expect(dialog.closest('[data-suppress-info-toasts]')).not.toBeNull();
    expect(dialog.querySelectorAll('.rd-auth-choice__text > .rd-field__hint')).toHaveLength(2);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole('radio', { name: /Saved CLI\/config/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Launch environment/ })).not.toBeChecked();
    expect(await within(dialog).findByText('ANTHROPIC_API_KEY')).toBeInTheDocument();
    expect(within(dialog).getByText('AWS_PROFILE')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('synthetic-secret');
    expect(JSON.stringify(rendered.controller.state)).not.toContain('ANTHROPIC_API_KEY');
    expect(set).not.toHaveBeenCalled();
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(document.body).not.toHaveTextContent('ANTHROPIC_API_KEY');
  });

  it('requires billing/account confirmation and clears only target status without triggering an auth or usage request', async () => {
    const rendered = await renderApp({}, (api) => { vi.spyOn(api.accounts, 'authenticationEnvironment').mockResolvedValue({ available: true, variableNames: ['ANTHROPIC_API_KEY'] }); });
    await waitFor(() => expect(rendered.controller.state.auth[profileId]).toBeDefined());
    const set = vi.spyOn(rendered.api.accounts, 'setAuthenticationSource'), status = vi.spyOn(rendered.api.accounts, 'status'), usage = vi.spyOn(rendered.api.usage, 'get');
    const before = rendered.controller.state.activeProfileId, otherStatus = rendered.controller.state.auth.default;
    await openAccounts(rendered); const dialog = await sourceDialog(rendered);
    let confirmation = await selectEnvironment(rendered, dialog);
    expect(confirmation).toHaveTextContent('different account'); expect(confirmation).toHaveTextContent('API or cloud charges');
    expect(set).not.toHaveBeenCalled();
    await rendered.user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(set).not.toHaveBeenCalled(); expect(rendered.controller.state.profiles.find((row) => row.id === profileId)?.authenticationSource).toBeUndefined();
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Save' })); confirmation = await screen.findByRole('alertdialog');
    status.mockClear(); usage.mockClear();
    await rendered.user.click(within(confirmation).getByRole('button', { name: 'Use launch environment' }));
    await waitFor(() => expect(screen.queryByTestId('authentication-source-dialog')).not.toBeInTheDocument());
    expect(set).toHaveBeenCalledExactlyOnceWith(profileId, 'launch-environment');
    expect(rendered.controller.state.profiles.find((row) => row.id === profileId)?.authenticationSource).toBe('launch-environment');
    expect(rendered.controller.state.activeProfileId).toBe(before); expect(rendered.controller.state.auth.default).toEqual(otherStatus);
    expect(rendered.controller.state.auth[profileId]).toBeUndefined(); expect(rendered.controller.state.usage[profileId]).toBeUndefined();
    expect(rendered.controller.state.plans[profileId]).toBeUndefined(); expect(rendered.controller.state.labels[profileId]).toBeUndefined();
    expect(status).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
    const saved = await sourceDialog(rendered);
    expect(within(saved).getByRole('radio', { name: /Launch environment/ })).toBeChecked();
    await rendered.user.click(within(saved).getByRole('radio', { name: /Saved CLI\/config/ }));
    await rendered.user.click(within(saved).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenLastCalledWith(profileId, 'cli-config'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(); expect(status).not.toHaveBeenCalled();
  });

  it('disables environment mode when no nonempty supported names exist', async () => {
    const rendered = await renderApp(); const set = vi.spyOn(rendered.api.accounts, 'setAuthenticationSource');
    await openAccounts(rendered); const dialog = await sourceDialog(rendered);
    expect(await within(dialog).findByTestId('authentication-environment-empty')).toHaveTextContent('Environment mode is unavailable');
    expect(within(dialog).getByRole('radio', { name: /Launch environment/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Saved CLI\/config/ })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled(); expect(set).not.toHaveBeenCalled();
  });

  it('keeps rejected source changes and inspection failures free of backend secrets', async () => {
    const rendered = await renderApp({}, (api) => { vi.spyOn(api.accounts, 'authenticationEnvironment').mockRejectedValueOnce(new Error('synthetic-secret')); });
    await openAccounts(rendered); let dialog = await sourceDialog(rendered);
    await waitFor(() => expect(dialog).toHaveTextContent('Could not inspect launch authentication variables.'));
    expect(within(dialog).getByRole('radio', { name: /Launch environment/ })).toBeDisabled();
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    vi.mocked(rendered.api.accounts.authenticationEnvironment).mockResolvedValueOnce({ available: true, variableNames: ['AWS_PROFILE'] });
    vi.spyOn(rendered.api.accounts, 'setAuthenticationSource').mockRejectedValueOnce(new Error('synthetic-secret'));
    dialog = await sourceDialog(rendered); const confirm = await selectEnvironment(rendered, dialog);
    await rendered.user.click(within(confirm).getByRole('button', { name: 'Use launch environment' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(rendered.controller.state.profiles.find((row) => row.id === profileId)?.authenticationSource).toBeUndefined();
    expect(JSON.stringify(rendered.controller.state)).not.toContain('synthetic-secret'); expect(document.body).not.toHaveTextContent('synthetic-secret');
  });

  it.each(['response', 'error'] as const)('ignores an old-source in-flight status %s after the selection changes', async (kind) => {
    const rendered = await renderApp(); await waitFor(() => expect(rendered.controller.state.auth[profileId]).toBeDefined());
    let resolve!: (status: AuthStatus) => void, reject!: (error: Error) => void;
    const pending = new Promise<AuthStatus>((yes, no) => { resolve = yes; reject = no; });
    vi.spyOn(rendered.api.accounts, 'status').mockReturnValueOnce(pending);
    let refresh!: Promise<void>; act(() => { refresh = rendered.controller.refreshStatus(profileId, true); });
    let changed!: Promise<boolean>; act(() => { changed = rendered.controller.setAuthenticationSource(profileId, 'launch-environment'); });
    const dialog = await screen.findByRole('alertdialog');
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Use launch environment' })); await changed;
    await act(async () => {
      if (kind === 'response') resolve({ profileId, loggedIn: true, authMethod: 'claude.ai', email: 'old-source@example.invalid', checkedAt: Date.now() });
      else reject(new Error('old-source secret'));
      await refresh;
    });
    expect(rendered.controller.state.auth[profileId]).toBeUndefined();
    expect(JSON.stringify(rendered.controller.state)).not.toContain('old-source');
  });

  it('cancels only the selected login and distinguishes no pending attempt using fixed notices', async () => {
    const rendered = await renderApp(); const cancel = vi.spyOn(rendered.api.accounts, 'cancelLogin').mockResolvedValueOnce({ ok: true, noPending: true, message: 'synthetic-secret' });
    const logout = vi.spyOn(rendered.api.accounts, 'logout'); await openAccounts(rendered);
    await rendered.user.click(screen.getByRole('button', { name: actionLabel }));
    await rendered.user.click(screen.getByRole('menuitem', { name: 'Cancel pending login' }));
    expect(cancel).toHaveBeenCalledExactlyOnceWith(profileId);
    expect(rendered.controller.state.toasts.at(-1)?.text).toBe('There is no pending login for this account.');
    cancel.mockResolvedValueOnce({ ok: true, noPending: false, message: 'synthetic-secret' });
    await act(async () => rendered.controller.cancelLogin(profileId));
    expect(rendered.controller.state.toasts.at(-1)?.text).toBe('The pending login for this account was cancelled.');
    cancel.mockRejectedValueOnce(new Error('synthetic-secret')); await act(async () => rendered.controller.cancelLogin(profileId));
    expect(rendered.controller.state.toasts.at(-1)?.text).toBe('Could not cancel the pending login for this account.');
    expect(logout).not.toHaveBeenCalled(); expect(JSON.stringify(rendered.controller.state)).not.toContain('synthetic-secret');
  });

  it.each(['response', 'error'] as const)('ignores an old-source pending usage push and %s without suppressing unrelated or fresh usage', async (kind) => {
    const rendered = await renderApp(); await waitFor(() => expect(rendered.controller.state.usage.default).toBeDefined());
    let resolve!: (usage: PlanUsage) => void, reject!: (error: Error) => void;
    const pending = new Promise<PlanUsage>((yes, no) => { resolve = yes; reject = no; });
    const get = vi.spyOn(rendered.api.usage, 'get').mockReturnValueOnce(pending);
    let refresh!: Promise<PlanUsage | null>; act(() => { refresh = rendered.controller.refreshUsage(profileId, true); });
    let changed!: Promise<boolean>; act(() => { changed = rendered.controller.setAuthenticationSource(profileId, 'launch-environment'); });
    const dialog = await screen.findByRole('alertdialog');
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Use launch environment' })); await changed;
    const stale: PlanUsage = { profileId, available: true, subscriptionType: 'old-source-plan', fetchedAt: Date.now() + 1000,
      windows: [{ id: 'five_hour', percent: 99, resetsAt: Date.now() + 60_000 }] };
    act(() => rendered.api.mock.emitEngine({ type: 'usage', usage: stale }));
    expect(rendered.controller.state.usage[profileId]).toBeUndefined(); expect(rendered.controller.state.labels[profileId]).toBeUndefined();
    act(() => rendered.api.mock.emitEngine({ type: 'usage', usage: { ...stale, profileId: 'default', subscriptionType: 'unrelated-plan' } }));
    expect(rendered.controller.state.usage.default?.subscriptionType).toBe('unrelated-plan');
    await act(async () => {
      if (kind === 'response') resolve(stale); else reject(new Error('old-source secret'));
      expect(await refresh).toBeNull();
    });
    expect(rendered.controller.state.usage[profileId]).toBeUndefined(); expect(JSON.stringify(rendered.controller.state)).not.toContain('old-source');
    const fresh: PlanUsage = { profileId, available: false, windows: [], fetchedAt: Date.now() + 2000 };
    get.mockResolvedValueOnce(fresh);
    await act(async () => { expect(await rendered.controller.refreshUsage(profileId, false)).toEqual(fresh); });
    expect(rendered.controller.state.usage[profileId]).toEqual(fresh);
    const live = { ...fresh, fetchedAt: fresh.fetchedAt + 1 };
    act(() => rendered.api.mock.emitEngine({ type: 'usage', usage: live }));
    expect(rendered.controller.state.usage[profileId]).toEqual(live);
  });
});
