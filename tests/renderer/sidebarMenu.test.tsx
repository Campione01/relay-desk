import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/types';
import { groupSessions } from '../../src/renderer/components/shell/Sidebar';
import { Menu, type MenuEntry } from '../../src/renderer/components/ui/Menu';
import {
  EMPTY_MARKS,
  MAX_PINNED,
  SIDEBAR_MARKS_KEY,
  forgetSession,
  readMarks,
  sanitizeMarks,
  withArchived,
  withGroup,
  withoutGroup,
  withPin,
  withPlacement,
  withUnread,
} from '../../src/renderer/state/sidebarMarks';
import { MAIN_SESSION_ID, renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const LABELS = { other: 'Other', pinned: 'Pinned' };
const summary = (id: string, cwd: string, lastModified: number): SessionSummary => ({ sessionId: id, title: `t-${id}`, cwd, lastModified });

// A row's name also carries its status dot (Unread, Open in Relay Desk), so rows are found by their title text.
function rowOf(title: string): HTMLElement {
  const row = [...sidebar().querySelectorAll<HTMLElement>('.rd-srow-wrap')].find((li) => li.querySelector('.rd-srow__title')?.textContent === title);
  if (!row) throw new Error(`no sidebar row ${title}`);
  return row;
}

const rowButton = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>('.rd-srow')!;
const hasRow = (title: string): boolean => [...sidebar().querySelectorAll('.rd-srow__title')].some((el) => el.textContent === title);

async function openRowMenu(user: Rendered['user'], title: string): Promise<HTMLElement> {
  await user.click(within(rowOf(title)).getByRole('button', { name: `More options for ${title}` }));
  return screen.findByRole('menu', { name: `More options for ${title}` });
}

const itemTexts = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll(':scope > .rd-menu__item, :scope > [role=separator]')].map((el) =>
    el.getAttribute('role') === 'separator'
      ? '---'
      : [el.querySelector('.rd-menu__label')?.textContent, el.querySelector('.rd-menu__right')?.textContent].filter(Boolean).join(' '),
  );

const groupNames = (): string[] =>
  [...sidebar().querySelectorAll('.rd-sgroup .rd-sgroup__name')].map((el) => el.textContent ?? '');

const rowsIn = (name: string): string[] => {
  const section = [...sidebar().querySelectorAll('.rd-sgroup')].find((s) => s.querySelector('.rd-sgroup__name')?.textContent === name);
  return section ? [...section.querySelectorAll('.rd-srow__title')].map((el) => el.textContent ?? '') : [];
};

function mockMenuResizeObserver() {
  const observers: Array<{ targets: Set<Element>; notify: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('ResizeObserver', class {
    readonly targets = new Set<Element>();
    readonly disconnect = vi.fn(() => this.targets.clear());
    constructor(readonly notify: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
  });
  return {
    observers,
    resize: (target: Element) => act(() => {
      for (const observer of observers) if (observer.targets.has(target)) observer.notify();
    }),
  };
}

describe('open menu geometry', () => {
  const entries: MenuEntry[] = [{ id: 'first', label: 'First', checked: true }, { id: 'second', label: 'Second' }];

  it('follows viewport resize and nested scrolling without resetting selection, then releases listeners on close', () => {
    const { observers } = mockMenuResizeObserver();
    vi.stubGlobal('innerWidth', 1180);
    vi.stubGlobal('innerHeight', 788);
    const fixture = render(<div><button>Geometry anchor</button></div>);
    const anchor = within(fixture.container).getByRole('button');
    let rect = DOMRect.fromRect({ x: 900, y: 750, width: 105, height: 24 });
    const measure = vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect);
    try {
      const view = render(<Menu anchor={anchor} open onClose={vi.fn()} entries={entries} label="Geometry" placement="top-end" offset={6} />);
      const menu = screen.getByRole('menu', { name: 'Geometry' });
      expect(menu).toHaveStyle({ bottom: '44px', right: '175px' });
      fireEvent.keyDown(menu, { key: 'End' });
      const active = menu.getAttribute('aria-activedescendant');
      expect(within(menu).getByRole('menuitem', { name: 'Second' })).toHaveAttribute('data-active', 'true');

      rect = DOMRect.fromRect({ x: 600, y: 420, width: 105, height: 24 });
      vi.stubGlobal('innerWidth', 1280);
      vi.stubGlobal('innerHeight', 900);
      fireEvent.resize(window);
      expect(menu).toHaveStyle({ bottom: '486px', right: '575px' });
      rect = DOMRect.fromRect({ x: 600, y: 380, width: 105, height: 24 });
      fireEvent.scroll(anchor.parentElement!);
      expect(menu).toHaveStyle({ bottom: '526px', right: '575px' });
      expect(menu).toHaveAttribute('aria-activedescendant', active);
      expect(menu).toHaveFocus();

      view.rerender(<Menu anchor={anchor} open={false} onClose={vi.fn()} entries={entries} label="Geometry" placement="top-end" offset={6} />);
      expect(observers).not.toHaveLength(0);
      expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
      measure.mockClear();
      fireEvent.resize(window);
      fireEvent.scroll(anchor.parentElement!);
      expect(measure).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      measure.mockRestore();
    }
  });

  it('follows anchor layout and React content changes while keeping the open submenu and its active row', () => {
    const { resize } = mockMenuResizeObserver();
    vi.stubGlobal('innerHeight', 788);
    const fixture = render(<div><button>Layout anchor</button></div>);
    const anchor = within(fixture.container).getByRole('button');
    let rect = DOMRect.fromRect({ x: 600, y: 420, width: 105, height: 24 });
    const measure = vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect);
    const choices: MenuEntry[] = [...entries, { id: 'more', label: 'More choices', submenu: entries }];
    try {
      const view = render(<Menu anchor={anchor} open onClose={vi.fn()} entries={choices} label="Layout" placement="top-end" offset={6} />);
      const menu = screen.getByRole('menu', { name: 'Layout' });
      const more = within(menu).getByRole('menuitem', { name: 'More choices' });
      fireEvent.pointerEnter(more);
      const submenu = screen.getByRole('menu', { name: 'More choices' });
      fireEvent.keyDown(submenu, { key: 'End' });
      const active = submenu.getAttribute('aria-activedescendant');
      rect = DOMRect.fromRect({ x: 600, y: 520, width: 105, height: 24 });
      resize(anchor.parentElement!);
      expect(menu).toHaveStyle({ bottom: '274px' });
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(submenu).toHaveAttribute('aria-activedescendant', active);
      expect(submenu).toHaveFocus();

      rect = DOMRect.fromRect({ x: 600, y: 620, width: 105, height: 24 });
      view.rerender(<Menu anchor={anchor} open onClose={vi.fn()} entries={[...choices.slice(0, -1), { id: 'more', label: 'More choices', submenu: [...entries, { id: 'third', label: 'Loaded choice' }] }]} label="Layout" placement="top-end" offset={6} />);
      expect(menu).toHaveStyle({ bottom: '174px' });
      expect(screen.getByRole('menu', { name: 'More choices' })).toBe(submenu);
      expect(within(submenu).getByRole('menuitem', { name: 'Loaded choice' })).toBeInTheDocument();
      expect(submenu).toHaveAttribute('aria-activedescendant', active);
      expect(submenu).toHaveFocus();
    } finally {
      vi.unstubAllGlobals();
      measure.mockRestore();
    }
  });

  it('repositions a resized submenu without selection resets or repeated identical style commits', () => {
    const { resize } = mockMenuResizeObserver();
    vi.stubGlobal('innerWidth', 1180);
    vi.stubGlobal('innerHeight', 788);
    const fixture = render(<button>Submenu anchor</button>);
    const anchor = within(fixture.container).getByRole('button');
    const measure = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 905, y: 700, width: 125, height: 24 }));
    let size = { width: 128, height: 60 };
    const measuredWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => size.width);
    const measuredHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => size.height);
    const committed = vi.fn();
    try {
      render(<Profiler id="menu" onRender={committed}><Menu anchor={anchor} open onClose={vi.fn()} entries={entries} label="Resized submenu" placement="right-start" /></Profiler>);
      const menu = screen.getByRole('menu', { name: 'Resized submenu' });
      expect(menu).toHaveStyle({ top: '696px', left: '1034px' });
      fireEvent.keyDown(menu, { key: 'End' });
      const active = menu.getAttribute('aria-activedescendant');
      size = { width: 260, height: 200 };
      resize(menu);
      expect(menu).toHaveStyle({ top: '524px', left: '641px' });
      expect(menu).toHaveAttribute('aria-activedescendant', active);
      expect(menu).toHaveFocus();
      committed.mockClear();
      for (let repeat = 0; repeat < 4; repeat++) resize(menu);
      expect(committed).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      measure.mockRestore();
      measuredWidth.mockRestore();
      measuredHeight.mockRestore();
    }
  });
});

describe('sidebar marks (lib)', () => {
  it('keeps pins newest first, clears pin and unread on archive, and drops a removed group\'s placements', () => {
    let marks = withPin(withPin(EMPTY_MARKS, 'A', true), 'b', true);
    expect(marks.pinned).toEqual(['b', 'a']);
    expect(withPin(marks, 'a', false).pinned).toEqual(['b']);
    marks = withUnread(marks, 'a', true);
    expect(withUnread(marks, 'a', true)).toBe(marks);
    marks = withArchived(marks, 'a', true);
    expect(marks).toMatchObject({ archived: ['a'], pinned: ['b'], unread: [] });
    expect(withArchived(marks, 'a', false).archived).toEqual([]);
    marks = withPlacement(withGroup(marks, { id: 'g1', name: ' Work ' }), 'C', 'g1');
    expect(marks.groups).toEqual([{ id: 'g1', name: 'Work' }]);
    expect(marks.placement).toEqual({ c: 'g1' });
    expect(withPlacement(marks, 'd', 'missing').placement).toEqual({ c: 'g1' });
    expect(withPlacement(marks, 'c', null).placement).toEqual({});
    expect(withGroup(marks, { id: 'g1', name: 'Renamed' }).groups).toEqual([{ id: 'g1', name: 'Renamed' }]);
    expect(withGroup(marks, { id: 'g2', name: '   ' })).toBe(marks);
    expect(withoutGroup(marks, 'g1').groups).toEqual([]);
    expect(withoutGroup(marks, 'g1').placement).toEqual({});
    expect(forgetSession({ ...marks, pinned: ['c'], unread: ['c'] }, 'C')).toMatchObject({ pinned: [], unread: [], placement: {} });
    let many = EMPTY_MARKS;
    for (let i = 0; i <= MAX_PINNED; i++) many = withPin(many, `s${i}`, true);
    expect(many.pinned).toHaveLength(MAX_PINNED);
    expect(many.pinned[0]).toBe(`s${MAX_PINNED}`);
  });

  it('reads only well-formed stored marks', () => {
    expect(
      sanitizeMarks({
        pinned: ['A', 'a', 3, ''],
        unread: 'x',
        groups: [{ id: 'g', name: ' G ' }, { id: 'g', name: 'dup' }, { id: 7, name: 'n' }, { id: 'h', name: '' }],
        placement: { S1: 'g', s2: 'nope', s3: 5 },
      }),
    ).toEqual({ pinned: ['a'], unread: [], archived: [], groups: [{ id: 'g', name: 'G' }], placement: { s1: 'g' } });
    window.localStorage.setItem(SIDEBAR_MARKS_KEY, 'not json');
    expect(readMarks()).toEqual({});
    window.localStorage.setItem(SIDEBAR_MARKS_KEY, JSON.stringify({ default: { pinned: ['x'] } }));
    expect(readMarks().default?.pinned).toEqual(['x']);
  });

  it('lists pinned sessions first in pin order, own groups among the folders, archived ones apart', () => {
    const sessions = [summary('a', 'D:\\w\\one', 50), summary('b', 'D:\\w\\one', 40), summary('c', 'D:\\w\\two', 30), summary('d', 'D:\\w\\two', 20), summary('e', 'D:\\w\\two', 10)];
    let marks = withPin(withPin(EMPTY_MARKS, 'c', true), 'e', true);
    marks = withPlacement(withGroup(marks, { id: 'g', name: 'Mine' }), 'b', 'g');
    marks = withGroup(marks, { id: 'empty', name: 'Later' });
    marks = withArchived(marks, 'd', true);
    const lists = groupSessions(sessions, {}, 'default', '', LABELS, marks);
    expect(lists.groups.map((g) => [g.kind, g.label, g.rows.map((r) => r.id).join(',')])).toEqual([
      ['pinned', 'Pinned', 'e,c'],
      ['folder', 'one', 'a'],
      ['custom', 'Mine', 'b'],
      ['custom', 'Later', ''],
    ]);
    expect(lists.archived.map((r) => r.id)).toEqual(['d']);
    // Searching hides empty own groups and still keeps archived matches apart.
    const found = groupSessions(sessions, {}, 'default', 't-d', LABELS, marks);
    expect(found.groups).toEqual([]);
    expect(found.archived.map((r) => r.id)).toEqual(['d']);
  });
});

describe('sidebar session menu', () => {
  it('shows the desktop menu from the row\'s ⋯ button and from a right-click', async () => {
    const { user } = await renderApp();
    const menu = await openRowMenu(user, 'Shortcut bar editor');
    expect(itemTexts(menu)).toEqual([
      'Open in',
      '---',
      'Pin P',
      'Mark as unread U',
      'Rename R',
      'Fork F',
      '---',
      'Move to',
      '---',
      'Archive A',
      'Delete D',
    ]);
    expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toHaveClass('rd-menu__item--danger');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    fireEvent.contextMenu(rowButton('Account switching research'));
    expect(await screen.findByRole('menu', { name: 'More options for Account switching research' })).toBeInTheDocument();
  });

  it('pins with P, marks unread with U, and opening the session reads it', async () => {
    const { user, controller } = await renderApp();
    let menu = await openRowMenu(user, 'Shortcut bar editor');
    fireEvent.keyDown(menu, { key: 'p' });
    await waitFor(() => expect(groupNames()[0]).toBe('Pinned'));
    expect(rowsIn('Pinned')).toEqual(['Shortcut bar editor']);
    menu = await openRowMenu(user, 'Shortcut bar editor');
    expect(within(menu).getByRole('menuitem', { name: /Unpin/ })).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'U' });
    await waitFor(() => expect(within(rowOf('Shortcut bar editor')).getByRole('img', { name: 'Unread' })).toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_MARKS_KEY)!).default).toMatchObject({ pinned: [expect.any(String)], unread: [expect.any(String)] });
    await user.click(rowButton('Shortcut bar editor'));
    await waitFor(() => expect(within(rowOf('Shortcut bar editor')).queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument());
    expect(controller.marksOf().unread).toEqual([]);
  });

  it('marks a session unread when its reply finishes while another one is in view', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() }));
    act(() => rendered.controller.showHome());
    act(() => rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'idle' }));
    expect(rendered.controller.marksOf().unread).toEqual([MAIN_SESSION_ID.toLowerCase()]);
  });

  it('renames, forks into a new session of its own, and opens a session elsewhere', async () => {
    const { api, user, controller } = await renderApp();
    const rename = vi.spyOn(api.sessions, 'rename');
    let menu = await openRowMenu(user, 'Shortcut bar editor');
    await user.click(within(menu).getByRole('menuitem', { name: /Rename/ }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Shortcut editor{Enter}');
    await waitFor(() => expect(rename).toHaveBeenCalledWith('default', expect.any(String), 'Shortcut editor'));
    expect(hasRow('Shortcut editor')).toBe(true);

    const fork = vi.spyOn(api.sessions, 'fork');
    menu = await openRowMenu(user, 'Shortcut editor');
    await user.click(within(menu).getByRole('menuitem', { name: /Fork/ }));
    await waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(controller.currentView()?.title).toBe('Shortcut editor (fork)'));
    expect(controller.currentView()?.confirmed).toBe(true);
    expect(hasRow('Shortcut editor (fork)')).toBe(true);

    const terminal = vi.spyOn(api.handoff, 'openInTerminal');
    const reveal = vi.spyOn(api.app, 'revealPath');
    menu = await openRowMenu(user, 'Account switching research');
    await user.hover(within(menu).getByRole('menuitem', { name: /Open in/ }));
    const openIn = await screen.findByRole('menu', { name: 'Open in' });
    expect([...openIn.querySelectorAll('.rd-menu__item')].map((el) => el.textContent)).toEqual(['Claude desktop', 'Terminal', 'File Explorer']);
    await user.click(within(openIn).getByRole('menuitem', { name: 'Terminal' }));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'default' })));
    menu = await openRowMenu(user, 'Account switching research');
    await user.hover(within(menu).getByRole('menuitem', { name: /Open in/ }));
    await user.click(within(await screen.findByRole('menu', { name: 'Open in' })).getByRole('menuitem', { name: 'File Explorer' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1));
  });

  it('moves a session into a new group, back to its folder, and removes the group', async () => {
    const { user, controller } = await renderApp();
    let menu = await openRowMenu(user, 'Shortcut bar editor');
    await user.hover(within(menu).getByRole('menuitem', { name: /Move to/ }));
    await user.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'New group…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Tools{Enter}');
    await waitFor(() => expect(rowsIn('Tools')).toEqual(['Shortcut bar editor']));
    expect(rowsIn('relay-desk')).not.toContain('Shortcut bar editor');

    menu = await openRowMenu(user, 'Shortcut bar editor');
    await user.hover(within(menu).getByRole('menuitem', { name: /Move to/ }));
    const move = await screen.findByRole('menu', { name: 'Move to' });
    expect(within(move).getByRole('menuitemradio', { name: 'Tools' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(move).getByRole('menuitem', { name: 'Back to relay-desk' }));
    await waitFor(() => expect(rowsIn('relay-desk')).toContain('Shortcut bar editor'));
    expect(rowsIn('Tools')).toEqual([]);
    expect(groupNames()).toContain('Tools');

    act(() => controller.removeGroup(controller.marksOf().groups[0]!.id));
    expect(groupNames()).not.toContain('Tools');
  });

  it('archives a session out of the list and back, and deletes one only after a confirmation', async () => {
    const { api, user, controller } = await renderApp();
    let menu = await openRowMenu(user, 'Shortcut bar editor');
    fireEvent.keyDown(menu, { key: 'a' });
    await waitFor(() => expect(hasRow('Shortcut bar editor')).toBe(false));
    await user.click(within(sidebar()).getByRole('button', { name: 'Archived (1)' }));
    menu = await openRowMenu(user, 'Shortcut bar editor');
    await user.click(within(menu).getByRole('menuitem', { name: /Unarchive/ }));
    await waitFor(() => expect(within(sidebar()).queryByRole('button', { name: 'Archived (1)' })).not.toBeInTheDocument());
    expect(rowsIn('relay-desk')).toContain('Shortcut bar editor');

    const remove = vi.spyOn(api.sessions, 'delete');
    menu = await openRowMenu(user, 'Shortcut bar editor');
    await user.click(within(menu).getByRole('menuitem', { name: /Delete/ }));
    let confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('"Shortcut bar editor" and its subagent transcripts are removed from this computer. This cannot be undone.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
    menu = await openRowMenu(user, 'Shortcut bar editor');
    fireEvent.keyDown(menu, { key: 'd' });
    confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hasRow('Shortcut bar editor')).toBe(false));
    expect(controller.state.sessions.some((s) => s.title === 'Shortcut bar editor')).toBe(false);
  });

  it('archiving the open session in view closes Relay\'s handle and leaves the view', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const close = vi.spyOn(rendered.api.engine, 'close');
    const menu = await openRowMenu(rendered.user, 'Relay Desk packaging plan');
    fireEvent.keyDown(menu, { key: 'a' });
    await waitFor(() => expect(hasRow('Relay Desk packaging plan')).toBe(false));
    expect(close).toHaveBeenCalledWith(handleId);
    expect(rendered.controller.state.currentKey).toBeNull();
    expect(within(sidebar()).getByRole('button', { name: 'Archived (1)' })).toBeInTheDocument();
  });

  it('closes Relay\'s own handle before archiving or deleting an open session', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    const close = vi.spyOn(rendered.api.engine, 'close');
    const remove = vi.spyOn(rendered.api.sessions, 'delete');
    const menu = await openRowMenu(rendered.user, 'Relay Desk packaging plan');
    fireEvent.keyDown(menu, { key: 'd' });
    await rendered.user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledWith(handleId);
    expect(close.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);
    expect(rendered.controller.state.currentKey).toBeNull();
  });
});
