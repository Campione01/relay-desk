import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, sidebar } from './helpers';

describe('inline errors and settings', () => {
  it('a failed history load shows the error inline and Retry loads it again', async () => {
    const { api, user } = await renderApp();
    const history = vi
      .spyOn(api.sessions, 'history')
      .mockRejectedValueOnce(new Error("Error invoking remote method 'relay:sessions:history': Error: worker exited"));
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    const error = await screen.findByTestId('inline-error');
    expect(error).toHaveTextContent('worker exited');
    await user.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ran `npm install`')).toBeInTheDocument();
    expect(history).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('inline-error')).not.toBeInTheDocument();
  });

  it('an unconfirmed send keeps the text and explicitly offers Send again, not a status retry', async () => {
    const { api, user, controller } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await user.click(within(await screen.findByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByTestId('takeover-dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const send = vi.spyOn(api.engine, 'send').mockRejectedValueOnce(new Error('engine busy'));
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'try this{Enter}');
    const error = await screen.findByTestId('inline-error');
    expect(error).toHaveTextContent('engine busy');
    expect(box).toHaveValue('try this');
    expect(send).toHaveBeenCalledTimes(1);
    expect(within(error).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('submission-status')).not.toBeInTheDocument();
    await user.click(within(error).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual([controller.currentView()!.handleId, 'try this', undefined]);
  });

  it('settings apply the theme and language at once and save them', async () => {
    const { api, user } = await renderApp();
    const save = vi.spyOn(api.app, 'setSettings');
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByTestId('settings-dialog');
    expect(within(dialog).getByText('0.3.302')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(save).toHaveBeenCalledWith({ theme: 'dark' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Language' }), 'zh-TW');
    expect(await screen.findByRole('heading', { name: '設定' })).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith({ language: 'zh-TW' });
  });
});
