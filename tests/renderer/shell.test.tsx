import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, sidebar } from './helpers';

describe('app shell', () => {
  it('groups sessions by project folder, newest first, and hides older ones behind "Show older"', async () => {
    await renderApp();
    const nav = sidebar();
    const labels = within(nav)
      .getAllByRole('button', { expanded: true })
      .map((b) => b.textContent);
    expect(labels.slice(0, 3)).toEqual(['relay-desk', 'D:', 'business']);
    const relay = within(nav).getByRole('region', { name: 'relay-desk' });
    expect(within(relay).getAllByRole('listitem')).toHaveLength(6);
    expect(within(relay).getByRole('button', { name: 'Show older (2)' })).toBeInTheDocument();
  });

  it('opening a listed session loads its history read-only and resumes nothing (R4)', async () => {
    const { api, user } = await renderApp();
    const history = vi.spyOn(api.sessions, 'history');
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    expect(await screen.findByText('Ran `npm install`')).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith('default', '3b8e5d10-6a2f-4e7c-8d94-71c0a5f2e3b2', 'D:\\demos\\demo-app');
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId('readonly-note')).toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'Fix flaky test' })).toHaveAttribute('aria-current', 'page');
  });

  it('the "+" of a folder group starts a new session there without resuming', async () => {
    const { api, user } = await renderApp();
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(sidebar()).getByRole('button', { name: 'New session in business' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]![0]).toEqual({ profileId: 'default', cwd: 'D:\\work\\business', startupRequestId: expect.any(String) });
    expect(await screen.findByText(/Working folder: D:\\work\\business/)).toBeInTheDocument();
  });

  it('Ctrl+B hides and shows the sidebar', async () => {
    await renderApp();
    expect(sidebar()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(sidebar()).toBeInTheDocument();
  });

  it('the account chip shows the active profile and switches the list only on a click (R5)', async () => {
    const { api, user, controller } = await renderApp();
    const chip = within(sidebar()).getByRole('button', { name: 'Account: Personal account' });
    await waitFor(() => expect(chip).toHaveTextContent('Personal account· Max'));
    const list = vi.spyOn(api.sessions, 'list');
    await user.click(chip);
    await user.click(await screen.findByRole('menuitemradio', { name: /Work account/ }));
    await waitFor(() => expect(list).toHaveBeenCalledWith('profile-work'));
    expect(controller.state.activeProfileId).toBe('profile-work');
    expect(await within(sidebar()).findByRole('button', { name: 'Onboarding notes' })).toBeInTheDocument();
  });

  it('back returns to the previous view', async () => {
    const { user } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await screen.findByText('Ran `npm install`');
    await user.click(screen.getAllByRole('button', { name: 'Back' })[0]!);
    expect(await screen.findByRole('heading', { name: 'What are we picking up today?' })).toBeInTheDocument();
  });
});
