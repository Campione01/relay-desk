import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp, takeOverMain, type Rendered } from './helpers';

async function ready(): Promise<Rendered & { handleId: string; box: HTMLTextAreaElement }> {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  return { ...rendered, handleId, box };
}

describe('prompt box keyboard', () => {
  it('Enter sends the text and clears the box', async () => {
    const { api, user, box, handleId } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    await user.type(box, 'hello there{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, 'hello there', undefined));
    expect(box).toHaveValue('');
    expect(await screen.findByText('Mock reply to: hello there')).toBeInTheDocument();
  });

  it('Shift+Enter inserts a new line and does not send', async () => {
    const { api, user, box } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a rejected control-recovery send in the draft and does not retry or close automatically', async () => {
    const { api, user, box } = await ready();
    const send = vi.spyOn(api.engine, 'send').mockRejectedValueOnce(new Error('Native control recovery required. Close and reopen this Relay session before sending.'));
    const close = vi.spyOn(api.engine, 'close');
    const interrupt = vi.spyOn(api.engine, 'interrupt');
    await user.type(box, 'Keep my unsent request{Enter}');
    await waitFor(() => expect(box).toHaveValue('Keep my unsent request'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Mock reply to: Keep my unsent request')).toBeInTheDocument();
  });

  it('Ctrl+Enter queues the message for later', async () => {
    const { api, user, box, handleId } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running' }));
    await user.type(box, 'after this{Control>}{Enter}{/Control}');
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, 'after this', { queue: true }));
  });

  it('Enter during IME composition does not send', async () => {
    const { api, box } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue('你好');
  });

  it('Esc interrupts a running turn and the stop button replaces send while the box is empty', async () => {
    const { api, user, box, handleId } = await ready();
    const interrupt = vi.spyOn(api.engine, 'interrupt');
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(interrupt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running' }));
    box.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
  });

  it('typing "/" opens the slash popup; filtering and Enter insert the command', async () => {
    const { user, box } = await ready();
    await user.type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Slash commands' });
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('schedule');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Create a scheduled task');
    await user.type(box, 'comp');
    const options = within(screen.getByRole('listbox', { name: 'Slash commands' })).getAllByRole('option');
    expect(options[0]).toHaveTextContent('compact');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('/compact ');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
  });

  it('the "+" menu offers enabled files, folder and slash commands', async () => {
    const { user } = await ready();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const menu = await screen.findByRole('menu', { name: 'Add' });
    expect(within(menu).getByRole('menuitem', { name: /Add files or photos/ })).not.toHaveAttribute('aria-disabled');
    expect(within(menu).getByRole('menuitem', { name: 'Add folder' })).not.toHaveAttribute('aria-disabled');
    await user.click(within(menu).getByRole('menuitem', { name: 'Slash commands' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('/');
  });

  it('the row under the box changes permission mode and effort through the engine', async () => {
    const { api, user, handleId } = await ready();
    const setMode = vi.spyOn(api.engine, 'setPermissionMode');
    const setEffort = vi.spyOn(api.engine, 'setEffort');
    const footer = screen.getByTestId('prompt-footer');
    await user.click(within(footer).getByRole('button', { name: 'Settings default' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Plan/ }));
    expect(setMode).toHaveBeenCalledWith(handleId, 'plan');
    await user.click(within(footer).getByRole('button', { name: /Default effort$/ }));
    await user.click(within(await screen.findByRole('menu', { name: 'Model' })).getByRole('menuitem', { name: /^Effort/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Extra' }));
    expect(setEffort).toHaveBeenCalledWith(handleId, 'xhigh');
    expect(within(footer).getByRole('button', { name: /Extra$/ })).toBeInTheDocument();
  });
});
