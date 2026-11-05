import { ChevronDown, ChevronRight, Ellipsis, LogIn, Plus, RotateCw, Settings, Settings2, Users } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { DEFAULT_PROFILE_ID, type SessionSummary } from '@shared/types';
import { useT } from '../../i18n';
import { folderName, planLabel } from '../../lib/format';
import { focusWithoutScroll } from '../../lib/focus';
import { useAppState, useController } from '../../state/context';
import { sessionKey } from '../../state/controller';
import { planDisplay } from '../../state/plan';
import { findSessionViewKey, hasOpenHandle, isActiveState } from '../../state/sessionReducer';
import { EMPTY_MARKS, type SidebarMarks } from '../../state/sidebarMarks';
import type { SessionView } from '../../state/types';
import { Menu, type MenuEntry } from '../ui/Menu';
import { Avatar, ICON, ICON_SM, ICON_XS, IconButton } from '../ui/primitives';
import { NavButtons } from './NavButtons';

const VISIBLE_PER_GROUP = 5;
const COLLAPSED_GROUPS_KEY = 'relay.sidebarCollapsedGroups';

function readCollapsedGroups(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

interface Row {
  id: string;
  title: string;
  lastModified: number;
  summary?: SessionSummary;
  viewKey?: string;
}

interface Group {
  /** Folder groups: the folder (as before, so stored collapse states still apply); others: "pinned" or "group:<id>". */
  id: string;
  kind: 'folder' | 'pinned' | 'custom';
  cwd: string;
  label: string;
  rows: Row[];
  latest: number;
  /** Own group id ("Move to"). */
  groupId?: string;
}

export interface SidebarLists {
  groups: Group[];
  /** Archived sessions, newest first; listed in their own section at the end. */
  archived: Row[];
}

function matches(summary: SessionSummary, query: string): boolean {
  const q = query.toLowerCase();
  return [summary.title, summary.firstPrompt ?? '', summary.cwd, summary.gitBranch ?? ''].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/**
 * The sidebar's lists: pinned sessions first (pin order), then folder groups and the user's own groups, newest
 * activity first; archived sessions apart. Relay's own unsaved new sessions are included in their folders.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  views: Readonly<Record<string, SessionView>>,
  profileId: string,
  query: string,
  labels: { other: string; pinned: string },
  marks: SidebarMarks = EMPTY_MARKS,
): SidebarLists {
  const groups = new Map<string, Group>();
  const listed = new Set(sessions.map((s) => s.sessionId.toLowerCase()));
  const pinned: Row[] = [];
  const archived: Row[] = [];
  const add = (key: string, init: Omit<Group, 'rows' | 'latest'>, row: Row): void => {
    let group = groups.get(key);
    if (!group) {
      group = { ...init, rows: [], latest: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.latest = Math.max(group.latest, row.lastModified);
  };
  const folder = (cwd: string): Omit<Group, 'rows' | 'latest'> => ({ id: cwd, kind: 'folder', cwd, label: folderName(cwd) || labels.other });
  for (const summary of sessions) {
    if (query && !matches(summary, query)) continue;
    const row: Row = { id: summary.sessionId, title: summary.title || summary.sessionId, lastModified: summary.lastModified, summary };
    const id = summary.sessionId.toLowerCase();
    if (marks.archived.includes(id)) archived.push(row);
    else if (marks.pinned.includes(id)) pinned.push(row);
    else {
      const own = marks.groups.find((g) => g.id === marks.placement[id]);
      if (own) add(`group:${own.id}`, { id: `group:${own.id}`, kind: 'custom', cwd: '', label: own.name, groupId: own.id }, row);
      else add(summary.cwd, folder(summary.cwd), row);
    }
  }
  for (const view of Object.values(views)) {
    if (!view.isNew || view.profileId !== profileId) continue;
    if (view.sessionId && listed.has(view.sessionId.toLowerCase())) continue;
    if (query && !view.title.toLowerCase().includes(query.toLowerCase())) continue;
    add(view.cwd, folder(view.cwd), { id: view.key, title: view.title, lastModified: Number.MAX_SAFE_INTEGER, viewKey: view.key });
  }
  const list = [...groups.values()];
  for (const group of list) group.rows.sort((a, b) => b.lastModified - a.lastModified);
  list.sort((a, b) => b.latest - a.latest);
  // An own group stays visible while empty, so it can be renamed, removed or moved into.
  if (!query) {
    for (const own of marks.groups) {
      if (!groups.has(`group:${own.id}`)) list.push({ id: `group:${own.id}`, kind: 'custom', cwd: '', label: own.name, groupId: own.id, rows: [], latest: 0 });
    }
  }
  if (pinned.length > 0) {
    pinned.sort((a, b) => marks.pinned.indexOf(a.id.toLowerCase()) - marks.pinned.indexOf(b.id.toLowerCase()));
    list.unshift({ id: 'pinned', kind: 'pinned', cwd: '', label: labels.pinned, rows: pinned, latest: Number.MAX_SAFE_INTEGER });
  }
  archived.sort((a, b) => b.lastModified - a.lastModified);
  return { groups: list, archived };
}

/** The listed session behind a row, or Relay's own new session once it has an id. */
function rowSession(row: Row, view?: SessionView): Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'> | undefined {
  if (row.summary) return row.summary;
  return view?.sessionId ? { sessionId: view.sessionId, title: view.title, cwd: view.cwd } : undefined;
}

/** The desktop's session menu (hover ⋯ or right-click): Open in, Pin, Mark as unread, Rename, Fork, Move to, Archive, Delete. */
function sessionMenu(
  session: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>,
  marks: SidebarMarks,
  profileId: string,
  controller: ReturnType<typeof useController>,
  t: ReturnType<typeof useT>,
): MenuEntry[] {
  const id = session.sessionId.toLowerCase();
  const pinned = marks.pinned.includes(id);
  const unread = marks.unread.includes(id);
  const archived = marks.archived.includes(id);
  const placement = marks.placement[id];
  const key = (): string => controller.sessionViewKey(session);
  const folder = folderName(session.cwd) || t('sidebar.otherFolder');
  return [
    {
      id: 'open-in',
      label: t('sidebar.openIn'),
      submenu: [
        {
          id: 'desktop',
          label: t('sidebar.openInDesktop'),
          disabled: profileId !== DEFAULT_PROFILE_ID,
          disabledReason: t('reason.defaultOnly'),
          onSelect: () => void controller.runAction('handoff.toDesktop', key()),
        },
        { id: 'terminal', label: t('sidebar.openInTerminal'), onSelect: () => void controller.runAction('handoff.openInTerminal', key()) },
        {
          id: 'explorer',
          label: t('sidebar.openInExplorer'),
          disabled: !session.cwd,
          disabledReason: t('reason.noFolder'),
          onSelect: () => void controller.openFolder(session.cwd),
        },
      ],
    },
    { type: 'separator', id: 'sep-open' },
    { id: 'pin', label: t(pinned ? 'sidebar.unpin' : 'sidebar.pin'), shortcut: 'P', disabled: archived, onSelect: () => controller.setPinned(id, !pinned) },
    { id: 'unread', label: t(unread ? 'sidebar.markRead' : 'sidebar.markUnread'), shortcut: 'U', onSelect: () => controller.setUnread(id, !unread) },
    { id: 'rename', label: t('sidebar.rename'), shortcut: 'R', onSelect: () => void controller.renameSession(key()) },
    { id: 'fork', label: t('sidebar.fork'), shortcut: 'F', onSelect: () => void controller.forkSession(session) },
    { type: 'separator', id: 'sep-move' },
    {
      id: 'move',
      label: t('sidebar.moveTo'),
      submenu: [
        ...marks.groups.map<MenuEntry>((group) => ({
          id: `group-${group.id}`,
          label: group.name,
          checked: placement === group.id,
          onSelect: () => controller.moveSession(id, group.id),
        })),
        ...(placement ? [{ id: 'folder', label: t('sidebar.backToFolder', { folder }), onSelect: () => controller.moveSession(id, null) } satisfies MenuEntry] : []),
        ...(marks.groups.length > 0 ? [{ type: 'separator', id: 'sep-new' } satisfies MenuEntry] : []),
        { id: 'new', label: t('sidebar.newGroup'), onSelect: () => void controller.moveToNewGroup(id) },
      ],
    },
    { type: 'separator', id: 'sep-archive' },
    { id: 'archive', label: t(archived ? 'sidebar.unarchive' : 'sidebar.archive'), shortcut: 'A', onSelect: () => void controller.setArchived(session, !archived) },
    { id: 'delete', label: t('sidebar.delete'), shortcut: 'D', danger: true, onSelect: () => void controller.deleteSession(session) },
  ];
}

function SessionRow({ row, view, active }: { row: Row; view?: SessionView; active: boolean }) {
  const controller = useController();
  const t = useT();
  const profileId = useAppState((s) => s.activeProfileId);
  const marks = useAppState((s) => s.marks[s.activeProfileId]) ?? EMPTY_MARKS;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const running = view ? isActiveState(view.engineState) || view.engineState === 'starting' : false;
  const open = view ? hasOpenHandle(view) : false;
  const session = rowSession(row, view);
  const unread = Boolean(session && marks.unread.includes(session.sessionId.toLowerCase()));
  const onContextMenu = (event: MouseEvent): void => {
    if (!session) return;
    event.preventDefault();
    setMenuOpen(true);
  };
  return (
    <li className="rd-srow-wrap" data-menu-open={menuOpen ? 'true' : undefined} data-has-menu={session ? 'true' : undefined}>
      <button
        type="button"
        className="rd-srow"
        aria-current={active ? 'page' : undefined}
        data-tip={row.title}
        data-tip-place="right"
        onMouseDown={focusWithoutScroll}
        onContextMenu={onContextMenu}
        onClick={() => {
          if (row.viewKey) controller.navigate(row.viewKey);
          else if (row.summary) controller.openSummary(row.summary);
        }}
      >
        <span className="rd-srow__title">{row.title}</span>
        {running ? (
          <span className="rd-dot rd-dot--running" role="img" aria-label={t('sidebar.running')} />
        ) : unread ? (
          <span className="rd-dot rd-dot--unread" role="img" aria-label={t('sidebar.unread')} />
        ) : open ? (
          <span className="rd-dot" role="img" aria-label={t('sidebar.openInRelay')} />
        ) : null}
      </button>
      {session ? (
        <>
          <IconButton
            ref={moreRef}
            label={t('sidebar.rowOptions', { title: row.title })}
            icon={<Ellipsis {...ICON_SM} />}
            size="small"
            className="rd-srow__more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          />
          <Menu
            anchor={moreRef.current}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            entries={menuOpen ? sessionMenu(session, marks, profileId, controller, t) : []}
            label={t('sidebar.rowOptions', { title: row.title })}
            placement="bottom-end"
            width={196}
            className="rd-menu--session"
          />
        </>
      ) : null}
    </li>
  );
}

function GroupHeader({ group, collapsed, headingId, onToggle }: {
  group: Group;
  collapsed: boolean;
  headingId: string;
  onToggle(): void;
}) {
  const controller = useController();
  const t = useT();
  const optionsRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const entries: MenuEntry[] = [
    { id: 'toggle', label: t(collapsed ? 'sidebar.expandGroup' : 'sidebar.collapseGroup'), onSelect: onToggle },
    ...(group.kind === 'folder' && group.cwd ? [
      { id: 'new', label: t('sidebar.newInFolder', { folder: group.label }), onSelect: () => void controller.newSession(group.cwd) },
      { id: 'folder', label: t('session.openFolder'), onSelect: () => void controller.openFolder(group.cwd) },
    ] : []),
    ...(group.kind === 'custom' && group.groupId ? [
      { id: 'rename', label: t('sidebar.renameGroup'), onSelect: () => void controller.renameGroup(group.groupId!) },
      { id: 'remove', label: t('sidebar.removeGroup'), onSelect: () => controller.removeGroup(group.groupId!) },
    ] : []),
  ];
  return (
    <div className="rd-sgroup__head">
      <button
        type="button"
        id={headingId}
        className="rd-sgroup__label"
        title={group.kind === 'folder' ? group.cwd : undefined}
        aria-expanded={!collapsed}
        aria-controls={`${headingId}-rows`}
        onMouseDown={focusWithoutScroll}
        onClick={onToggle}
      >
        <span className="rd-sgroup__name">{group.label}</span>
        {/* Collapsed: "name >" always; expanded: "name ∨" only on hover or keyboard focus (desktop-light-06). */}
        <span className="rd-sgroup__chevron" data-direction={collapsed ? 'right' : 'down'}>
          {collapsed ? <ChevronRight {...ICON_SM} /> : <ChevronDown {...ICON_SM} />}
        </span>
      </button>
      <span className="rd-sgroup__actions" data-open={optionsOpen}>
        <IconButton
          ref={optionsRef}
          label={t('sidebar.optionsFor', { folder: group.label })}
          icon={<Settings2 {...ICON} className="rd-sgroup__optionsicon" />}
          size="small"
          aria-haspopup="menu"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((open) => !open)}
        />
        {group.kind === 'folder' && group.cwd ? (
          <IconButton
            label={t('sidebar.newInFolder', { folder: group.label })}
            icon={<Plus {...ICON} />}
            size="small"
            className="rd-sgroup__add"
            onClick={() => void controller.newSession(group.cwd)}
          />
        ) : null}
      </span>
      <Menu
        anchor={optionsRef.current}
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        entries={entries}
        label={t('sidebar.optionsFor', { folder: group.label })}
        width={240}
      />
    </div>
  );
}

function SessionRows({ rows }: { rows: readonly Row[] }) {
  const views = useAppState((s) => s.views);
  const currentKey = useAppState((s) => s.currentKey);
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const currentView = currentKey ? views[currentKey] : undefined;
  return (
    <>
      {rows.map((row) => {
        // Relay's own new session keeps its live view after it shows up in the list (RQ-1).
        const key = row.viewKey ?? findSessionViewKey(views, row.id, activeProfileId) ?? sessionKey(row.id);
        const view = views[key];
        const active = currentKey === key || Boolean(row.summary && currentView?.sessionId === row.summary.sessionId);
        return <SessionRow key={row.id} row={row} view={view} active={active} />;
      })}
    </>
  );
}

function SessionGroup({ group, collapsed, showAll, searching, onToggle, onToggleAll }: {
  group: Group;
  collapsed: boolean;
  showAll: boolean;
  searching: boolean;
  onToggle(): void;
  onToggleAll(): void;
}) {
  const t = useT();
  // Folder paths contain spaces and backslashes, so they cannot serve as element ids (HI-5).
  const headingId = useId();
  const rows = showAll ? group.rows : group.rows.slice(0, VISIBLE_PER_GROUP);
  const hidden = group.rows.length - rows.length;
  return (
    <section className="rd-sgroup" aria-labelledby={headingId} data-kind={group.kind}>
      <GroupHeader group={group} collapsed={collapsed} headingId={headingId} onToggle={onToggle} />
      {collapsed ? null : (
        <ul id={`${headingId}-rows`} className="rd-sgroup__rows">
          <SessionRows rows={rows} />
          {hidden > 0 ? (
            <li>
              <button type="button" className="rd-srow rd-srow--more" onClick={onToggleAll}>
                {t('sidebar.showOlder', { n: hidden })}
              </button>
            </li>
          ) : null}
          {showAll && !searching && group.rows.length > VISIBLE_PER_GROUP ? (
            <li>
              <button type="button" className="rd-srow rd-srow--more" onClick={onToggleAll}>
                {t('sidebar.showFewer')}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

/** Archived sessions, folded away at the end of the list; their menu offers Unarchive. */
function ArchivedSection({ rows }: { rows: readonly Row[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  return (
    <section className="rd-sgroup rd-sgroup--archived" aria-labelledby={headingId} data-kind="archived">
      <div className="rd-sgroup__head">
        <button
          type="button"
          id={headingId}
          className="rd-sgroup__label"
          aria-expanded={open}
          aria-controls={`${headingId}-rows`}
          onMouseDown={focusWithoutScroll}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="rd-sgroup__name">{t('sidebar.archived', { n: rows.length })}</span>
          <span className="rd-sgroup__chevron" data-direction={open ? 'down' : 'right'}>
            {open ? <ChevronDown {...ICON_SM} /> : <ChevronRight {...ICON_SM} />}
          </span>
        </button>
      </div>
      {open ? (
        <ul id={`${headingId}-rows`} className="rd-sgroup__rows">
          <SessionRows rows={rows} />
        </ul>
      ) : null}
    </section>
  );
}

function AccountChip() {
  const controller = useController();
  const t = useT();
  const profiles = useAppState((s) => s.profiles);
  const auth = useAppState((s) => s.auth);
  const plans = useAppState((s) => s.plans);
  const usage = useAppState((s) => s.usage);
  const labels = useAppState((s) => s.labels);
  const drift = useAppState((s) => s.labels[s.activeProfileId]?.drift);
  const activeId = useAppState((s) => s.activeProfileId);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = profiles.find((p) => p.id === activeId);
  const status = auth[activeId];
  const name = active?.name ?? activeId;
  const shown = (id: string) => planDisplay(auth[id], plans[id], usage[id], labels[id]);
  const plan = status?.loggedIn ? shown(activeId).plan : status ? t('accounts.loggedOut') : undefined;
  const driftNote = status?.loggedIn && drift ? t('accounts.labelDrift', { label: drift.label, remembered: drift.remembered }) : undefined;

  const entries: MenuEntry[] = [
    { type: 'section', id: 'profiles', label: t('accounts.switchFor') },
    ...profiles.map<MenuEntry>((profile) => {
      const s = auth[profile.id];
      return {
        id: `p-${profile.id}`,
        label: profile.name,
        description: s?.loggedIn ? (shown(profile.id).label ?? t('accounts.loggedIn')) : t('accounts.loggedOut'),
        checked: profile.id === activeId,
        onSelect: () => void controller.setActiveProfile(profile.id),
      };
    }),
    { type: 'separator', id: 'sep' },
    ...(status && !status.loggedIn
      ? [
          {
            id: 'login',
            label: t('accounts.login'),
            icon: <LogIn {...ICON} />,
            onSelect: () => void controller.login(activeId),
          } satisfies MenuEntry,
        ]
      : []),
    {
      id: 'manage',
      label: t('accounts.manage'),
      icon: <Users {...ICON} />,
      onSelect: () => controller.revealCard('accounts'),
    },
  ];

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="rd-account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('accounts.chipLabel', { name })}
        data-tip={driftNote}
        data-tip-place="top"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={name} />
        <span className="rd-account__name">{name}</span>
        {plan ? <span className="rd-account__plan">· {plan}</span> : null}
        {driftNote ? <span className="rd-dot rd-dot--warn" role="img" aria-label={driftNote} data-testid="account-drift-dot" /> : null}
        <ChevronDown {...ICON_SM} className="rd-account__chevron" />
      </button>
      <Menu
        anchor={chipRef.current}
        open={open}
        onClose={() => setOpen(false)}
        entries={entries}
        label={t('accounts.title')}
        placement="top-start"
        width={240}
      />
    </>
  );
}

export function Sidebar() {
  const controller = useController();
  const t = useT();
  const sessions = useAppState((s) => s.sessions);
  const sessionsState = useAppState((s) => s.sessionsState);
  const sessionsError = useAppState((s) => s.sessionsError);
  const views = useAppState((s) => s.views);
  const currentKey = useAppState((s) => s.currentKey);
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const marks = useAppState((s) => s.marks[s.activeProfileId]);
  const searchRequested = useAppState((s) => s.ui.sessionSearch);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!searchRequested) return;
    searchRef.current?.focus({ preventScroll: true });
    controller.sessionSearchShown();
  }, [searchRequested, controller]);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedGroups);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const { groups, archived } = useMemo(
    () =>
      groupSessions(sessions, views, activeProfileId, query.trim(), { other: t('sidebar.otherFolder'), pinned: t('sidebar.pinned') }, marks),
    [sessions, views, activeProfileId, query, t, marks],
  );

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  return (
    <aside className="rd-sidebar" aria-label={t('sidebar.label')}>
      <div className="rd-sidebar__head">
        <NavButtons />
      </div>
      <div className="rd-sidebar__search">
        <input
          ref={searchRef}
          type="search"
          className="rd-sidebar__searchbox"
          placeholder={t('sidebar.search')}
          aria-label={t('sidebar.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
      </div>
      <nav className="rd-sidebar__nav" aria-label={t('sidebar.label')}>
        <button type="button" className="rd-navrow" onClick={() => controller.showHome()} aria-current={currentKey === null ? 'page' : undefined}>
          <span className="rd-navrow__circle">
            <Plus size={13} strokeWidth={1.75} aria-hidden />
          </span>
          <span>{t('sidebar.newSession')}</span>
        </button>
      </nav>
      <div className="rd-sidebar__list">
        {sessionsState === 'loading' && sessions.length === 0 ? (
          <p className="rd-sidebar__status">{t('common.loading')}</p>
        ) : null}
        {sessionsState === 'error' ? (
          <div className="rd-sidebar__status rd-sidebar__status--error" role="alert">
            <span>{t('sidebar.loadFailed', { message: sessionsError ?? '' })}</span>
            <button type="button" className="rd-link" onClick={() => void controller.loadSessions()}>
              <RotateCw {...ICON_XS} /> {t('common.retry')}
            </button>
          </div>
        ) : null}
        {sessionsState === 'loaded' && groups.length === 0 && archived.length === 0 ? (
          <p className="rd-sidebar__status">{query ? t('sidebar.noMatches') : t('sidebar.empty')}</p>
        ) : null}
        {groups.map((group) => {
          // Folder groups keep their earlier key, so collapse states saved before own groups existed still apply.
          const groupKey = JSON.stringify([activeProfileId, group.kind === 'folder' ? group.cwd : group.id]);
          return (
            <SessionGroup
              key={group.kind === 'folder' ? group.cwd || '__none' : group.id}
              group={group}
              collapsed={collapsed.has(groupKey)}
              showAll={query !== '' || expanded.has(group.id)}
              searching={query !== ''}
              onToggle={() => setCollapsed((set) => {
                const next = toggle(set, groupKey);
                try {
                  window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
                } catch {
                  // Keep collapse controls usable when storage is unavailable.
                }
                return next;
              })}
              onToggleAll={() => setExpanded((set) => toggle(set, group.id))}
            />
          );
        })}
        {archived.length > 0 ? <ArchivedSection rows={archived} /> : null}
      </div>
      <footer className="rd-sidebar__foot">
        <AccountChip />
        <IconButton
          label={t('settings.title')}
          shortcut="Ctrl+,"
          icon={<Settings {...ICON} />}
          tipPlace="top"
          onClick={() => controller.openSettings(true)}
        />
      </footer>
    </aside>
  );
}
