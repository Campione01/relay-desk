import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { seedShortcuts } from '@shared/shortcuts';
import { assignHotkeys } from '../../src/renderer/components/shortcuts/hotkeys';
import { validateDraft } from '../../src/renderer/components/shortcuts/ShortcutEditor';
import { renderApp, takeOverMain } from './helpers';

async function readyBar() {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  const bar = screen.getByRole('toolbar', { name: 'Shortcut bar' });
  return { ...rendered, handleId, bar };
}

describe('shortcut bar', () => {
  it('shows the chips of the selected group and sends a "send" chip on click (R6)', async () => {
    const { api, user, bar, handleId } = await readyBar();
    const send = vi.spyOn(api.engine, 'send');
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Replies',
      'Go ahead',
      'Continue',
      'Try again',
      'Anything left?',
      'Change summary',
      'Goal progress',
      'Test list',
      'Edit',
    ]);
    expect(send).not.toHaveBeenCalled();
    await user.click(within(bar).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, 'continue', undefined));
  });

  it('a "fill" chip puts its text in the box and sends nothing', async () => {
    const { api, user, bar } = await readyBar();
    const send = vi.spyOn(api.engine, 'send');
    await user.click(within(bar).getByRole('button', { name: /Replies/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Commands' }));
    await user.click(within(bar).getByRole('button', { name: '/compact …' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('/compact ');
    expect(send).not.toHaveBeenCalled();
  });

  it('Alt+N triggers the N-th chip of the visible group', async () => {
    const { api, handleId } = await readyBar();
    const send = vi.spyOn(api.engine, 'send');
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, 'Try again', undefined));
  });

  it('sends while running are queued instead of interrupting', async () => {
    const { api, user, bar, handleId } = await readyBar();
    const send = vi.spyOn(api.engine, 'send');
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running' }));
    await user.click(within(bar).getByRole('button', { name: 'Go ahead' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, 'Go ahead', { queue: true }));
  });

  it('hand-off chips confirm before closing the Relay session, then call the official command', async () => {
    const { api, user, bar, handleId } = await readyBar();
    const terminal = vi.spyOn(api.handoff, 'openInTerminal');
    await user.click(within(bar).getByRole('button', { name: /Replies/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Hand-off' }));
    await user.click(within(bar).getByRole('button', { name: 'Continue in terminal' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'End the Relay Desk session?' });
    expect(terminal).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(terminal).toHaveBeenCalledWith({
        profileId: 'default',
        cwd: 'D:\\demos\\relay-desk',
        sessionId: '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01',
        handleId,
      }),
    );
  });

  it('action chips that cannot run are marked disabled and do nothing', async () => {
    const { api, user, bar, controller } = await readyBar();
    const toDesktop = vi.spyOn(api.handoff, 'toDesktop');
    act(() => {
      const key = controller.state.currentKey!;
      controller.store.set((s) => ({ ...s, views: { ...s.views, [key]: { ...s.views[key]!, profileId: 'profile-work' } } }));
    });
    await user.click(within(bar).getByRole('button', { name: /Replies/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Hand-off' }));
    const chip = within(bar).getByRole('button', { name: 'Hand back to desktop' });
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAttribute('data-tip', 'Only the default account can hand off to the desktop');
    await user.click(chip);
    expect(toDesktop).not.toHaveBeenCalled();
  });
});

describe('seed shortcuts', () => {
  it('send English prompts and carry the English labels of the app', () => {
    const seeds = seedShortcuts();
    expect(seeds.filter((s) => s.kind === 'prompt').map((s) => s.text)).toEqual([
      'Go ahead',
      'continue',
      'Try again',
      'Is there anything left to do?',
      'Briefly list the files and features you changed this time.',
      'What is still missing to reach the original goal?',
      'List what I need to test by hand, with the steps.',
    ]);
    expect(seeds.filter((s) => s.kind === 'action').map((s) => s.label)).toEqual([
      'Model',
      'Effort',
      'Permission mode',
      'Usage panel',
      'Hand back to desktop',
      'Open this folder in desktop',
      'Continue in terminal',
      'Fork into terminal',
      'Continue latest in terminal',
      'Send to cloud',
      'Pull from cloud',
      'Remote Control',
    ]);
    expect(seeds.some((s) => /[\u3000-\u9fff\uff00-\uffef]/.test(`${s.label}${s.text ?? ''}${s.hint ?? ''}`))).toBe(false);
  });
});

describe('shortcut editor', () => {
  it('adds, reorders and deletes shortcuts and saves the list through window.relay.shortcuts', async () => {
    const { api, user } = await readyBar();
    const set = vi.spyOn(api.shortcuts, 'set');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByTestId('shortcut-editor');
    await user.click(within(editor).getByRole('radio', { name: /Custom/ }));
    await user.click(within(editor).getByRole('button', { name: 'Add shortcut' }));
    await user.type(within(editor).getByRole('textbox', { name: 'Name' }), '跑測試');
    await user.type(within(editor).getByRole('textbox', { name: 'Text to send' }), '跑一次完整測試');
    await user.click(within(editor).getByRole('button', { name: 'Add' }));
    await user.click(within(editor).getByRole('radio', { name: /Replies/ }));
    await user.click(within(editor).getByRole('button', { name: 'Move “Continue” up' }));
    await user.click(within(editor).getByRole('button', { name: 'Delete “Goal progress”' }));
    await user.click(within(editor).getByRole('button', { name: 'Delete' }));
    await user.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    const saved = set.mock.calls[0]![0];
    expect(saved.filter((s) => s.group === 'replies').map((s) => s.label).slice(0, 3)).toEqual(['Continue', 'Go ahead', 'Try again']);
    expect(saved.find((s) => s.label === '跑測試')).toMatchObject({ group: 'custom', kind: 'prompt', text: '跑一次完整測試', mode: 'send' });
    expect(saved.some((s) => s.id === 'seed.reply.goalProgress')).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('shortcut-editor')).not.toBeInTheDocument());
  });

  it('validates required fields, slash prefix and hotkey clashes', () => {
    const seeds = seedShortcuts().map((s) => (s.id === 'seed.reply.ok' ? { ...s, hotkey: 'Alt+Q' } : s));
    const draft = { id: 'new', label: '', group: 'custom' as const, kind: 'slash' as const, text: 'compact', action: '' as const, mode: 'send' as const, hotkey: 'alt+q', hint: '' };
    expect(validateDraft(draft, seeds)).toEqual({
      label: 'shortcuts.error.label',
      text: 'shortcuts.error.slash',
      hotkey: 'shortcuts.error.taken',
    });
    expect(validateDraft({ ...draft, label: 'x', text: '/compact', hotkey: 'Ctrl+B' }, seeds)).toEqual({ hotkey: 'shortcuts.error.reserved' });
  });

  it('explicit hotkeys win; the visible group gets Alt+1 … Alt+9 by position', () => {
    const list = seedShortcuts();
    const replies = list.filter((s) => s.group === 'replies');
    list.find((s) => s.id === 'seed.cmd.compact')!.hotkey = 'alt+2';
    const map = assignHotkeys(list, replies);
    expect(map.get('Alt+1')).toBe('seed.reply.ok');
    expect(map.get('Alt+2')).toBe('seed.cmd.compact');
    expect(map.get('Alt+3')).toBe('seed.reply.tryAgain');
  });
});
