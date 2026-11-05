import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { actionAvailability, actionClosesSession } from '../../src/renderer/state/availability';
import { AppController } from '../../src/renderer/state/controller';
import { createView } from '../../src/renderer/state/sessionReducer';
import { MAIN_SESSION_ID, renderApp, sidebar, takeOverMain } from './helpers';

describe('renderer handoff fixes', () => {
  it('sidebar pointer focus preserves the scroll position and the click opens history without resuming', async () => {
    const { api, user, controller } = await renderApp();
    const row = within(sidebar()).getByRole('button', { name: 'Fix flaky test' });
    const list = sidebar().querySelector<HTMLElement>('.rd-sidebar__list')!;
    list.scrollTop = 146;
    const focus = vi.spyOn(row, 'focus');
    const open = vi.spyOn(api.engine, 'open');
    expect(fireEvent.mouseDown(row, { button: 0 })).toBe(false);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await user.click(row);
    expect(await screen.findByTestId('readonly-note')).toBeInTheDocument();
    expect(controller.currentView()?.title).toBe('Fix flaky test');
    expect(list.scrollTop).toBe(146);
    expect(open).not.toHaveBeenCalled();
  });

  it('long sidebar titles expose the whole tooltip and cannot widen the scrollable grid', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const shellCss = readFileSync('src/renderer/styles/shell.css', 'utf8');
    const title = 'A deliberately long title '.repeat(20);
    await renderApp({ sessions: [{ sessionId: MAIN_SESSION_ID, title, cwd: 'D:\\long folder', lastModified: 1 }] });
    const row = within(sidebar()).getByRole('button', { name: title.trim() });
    // One tooltip only (HI-4): the custom data-tip carries the full title, no native title.
    expect(row).not.toHaveAttribute('title');
    expect(row).toHaveAttribute('data-tip', title);
    expect(shellCss).toMatch(/\.rd-sidebar__list\s*\{[^}]*overflow-x:\s*hidden/);
    expect(shellCss).toMatch(/\.rd-sgroup__rows\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(shellCss).toMatch(/\.rd-srow__title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/);
  });

  it('recent-session unbroken titles stay inside shrinkable grid and flex rows with a full tooltip and working click', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const shellCss = readFileSync('src/renderer/styles/shell.css', 'utf8');
    const title = 'ExtremelyLongUnbrokenTitle'.repeat(80);
    const { api, user, controller } = await renderApp({ sessions: [{ sessionId: MAIN_SESSION_ID, title, cwd: 'D:\\project', lastModified: 1 }] });
    const titleElement = within(screen.getByTestId('home')).getByText(title);
    const row = titleElement.closest('button')!;
    expect(row).toHaveAttribute('title', title);
    expect(row).toHaveAttribute('data-tip', title);
    expect(shellCss).toMatch(/\.rd-home__inner,\s*\.rd-home__section,\s*\.rd-home__list\s*\{\s*min-width:\s*0;\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(shellCss).toMatch(/\.rd-home__list > li,\s*\.rd-home__row,\s*\.rd-home__row-title\s*\{\s*min-width:\s*0/);
    expect(shellCss).toMatch(/\.rd-home__row-title\s*\{[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/);
    const open = vi.spyOn(api.engine, 'open');
    await user.click(row);
    expect(await screen.findByTestId('readonly-note')).toBeInTheDocument();
    expect(controller.currentView()?.title).toBe(title);
    expect(open).not.toHaveBeenCalled();
  });

  it('folder groups toggle with Enter and Space and preserve each collapse across remount and restart', async () => {
    const { user } = await renderApp();
    const group = within(sidebar()).getByRole('region', { name: 'relay-desk' });
    const heading = within(group).getByRole('button', { name: 'relay-desk' });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(heading.querySelector('.rd-sgroup__chevron')).toHaveAttribute('data-direction', 'down');
    heading.focus();
    await user.keyboard('{Enter}');
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(heading.querySelector('.rd-sgroup__chevron')).toHaveAttribute('data-direction', 'right');
    expect(within(group).queryByRole('list')).not.toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'Fix flaky test' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(within(sidebar()).getByRole('button', { name: 'relay-desk' })).toHaveAttribute('aria-expanded', 'false');
    cleanup();
    const restarted = await renderApp();
    const restored = within(sidebar()).getByRole('button', { name: 'relay-desk' });
    expect(restored).toHaveAttribute('aria-expanded', 'false');
    restored.focus();
    await restarted.user.keyboard(' ');
    expect(restored).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' })).toBeInTheDocument();
  });

  it('clicking a folder chevron or label toggles its two child sessions, including during search', async () => {
    const cwd = 'D:\\work\\project';
    const { user } = await renderApp({ sessions: [
      { sessionId: MAIN_SESSION_ID, title: 'First child task', cwd, lastModified: 2 },
      { sessionId: '3b8e5d10-6a2f-4e7c-8d94-71c0a5f2e3b2', title: 'Second child task', cwd, lastModified: 1 },
    ] });
    const group = within(sidebar()).getByRole('region', { name: 'project' });
    const heading = within(group).getByRole('button', { name: 'project' });
    const chevron = (): HTMLElement => heading.querySelector<HTMLElement>('.rd-sgroup__chevron')!;
    expect(within(group).getAllByRole('listitem')).toHaveLength(2);
    await user.click(chevron());
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(within(group).queryByRole('list')).not.toBeInTheDocument();
    await user.click(chevron());
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(within(group).getAllByRole('listitem')).toHaveLength(2);
    await user.click(heading.querySelector('.rd-sgroup__name')!);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    await user.click(heading.querySelector('.rd-sgroup__name')!);
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search' }), 'child');
    await user.click(chevron());
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(within(group).queryByRole('list')).not.toBeInTheDocument();
    await user.clear(within(sidebar()).getByRole('searchbox', { name: 'Search' }));
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(window.localStorage.getItem('relay.sidebarCollapsedGroups')!)).toContain(JSON.stringify(['default', cwd]));
  });

  it('a folder with spaces still names its region and controls its own list (HI-5)', async () => {
    const cwd = 'D:\\my work\\demo project';
    await renderApp({ sessions: [{ sessionId: MAIN_SESSION_ID, title: 'Spaced task', cwd, lastModified: 1 }] });
    const group = within(sidebar()).getByRole('region', { name: 'demo project' });
    const heading = within(group).getByRole('button', { name: 'demo project' });
    const controls = heading.getAttribute('aria-controls')!;
    expect(controls).not.toMatch(/\s/);
    expect(document.getElementById(controls)).toBe(within(group).getByRole('list'));
  });

  it('a listed session that is live in Relay shows its running dot and opens the live view (RQ-1)', async () => {
    const { api, controller, user } = await renderApp();
    await act(async () => { await controller.newSession('D:\\work\\fresh'); });
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const live = controller.currentView()!;
    const listed = await api.sessions.list('default');
    vi.spyOn(api.sessions, 'list').mockResolvedValue([
      ...listed,
      { sessionId: live.sessionId!.toUpperCase(), title: 'Fresh work', cwd: 'D:\\work\\fresh', lastModified: Date.now() },
    ]);
    await act(async () => { await controller.loadSessions(); });
    act(() => api.mock.emitEngine({ type: 'state', handleId: live.handleId!, state: 'running' }));
    const row = within(sidebar()).getByRole('button', { name: /^Fresh work/ });
    expect(within(within(sidebar()).getByRole('region', { name: 'fresh' })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(row).getByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-current', 'page');
    act(() => controller.showHome());
    expect(row).not.toHaveAttribute('aria-current');
    await user.click(row);
    expect(controller.state.currentKey).toBe(live.key);
    expect(Object.keys(controller.state.views).filter((key) => key.startsWith('s:'))).toEqual([]);
  });

  it('folder options and new-session buttons are keyboard operable without toggling the group', async () => {
    const { api, user } = await renderApp();
    const reveal = vi.spyOn(api.app, 'revealPath');
    const open = vi.spyOn(api.engine, 'open');
    const group = within(sidebar()).getByRole('region', { name: 'business' });
    const options = within(group).getByRole('button', { name: 'Options for business' });
    options.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Options for business' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Open folder in File Explorer' }));
    expect(reveal).toHaveBeenCalledWith('D:\\work\\business');
    const add = within(group).getByRole('button', { name: 'New session in business' });
    add.focus();
    await user.keyboard(' ');
    await waitFor(() => expect(open).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\work\\business', startupRequestId: expect.any(String) }));
    expect(within(group).getByRole('button', { name: 'business' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('all five card header rows expand and collapse by mouse, Enter and Space', async () => {
    const { user } = await renderApp();
    // Background tasks moved out of the panel into their own pane; Connectors keeps the count at five.
    for (const id of ['environment', 'handoff', 'context', 'accounts', 'connectors']) {
      const card = screen.getByTestId(`card-${id}`);
      const head = card.querySelector<HTMLButtonElement>('.rd-card__head')!;
      const before = head.getAttribute('aria-expanded') === 'true';
      expect(fireEvent.mouseDown(head, { button: 0 })).toBe(false);
      await user.click(head.querySelector('.rd-card__title')!);
      expect(head).toHaveAttribute('aria-expanded', String(!before));
      head.focus();
      await user.keyboard('{Enter}');
      expect(head).toHaveAttribute('aria-expanded', String(before));
      await user.keyboard(' ');
      expect(head).toHaveAttribute('aria-expanded', String(!before));
    }
  });

  it('read-only default sessions advertise handoff actions without requiring a Relay engine', async () => {
    const { api, user, controller } = await renderApp();
    const open = vi.spyOn(api.engine, 'open');
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    const card = screen.getByTestId('card-handoff');
    expect(card).toHaveTextContent('Available');
    await user.click(within(card).getByRole('button', { name: /Hand-off/ }));
    const rows = within(card).getAllByRole('button').filter((button) => button.classList.contains('rd-actionrow'));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row).not.toHaveAttribute('aria-disabled');
    const view = controller.currentView()!;
    // The model menu works before the open too (the pick is sent with it), as in the desktop.
    expect(actionAvailability('ui.modelPicker', view, 'default')).toEqual({ ok: true });
    expect(actionAvailability('ui.effortPicker', view, 'default')).toEqual({ ok: true });
    expect(actionAvailability('ui.modelPicker', null, 'default')).toEqual({ ok: false, reason: 'reason.noSession' });
    expect(actionAvailability('handoff.toDesktop', { ...view, profileId: 'profile-work' }, 'profile-work')).toEqual({ ok: false, reason: 'reason.defaultOnly' });
    const desktop = vi.spyOn(api.handoff, 'toDesktop');
    const terminal = vi.spyOn(api.handoff, 'openInTerminal');
    const remote = vi.spyOn(api.handoff, 'remoteControl');
    await act(async () => {
      await controller.runAction('handoff.toDesktop');
      await controller.runAction('handoff.openInTerminalFork');
      await controller.runAction('handoff.remoteControl');
    });
    expect(desktop).toHaveBeenCalledWith({ profileId: 'default', cwd: view.cwd, sessionId: MAIN_SESSION_ID });
    expect(terminal).toHaveBeenCalledWith({ profileId: 'default', cwd: view.cwd, sessionId: MAIN_SESSION_ID, fork: true });
    expect(remote).toHaveBeenCalledWith({ profileId: 'default', cwd: view.cwd, sessionId: MAIN_SESSION_ID });
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a resume launch without a profile uses default even when another profile was saved as active', async () => {
    const { api, user, controller } = await renderApp({
      settings: { activeProfileId: 'profile-work' },
      launchRequest: { action: 'resume', sessionId: MAIN_SESSION_ID, cwd: 'D:\\demos\\relay-desk' },
    });
    const dialog = await screen.findByTestId('takeover-dialog');
    const open = vi.spyOn(api.engine, 'open');
    expect(controller.currentView()?.profileId).toBe('default');
    expect(controller.state.activeProfileId).toBe('default');
    expect(open).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\demos\\relay-desk', resumeSessionId: MAIN_SESSION_ID, startupRequestId: expect.any(String) }));
  });

  it('continue latest confirms and forwards the writer handle, including cancellation', async () => {
    const rendered = await renderApp();
    const { api, user, controller } = rendered;
    const handleId = await takeOverMain(rendered);
    const terminal = vi.spyOn(api.handoff, 'openInTerminal');
    let action: Promise<void>;
    act(() => { action = controller.runAction('handoff.continueLatestInTerminal'); });
    const cancelled = await screen.findByRole('alertdialog');
    expect(terminal).not.toHaveBeenCalled();
    await user.click(within(cancelled).getByRole('button', { name: 'Cancel' }));
    await action!;
    expect(terminal).not.toHaveBeenCalled();
    expect(controller.currentView()?.handleId).toBe(handleId);
    act(() => { action = controller.runAction('handoff.continueLatestInTerminal'); });
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Continue' }));
    await action!;
    expect(terminal).toHaveBeenCalledWith({ profileId: 'default', cwd: 'D:\\demos\\relay-desk', continueLatest: true, handleId });
    await waitFor(() => expect(controller.currentView()?.handleId).toBeUndefined());
  });

  it('continue latest treats an uninitialized writer as closing but a fork never closes it', () => {
    const view = { ...createView({ key: 'new', profileId: 'default', cwd: 'D:\\work', title: 'New' }), handleId: 'pending', engineState: 'starting' as const };
    expect(actionClosesSession('handoff.continueLatestInTerminal', view)).toBe(true);
    expect(actionClosesSession('handoff.openInTerminalFork', view)).toBe(false);
  });

  it('remove account defaults to keeping its directory and cancellation removes nothing', async () => {
    const { api, user, controller } = await renderApp();
    const remove = vi.spyOn(api.accounts, 'remove');
    let action: Promise<void>;
    act(() => { action = controller.removeProfile('profile-work'); });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await action!;
    expect(remove).not.toHaveBeenCalled();
    act(() => { action = controller.removeProfile('profile-work'); });
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await action!;
    expect(remove).toHaveBeenCalledWith('profile-work', { deleteDirectory: false });
    await act(async () => { await controller.removeProfile('default'); });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('remove account deletes its directory only after the explicit checkbox opt-in', async () => {
    const { api, user, controller } = await renderApp();
    const remove = vi.spyOn(api.accounts, 'remove');
    let action: Promise<void>;
    act(() => { action = controller.removeProfile('profile-work'); });
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also delete this account’s config folder and session history' }));
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await action!;
    expect(remove).toHaveBeenCalledWith('profile-work', { deleteDirectory: true });
  });

  it('folder reveal uses the local path IPC rather than an external file URL', async () => {
    const { api, controller } = await renderApp();
    const reveal = vi.spyOn(api.app, 'revealPath');
    const external = vi.spyOn(api.app, 'openExternal');
    await controller.openFolder('D:\\projects with spaces\\demo');
    expect(reveal).toHaveBeenCalledWith('D:\\projects with spaces\\demo');
    expect(external).not.toHaveBeenCalled();
  });

  it('file and folder menu picks append quoted references without sending or resuming', async () => {
    const { api, user } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    const send = vi.spyOn(api.engine, 'send');
    const open = vi.spyOn(api.engine, 'open');
    vi.spyOn(api.app, 'pickFiles').mockResolvedValue(['D:\\my project\\file.ts', 'E:\\image.png']);
    vi.spyOn(api.app, 'pickFolder').mockResolvedValue('D:\\another folder');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'look');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Add' })).getByRole('menuitem', { name: /Add files or photos/ }));
    await waitFor(() => expect(box).toHaveValue('look @"D:\\my project\\file.ts" @"E:\\image.png" '));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Add' })).getByRole('menuitem', { name: 'Add folder' }));
    await waitFor(() => expect(box).toHaveValue('look @"D:\\my project\\file.ts" @"E:\\image.png" @"D:\\another folder" '));
    expect(box).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('Ctrl+U opens the file picker directly and a cancelled picker preserves the draft', async () => {
    const { api, user } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    const files = vi.spyOn(api.app, 'pickFiles').mockResolvedValueOnce(['D:\\some file.md']).mockResolvedValueOnce([]);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.click(box);
    await user.keyboard('{Control>}u{/Control}');
    await waitFor(() => expect(box).toHaveValue('@"D:\\some file.md" '));
    await user.keyboard('{Control>}u{/Control}');
    expect(files).toHaveBeenCalledTimes(2);
    expect(box).toHaveValue('@"D:\\some file.md" ');
    expect(screen.queryByRole('menu', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('the saved active profile wins over legacy localStorage and a user switch is persisted', async () => {
    window.localStorage.setItem('relay.activeProfile', 'default');
    const { api, controller } = await renderApp({ settings: { activeProfileId: 'profile-work' } });
    expect(controller.state.activeProfileId).toBe('profile-work');
    expect(within(sidebar()).getByRole('button', { name: 'Onboarding notes' })).toBeInTheDocument();
    const save = vi.spyOn(api.app, 'setSettings');
    await act(async () => { await controller.setActiveProfile('default'); });
    expect(save).toHaveBeenCalledWith({ activeProfileId: 'default' });
    expect((await api.app.getSettings()).activeProfileId).toBe('default');
    const restarted = new AppController(api);
    const stop = restarted.start();
    try {
      await waitFor(() => expect(restarted.state.ready).toBe(true));
      expect(restarted.state.activeProfileId).toBe('default');
    } finally { stop(); }
  });

  it('four stacked notifications anchor above the conversation outside the composer and remain dismissable', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const css = readFileSync('src/renderer/styles/base.css', 'utf8');
    const rendered = await renderApp();
    await takeOverMain(rendered);
    act(() => {
      for (let index = 1; index <= 4; index++) rendered.controller.toast('error', `Synthetic notification ${index}`);
    });
    const stack = screen.getAllByRole('status').find((element) => element.classList.contains('rd-toasts'))!;
    const content = document.querySelector<HTMLElement>('.rd-content')!;
    expect(stack.parentElement).toBe(content);
    expect(content).toHaveAttribute('data-panel', 'true');
    expect(stack.querySelectorAll('.rd-toast')).toHaveLength(4);
    const stackRule = css.match(/\.rd-toasts\s*\{([^}]+)\}/)![1]!;
    expect(stackRule).toMatch(/position:\s*absolute;/);
    expect(stackRule).toMatch(/top:\s*12px;/);
    expect(stackRule).not.toMatch(/bottom:/);
    expect(stackRule).toMatch(/left:\s*16px;/);
    expect(stackRule).toMatch(/right:\s*16px;/);
    expect(stackRule).toMatch(/max-width:\s*360px;/);
    expect(stackRule).toMatch(/margin-inline:\s*auto;/);
    expect(stackRule).toMatch(/pointer-events:\s*none;/);
    expect(css).toMatch(/\.rd-content\[data-panel="true"\] \.rd-toasts\s*\{\s*right:\s*max\(16px, clamp\(0px, calc\(1392px - 100%\), 312px\)\)/);
    expect(css).toMatch(/\.rd-toast\s*\{\s*pointer-events:\s*auto;/);
    await rendered.user.click(within(stack).getAllByRole('button', { name: 'Dismiss' })[0]!);
    expect(stack.querySelectorAll('.rd-toast')).toHaveLength(3);
    expect(within(stack).queryByText('Synthetic notification 1')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('a deleted saved profile falls back to default and repairs the saved selection', async () => {
    window.localStorage.setItem('relay.activeProfile', 'profile-work');
    const { api, controller } = await renderApp({ settings: { activeProfileId: 'deleted-profile' } });
    expect(controller.state.activeProfileId).toBe('default');
    expect((await api.app.getSettings()).activeProfileId).toBe('default');
    expect(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' })).toBeInTheDocument();
  });
});
