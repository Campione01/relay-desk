import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const NOTICE_KEY = 'relay.takeoverNotice';

async function takeOver(rendered: Rendered, title: string): Promise<void> {
  const { user, controller } = rendered;
  await user.click(within(sidebar()).getByRole('button', { name: title }));
  await user.click(within(await screen.findByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
  await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
  await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
}

describe('one-time take-over notice', () => {
  it('shows on the first take-over only; its × closes it for good and the hand-back stays in the title menu', async () => {
    const rendered = await renderApp();
    const { user, controller } = rendered;
    await takeOverMain(rendered);
    const banner = await screen.findByTestId('takeover-banner');
    expect(banner).toHaveTextContent('Relay Desk is running this session');

    await user.click(within(banner).getByRole('button', { name: 'Close this notice (it will not show again)' }));
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(NOTICE_KEY)).toBe('done');
    expect(controller.currentView()?.takeover).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    expect(await screen.findByRole('menuitem', { name: /Hand back to desktop/ })).toBeEnabled();
    await user.keyboard('{Escape}');

    await takeOver(rendered, 'Fix flaky test');
    expect(controller.currentView()?.takeover).toBe(true);
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
  });

  it('stays through view switches of that take-over and never returns once it ended', async () => {
    const rendered = await renderApp();
    const { user, controller } = rendered;
    await takeOverMain(rendered);
    const mainKey = controller.state.currentKey!;
    expect(await screen.findByTestId('takeover-banner')).toBeInTheDocument();

    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await screen.findByTestId('readonly-note');
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
    await user.click(within(sidebar()).getByRole('button', { name: /^Relay Desk packaging plan/ }));
    expect(await screen.findByTestId('takeover-banner')).toBeInTheDocument();

    // The take-over ends without the × (hand back from the banner).
    await user.click(within(screen.getByTestId('takeover-banner')).getByRole('button', { name: /Hand back to desktop/ }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Hand back to the desktop?' })).getByRole('button', { name: 'Hand back to desktop' }));
    await screen.findByTestId('handoff-result');
    await waitFor(() => expect(window.localStorage.getItem(NOTICE_KEY)).toBe('done'));

    await user.click(within(screen.getByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(controller.view(mainKey)?.engineState).toBe('idle'));
    expect(controller.view(mainKey)?.takeover).toBe(true);
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
  });

  it('is not shown again after a restart, also when the app quit while it was showing', async () => {
    const first = await renderApp();
    await takeOverMain(first);
    expect(await screen.findByTestId('takeover-banner')).toBeInTheDocument();
    expect(window.localStorage.getItem(NOTICE_KEY)).toMatch(/^active:/);
    cleanup();

    const second = await renderApp();
    await takeOverMain(second);
    expect(second.controller.currentView()?.takeover).toBe(true);
    expect(screen.queryByTestId('takeover-banner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(NOTICE_KEY)).toBe('done');
  });

  it('still shows when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      const rendered = await renderApp();
      await takeOverMain(rendered);
      expect(await screen.findByTestId('takeover-banner')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
