import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { contextLegend } from '../../src/renderer/components/panel/Cards';
import { renderApp, sidebar, takeOverMain } from './helpers';

describe('right panel', () => {
  it('context breakdown classifies rows on kind, never on the name', () => {
    const { main, deferred } = contextLegend({
      usedTokens: 10,
      maxTokens: 100,
      percent: 10,
      categories: [
        { name: 'Free space', tokens: 5, kind: 'used' },
        { name: 'Messages', tokens: 3, kind: 'free' },
        { name: 'Buffer', tokens: 2, kind: 'buffer', color: '#123456' },
        { name: 'Later', tokens: 9, kind: 'deferred' },
      ],
    });
    expect(main.map((r) => [r.name, r.kind, r.color])).toEqual([
      ['Free space', 'used', 'var(--rd-legend-blue)'],
      ['Buffer', 'buffer', '#123456'],
      ['Messages', 'free', 'var(--rd-legend-free)'],
    ]);
    expect(deferred.map((r) => r.name)).toEqual(['Later']);
  });

  it('the context card shows the percentage and expands into the breakdown', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    const card = screen.getByTestId('card-context');
    await waitFor(() => expect(card).toHaveTextContent('22%'));
    await rendered.user.click(within(card).getByRole('button', { name: /Context/ }));
    const breakdown = await within(card).findByTestId('context-breakdown');
    expect(breakdown).toHaveTextContent('22% used');
    expect(breakdown).toHaveTextContent('184.9k / 850k');
    expect(within(breakdown).getAllByRole('listitem')).toHaveLength(13);
  });

  it('the hand-off card explains every action and says why one is unavailable', async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: /Hand-off/ }));
    const card = screen.getByTestId('card-handoff');
    const rows = within(card).getAllByRole('button').filter((b) => b.classList.contains('rd-actionrow'));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveAttribute('aria-disabled', 'true');
    expect(rows[0]).toHaveTextContent('Hand back to desktopOpen an existing session first');
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await waitFor(() => expect(rows[0]).not.toHaveAttribute('aria-disabled'));
    expect(rows[0]).toHaveTextContent('End the Relay session first, then continue it in the desktop app');
  });

  it('accounts: logout asks first; the default profile cannot be removed', async () => {
    const { api, user } = await renderApp();
    const logout = vi.spyOn(api.accounts, 'logout');
    const remove = vi.spyOn(api.accounts, 'remove');
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    const rows = await screen.findAllByTestId('account-row');
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(within(rows[0]!).getByTestId('account-label')).toHaveTextContent('me@example.com'));
    expect(within(rows[1]!).getByRole('img', { name: 'Not logged in' })).toBeInTheDocument();

    await user.click(within(rows[0]!).getByRole('button', { name: 'Actions for “Personal account”' }));
    const menu = await screen.findByRole('menu', { name: 'Actions for “Personal account”' });
    expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Log out' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Log out of “Personal account”?' });
    expect(logout).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(logout).toHaveBeenCalledWith('default'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('accounts: login opens the official flow for that profile only', async () => {
    const { api, user } = await renderApp();
    const login = vi.spyOn(api.accounts, 'login');
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    const rows = await screen.findAllByTestId('account-row');
    await user.click(within(rows[1]!).getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('profile-work', undefined));
  });
});
